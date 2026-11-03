"""Microphone recording for the voice-cloning tab, done in Python (sounddevice).

The native window (WKWebView / WebView2 / WebKitGTK through pywebview) does not
reliably grant ``getUserMedia``, so the page asks the app to record instead.
On macOS the first recording triggers the system microphone prompt for the app
that launched V Studio (e.g. Terminal).
"""
from __future__ import annotations

import io
import threading
import time
from typing import Optional

import numpy as np

MAX_SECONDS = 30


class Recorder:
    def __init__(self) -> None:
        self._stream = None
        self._chunks: list[np.ndarray] = []
        self._lock = threading.Lock()
        self._t0 = 0.0
        self._level = 0.0
        self.sr = 0

    @property
    def active(self) -> bool:
        return self._stream is not None

    def start(self) -> dict:
        try:
            import sounddevice as sd
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Thiếu thư viện ghi âm (pip install sounddevice): {e}"}
        if self._stream is not None:
            return {"ok": True}
        try:
            dev = sd.query_devices(kind="input")
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Không tìm thấy micro: {e}"}
        self.sr = int(dev.get("default_samplerate") or 48000)
        self._chunks = []
        self._level = 0.0

        def cb(indata, frames, t, status):  # noqa: ARG001
            x = indata[:, 0].copy()
            with self._lock:
                self._chunks.append(x)
            self._level = float(np.sqrt(np.mean(x * x))) if len(x) else 0.0

        try:
            self._stream = sd.InputStream(samplerate=self.sr, channels=1, dtype="float32", callback=cb)
            self._stream.start()
        except Exception as e:  # noqa: BLE001
            self._stream = None
            return {"ok": False, "error": f"Không mở được micro (kiểm tra quyền Microphone trong Cài đặt hệ thống): {e}"}
        self._t0 = time.time()
        return {"ok": True, "device": dev.get("name"), "sample_rate": self.sr}

    def poll(self) -> dict:
        if self._stream is None:
            return {"active": False}
        el = time.time() - self._t0
        if el >= MAX_SECONDS:
            return {"active": True, "seconds": el, "level": self._level, "limit": True}
        return {"active": True, "seconds": el, "level": self._level}

    def stop(self) -> Optional[bytes]:
        """Stop and return the take as a 16-bit mono WAV (None if nothing was captured)."""
        st, self._stream = self._stream, None
        if st is not None:
            try:
                st.stop()
                st.close()
            except Exception:  # noqa: BLE001
                pass
        with self._lock:
            data = np.concatenate(self._chunks) if self._chunks else np.zeros(0, np.float32)
            self._chunks = []
        if not data.size:
            return None
        data = data[: MAX_SECONDS * self.sr]
        import soundfile as sf
        buf = io.BytesIO()
        sf.write(buf, data, self.sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()


RECORDER = Recorder()
