@echo off
REM Limkenion CLI launcher - DeepSeek only.
REM ASCII-only filename on purpose (non-ASCII .bat names get garbled on Windows).

chcp 65001 >nul 2>&1
cd /d "D:\Github Repositories\Limkenion"

REM ============ DeepSeek config ============
REM LIMKENION_API_PROVIDER=openai 让 CLI 走 services/api/openai-compat.ts，
REM 即 OpenAI SDK + OpenAI chat-completions 协议，不再经过 上游 SDK。
REM 因此端点用 DeepSeek 原生地址（不是 /上游兼容 兼容路径）。
set "LIMKENION_API_PROVIDER=openai"
set "DEEPSEEK_OPENAI_URL=https://api.deepseek.com"
set "DEEPSEEK_MODEL=deepseek-chat"
REM 需要推理能力时改成 deepseek-reasoner（等效 上游 extended thinking）
REM REASONING_EFFORT=low|medium|high 仅对 OpenAI o-series / gpt-5+ 生效，DeepSeek 不认

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

REM Map DeepSeek onto the env vars the OpenAI-compat adapter reads
set "DEEPSEEK_BASE_URL=%DEEPSEEK_OPENAI_URL%"
set "LIMKENION_API_KEY=%DEEPSEEK_API_KEY%"
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
