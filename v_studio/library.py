"""Library ("Thư viện"): every generated clip kept across launches, under
``~/.vieneu/studio/library/``:

    index.json      [{id, title, kind, voice, text, duration, sr, created, bytes}]  newest first
    <id>.flac       the audio

    GET    /api/library                 ?q=&kind=&offset=&limit= → {items, total, duration, kinds, dir, bytes}
    POST   /api/library                 multipart(file=WAV, meta=JSON{title, kind, voice, text}) → item
    GET    /api/library/{id}/audio      raw PCM s16le mono (X-Sample-Rate)
    PATCH  /api/library/{id}            {title} → item
    DELETE /api/library/{id}
    DELETE /api/library                 everything
"""
from __future__ import annotations

import io
import json
import os
import re
import tempfile
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

from .engine import voices_home

router = APIRouter(prefix="/api/library")

_ID = re.compile(r"^[a-f0-9]{12}$")
_LOCK = threading.RLock()
MAX_AUDIO = 500 * 1024 * 1024


def library_dir() -> Path:
    return voices_home() / "studio" / "library"


def _index_path() -> Path:
    return library_dir() / "index.json"


def _read_index() -> list[dict]:
    p = _index_path()
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text("utf-8"))
        return [x for x in data.get("items", []) if isinstance(x, dict) and _ID.match(str(x.get("id", "")))]
    except (OSError, ValueError, AttributeError):
        return []


def _write_index(items: list[dict]) -> None:
    d = library_dir()
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(d), prefix=".index-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "items": items}, f, ensure_ascii=False)
        os.replace(tmp, _index_path())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _str(v: Any, limit: int) -> str:
    return (v if isinstance(v, str) else "").strip()[:limit]


def _fold(s: str) -> str:
    """Lower-case, accent-free form for search ("tieng viet" finds "Tiếng Việt")."""
    s = unicodedata.normalize("NFD", s.lower()).replace("đ", "d")
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def _check(item_id: str) -> str:
    if not _ID.match(item_id or ""):
        raise HTTPException(400, "Mã không hợp lệ.")
    return item_id


@router.get("")
def list_items(q: str = "", kind: str = "", offset: int = 0, limit: int = 50):
    with _LOCK:
        items = _read_index()
    kinds = sorted({i.get("kind", "") for i in items if i.get("kind")})
    sel = items
    if kind:
        sel = [i for i in sel if i.get("kind") == kind]
    if q.strip():
        terms = _fold(q).split()
        sel = [i for i in sel if all(t in _fold(" ".join(str(i.get(k, "")) for k in ("title", "voice", "text", "kind")))
                                     for t in terms)]
    offset, limit = max(0, int(offset)), min(max(1, int(limit)), 500)
    return {"items": sel[offset:offset + limit], "total": len(sel),
            "duration": round(sum(float(i.get("duration") or 0) for i in sel), 3),
            "count_all": len(items), "kinds": kinds, "dir": str(library_dir()),
            "bytes": sum(int(i.get("bytes") or 0) for i in items)}


@router.post("")
def add_item(file: UploadFile = File(...), meta: str = Form("{}")):
    import soundfile as sf
    data = file.file.read(MAX_AUDIO + 1)
    if len(data) > MAX_AUDIO:
        raise HTTPException(413, "Âm thanh quá lớn.")
    try:
        wav, sr = sf.read(io.BytesIO(data), dtype="float32")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Không đọc được âm thanh: {e}")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if not wav.size:
        raise HTTPException(400, "Âm thanh rỗng.")
    try:
        m = json.loads(meta or "{}")
    except ValueError:
        m = {}
    m = m if isinstance(m, dict) else {}
    item_id = uuid.uuid4().hex[:12]
    buf = io.BytesIO()
    sf.write(buf, np.clip(wav, -1.0, 1.0), int(sr), format="FLAC", subtype="PCM_16")
    blob = buf.getvalue()
    item = {"id": item_id, "title": _str(m.get("title"), 200) or "Bản ghi", "kind": _str(m.get("kind"), 40),
            "voice": _str(m.get("voice"), 200), "text": _str(m.get("text"), 4000),
            "duration": round(len(wav) / float(sr), 3), "sr": int(sr), "created": time.time(), "bytes": len(blob)}
    with _LOCK:
        d = library_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{item_id}.flac").write_bytes(blob)
        items = _read_index()
        items.insert(0, item)
        _write_index(items)
    return item


@router.get("/{item_id}/audio")
def get_audio(item_id: str):
    import soundfile as sf
    p = library_dir() / f"{_check(item_id)}.flac"
    if not p.is_file():
        raise HTTPException(404, "Không tìm thấy file âm thanh.")
    wav, sr = sf.read(str(p), dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    pcm = (wav * 32767).clip(-32768, 32767).astype("<i2").tobytes()
    return Response(pcm, media_type="audio/pcm", headers={"X-Sample-Rate": str(int(sr)), "Cache-Control": "no-store"})


@router.patch("/{item_id}")
async def rename_item(item_id: str, request: Request):
    _check(item_id)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Dữ liệu phải là JSON.")
    title = _str(body.get("title") if isinstance(body, dict) else "", 200)
    if not title:
        raise HTTPException(400, "Tên không được để trống.")
    with _LOCK:
        items = _read_index()
        it = next((i for i in items if i["id"] == item_id), None)
        if it is None:
            raise HTTPException(404, "Không tìm thấy bản ghi.")
        it["title"] = title
        _write_index(items)
        return it


@router.delete("/{item_id}")
def delete_item(item_id: str):
    _check(item_id)
    with _LOCK:
        items = _read_index()
        rest = [i for i in items if i["id"] != item_id]
        if len(rest) == len(items):
            raise HTTPException(404, "Không tìm thấy bản ghi.")
        _write_index(rest)
        try:
            (library_dir() / f"{item_id}.flac").unlink()
        except OSError:
            pass
    return {"ok": True}


@router.delete("")
def clear_items():
    with _LOCK:
        d = library_dir()
        if d.is_dir():
            for f in d.glob("*.flac"):
                if _ID.match(f.stem):
                    try:
                        f.unlink()
                    except OSError:
                        pass
        _write_index([])
    return {"ok": True}


