"""Model manager for V Studio: loads one speech model at a time — VieNeu-TTS
(v3 Turbo / v3 Nano, Vietnamese, through the official ``vieneu`` SDK) or
Kokoro-82M (multilingual, see kokoro.py) — keeps the user's saved voices, and
serialises inference (one generation at a time — a desktop app has one user,
and the CPU/ONNX engines share every core anyway).

Everything the app stores lives in ``~/.vstudio`` (``VSTUDIO_HOME`` overrides
it): saved voices ``user_voices_v3_{turbo,nano}.json``, ``library/``,
``stories/``, ``music/``, ``lexicon.json`` and downloaded ``models/``.
Data of V Studio ≤ 1.1 (``~/.vieneu``) is copied over on first start.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

log = logging.getLogger("vieneu.studio")

USER_MARK = "_user"
DEFAULT_DESC = "giọng đã lưu"

# features: clone (voice cloning, saved voices, denoise), emotions ([cười]-style tags),
# watermark (Perth), normalize (Vietnamese numbers / units / formulas → words), stream.
_VIENEU_FEATURES = ["clone", "emotions", "watermark", "normalize", "stream"]
MODES = {
    "v3turbo": {"label": "VieNeu-TTS v3 Turbo", "sample_rate": 48_000, "clone": True, "languages": ["vi"],
                "features": _VIENEU_FEATURES},
    "v3nano": {"label": "VieNeu-TTS v3 Nano (preview)", "sample_rate": 24_000, "clone": True, "languages": ["vi"],
               "features": _VIENEU_FEATURES},
    "kokoro": {"label": "Kokoro-82M (đa ngôn ngữ)", "sample_rate": 24_000, "clone": False,
               "languages": ["en-us", "en-gb", "es", "fr-fr", "it", "pt-br", "hi", "ja", "cmn"],
               "features": ["stream"]},
}

_migrated = False


def app_home() -> Path:
    """Root folder of everything V Studio stores (``~/.vstudio``)."""
    home = Path(os.environ.get("VSTUDIO_HOME") or (Path.home() / ".vstudio"))
    global _migrated
    if not _migrated:
        _migrated = True
        _migrate_legacy(home)
    return home


voices_home = app_home   # older name, kept for callers


def _migrate_legacy(home: Path) -> None:
    """Copy the data of V Studio ≤ 1.1 (``~/.vieneu/studio/*`` and the saved
    voices in ``~/.vieneu``) into the new home, once. The old folder is left
    untouched: the VieNeu Gradio app may still use it."""
    old = Path(os.environ.get("VIENEU_HOME") or (Path.home() / ".vieneu"))
    marker = home / ".migrated"
    if marker.exists() or not old.is_dir():
        return
    try:
        home.mkdir(parents=True, exist_ok=True)
        studio = old / "studio"
        items = list(studio.iterdir()) if studio.is_dir() else []
        items += list(old.glob("user_voices_v3_*.json"))
        for src in items:
            dst = home / src.name
            if dst.exists():   # never overwrite data already in the new home
                continue
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        marker.write_text(f"copied from {old}\n", encoding="utf-8")
        log.info("Copied V Studio data from %s to %s", old, home)
    except Exception:  # noqa: BLE001 — never block start-up over this
        log.exception("Could not copy old data from %s", old)


def _kokoro_downloaded() -> dict:
    try:
        from .kokoro import downloaded
        return downloaded(app_home() / "models" / "kokoro")
    except Exception:  # noqa: BLE001
        return {}


def _cuda_available() -> bool:
    try:
        import torch  # noqa: F401
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _torch_available() -> bool:
    try:
        import importlib.util
        return importlib.util.find_spec("torch") is not None
    except Exception:
        return False


def _watermark_available() -> bool:
    try:
        import perth
        return hasattr(perth, "PerthImplicitWatermarker")
    except Exception:
        return False


class ModelManager:
    def __init__(self) -> None:
        self.tts: Any = None
        self.mode: Optional[str] = None
        self.config: dict = {}
        self.loading = False
        self.load_started: Optional[float] = None
        self.load_seconds: Optional[float] = None
        self.error: Optional[str] = None
        self.note: Optional[str] = None   # loading progress shown in the UI (downloads)
        self._load_lock = threading.Lock()
        self.infer_lock = threading.Lock()

    # ── status ────────────────────────────────────────────────────────────
    def status(self) -> dict:
        tts = self.tts
        try:
            import importlib.metadata as md
            sdk_version = md.version("vieneu")
        except Exception:
            sdk_version = "?"
        return {
            "loaded": tts is not None,
            "loading": self.loading,
            "loading_for": round(time.time() - self.load_started, 1) if self.loading and self.load_started else None,
            "load_seconds": self.load_seconds,
            "error": self.error,
            "mode": self.mode,
            "mode_label": MODES.get(self.mode or "", {}).get("label"),
            "loading_note": self.note if self.loading else None,
            "can_clone": bool(MODES.get(self.mode or "", {}).get("clone")) and tts is not None,
            "languages": MODES.get(self.mode or "", {}).get("languages", []),
            "features": MODES.get(self.mode or "", {}).get("features", []) if tts is not None else [],
            "modes": MODES,
            "downloads": {"kokoro": _kokoro_downloaded()},
            "backend": getattr(tts, "backend", None),
            "sample_rate": getattr(tts, "sample_rate", None),
            "default_voice": getattr(tts, "_default_voice", None),
            "watermark_active": bool(getattr(tts, "watermarker", None)),
            "config": self.config,
            "sdk_version": sdk_version,
            "system": {
                "torch": _torch_available(),
                "cuda": _cuda_available() if _torch_available() else False,
                "watermark": _watermark_available(),
                "cpu_count": os.cpu_count(),
            },
            "voices_home": str(app_home()),
        }

    # ── loading ───────────────────────────────────────────────────────────
    def load_async(self, cfg: dict) -> None:
        if self.loading:
            raise RuntimeError("Đang tải một mô hình khác, vui lòng đợi.")
        mode = cfg.get("mode", "v3turbo")
        if mode not in MODES:
            raise ValueError(f"mode phải là một trong {list(MODES)}")
        self.loading = True
        self.error = None
        self.note = None
        self.load_started = time.time()
        threading.Thread(target=self._load, args=(cfg,), daemon=True).start()

    def _load(self, cfg: dict) -> None:
        with self._load_lock:
            try:
                mode = cfg.get("mode", "v3turbo")
                kw: dict = {}
                threads = int(cfg.get("threads") or 0)
                if mode == "kokoro":
                    kw.update(precision=cfg.get("precision") if cfg.get("precision") in ("fp32", "int8") else "fp32",
                              threads=threads)
                    if cfg.get("model_dir"):
                        kw["model_dir"] = str(cfg["model_dir"]).strip()
                elif mode == "v3turbo":
                    kw.update(
                        backend=cfg.get("backend") or "auto",
                        device=cfg.get("device") or "auto",
                        precision=cfg.get("precision") or "fp32",
                        threads=threads,
                        max_batch_size=int(cfg.get("max_batch_size") or 32),
                        max_streams=int(cfg.get("max_streams") or 16),
                    )
                    if cfg.get("backbone_repo"):
                        kw["backbone_repo"] = str(cfg["backbone_repo"]).strip()
                    if cfg.get("onnx_dir"):
                        kw["onnx_dir"] = str(cfg["onnx_dir"]).strip()
                else:
                    kw.update(threads=threads,
                              steps=int(cfg.get("steps") or 16),
                              cfg=float(cfg.get("cfg") if cfg.get("cfg") is not None else 3.0))
                    if cfg.get("onnx_dir"):
                        kw["onnx_dir"] = str(cfg["onnx_dir"]).strip()

                with self.infer_lock:
                    old, self.tts = self.tts, None
                    if old is not None:
                        try:
                            old.close()
                        except Exception:
                            pass
                    log.info("⏳ Loading %s with %s", mode, kw)
                    t = time.time()
                    if mode == "kokoro":
                        from .kokoro import KokoroTTS
                        tts = KokoroTTS(home=app_home() / "models" / "kokoro", note=self._set_note, **kw)
                    else:
                        from vieneu import Vieneu
                        tts = Vieneu(mode=mode, **kw)
                    self.load_seconds = round(time.time() - t, 1)
                    self.mode = mode
                    self.config = {"mode": mode, **{k: v for k, v in kw.items()}}
                    self.tts = tts
                    n = self.load_user_voices()
                    log.info("✅ %s ready in %.1fs (%d saved voices)", mode, self.load_seconds, n)
            except Exception as e:  # noqa: BLE001
                log.exception("Model load failed")
                self.error = f"{type(e).__name__}: {e}"
            finally:
                self.loading = False
                self.note = None

    def _set_note(self, text: Optional[str]) -> None:
        self.note = text

    @property
    def can_clone(self) -> bool:
        return bool(MODES.get(self.mode or "", {}).get("clone"))

    def require_clone(self):
        tts = self.require()
        if not self.can_clone:
            raise ValueError("Mô hình đang dùng không nhân bản được giọng. Hãy chọn VieNeu-TTS (tiếng Việt) trong mục Mô hình.")
        return tts

    def require(self):
        if self.tts is None:
            if self.loading:
                raise RuntimeError("Mô hình đang được tải, vui lòng đợi.")
            raise RuntimeError("Chưa tải mô hình.")
        return self.tts

    # ── voices ────────────────────────────────────────────────────────────
    @property
    def kind(self) -> str:
        return "nano" if self.mode == "v3nano" else "turbo"

    def user_voices_path(self) -> Path:
        return app_home() / f"user_voices_v3_{self.kind}.json"

    def voices(self) -> list[dict]:
        tts = self.require()
        presets: dict = tts._preset_voices
        out = []
        for name, v in presets.items():
            desc = v.get("description", "") or ""
            parts = [p.strip() for p in desc.split("·")]
            region = parts[1] if len(parts) >= 3 and not v.get("language") else ""
            out.append({
                "id": name,
                "description": desc,
                "gender": v.get("gender", "") or "",
                "region": region,
                "language": v.get("language") or "vi",
                "language_label": v.get("language_label") or "Tiếng Việt",
                "featured": v.get("featured"),
                "aliases": list(v.get("aliases") or []),
                "user": bool(v.get(USER_MARK)),
            })
        out.sort(key=lambda x: (x["user"], x["featured"] is None, x["featured"] or 0))
        return out

    def load_user_voices(self) -> int:
        tts = self.tts
        path = self.user_voices_path()
        if tts is None or not self.can_clone or not path.is_file():
            return 0
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return 0
        n = 0
        for name, v in (data.get("presets") or {}).items():
            if not isinstance(v, dict) or v.get("speaker_emb") is None:
                continue
            entry: dict = {
                "description": v.get("description", "") or DEFAULT_DESC,
                "gender": v.get("gender", ""),
                "speaker_emb": np.asarray(v["speaker_emb"], dtype=np.float32),
                "podcast": True,
                USER_MARK: True,
            }
            if self.kind == "nano":
                if v.get("style") is None:
                    continue
                style = np.asarray(v["style"], dtype=np.float32)
                entry["style"] = style
                entry["codes"] = style
            else:
                codes = v.get("codes")
                entry["codes"] = None if codes is None else np.asarray(codes, dtype=np.int64)
                entry["style"] = v.get("style_name") or getattr(tts, "default_style", "tu_nhien")
            tts._preset_voices[name] = entry
            n += 1
        return n

    def _write_user_voices(self) -> None:
        tts = self.tts
        path = self.user_voices_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        presets = {}
        for name, v in tts._preset_voices.items():
            if not v.get(USER_MARK):
                continue
            item: dict = {"description": v.get("description", ""), "gender": v.get("gender", "")}
            item["speaker_emb"] = [round(float(x), 6) for x in np.asarray(v["speaker_emb"], dtype=np.float32).reshape(-1)]
            if self.kind == "nano":
                item["style"] = np.asarray(v["style"], dtype=np.float32).round(5).tolist()
            else:
                codes = v.get("codes")
                item["codes"] = None if codes is None else np.asarray(codes, dtype=np.int64).tolist()
                if isinstance(v.get("style"), str):
                    item["style_name"] = v["style"]
            presets[name] = item
        data = {"meta": {"note": f"VieNeu v3 {self.kind} voices saved from V Studio"}, "presets": presets}
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)

    def save_voice(self, name: str, ref_path: str, *, denoise: bool, description: str, gender: str) -> str:
        tts = self.require_clone()
        name = (name or "").strip()
        if not name:
            raise ValueError("Hãy đặt tên cho giọng.")
        if len(name) > 40:
            raise ValueError("Tên giọng tối đa 40 ký tự.")
        existing = tts._preset_voices.get(name)
        resolve = getattr(tts, "resolve_voice_name", None)
        is_alias = resolve is not None and resolve(name) not in (None, name)
        if (existing is not None and not existing.get(USER_MARK)) or is_alias:
            raise ValueError(f"'{name}' là giọng có sẵn, hãy chọn tên khác.")
        with self.infer_lock:
            tts.add_voice(name, ref_path, denoise=denoise,
                          description=(description or "").strip() or DEFAULT_DESC, gender=gender or "")
            entry = tts._preset_voices[name]
            entry[USER_MARK] = True
            entry["podcast"] = True
            self._write_user_voices()
        return name

    def delete_voice(self, name: str) -> None:
        tts = self.require()
        entry = tts._preset_voices.get(name)
        if entry is None or not entry.get(USER_MARK):
            raise ValueError("Chỉ xoá được giọng do bạn lưu.")
        with self.infer_lock:
            tts.remove_voice(name)
            self._write_user_voices()

    # ── denoise ───────────────────────────────────────────────────────────
    def denoise(self, ref_path: str) -> tuple[np.ndarray, int]:
        tts = self.require_clone()
        with self.infer_lock:
            if hasattr(tts, "denoise"):
                return tts.denoise(ref_path)
            getter = getattr(tts.engine, "_get_denoiser", None)
            den = getter() if getter else getattr(tts.engine, "denoiser", None)
            if den is None:
                raise RuntimeError("Bộ khử nhiễu không khả dụng với mô hình này.")
            import soundfile as sf
            wav, sr = sf.read(ref_path)
            if getattr(wav, "ndim", 1) > 1:
                wav = wav.mean(axis=1)
            return den.denoise(np.asarray(wav, dtype=np.float32), sr), 44_100


MANAGER = ModelManager()
