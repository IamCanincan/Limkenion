@echo off
REM Limkenion CLI launcher - DeepSeek only.
REM ASCII-only filename on purpose (non-ASCII .bat names get garbled on Windows).

chcp 65001 >nul 2>&1
cd /d "D:\Github Repositories\Limkenion"

REM ============ DeepSeek config ============
REM DeepSeek exposes an 上游-Messages-compatible endpoint, which is what
REM Limkenion speaks (it uses the 上游 SDK under the hood).
set "DEEPSEEK_上游_URL=https://api.deepseek.com/上游兼容"
set "DEEPSEEK_MODEL=deepseek-chat"

if not "%DEEPSEEK_API_KEY%"=="" goto HAVE_KEY
echo ==========================================
echo   DeepSeek API key not found
echo ==========================================
echo.
echo Get one at: https://platform.deepseek.com/api_keys
echo.
set /p DEEPSEEK_API_KEY=Paste your DeepSeek API key: 
setx DEEPSEEK_API_KEY "%DEEPSEEK_API_KEY%" >nul 2>&1
echo Saved - you will not be asked again.
echo.
:HAVE_KEY

REM Map DeepSeek onto the env vars Limkenion reads
set "LIMKENION_API_KEY=%DEEPSEEK_API_KEY%"
set "LIMKENION_BASE_URL=%DEEPSEEK_上游_URL%"
set "LIMKENION_MODEL=%DEEPSEEK_MODEL%"
set "LIMKENION_SMALL_FAST_MODEL=%DEEPSEEK_MODEL%"
REM tool search is disabled by default on non-first-party hosts
set "ENABLE_TOOL_SEARCH=true"

REM ============ Node detection ============
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

REM ============ Build if needed ============
if not exist "dist\cli.mjs" (
    echo [Limkenion] dist\cli.mjs not found - building...
    "%NODE_EXE%" scripts\build-cli.mjs
    if %errorlevel% neq 0 (
        echo [Limkenion] Build failed.
        pause
        exit /b 1
    )
)

REM ============ Run ============
echo.
echo [Limkenion] Provider : DeepSeek
echo [Limkenion] Endpoint : %LIMKENION_BASE_URL%
echo [Limkenion] Model    : %LIMKENION_MODEL%
echo.
"%NODE_EXE%" dist\cli.mjs %*
set EXIT_CODE=%errorlevel%

echo.
echo [Limkenion] CLI exited with code %EXIT_CODE%
pause
