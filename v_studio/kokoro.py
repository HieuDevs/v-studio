"""Kokoro-82M (Apache 2.0) through ``kokoro-onnx``: the multilingual engine of
V Studio — English (US / UK), Spanish, French, Italian, Brazilian Portuguese,
Hindi, Japanese and Mandarin, 54 preset voices, 24 kHz, CPU via ONNX Runtime.

``KokoroTTS`` mirrors the part of the ``vieneu`` SDK that engine.py and
server.py use (``_preset_voices``, ``_default_voice``, ``resolve_voice_name``,
``infer``, ``infer_stream``, ``sample_rate``, ``backend``, ``close``), so the
rest of the app does not care which engine is loaded. Kokoro has no voice
cloning; the language of a generation is the language of its voice.

Model files are downloaded once into ``~/.vstudio/models/kokoro/``.
"""
from __future__ import annotations

import logging
import os
import re
import urllib.request
from pathlib import Path
from typing import Callable, Iterator, Optional

import numpy as np

log = logging.getLogger("vieneu.studio")

BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILES = {"fp32": "kokoro-v1.0.onnx", "int8": "kokoro-v1.0.int8.onnx"}
VOICES_FILE = "voices-v1.0.bin"
SAMPLE_RATE = 24_000

# voice-id prefix letter → (espeak language code, display label, short tag)
LANGS = {
    "a": ("en-us", "Tiếng Anh (Mỹ)", "US"),
    "b": ("en-gb", "Tiếng Anh (Anh)", "UK"),
    "e": ("es", "Tiếng Tây Ban Nha", "ES"),
    "f": ("fr-fr", "Tiếng Pháp", "FR"),
    "i": ("it", "Tiếng Ý", "IT"),
    "p": ("pt-br", "Tiếng Bồ Đào Nha (Brazil)", "BR"),
    "h": ("hi", "Tiếng Hindi", "HI"),
    "j": ("ja", "Tiếng Nhật", "JA"),
    "z": ("cmn", "Tiếng Trung (Quan thoại)", "ZH"),
}
# The voices with the best quality grades of each language, in display order.
FEATURED = ["af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george", "ef_dora", "ff_siwis",
            "if_sara", "pf_dora", "hf_alpha", "jf_alpha", "zf_xiaoxiao"]
DEFAULT_VOICE = "af_heart"

_TAGS = re.compile(r"\[[^\[\]\n]{1,24}\]")
_SENT = re.compile(r"(?<=[.!?…;:。！？；])\s+|(?<=[。！？])|\n+")


def _download(url: str, dest: Path, label: str, note: Optional[Callable[[Optional[str]], None]]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log.info("⬇️  %s → %s", url, dest)
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:   # noqa: S310 — fixed https URL
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)
            done += len(buf)
            if note:
                pct = f" {done * 100 // total}%" if total else ""
                note(f"Đang tải {label}{pct} ({done / 1e6:.0f} MB)")
    if total and tmp.stat().st_size != total:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Tải {dest.name} không trọn vẹn, hãy thử lại.")
    os.replace(tmp, dest)


def downloaded(home: Path) -> dict:
    """Which precisions are already on disk: {"fp32": bool, "int8": bool}."""
    has_voices = (home / VOICES_FILE).is_file()
    return {p: has_voices and (home / f).is_file() for p, f in MODEL_FILES.items()}


def ensure_files(home: Path, precision: str, note=None) -> tuple[Path, Path]:
    model = home / MODEL_FILES[precision]
    voices = home / VOICES_FILE
    if not voices.is_file():
        _download(BASE_URL + VOICES_FILE, voices, "giọng Kokoro", note)
    if not model.is_file():
        _download(BASE_URL + MODEL_FILES[precision], model, "mô hình Kokoro", note)
    return model, voices


_ja_g2p = None


def _ja_kana(text: str) -> str:
    """espeak-ng cannot read kanji ("Chinese letter"), so Japanese text is turned
    into katakana first with pyopenjtalk (optional extra: ``pip install "v-studio[ja]"``)."""
    global _ja_g2p
    if _ja_g2p is None:
        try:
            import pyopenjtalk
            _ja_g2p = lambda s: pyopenjtalk.g2p(s, kana=True)   # noqa: E731
        except Exception:  # noqa: BLE001
            log.warning("pyopenjtalk is not installed: kanji in Japanese text will not be read correctly")
            _ja_g2p = False
    if not _ja_g2p or not re.search(r"[一-鿿]", text):
        return text
    try:
        return _ja_g2p(text) or text
    except Exception:  # noqa: BLE001
        return text


def _pretty(vid: str) -> str:
    name = vid.split("_", 1)[-1]
    return name[:1].upper() + name[1:]


def split_text(text: str, max_chars: int) -> list[str]:
    """Sentences, merged up to ``max_chars``; over-long sentences are cut at commas / spaces."""
    out: list[str] = []
    for sent in (s.strip() for s in _SENT.split(text)):
        if not sent:
            continue
        while len(sent) > max_chars:
            cut = max(sent.rfind(c, 0, max_chars) for c in (",", "，", "、", " "))
            cut = cut + 1 if cut > max_chars // 3 else max_chars
            out.append(sent[:cut].strip())
            sent = sent[cut:].strip()
        if not sent:
            continue
        # Merge short sentences so each model call has enough context; keep the
        # first chunk alone so streaming starts quickly.
        if len(out) > 1 and len(out[-1]) + 1 + len(sent) <= max_chars:
            out[-1] = f"{out[-1]} {sent}"
        else:
            out.append(sent)
    return out


class KokoroTTS:
    backend = "onnx"
    sample_rate = SAMPLE_RATE
    watermarker = None

    def __init__(self, *, home: Path, precision: str = "fp32", threads: int = 0, model_dir: str = "",
                 note: Optional[Callable[[Optional[str]], None]] = None) -> None:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        if model_dir:
            d = Path(model_dir).expanduser()
            model, voices = d / MODEL_FILES[precision], d / VOICES_FILE
            if not model.is_file() or not voices.is_file():
                raise FileNotFoundError(f"Không thấy {model.name} và {VOICES_FILE} trong {d}")
        else:
            model, voices = ensure_files(home, precision, note)
        if note:
            note("Đang nạp Kokoro…")
        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = int(threads)
        sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
        self.k = Kokoro.from_session(sess, str(voices))
        self._preset_voices: dict[str, dict] = {}
        self._ids: dict[str, str] = {}   # display name / raw id → display name
        self._raw: dict[str, str] = {}   # display name → kokoro voice id
        self._build_voices(self.k.get_voices())
        self._default_voice = self._ids.get(DEFAULT_VOICE) or next(iter(self._preset_voices))

    def _build_voices(self, raw_ids: list[str]) -> None:
        raw_ids = [v for v in raw_ids if len(v) > 3 and v[0] in LANGS and v[2] == "_"]
        names = [_pretty(v) for v in raw_ids]
        order = {v: i for i, v in enumerate(FEATURED)}
        for vid, name in zip(raw_ids, names):
            code, label, tag = LANGS[vid[0]]
            if names.count(name) > 1:
                name = f"{name} ({tag})"
            gender = "female" if vid[1] == "f" else "male"
            self._preset_voices[name] = {
                "description": f"{'Nữ' if gender == 'female' else 'Nam'} · {label}",
                "gender": gender, "language": code, "language_label": label,
                "featured": order[vid] + 1 if vid in order else None,
                "aliases": [vid], "_kokoro": vid,
            }
            self._ids[name] = self._ids[vid] = self._ids[name.lower()] = name
            self._raw[name] = vid
        # featured first, then by language in LANGS order, then by name
        lang_order = {k: i for i, k in enumerate(LANGS)}
        self._preset_voices = dict(sorted(self._preset_voices.items(), key=lambda kv: (
            kv[1]["featured"] is None, kv[1]["featured"] or 0, lang_order[kv[1]["_kokoro"][0]], kv[0])))

    def resolve_voice_name(self, name: str) -> Optional[str]:
        return self._ids.get(name) or self._ids.get(str(name).lower())

    def _voice(self, voice: Optional[str]) -> tuple[str, str]:
        name = self.resolve_voice_name(voice or self._default_voice) or self._default_voice
        return self._raw[name], self._preset_voices[name]["language"]

    def infer_stream(self, text: str, *, voice: Optional[str] = None, speed: float = 1.0, max_chars: int = 300,
                     **_ignored) -> Iterator[np.ndarray]:
        vid, lang = self._voice(voice)
        text = _TAGS.sub(" ", text)   # VieNeu emotion tags ([cười] …) would be read out literally
        for chunk in split_text(text, max(40, int(max_chars))):
            if lang == "ja":
                chunk = _ja_kana(chunk)
            audio, _sr = self.k.create(chunk, voice=vid, speed=float(speed), lang=lang)
            if audio is not None and len(audio):
                yield np.asarray(audio, dtype=np.float32)
                yield np.zeros(int(SAMPLE_RATE * 0.12), dtype=np.float32)   # breath between sentences

    def infer(self, text: str, **kw) -> np.ndarray:
        parts = list(self.infer_stream(text, **kw))
        if parts:
            parts.pop()   # no trailing pause
        return np.concatenate(parts) if parts else np.zeros(0, np.float32)

    def close(self) -> None:
        self.k = None
