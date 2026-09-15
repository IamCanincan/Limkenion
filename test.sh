#!/usr/bin/env bash
set -euo pipefail

# 隔离用户资源、凭据、临时文件和工具配置。
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/limkenion-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# 标记生成的根目录，便于清理前确认归属。
touch "$test_root/.limkenion-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# 只删除上面创建的带标记目录，绝不删除未经验证的路径。
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/limkenion-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.limkenion-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "拒绝删除未经验证的测试目录：%s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "拒绝删除意外的测试目录：%s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# 从空环境开始，只允许平台和测试必需的设置。
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"LIMKENION_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# 原生 Windows 需要继承这些值才能启动子进程。
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# 仅为运行器行为和测试报告保留 CI 检测。
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "在隔离的 home 中运行不带 API 密钥的测试：$test_root/home"
env -i "${test_env[@]}" npm test
