# PyInstaller spec for V Studio (macOS .app, Windows / Linux folder build).
#   pyinstaller --noconfirm packaging/v_studio.spec
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

ROOT = Path(SPECPATH).parent
VERSION = re.search(r'__version__\s*=\s*"([^"]+)"', (ROOT / "v_studio" / "__init__.py").read_text()).group(1)
ICON_DIR = ROOT / "packaging"

datas = [(str(ROOT / "v_studio" / "ui"), "v_studio/ui")]
binaries = []
hiddenimports = [
    "v_studio.server", "v_studio.engine", "v_studio.recorder", "v_studio.updater", "v_studio.stories",
    "v_studio.lexicon", "v_studio.library", "v_studio.music", "v_studio.kokoro",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto", "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# Packages that load model code, assets or lazy submodules at run time.
for pkg in ("vieneu", "sea_g2p", "webview", "librosa", "kaldi_native_fbank", "soundfile", "sounddevice",
            "kokoro_onnx", "espeakng_loader", "phonemizer", "pyopenjtalk"):
    try:
        d, b, h = collect_all(pkg)
    except Exception:  # noqa: BLE001 — optional on some platforms
        continue
    datas += d
    binaries += b
    hiddenimports += h

# importlib.metadata lookups (version display, update check).
for dist in ("vieneu", "onnxruntime", "huggingface_hub", "numpy", "librosa", "fastapi", "uvicorn", "pywebview",
             "kokoro-onnx", "phonemizer", "espeakng-loader"):
    try:
        datas += copy_metadata(dist)
    except Exception:  # noqa: BLE001
        pass

datas += collect_data_files("certifi")

# Large packages that the desktop app never imports (vieneu's optional web UI, torch backend, ...).
excludes = [
    "gradio", "gradio_client", "hf_gradio", "torch", "torchaudio", "torchvision", "tensorflow",
    "matplotlib", "tkinter", "IPython", "jupyter", "notebook", "pytest",
]

a = Analysis(
    [str(ROOT / "packaging" / "launcher.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

if sys.platform == "darwin":
    icon = str(ICON_DIR / "icon.icns")
elif sys.platform.startswith("win"):
    icon = str(ICON_DIR / "icon.ico")
else:
    icon = None
if icon and not Path(icon).exists():
    icon = None

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="V Studio" if sys.platform == "darwin" else "VStudio",
    console=False,
    icon=icon,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="VStudio", upx=False)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="V Studio.app",
        icon=icon,
        bundle_identifier="io.github.hieudevs.v-studio",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": "V Studio",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "NSHighResolutionCapable": True,
            "NSMicrophoneUsageDescription": "V Studio records your voice to clone it.",
            "LSMinimumSystemVersion": "11.0",
        },
    )

