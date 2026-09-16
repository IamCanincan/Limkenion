@echo off
REM Limkenion CLI launcher - DeepSeek only.
REM
REM IMPORTANT: this file must stay pure ASCII and must NOT call chcp.
REM Changing the codepage mid-script makes cmd re-read the remaining lines
REM at wrong byte offsets when multi-byte characters are present, which
REM corrupts commands and makes the window exit instantly. Also, "|" is a
REM special character in batch even inside REM in some encodings.

cd /d "D:\Github Repositories\Limkenion"

REM ---- DeepSeek configuration ----
set "LIMKENION_API_PROVIDER=openai"
set "DEEPSEEK_OPENAI_URL=https://api.deepseek.com"
set "DEEPSEEK_MODEL=deepseek-chat"
REM Use deepseek-reasoner instead if you want reasoning.
REM REASONING_EFFORT only applies to OpenAI o-series and gpt-5+ models,
REM DeepSeek ignores it.

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

REM Map onto the env vars read by services/api/openai-compat.ts
set "DEEPSEEK_BASE_URL=%DEEPSEEK_OPENAI_URL%"
set "LIMKENION_API_KEY=%DEEPSEEK_API_KEY%"
set "LIMKENION_MODEL=%DEEPSEEK_MODEL%"
set "LIMKENION_SMALL_FAST_MODEL=%DEEPSEEK_MODEL%"
REM tool search is disabled by default on non-first-party hosts
set "ENABLE_TOOL_SEARCH=true"

REM ---- Node detection ----
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

REM ---- Build if needed ----
if not exist "dist\cli.mjs" (
    echo [Limkenion] dist\cli.mjs not found - building...
    "%NODE_EXE%" scripts\build-cli.mjs
    if %errorlevel% neq 0 (
        echo [Limkenion] Build failed.
        pause
        exit /b 1
    )
)

REM ---- Run ----
echo.
echo [Limkenion] Provider : DeepSeek
echo [Limkenion] Endpoint : %DEEPSEEK_BASE_URL%
echo [Limkenion] Model    : %LIMKENION_MODEL%
echo.
"%NODE_EXE%" dist\cli.mjs %*
set EXIT_CODE=%errorlevel%

echo.
echo [Limkenion] CLI exited with code %EXIT_CODE%
pause
