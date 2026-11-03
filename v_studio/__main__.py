"""V Studio — desktop app for VieNeu-TTS.

    python -m v_studio                 # open the app
    python -m v_studio --mode v3nano   # preload v3 Nano instead of v3 Turbo
    python -m v_studio --no-preload    # pick the model in the app first
"""
from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time

# Recent huggingface_hub releases link downloads through a shared blob store
# (blobs/xx/<hash>); onnxruntime then refuses the model's external weight file
# ("External data path escapes model directory"). Plain per-repo blobs work.
os.environ.setdefault("HF_HUB_DISABLE_SHARED_BLOBS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# Use the OS certificate store (corporate proxies with their own CA).
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:  # noqa: BLE001
    pass

# Packaged builds run without a console (sys.stdout / sys.stderr are None on
# Windows), which breaks uvicorn and download progress bars. Send all output to
# a log file instead: ~/.vstudio/v-studio.log
if getattr(sys, "frozen", False) or sys.stdout is None or sys.stderr is None:
    try:
        _log_dir = os.environ.get("VSTUDIO_HOME") or os.path.join(os.path.expanduser("~"), ".vstudio")
        os.makedirs(_log_dir, exist_ok=True)
        _log_file = open(os.path.join(_log_dir, "v-studio.log"), "w", encoding="utf-8", buffering=1)
    except OSError:
        _log_file = open(os.devnull, "w")
    if sys.stdout is None or getattr(sys, "frozen", False):
        sys.stdout = _log_file
    if sys.stderr is None or getattr(sys, "frozen", False):
        sys.stderr = _log_file

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("vieneu.studio")


DEFAULT_PORT = 17863   # fixed so the page origin (and its saved settings) stays the same between launches


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        # Same option uvicorn binds with: connections of the previous run that
        # linger in TIME_WAIT must not make the port look busy.
        if not sys.platform.startswith("win"):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _pick_port(host: str) -> int:
    if _port_free(host, DEFAULT_PORT):
        return DEFAULT_PORT
    log.warning("Port %d is busy — using a random port (saved settings will not carry over)", DEFAULT_PORT)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def _wait_ready(host: str, port: int, timeout: float = 30.0) -> None:
    t = time.time()
    while time.time() - t < timeout:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Server did not start")


class JsApi:
    """Methods callable from the page as ``window.pywebview.api.*``."""

    def __init__(self):
        self._window = None

    def save_stash(self, sid: str, filename: str):
        import shutil
        import webview
        from .server import stash_path
        src = stash_path(sid)
        if src is None:
            return {"ok": False, "error": "Không tìm thấy dữ liệu để lưu."}
        res = self._window.create_file_dialog(getattr(getattr(webview, "FileDialog", None), "SAVE", None) or webview.SAVE_DIALOG, save_filename=filename)
        if not res:
            src.unlink(missing_ok=True)
            return {"ok": False, "cancelled": True}
        dst = res if isinstance(res, str) else res[0]
        shutil.move(str(src), dst)
        return {"ok": True, "path": dst}

    def restart(self):
        from . import updater
        from .engine import MANAGER
        if MANAGER.infer_lock.locked():
            return {"ok": False, "error": "Đang tạo âm thanh, hãy đợi xong rồi khởi động lại."}
        updater.relaunch()
        threading.Timer(0.3, self._window.destroy).start()
        return {"ok": True}

    def quit(self):
        """Close the app (so an installer can replace it)."""
        threading.Timer(0.3, self._window.destroy).start()
        return {"ok": True}

    # microphone (recorder.py) — the web view cannot be relied on for getUserMedia
    def rec_start(self):
        from .recorder import RECORDER
        return RECORDER.start()

    def rec_poll(self):
        from .recorder import RECORDER
        return RECORDER.poll()

    def rec_stop(self):
        import base64
        from .recorder import RECORDER
        wav = RECORDER.stop()
        if not wav:
            return {"ok": False, "error": "Không thu được âm thanh nào từ micro."}
        return {"ok": True, "wav": base64.b64encode(wav).decode("ascii")}


HOST = "127.0.0.1"


def main() -> None:
    ap = argparse.ArgumentParser(prog="v-studio", description="V Studio — VieNeu-TTS desktop app")
    ap.add_argument("--mode", default="v3turbo", choices=["v3turbo", "v3nano"], help="model to preload")
    ap.add_argument("--precision", default="fp32", choices=["fp32", "int8"], help="v3 Turbo CPU precision")
    ap.add_argument("--no-preload", action="store_true", help="do not load a model at start-up")
    ap.add_argument("--port", type=int, default=0, help=f"internal port (0 = {DEFAULT_PORT}, or a free one if busy)")
    args = ap.parse_args()

    try:
        import webview
    except ImportError:
        sys.exit("Thiếu pywebview — hãy cài lại: uv pip install -e .")

    import uvicorn
    from .engine import MANAGER
    from .server import app

    # After an in-app update the old copy is still shutting down: wait for its port.
    wait = float(os.environ.pop("VIENEU_STUDIO_RESTART_WAIT", "0") or 0)
    if wait:
        t_end = time.time() + wait + 8
        time.sleep(wait)
        while time.time() < t_end and not _port_free(HOST, args.port or DEFAULT_PORT):
            time.sleep(0.25)
    port = args.port or _pick_port(HOST)
    # The UI talks to the engine over this loopback-only server; nothing is exposed to the network.
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    _wait_ready(HOST, port)
    log.info("🦜 V Studio ready (internal port %d)", port)

    if not args.no_preload:
        MANAGER.load_async({"mode": args.mode, "precision": args.precision})
    from .music import warm_cache
    warm_cache()   # synthesise the built-in background music once (cached afterwards)

    api = JsApi()
    window = webview.create_window("V Studio", f"http://{HOST}:{port}/", js_api=api, width=1320, height=900,
                                   min_size=(980, 680), text_select=True)
    api._window = window
    webview.start(private_mode=False)
    server.should_exit = True


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()   # no-op unless packaged
    main()
