$ErrorActionPreference = "Stop"

# 从源码直接运行 CLI，用于开发调试。可加 --no-env 清掉模型凭据。

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$noEnv = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

foreach ($arg in $args) {
	if ($arg -eq "--no-env") {
		$noEnv = $true
	} else {
		$forwardArgs.Add($arg)
	}
}

if ($noEnv) {
	# 只清 DeepSeek 凭据：这是本框架唯一使用的凭据。
	Remove-Item -Path "Env:DEEPSEEK_API_KEY" -ErrorAction SilentlyContinue
	Remove-Item -Path "Env:DEEPSEEK_BASE_URL" -ErrorAction SilentlyContinue
	Write-Host "Running without API keys..."
}

$tsxBin = Join-Path $scriptDir "node_modules/.bin/tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxBin)) {
	throw "tsx not found at $tsxBin. Run npm install from the repo root first."
}

$cliPath = Join-Path $scriptDir "packages/cli/src/cli.ts"
& $tsxBin $cliPath @forwardArgs
exit $LASTEXITCODE
