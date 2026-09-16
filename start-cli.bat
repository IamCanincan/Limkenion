@echo off
REM Limkenion CLI launcher - double-click to run.
REM Filename is deliberately ASCII-only: non-ASCII .bat names get garbled
REM by codepage mismatches on Windows.

chcp 65001 >nul 2>&1
cd /d "D:\Github Repositories\Limkenion"

REM Prefer node from PATH; fall back to the known system install.
set "NODE_EXE=node"
where node >nul 2>&1
if %errorlevel% neq 0 (
    if exist "D:\nodejs\node.exe" (
        set "NODE_EXE=D:\nodejs\node.exe"
    ) else (
        echo [Limkenion] node.exe not found. Install Node.js or fix PATH.
        pause
        exit /b 1
    )
)

REM Build the bundle on first run (or after it was deleted).
if not exist "dist\cli.mjs" (
    echo [Limkenion] dist\cli.mjs not found - building...
    "%NODE_EXE%" scripts\build-cli.mjs
    if %errorlevel% neq 0 (
        echo [Limkenion] Build failed. See errors above.
        pause
        exit /b 1
    )
)

echo [Limkenion] Starting CLI...
"%NODE_EXE%" dist\cli.mjs %*
set EXIT_CODE=%errorlevel%

echo.
echo [Limkenion] CLI exited with code %EXIT_CODE%
pause
