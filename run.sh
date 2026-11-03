#!/usr/bin/env bash
# V Studio — cài đặt và chạy. Cần uv: https://docs.astral.sh/uv/
set -e
export UV_NATIVE_TLS=1   # trust the OS certificate store (corporate proxies)
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  uv venv --python 3.12 .venv
fi
# (Re)install whenever the dependency list changed since the last install.
if [ ! -f .venv/.installed ] || [ pyproject.toml -nt .venv/.installed ]; then
  uv pip install --python .venv/bin/python -e .
  touch .venv/.installed
fi
exec .venv/bin/python -m v_studio "$@"
