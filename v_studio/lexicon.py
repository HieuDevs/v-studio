"""Pronunciation dictionary ("Từ điển phát âm"): user rules that rewrite the
text before it reaches the engine — proper names, jargon, abbreviations.

Rules live in ``~/.vieneu/studio/lexicon.json`` and are applied by /api/tts, so
every mode (read, podcast, story, SRT) uses them.

    GET  /api/lexicon            {enabled, rules, path, max}
    PUT  /api/lexicon            {enabled, rules} → same as GET
    POST /api/lexicon/preview    {text, rules?, enabled?} → {text, spoken}

A rule is ``{src, dst, word, case, on}``: ``word`` = whole word only, ``case`` =
case-sensitive, ``on`` = active. Matching is a single left-to-right pass where
longer sources win ("km/h" before "km"), and replaced text is never re-scanned,
so rules cannot chain or loop.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from .engine import voices_home

router = APIRouter(prefix="/api/lexicon")

MAX_RULES = 2000
MAX_LEN = 200


def lexicon_path() -> Path:
    return voices_home() / "studio" / "lexicon.json"


def clean_rules(rules: Any) -> list[dict]:
    out: list[dict] = []
    if not isinstance(rules, list):
        return out
    for r in rules[:MAX_RULES]:
        if not isinstance(r, dict):
            continue
        src = r.get("src") if isinstance(r.get("src"), str) else ""
        dst = r.get("dst") if isinstance(r.get("dst"), str) else ""
        src, dst = src.strip()[:MAX_LEN], dst.strip()[:MAX_LEN]
        if not src:
            continue
        out.append({"src": src, "dst": dst, "word": bool(r.get("word", True)),
                    "case": bool(r.get("case", False)), "on": bool(r.get("on", True))})
    return out


def compile_rules(rules: list[dict]) -> Optional[tuple[re.Pattern, list[str]]]:
    active = [r for r in rules if r.get("on", True) and r.get("src")]
    if not active:
        return None
    # Longest source first: Python's alternation is ordered, so this makes
    # "km/h" win over "km" at the same position. sorted() is stable, so equal
    # lengths keep the user's order.
    active.sort(key=lambda r: len(r["src"]), reverse=True)
    parts, repl = [], []
    for i, r in enumerate(active):
        src = r["src"]
        body = re.escape(src)
        if not r.get("case"):
            body = f"(?i:{body})"
        if r.get("word", True):
            # Only guard the ends that are word characters: "C++" as a whole
            # word must still match before a space or punctuation.
            if re.match(r"\w", src[0]):
                body = r"(?<!\w)" + body
            if re.match(r"\w", src[-1]):
                body = body + r"(?!\w)"
        parts.append(f"(?P<r{i}>{body})")
        repl.append(r["dst"])
    return re.compile("|".join(parts)), repl


def apply_rules(text: str, compiled: Optional[tuple[re.Pattern, list[str]]]) -> str:
    if not compiled or not text:
        return text
    pat, repl = compiled
    return pat.sub(lambda m: repl[int(m.lastgroup[1:])], text)


class Lexicon:
    """The saved dictionary, recompiled only when the file changes."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stamp: Optional[tuple[float, int]] = None
        self._data: dict = {"enabled": True, "rules": []}
        self._compiled: Optional[tuple[re.Pattern, list[str]]] = None

    def _refresh(self) -> None:
        p = lexicon_path()
        try:
            st = p.stat()
            stamp = (st.st_mtime, st.st_size)
        except OSError:
            stamp = None
        if stamp == self._stamp:
            return
        data = {"enabled": True, "rules": []}
        if stamp is not None:
            try:
                raw = json.loads(p.read_text("utf-8"))
                data = {"enabled": bool(raw.get("enabled", True)), "rules": clean_rules(raw.get("rules"))}
            except (OSError, ValueError, AttributeError):
                pass
        self._data, self._stamp = data, stamp
        self._compiled = compile_rules(data["rules"])

    def get(self) -> dict:
        with self._lock:
            self._refresh()
            return {"enabled": self._data["enabled"], "rules": [dict(r) for r in self._data["rules"]]}

    def save(self, enabled: bool, rules: list[dict]) -> dict:
        data = {"version": 1, "enabled": bool(enabled), "rules": clean_rules(rules)}
        p = lexicon_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".lexicon-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=1)
                os.replace(tmp, p)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            self._stamp = None
            self._refresh()
            return {"enabled": self._data["enabled"], "rules": [dict(r) for r in self._data["rules"]]}

    def apply(self, text: str) -> str:
        with self._lock:
            self._refresh()
            if not self._data["enabled"]:
                return text
            compiled = self._compiled
        return apply_rules(text, compiled)


LEXICON = Lexicon()


def _spoken(text: str) -> Optional[str]:
    """What the engine's own normaliser makes of the text (numbers, units,
    formulas → words), when the SDK is importable."""
    try:
        from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps
        chunks, _ = normalize_to_chunks_v3_with_gaps(text, max_chars=512)
        return re.sub(r"</?\w+>", "", " ".join(chunks))   # drop internal markup such as <en>…</en>
    except Exception:  # noqa: BLE001
        return None


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Dữ liệu phải là JSON.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Dữ liệu phải là JSON object.")
    return body


@router.get("")
def get_lexicon():
    return {**LEXICON.get(), "path": str(lexicon_path()), "max": MAX_RULES}


@router.put("")
async def put_lexicon(request: Request):
    body = await _json(request)
    rules = body.get("rules")
    if not isinstance(rules, list):
        raise HTTPException(400, "rules phải là danh sách.")
    if len(rules) > MAX_RULES:
        raise HTTPException(400, f"Tối đa {MAX_RULES} luật.")
    return {**LEXICON.save(body.get("enabled", True), rules), "path": str(lexicon_path()), "max": MAX_RULES}


@router.post("/preview")
async def preview(request: Request):
    body = await _json(request)
    text = body.get("text") if isinstance(body.get("text"), str) else ""
    text = text[:5000]
    if isinstance(body.get("rules"), list):   # unsaved rules from the editor
        out = text if body.get("enabled") is False else apply_rules(text, compile_rules(clean_rules(body["rules"])))
    else:
        out = LEXICON.apply(text)
    return {"text": out, "spoken": _spoken(out) if out.strip() else ""}
