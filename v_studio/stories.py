"""Story studio ("Phòng thu Truyện"): multi-voice stories built segment by
segment, persisted under ``~/.vstudio/stories/<id>/``:

    project.json        name, pause, characters, segments (+ audio metadata)
    seg-<segment>.flac  the generated audio of one segment

The page keeps the editable state (characters, segment order/text) and saves the
whole project with PUT; audio metadata (``audio``, ``duration``, ``sr``, ``gen``)
is owned by the server and only changes when a segment's audio is uploaded.

    GET    /api/stories                              list (summaries, newest first)
    POST   /api/stories                              {name?, pause?, characters?, segments?} → project
    GET    /api/stories/{id}                         project
    PUT    /api/stories/{id}                         project (editable fields) → project
    DELETE /api/stories/{id}                         delete project + audio
    PUT    /api/stories/{id}/segments/{seg}/audio    multipart(file=WAV, gen=JSON) → segment
    GET    /api/stories/{id}/segments/{seg}/audio    FLAC
    POST   /api/stories/{id}/export                  form(sample_rate) → raw PCM s16le mono
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from .engine import app_home

router = APIRouter(prefix="/api/stories")

_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_LOCK = threading.RLock()
MAX_AUDIO = 300 * 1024 * 1024
MAX_SEGMENTS = 5000
MAX_TEXT = 20_000
OUT_RATES = (48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 8_000)


def stories_dir() -> Path:
    return app_home() / "stories"


def _new_id(n: int = 12) -> str:
    return uuid.uuid4().hex[:n]


def _check_id(sid: str) -> str:
    if not sid or not _ID.match(sid):
        raise HTTPException(400, "Mã không hợp lệ.")
    return sid


def _pdir(sid: str) -> Path:
    return stories_dir() / _check_id(sid)


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load(sid: str) -> dict:
    p = _pdir(sid) / "project.json"
    if not p.is_file():
        raise HTTPException(404, "Không tìm thấy truyện.")
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise HTTPException(500, f"Không đọc được truyện: {e}")


def _save(proj: dict) -> dict:
    proj["updated"] = time.time()
    _atomic_write(_pdir(proj["id"]) / "project.json",
                  json.dumps(proj, ensure_ascii=False, indent=1).encode("utf-8"))
    return proj


def _str(v: Any, limit: int) -> str:
    return (v if isinstance(v, str) else "").strip()[:limit]


def _num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if not np.isfinite(x) else min(max(x, lo), hi)


def _clean(body: dict, old: Optional[dict] = None) -> dict:
    """Validated editable fields from the page; audio metadata comes from `old`."""
    old = old or {}
    chars, seen = [], set()
    for c in (body.get("characters") or [])[:200]:
        if not isinstance(c, dict):
            continue
        cid = c.get("id") if isinstance(c.get("id"), str) and _ID.match(c.get("id")) else _new_id(8)
        if cid in seen:
            cid = _new_id(8)
        seen.add(cid)
        color = c.get("color") if isinstance(c.get("color"), str) and _COLOR.match(c.get("color")) else "#0d8a68"
        chars.append({"id": cid, "name": _str(c.get("name"), 60) or "Nhân vật",
                      "voice": _str(c.get("voice"), 200), "color": color})
    if not chars:
        chars = [{"id": _new_id(8), "name": "Người kể", "voice": "", "color": "#0d8a68"}]
    char_ids = {c["id"] for c in chars}

    old_segs = {s.get("id"): s for s in old.get("segments", []) if isinstance(s, dict)}
    segs, seen = [], set()
    for s in (body.get("segments") or [])[:MAX_SEGMENTS]:
        if not isinstance(s, dict):
            continue
        sid = s.get("id") if isinstance(s.get("id"), str) and _ID.match(s.get("id")) else _new_id(8)
        if sid in seen:
            sid = _new_id(8)
        seen.add(sid)
        ch = s.get("char") if s.get("char") in char_ids else chars[0]["id"]
        seg = {"id": sid, "char": ch, "text": (s.get("text") if isinstance(s.get("text"), str) else "")[:MAX_TEXT],
               "error": _str(s.get("error"), 500)}
        prev = old_segs.get(sid)
        if prev and prev.get("audio"):
            for k in ("audio", "duration", "sr", "gen"):
                if k in prev:
                    seg[k] = prev[k]
        segs.append(seg)

    return {"name": _str(body.get("name"), 120) or old.get("name") or "Truyện mới",
            "pause": round(_num(body.get("pause", old.get("pause", 0.4)), 0.0, 5.0, 0.4), 2),
            "characters": chars, "segments": segs}


def _is_fresh(seg: dict, chars: dict) -> bool:
    g = seg.get("gen") or {}
    c = chars.get(seg.get("char")) or {}
    return bool(seg.get("audio")) and g.get("text") == seg.get("text") and g.get("char") == seg.get("char") \
        and g.get("voice") == c.get("voice")


def _summary(p: dict) -> dict:
    chars = {c["id"]: c for c in p.get("characters", [])}
    segs = p.get("segments", [])
    spoken = [s for s in segs if (s.get("text") or "").strip()]
    return {"id": p["id"], "name": p.get("name", ""), "created": p.get("created"), "updated": p.get("updated"),
            "segments": len(segs), "spoken": len(spoken), "characters": len(chars),
            "done": sum(1 for s in spoken if _is_fresh(s, chars)),
            "duration": round(sum(float(s.get("duration") or 0) for s in segs if s.get("audio")), 3)}


def _prune_audio(pdir: Path, proj: dict) -> None:
    keep = {s.get("audio") for s in proj.get("segments", []) if s.get("audio")}
    for f in pdir.glob("seg-*.flac"):
        if f.name not in keep:
            try:
                f.unlink()
            except OSError:
                pass


# ── projects ─────────────────────────────────────────────────────────────────

@router.get("")
def list_stories():
    out = []
    root = stories_dir()
    if root.is_dir():
        for d in root.iterdir():
            pj = d / "project.json"
            if d.is_dir() and _ID.match(d.name) and pj.is_file():
                try:
                    p = json.loads(pj.read_text("utf-8"))
                    p["id"] = d.name
                    out.append(_summary(p))
                except (OSError, ValueError, KeyError, TypeError):
                    continue
    out.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return {"stories": out, "dir": str(root)}


@router.post("")
async def create_story(request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    with _LOCK:
        sid = _new_id()
        while (stories_dir() / sid).exists():
            sid = _new_id()
        proj = {"id": sid, "version": 1, "created": time.time(), **_clean(body)}
        for s in proj["segments"]:
            for k in ("audio", "duration", "sr", "gen"):
                s.pop(k, None)
        return _save(proj)


@router.get("/{sid}")
def get_story(sid: str):
    with _LOCK:
        p = _load(sid)
        p["id"] = sid
        return p


@router.put("/{sid}")
async def put_story(sid: str, request: Request):
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Dữ liệu phải là JSON.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Dữ liệu phải là JSON object.")
    with _LOCK:
        old = _load(sid)
        proj = {**old, "id": sid, **_clean(body, old)}
        _save(proj)
        _prune_audio(_pdir(sid), proj)
        return proj


@router.delete("/{sid}")
def delete_story(sid: str):
    with _LOCK:
        d = _pdir(sid)
        if not (d / "project.json").is_file():
            raise HTTPException(404, "Không tìm thấy truyện.")
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


# ── segment audio ────────────────────────────────────────────────────────────

@router.put("/{sid}/segments/{seg}/audio")
def put_segment_audio(sid: str, seg: str, file: UploadFile = File(...), gen: str = Form("{}")):
    import soundfile as sf
    _check_id(seg)
    data = file.file.read(MAX_AUDIO + 1)
    if len(data) > MAX_AUDIO:
        raise HTTPException(413, "Âm thanh quá lớn.")
    try:
        wav, sr = sf.read(io.BytesIO(data), dtype="float32")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Không đọc được âm thanh: {e}")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    try:
        g = json.loads(gen or "{}")
    except ValueError:
        g = {}
    g = g if isinstance(g, dict) else {}
    meta = {"text": g.get("text") if isinstance(g.get("text"), str) else "",
            "char": _str(g.get("char"), 40), "voice": _str(g.get("voice"), 200), "at": time.time()}
    with _LOCK:
        proj = _load(sid)
        proj["id"] = sid
        target = next((s for s in proj.get("segments", []) if s.get("id") == seg), None)
        if target is None:
            raise HTTPException(404, "Không tìm thấy đoạn này (đã bị xoá?).")
        name = f"seg-{seg}.flac"
        buf = io.BytesIO()
        sf.write(buf, np.clip(wav, -1.0, 1.0), int(sr), format="FLAC", subtype="PCM_16")
        _atomic_write(_pdir(sid) / name, buf.getvalue())
        target.update({"audio": name, "duration": round(len(wav) / float(sr), 3), "sr": int(sr),
                       "gen": meta, "error": ""})
        _save(proj)
        return target


@router.get("/{sid}/segments/{seg}/audio")
def get_segment_audio(sid: str, seg: str):
    _check_id(seg)
    p = _pdir(sid) / f"seg-{seg}.flac"
    if not p.is_file():
        raise HTTPException(404, "Đoạn này chưa có âm thanh.")
    return FileResponse(str(p), media_type="audio/flac", headers={"Cache-Control": "no-store"})


# ── export ───────────────────────────────────────────────────────────────────

@router.post("/{sid}/export")
def export_story(sid: str, sample_rate: int = Form(0)):
    import soundfile as sf
    with _LOCK:
        proj = _load(sid)
    segs = [s for s in proj.get("segments", []) if (s.get("text") or "").strip()]
    pdir = _pdir(sid)
    clips, missing = [], 0
    for s in segs:
        f = pdir / f"seg-{s['id']}.flac"
        if not s.get("audio") or not f.is_file():
            missing += 1
            continue
        wav, sr = sf.read(str(f), dtype="float32")
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        clips.append((wav, int(sr)))
    if not clips:
        raise HTTPException(400, "Chưa có đoạn nào được tạo giọng.")
    sample_rate = int(sample_rate or 0)
    if sample_rate and sample_rate not in OUT_RATES:
        raise HTTPException(400, f"sample_rate phải thuộc {OUT_RATES}")
    out_rate = sample_rate or max(sr for _, sr in clips)
    pause = np.zeros(int(round(float(proj.get("pause", 0.4)) * out_rate)), np.float32)
    parts = []
    for i, (wav, sr) in enumerate(clips):
        if sr != out_rate and wav.size:
            import soxr
            wav = soxr.resample(wav, sr, out_rate, quality="HQ").astype(np.float32)
        if i and pause.size:
            parts.append(pause)
        parts.append(wav)
    track = np.concatenate(parts).astype(np.float32)
    peak = float(np.abs(track).max()) if track.size else 0.0
    if peak > 0.98:
        track *= 0.98 / peak
    pcm = (track * 32767).clip(-32768, 32767).astype("<i2").tobytes()
    return Response(pcm, media_type="audio/pcm", headers={
        "X-Sample-Rate": str(out_rate), "X-Segments": str(len(clips)), "X-Missing": str(missing),
        "X-Audio-Seconds": f"{len(track) / out_rate:.3f}", "Cache-Control": "no-store"})
