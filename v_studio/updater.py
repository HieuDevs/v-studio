"""App updates for V Studio itself, from the GitHub releases of the app's repo
(``HieuDevs/v-studio``; ``VSTUDIO_UPDATE_REPO`` overrides it).

Two ways to update, picked automatically:

* ``installer`` — packaged app (PyInstaller): download this platform's installer
  from the newest release (``.dmg`` / ``-Setup.exe`` / ``.deb``), check it against
  the release's ``SHA256SUMS.txt`` and open it. The user finishes the install and
  reopens the app.
* ``git`` — running from a git checkout (``./run.sh``): ``git pull --ff-only``,
  reinstall the dependencies when ``pyproject.toml`` changed, then restart.

The engines (VieNeu-TTS SDK, Kokoro) are dependencies of the app, so they are
updated together with it — there is no separate SDK updater.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from . import __version__

log = logging.getLogger("vieneu.studio")

REPO = os.environ.get("VSTUDIO_UPDATE_REPO") or "HieuDevs/v-studio"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_URL = f"https://github.com/{REPO}/releases"
ROOT = Path(__file__).resolve().parent.parent   # repo root when running from source
UA = {"User-Agent": f"V-Studio/{__version__}", "Accept": "application/vnd.github+json"}

_cache: dict = {"t": 0.0, "data": None}
_job: dict = {"running": False, "done": False, "ok": None, "kind": None, "phase": "", "progress": None,
              "log": "", "path": None, "from": None, "to": None}
_lock = threading.Lock()


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _vtuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3]) or (0,)


def install_kind() -> str:
    if frozen():
        return "installer"
    if (ROOT / ".git").exists() and shutil.which("git"):
        return "git"
    return "manual"


def _pick_asset(assets: list[dict]) -> Optional[dict]:
    names = [a.get("name", "") for a in assets]
    if sys.platform == "darwin":
        arm = platform.machine().lower() in ("arm64", "aarch64")
        cands = [n for n in names if n.endswith(".dmg")]
        pref = [n for n in cands if ("arm64" in n) == arm] or cands
    elif sys.platform.startswith("win"):
        pref = [n for n in names if n.lower().endswith(".exe")]
    else:
        pref = [n for n in names if n.endswith(".deb")]
    if not pref:
        return None
    a = next(x for x in assets if x.get("name") == pref[0])
    return {"name": a["name"], "size": a.get("size"), "url": a.get("browser_download_url")}


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:   # noqa: S310
        return json.load(r)


def check(force: bool = False) -> dict:
    """Newest release vs the running version (cached for an hour)."""
    if not force and _cache["data"] and time.time() - _cache["t"] < 3600:
        return _cache["data"]
    base = {"installed": __version__, "repo": REPO, "releases_url": RELEASES_URL, "kind": install_kind(),
            "frozen": frozen()}
    try:
        rel = _get_json(API)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        data = {**base, "latest": None, "update_available": False, "no_release": True}
    else:
        latest = str(rel.get("tag_name") or "").lstrip("v")
        assets = rel.get("assets") or []
        data = {**base, "latest": latest, "name": rel.get("name"), "notes": (rel.get("body") or "")[:4000],
                "html_url": rel.get("html_url") or RELEASES_URL, "published_at": rel.get("published_at"),
                "update_available": bool(latest) and _vtuple(latest) > _vtuple(__version__),
                "asset": _pick_asset(assets),
                "sums_url": next((a.get("browser_download_url") for a in assets if a.get("name") == "SHA256SUMS.txt"), None)}
    data["restart_needed"] = bool(_job["done"] and _job["ok"] and _job["kind"] == "git")
    _cache.update(t=time.time(), data=data)
    return data


def job_status() -> dict:
    return dict(_job)


def start_install() -> dict:
    info = check()
    if not info.get("update_available"):
        raise RuntimeError("Đang dùng bản mới nhất.")
    kind = info["kind"]
    if kind == "manual":
        raise RuntimeError(f"Không tự cập nhật được bản này. Hãy tải bản mới tại {RELEASES_URL}")
    if kind == "installer" and not info.get("asset"):
        raise RuntimeError("Bản phát hành mới chưa có bộ cài cho hệ điều hành này.")
    with _lock:
        if _job["running"]:
            raise RuntimeError("Đang cập nhật.")
        _job.update(running=True, done=False, ok=None, kind=kind, phase="", progress=None, log="", path=None,
                    **{"from": __version__, "to": info["latest"]})
    target = _install_installer if kind == "installer" else _install_git
    threading.Thread(target=_run, args=(target, info), daemon=True).start()
    return job_status()


def _say(text: str) -> None:
    _job["log"] += text.rstrip() + "\n"
    log.info("update: %s", text.rstrip())


def _run(fn, info: dict) -> None:
    try:
        fn(info)
        _job["ok"] = True
    except Exception as e:  # noqa: BLE001
        _job["ok"] = False
        _say(f"{type(e).__name__}: {e}")
    finally:
        _job["running"] = False
        _job["done"] = True
        _cache["t"] = 0.0


# ── packaged app: download + open the installer ─────────────────────────────

def _download_dir() -> Path:
    d = Path.home() / "Downloads"
    return d if d.is_dir() else Path(tempfile.gettempdir())


def _install_installer(info: dict) -> None:
    asset = info["asset"]
    dest = _download_dir() / asset["name"]
    tmp = dest.with_suffix(dest.suffix + ".part")
    _job["phase"] = "download"
    _say(f"Tải {asset['name']} …")
    h = hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request(asset["url"], headers=UA), timeout=60) as r, open(tmp, "wb") as f:  # noqa: S310
        total = int(r.headers.get("Content-Length") or asset.get("size") or 0)
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            h.update(chunk)
            done += len(chunk)
            _job["progress"] = done / total if total else None
    if info.get("sums_url"):
        _job["phase"] = "verify"
        with urllib.request.urlopen(urllib.request.Request(info["sums_url"], headers=UA), timeout=20) as r:  # noqa: S310
            sums = {ln.split()[-1].lstrip("*"): ln.split()[0] for ln in r.read().decode().splitlines() if ln.strip()}
        want = sums.get(asset["name"])
        if want and want.lower() != h.hexdigest():
            tmp.unlink(missing_ok=True)
            raise RuntimeError("Tệp tải về không khớp SHA256 của bản phát hành — đã huỷ.")
        _say("Đã kiểm tra SHA256.")
    os.replace(tmp, dest)
    _job["path"] = str(dest)
    _job["phase"] = "open"
    _say(f"Đã lưu {dest}. Mở trình cài đặt…")
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(dest)])
    elif sys.platform.startswith("win"):
        os.startfile(str(dest))   # noqa: S606 — the installer the user asked for
    else:
        opener = shutil.which("xdg-open")
        if opener:
            subprocess.Popen([opener, str(dest)])
        _say(f"Hoặc cài bằng lệnh: sudo apt install {dest}")
    _job["phase"] = "opened"


# ── source checkout: git pull + reinstall ───────────────────────────────────

def _cmd(args: list[str], cwd: Path) -> str:
    _say("$ " + " ".join(args))
    p = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, timeout=900)
    out = (p.stdout + p.stderr).strip()
    if out:
        _say(out[-3000:])
    if p.returncode != 0:
        raise RuntimeError(f"Lệnh thất bại (mã {p.returncode}).")
    return p.stdout


def _install_git(info: dict) -> None:
    _job["phase"] = "pull"
    if _cmd(["git", "status", "--porcelain", "--untracked-files=no"], ROOT).strip():
        raise RuntimeError("Thư mục mã nguồn có thay đổi chưa commit — hãy commit hoặc stash rồi thử lại.")
    pyproject = ROOT / "pyproject.toml"
    before = pyproject.read_bytes() if pyproject.is_file() else b""
    _cmd(["git", "pull", "--ff-only"], ROOT)
    if pyproject.is_file() and pyproject.read_bytes() != before:
        _job["phase"] = "deps"
        uv = shutil.which("uv")
        args = [uv, "pip", "install", "--python", sys.executable, "-e", "."] if uv else [sys.executable, "-m", "pip", "install", "-e", "."]
        _cmd(args, ROOT)
        marker = ROOT / ".venv" / ".installed"   # what run.sh checks
        if marker.exists():
            marker.touch()
    _job["phase"] = "restart"
    _say("Xong. Khởi động lại app để dùng bản mới.")


def relaunch() -> None:
    """Start a fresh copy of the app (it waits for this one to free the port)."""
    env = dict(os.environ, VIENEU_STUDIO_RESTART_WAIT="2")
    args = [sys.executable, *sys.argv[1:]] if frozen() else [sys.executable, "-m", "v_studio", *sys.argv[1:]]
    kw: dict = {"env": env, "close_fds": True}
    if sys.platform.startswith("win"):
        kw["creationflags"] = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen(args, **kw)
