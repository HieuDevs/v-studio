@echo off
rem V Studio - cai dat va chay. Can uv: https://docs.astral.sh/uv/
cd /d "%~dp0"
set UV_NATIVE_TLS=1
if not exist .venv uv venv --python 3.12 .venv
rem (Re)install whenever pyproject.toml differs from the copy saved at the last install.
if not exist .venv\installed.toml goto install
fc /b pyproject.toml .venv\installed.toml >nul || goto install
goto run
:install
uv pip install --python .venv\Scripts\python.exe -e . || exit /b 1
copy /y pyproject.toml .venv\installed.toml >nul
:run
.venv\Scripts\python.exe -m v_studio %*
