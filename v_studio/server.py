"""Local HTTP API behind the V Studio window (127.0.0.1 only; the window's
page is its only client).

    GET    /api/status          model + system state
    POST   /api/load            {mode, backend, device, precision, threads, ...} → loads in background
    GET    /api/voices          preset + saved voices of the loaded model
    POST   /api/voices          multipart(name, description, gender, denoise, file) → save a cloned voice
    DELETE /api/voices/{name}   delete a saved voice
    POST   /api/denoise         multipart(file) → cleaned 44.1 kHz WAV
    POST   /api/tts             multipart(text, voice, params(JSON), stream, sample_rate, watermark, lexicon, ref_audio?)
                                → raw PCM s16le mono (chunked as it is generated when stream=true);
                                the pronunciation dictionary (lexicon.py) is applied first unless lexicon=false
    POST   /api/encode          multipart(file=WAV, format) → wav | flac | ogg | mp3
    POST   /api/extract         multipart(file=.txt/.md/.pdf/.docx) → {"text": ...}
    POST   /api/stash           multipart(file) → {"id"}; the window saves it with a native dialog
    GET    /api/update/check    newest vieneu on PyPI vs installed; POST /api/update/install; GET /api/update/status

Also mounted: /api/stories (stories.py), /api/lexicon (lexicon.py), /api/library (library.py),
/api/music + /api/mix (music.py).
"""
from __future__ import annotations

import io
import json
import logging
import os
import tempfile
import threading
import time
import uuid
import weakref
from pathlib import Path
from typing import Any, Iterator, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .engine import MANAGER
from .lexicon import LEXICON

log = logging.getLogger("vieneu.studio")

UI_DIR = Path(__file__).parent / "ui"
STASH_DIR = Path(tempfile.gettempdir()) / "v-studio-stash"
OUT_RATES = (48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 8_000)
MAX_UPLOAD = 50 * 1024 * 1024

app = FastAPI(title="V Studio", version="1.0")


@app.exception_handler(HTTPException)
async def _http_exc(_req: Request, exc: HTTPException):
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


@app.exception_handler(Exception)
async def _any_exc(_req: Request, exc: Exception):
    log.exception("Unhandled error")
    return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


def _need_model():
    try:
        return MANAGER.require()
    except RuntimeError as e:
        raise HTTPException(503, str(e))


def _save_upload(up: UploadFile, default_ext: str = ".wav") -> str:
    data = up.file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File quá lớn (tối đa 50 MB).")
    if not data:
        raise HTTPException(400, "File rỗng.")
    ext = os.path.splitext(up.filename or "")[1].lower()
    if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".txt", ".md", ".pdf", ".docx", ".srt"):
        ext = default_ext
    fd, path = tempfile.mkstemp(suffix=ext, prefix="vieneu-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def _unlink(path: Optional[str]) -> None:
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


def _pcm16(x: np.ndarray) -> bytes:
    return (np.asarray(x, dtype=np.float32) * 32767).clip(-32768, 32767).astype("<i2").tobytes()


def _clamp(v: Any, lo: float, hi: float, cast=float):
    try:
        v = cast(v)
    except (TypeError, ValueError):
        raise HTTPException(400, f"giá trị không hợp lệ: {v!r}")
    if isinstance(v, float) and not np.isfinite(v):
        raise HTTPException(400, "giá trị không hợp lệ")
    return min(max(v, lo), hi)


# ── status / model ───────────────────────────────────────────────────────────

@app.get("/api/status")
def status():
    st = MANAGER.status()
    try:
        import soundfile as sf
        fmts = sf.available_formats()
        st["formats"] = ["wav", "flac"] + (["ogg"] if "OGG" in fmts else []) + (["mp3"] if "MP3" in fmts else [])
    except Exception:
        st["formats"] = ["wav"]
    st["out_rates"] = list(OUT_RATES)
    return st


@app.post("/api/load")
async def load(request: Request):
    cfg = await request.json()
    try:
        MANAGER.load_async(cfg or {})
    except (RuntimeError, ValueError) as e:
        raise HTTPException(409, str(e))
    return MANAGER.status()


# ── voices ───────────────────────────────────────────────────────────────────

@app.get("/api/voices")
def voices():
    _need_model()
    return {"voices": MANAGER.voices(), "default": MANAGER.tts._default_voice}


@app.post("/api/voices")
def add_voice(name: str = Form(...), file: UploadFile = File(...), denoise: bool = Form(True),
              description: str = Form(""), gender: str = Form("")):
    _need_model()
    path = _save_upload(file)
    try:
        MANAGER.save_voice(name, path, denoise=denoise, description=description, gender=gender)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Không thể tạo giọng: {e}")
    finally:
        _unlink(path)
    return {"id": name.strip(), "voices": MANAGER.voices()}


@app.delete("/api/voices/{name}")
def delete_voice(name: str):
    _need_model()
    try:
        MANAGER.delete_voice(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "voices": MANAGER.voices()}


@app.post("/api/denoise")
def denoise(file: UploadFile = File(...)):
    _need_model()
    path = _save_upload(file)
    try:
        wav, sr = MANAGER.denoise(path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Không khử nhiễu được: {e}")
    finally:
        _unlink(path)
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, np.asarray(wav, dtype=np.float32), sr, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")


# ── synthesis ────────────────────────────────────────────────────────────────

def _infer_kwargs(mode: str, p: dict, stream: bool) -> dict:
    kw: dict = {"denoise": bool(p.get("denoise", True))}
    if mode == "v3turbo":
        kw.update(
            temperature=_clamp(p.get("temperature", 0.8), 0.0, 2.0),
            top_k=_clamp(p.get("top_k", 25), 1, 1024, int),
            top_p=_clamp(p.get("top_p", 0.95), 0.01, 1.0),
            repetition_penalty=_clamp(p.get("repetition_penalty", 1.2), 1.0, 2.0),
            repetition_window=_clamp(p.get("repetition_window", 64), 0, 1024, int),
            max_new_frames=_clamp(p.get("max_new_frames", 300), 25, 1500, int),
            max_chars=_clamp(p.get("max_chars", 256), 64, 512, int),
            use_ref_codes=bool(p.get("use_ref_codes", True)),
        )
        if not stream and p.get("batch_size"):
            kw["batch_size"] = _clamp(p["batch_size"], 1, 128, int)
    else:
        kw.update(
            steps=_clamp(p.get("steps", 16), 1, 64, int),
            cfg=_clamp(p.get("cfg", 3.0), 0.0, 10.0),
            sway=_clamp(p.get("sway", 0.0), -1.0, 1.0),
            speed=_clamp(p.get("speed", 1.0), 0.5, 2.0),
            max_chars=_clamp(p.get("max_chars", 140), 32, 512, int),
        )
        seed = p.get("seed")
        if not stream and seed not in (None, "", "null"):
            kw["seed"] = _clamp(seed, 0, 2**31 - 1, int)
    return kw


class _Resampler:
    def __init__(self, src: int, dst: int):
        self._rs = None
        if src != dst:
            import soxr
            self._rs = soxr.ResampleStream(src, dst, 1, dtype="float32", quality="HQ")

    def __call__(self, x: np.ndarray, last: bool = False) -> np.ndarray:
        x = np.asarray(x, dtype=np.float32)
        return x if self._rs is None else self._rs.resample_chunk(x, last=last)


class _LockSlot:
    """The inference lock, released exactly once (stream end, error, or the
    response body being dropped before it was read)."""

    def __init__(self):
        self._held = True
        self._mu = threading.Lock()

    def release(self):
        with self._mu:
            held, self._held = self._held, False
        if held:
            MANAGER.infer_lock.release()


@app.post("/api/tts")
def tts(text: str = Form(...), voice: str = Form(""), params: str = Form("{}"),
        stream: bool = Form(False), sample_rate: int = Form(0), watermark: bool = Form(True),
        lexicon: bool = Form(True), ref_audio: Optional[UploadFile] = File(None)):
    engine = _need_model()
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Văn bản trống.")
    if len(text) > 200_000:
        raise HTTPException(413, "Văn bản quá dài (tối đa 200.000 ký tự).")
    if lexicon:
        text = LEXICON.apply(text).strip()
        if not text:
            raise HTTPException(400, "Văn bản trống sau khi áp từ điển phát âm.")
    try:
        p = json.loads(params or "{}")
    except json.JSONDecodeError:
        raise HTTPException(400, "params phải là JSON.")
    mode = MANAGER.mode
    kw = _infer_kwargs(mode, p, stream)
    src_rate = int(engine.sample_rate)
    out_rate = int(sample_rate) if sample_rate else src_rate
    if out_rate not in OUT_RATES:
        raise HTTPException(400, f"sample_rate phải thuộc {OUT_RATES}")

    ref_path = _save_upload(ref_audio) if ref_audio is not None and ref_audio.filename else None
    if ref_path is None:
        v = voice or None
        if v is not None:
            resolve = getattr(engine, "resolve_voice_name", None)
            known = resolve(v) if resolve else (v if v in engine._preset_voices else None)
            if known is None:
                raise HTTPException(400, f"Không có giọng '{v}'.")
            v = known
        kw["voice"] = v
    else:
        kw["ref_audio"] = ref_path

    if not MANAGER.infer_lock.acquire(timeout=600):
        _unlink(ref_path)
        raise HTTPException(429, "Đang bận tạo âm thanh khác.")
    slot = _LockSlot()
    headers = {"X-Sample-Rate": str(out_rate), "Cache-Control": "no-store",
               "X-Model": mode or "", "X-Source-Rate": str(src_rate)}

    if not stream:
        t0 = time.perf_counter()
        try:
            wav = engine.infer(text, apply_watermark=watermark, **kw)
        except Exception as e:  # noqa: BLE001
            log.exception("infer failed")
            raise HTTPException(400, f"Lỗi khi tạo âm thanh: {e}")
        finally:
            slot.release()
            _unlink(ref_path)
        elapsed = time.perf_counter() - t0
        wav = np.asarray(wav, dtype=np.float32)
        if out_rate != src_rate and wav.size:
            import soxr
            wav = soxr.resample(wav, src_rate, out_rate, quality="HQ").astype(np.float32)
        headers.update({"X-Elapsed": f"{elapsed:.3f}", "X-Audio-Seconds": f"{len(wav) / out_rate:.3f}"})
        return Response(_pcm16(wav), media_type="audio/pcm", headers=headers)

    def body() -> Iterator[bytes]:
        rs = _Resampler(src_rate, out_rate)
        try:
            for chunk in engine.infer_stream(text, apply_watermark=watermark, **kw):
                if chunk is None or len(chunk) == 0:
                    continue
                out = rs(chunk)
                if len(out):
                    yield _pcm16(out)
            tail = rs(np.zeros(0, np.float32), last=True)
            if len(tail):
                yield _pcm16(tail)
        except Exception:  # noqa: BLE001 — headers already sent; the body just ends
            log.exception("stream failed")
        finally:
            slot.release()
            _unlink(ref_path)

    gen = body()
    weakref.finalize(gen, slot.release)
    return StreamingResponse(gen, media_type="audio/pcm", headers=headers)


# ── files ────────────────────────────────────────────────────────────────────

@app.post("/api/encode")
def encode(file: UploadFile = File(...), format: str = Form("wav")):
    import soundfile as sf
    fmt = format.lower()
    spec = {"wav": ("WAV", "PCM_16", "audio/wav"), "flac": ("FLAC", "PCM_16", "audio/flac"),
            "ogg": ("OGG", "VORBIS", "audio/ogg"), "mp3": ("MP3", "MPEG_LAYER_III", "audio/mpeg")}.get(fmt)
    if spec is None:
        raise HTTPException(400, "format: wav | flac | ogg | mp3")
    data, sr = sf.read(io.BytesIO(file.file.read(MAX_UPLOAD)), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    peak = float(np.abs(data).max()) if data.size else 0.0
    if peak > 0.999:
        data = data * (0.98 / peak)
    if fmt == "mp3" and sr not in (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000):
        raise HTTPException(400, "MP3 không hỗ trợ sample rate này.")
    buf = io.BytesIO()
    try:
        sf.write(buf, data, sr, format=spec[0], subtype=spec[1])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Không ghi được {fmt.upper()}: {e}")
    return Response(buf.getvalue(), media_type=spec[2])


@app.post("/api/extract")
def extract(file: UploadFile = File(...)):
    path = _save_upload(file, ".txt")
    ext = os.path.splitext(path)[1]
    try:
        if ext == ".pdf":
            try:
                from pypdf import PdfReader
            except ImportError:
                raise HTTPException(400, "Cần cài pypdf để đọc PDF: pip install pypdf")
            text = "\n\n".join((pg.extract_text() or "").strip() for pg in PdfReader(path).pages)
        elif ext == ".docx":
            import re
            import zipfile
            with zipfile.ZipFile(path) as z:
                xml = z.read("word/document.xml").decode("utf-8", "replace")
            xml = re.sub(r"</w:p>", "\n", xml)
            text = re.sub(r"<[^>]+>", "", xml)
            import html
            text = html.unescape(text)
        else:
            raw = Path(path).read_bytes()
            text = raw.decode("utf-8-sig", errors="replace")
    finally:
        _unlink(path)
    return {"text": text.strip()}


@app.post("/api/stash")
def stash(file: UploadFile = File(...)):
    STASH_DIR.mkdir(parents=True, exist_ok=True)
    sid = uuid.uuid4().hex
    (STASH_DIR / sid).write_bytes(file.file.read(500 * 1024 * 1024))
    return {"id": sid}


# ── updates ──────────────────────────────────────────────────────────────────

@app.get("/api/update/check")
def update_check(force: bool = False):
    from . import updater
    try:
        return updater.check(force=force)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Không kiểm tra được cập nhật (cần mạng): {e}")


@app.post("/api/update/install")
def update_install():
    from . import updater
    try:
        return updater.start_install()
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@app.get("/api/update/status")
def update_status():
    from . import updater
    return updater.job_status()


def stash_path(sid: str) -> Optional[Path]:
    if not sid or not all(c in "0123456789abcdef" for c in sid):
        return None
    p = STASH_DIR / sid
    return p if p.is_file() else None


# ── story ── Phòng thu Truyện (/api/stories…, see stories.py)
from .stories import router as _stories_router  # noqa: E402
app.include_router(_stories_router)
# ── /story ──

from .lexicon import router as _lexicon_router  # noqa: E402
from .library import router as _library_router  # noqa: E402
from .music import router as _music_router  # noqa: E402
app.include_router(_lexicon_router)
app.include_router(_library_router)
app.include_router(_music_router)

app.mount("/", StaticFiles(directory=str(UI_DIR), html=True), name="ui")
