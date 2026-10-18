@echo off
REM ===========================================================
REM  Listen Treasure - one click launcher
REM
REM  Interpreter lookup order:
REM    1. LISTEN_PYTHON environment variable
REM    2. the .python file in this folder (one line: absolute path)
REM    3. python / py -3 / python3 from PATH
REM    4. common install locations
REM
REM  Kept ASCII-only on purpose: cmd.exe reads this file with the
REM  active code page, and non-ASCII text in a .bat breaks parsing
REM  on systems whose default code page is not UTF-8.
REM ===========================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Python prints UTF-8; switch the console to UTF-8 so the
REM Chinese banners and logs are readable instead of mojibake.
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

set "PY="

if defined LISTEN_PYTHON (
  "%LISTEN_PYTHON%" --version >nul 2>nul
  if not errorlevel 1 set "PY=%LISTEN_PYTHON%"
)

if not defined PY if exist ".python" (
  for /f "usebackq delims=" %%L in (".python") do (
    if not defined PY (
      "%%~L" --version >nul 2>nul
      if not errorlevel 1 set "PY=%%~L"
    )
  )
)

if not defined PY (
  for %%C in ("python" "py -3" "python3") do (
    if not defined PY (
      %%~C --version >nul 2>nul
      if not errorlevel 1 set "PY=%%~C"
    )
  )
)

if not defined PY (
  for %%D in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "%ProgramFiles%\Python313\python.exe"
    "%ProgramFiles%\Python312\python.exe"
    "%ProgramFiles%\Python311\python.exe"
    "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
  ) do (
    if not defined PY (
      if exist "%%~D" (
        "%%~D" --version >nul 2>nul
        if not errorlevel 1 set "PY=%%~D"
      )
    )
  )
)

if not defined PY (
  echo [ERROR] No usable Python found.
  echo.
  echo   Install Python 3.10+ and tick "Add python.exe to PATH":
  echo     https://www.python.org/downloads/windows/
  echo.
  echo   If Python lives elsewhere, either set the environment
  echo   variable LISTEN_PYTHON, or create a .python file next to
  echo   this script containing the absolute path of python.exe.
  echo.
  pause
  exit /b 1
)

echo Interpreter: %PY%
%PY% --version
echo.

%PY% -c "import fastapi, uvicorn, numpy, scipy, soundfile, pyaudiowpatch, segno, PIL" >nul 2>nul
if errorlevel 1 (
  echo [INFO] Dependencies missing, installing requirements.txt ...
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo [ERROR] Install failed. Run manually:
    echo         %PY% -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
  )
  echo.
)

REM --lan binds 0.0.0.0 so a phone on the same Wi-Fi can open the /m UI.
%PY% scripts\run.py --lan %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo [Server exited with code %RC%]
  pause
)
endlocal
