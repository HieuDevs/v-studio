"""Update check / install for the VieNeu-TTS SDK (``vieneu`` on PyPI).

The open-source SDK is released on PyPI only (the GitHub releases of
VieNeu-TTS are the closed-source VieNeu Desktop app). Model weights need no
updater: the SDK downloads the newest files from Hugging Face whenever a model
is loaded while online.

Installing upgrades the package inside the running app's own environment; the
new code is used after the app restarts.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional

log = logging.getLogger("vieneu.studio")

PYPI_URL = "https://pypi.org/pypi/vieneu/json"
# Keep the runtime pair that is known to work with the VieNeu ONNX graphs.
EXTRA_PINS = ["onnxruntime>=1.20,<1.25"]

_cache: dict = {"t": 0.0, "data": None}
_job: dict = {"running": False, "done": False, "ok": None, "log": "", "from": None, "to": None}
_job_lock = threading.Lock()


def installed_version() -> Optional[str]:
    try:
        import importlib.metadata as md
        return md.version("vieneu")
    except Exception:
        return None


def _vkey(v: str):
    try:
        from packaging.version import Version
        return Version(v)
    except Exception:
        parts = []
        for p in v.replace("-", ".").split("."):
            parts.append(int(p) if p.isdigit() else 0)
        return tuple(parts)


def _find_uv() -> Optional[str]:
    cand = [shutil.which("uv"), str(Path.home() / ".local/bin/uv"), str(Path.home() / ".cargo/bin/uv"),
            "/opt/homebrew/bin/uv", "/usr/local/bin/uv"]
    for c in cand:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _has_pip() -> bool:
    try:
        import importlib.util
        return importlib.util.find_spec("pip") is not None
    except Exception:
        return False


def frozen() -> bool:
    """True inside a packaged build (PyInstaller): the bundled packages cannot be upgraded in place."""
    return bool(getattr(sys, "frozen", False))


def installer() -> Optional[list]:
    if frozen():
        return None
    uv = _find_uv()
    if uv:
        # --upgrade-package: move vieneu (and only what it needs) forward, not every package.
        return [uv, "pip", "install", "--native-tls", "--python", sys.executable, "--upgrade-package", "vieneu", "vieneu", *EXTRA_PINS]
    if _has_pip():
        return [sys.executable, "-m", "pip", "install", "--upgrade", "vieneu", *EXTRA_PINS]
    return None


def check(force: bool = False) -> dict:
    if not force and _cache["data"] and time.time() - _cache["t"] < 3600:
        data = dict(_cache["data"])
    else:
        req = urllib.request.Request(PYPI_URL, headers={"User-Agent": "V-Studio"})
        with urllib.request.urlopen(req, timeout=10) as r:
            info = json.load(r)
        latest = info["info"]["version"]
        files = info.get("releases", {}).get(latest) or []
        released = min((f.get("upload_time_iso_8601") or "" for f in files), default="") or None
        recent = sorted(info.get("releases", {}).keys(), key=_vkey, reverse=True)[:6]
        data = {"latest": latest, "released_at": released, "recent": recent,
                "pypi_url": f"https://pypi.org/project/vieneu/{latest}/",
                "changes_url": "https://github.com/pnnbao97/VieNeu-TTS/commits/main"}
        _cache.update(t=time.time(), data=data)
    inst = installed_version()
    data["installed"] = inst
    data["frozen"] = frozen()
    # A packaged build is updated by installing a newer release of the app, not package by package.
    data["update_available"] = bool(not data["frozen"] and inst and data["latest"] and _vkey(data["latest"]) > _vkey(inst))
    data["installer"] = None if data["frozen"] else ("uv" if _find_uv() else ("pip" if _has_pip() else None))
    data["restart_needed"] = bool(_job["done"] and _job["ok"])
    return data


def job_status() -> dict:
    return {k: _job[k] for k in ("running", "done", "ok", "log", "from", "to")}


def start_install() -> dict:
    cmd = installer()
    if cmd is None:
        raise RuntimeError("Không tìm thấy uv hoặc pip trong môi trường của app để cài bản mới.")
    with _job_lock:
        if _job["running"]:
            return job_status()
        _job.update(running=True, done=False, ok=None, log="$ " + " ".join(cmd) + "\n", **{"from": installed_version(), "to": None})
    threading.Thread(target=_run, args=(cmd,), daemon=True).start()
    return job_status()


def _run(cmd: list) -> None:
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in p.stdout:  # type: ignore[union-attr]
            _job["log"] = (_job["log"] + line)[-8000:]
        rc = p.wait()
        # The running process still has the old version imported; ask a fresh interpreter.
        out = subprocess.run([sys.executable, "-c", "import importlib.metadata as m; print(m.version('vieneu'))"],
                             capture_output=True, text=True, timeout=60)
        _job["to"] = out.stdout.strip() or None
        _job["ok"] = rc == 0
        if rc != 0:
            _job["log"] += f"\n(exit code {rc})"
    except Exception as e:  # noqa: BLE001
        _job["ok"] = False
        _job["log"] += f"\n{type(e).__name__}: {e}"
    finally:
        _job["running"] = False
        _job["done"] = True
        _cache["t"] = 0.0


def relaunch() -> None:
    """Start a fresh copy of the app (it waits for this one to free the port)."""
    env = dict(os.environ, VIENEU_STUDIO_RESTART_WAIT="2")
    if frozen():
        args = [sys.executable, *sys.argv[1:]]   # the packaged executable is the app itself
    else:
        args = [sys.executable, "-m", "v_studio", *sys.argv[1:]]
    kw: dict = {"env": env, "close_fds": True}
    if sys.platform.startswith("win"):
        kw["creationflags"] = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen(args, **kw)
