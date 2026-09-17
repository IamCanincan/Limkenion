@echo off
REM Limkenion CLI diagnostics - double-click and screenshot the output.
REM ASCII-only filename on purpose (non-ASCII .bat names get garbled).

chcp 65001 >nul 2>&1
cd /d "D:\Github Repositories\Limkenion"

set "NODE_EXE=node"
where node >nul 2>&1
if %errorlevel% neq 0 (
    if exist "D:\nodejs\node.exe" (
        set "NODE_EXE=D:\nodejs\node.exe"
    ) else (
        echo [FATAL] node.exe not found.
        pause
        exit /b 1
    )
)

echo ==========================================
echo   Limkenion CLI Diagnostics
echo ==========================================
echo.

echo [1] TTY status  (both should be true for the REPL)
"%NODE_EXE%" -e "console.log('    stdout.isTTY =', process.stdout.isTTY); console.log('    stdin.isTTY  =', process.stdin.isTTY)"
echo.

echo [2] API key env vars  (presence only - values are hidden)
"%NODE_EXE%" -e "const ks=['LIMKENION_API_KEY','DEEPSEEK_API_KEY','LIMKENION_AUTH_TOKEN','LIMKENION_BASE_URL'];for(const k of ks){console.log('    '+k+': '+(process.env[k]?'SET':'not set'))}"
echo.

echo [3] Bundle present?
if exist "dist\cli.mjs" (
    echo     dist\cli.mjs FOUND
) else (
    echo     dist\cli.mjs MISSING - run start-cli.bat to build
)
echo.

echo [4] Node version
"%NODE_EXE%" --version
echo.

echo [5] Running: cli.mjs -p "hello"   (non-interactive path)
echo ------------------------------------------
"%NODE_EXE%" dist\cli.mjs -p "hello" 2>&1
set EXIT_CODE=%errorlevel%
echo ------------------------------------------
echo     exit code = %EXIT_CODE%
echo.

echo [6] Running: cli.mjs --version
"%NODE_EXE%" dist\cli.mjs --version 2>&1
set EXIT_CODE2=%errorlevel%
echo     exit code = %EXIT_CODE2%
echo.

echo ==========================================
echo   Done - screenshot this window
echo ==========================================
pause
