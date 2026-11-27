#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
    printf '%s\n' '这个安装包适用于 macOS。' >&2
    exit 1
fi

for command in node npm codex; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf '终端里找不到 %s，请先安装并确认终端可调用。\n' "$command" >&2
        exit 1
    fi
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
    printf '%s\n' '请使用 Node.js 22.19 或更新版本。' >&2
    exit 1
fi
if ! codex login status >/dev/null 2>&1; then
    printf '%s\n' '请先在终端运行 codex login 并完成账号登录。' >&2
    exit 1
fi

source_dir=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
install_parent="$HOME/Library/Application Support/WeCom Codex Plugins"
plugin_version=$(node -p 'require(process.argv[1]).version' "$source_dir/wecom-codex/.codex-plugin/plugin.json")
install_dir="$install_parent/wecom-local-$plugin_version"
umask 077
mkdir -p "$install_parent"

staging=$(mktemp -d "$install_parent/.install.XXXXXXXX")
trap 'if [ -n "$staging" ]; then rm -rf "$staging"; fi' 0
mkdir -p "$staging/.agents/plugins" "$staging/wecom-codex"
cp "$source_dir/.agents/plugins/marketplace.json" "$staging/.agents/plugins/"
cp "$source_dir/LICENSE" "$staging/"
plugin_source="$source_dir/wecom-codex"
cp -R "$plugin_source/.codex-plugin" "$plugin_source/.mcp.json" "$plugin_source/hooks" \
    "$plugin_source/runtime" "$plugin_source/skills" "$plugin_source/package.json" \
    "$plugin_source/package-lock.json" "$staging/wecom-codex/"

if [ -d "$install_dir" ]; then
    if ! diff -qr "$staging" "$install_dir" >/dev/null; then
        printf '%s\n' '已有不同的同版本安装文件，请核对原安装目录后再继续。' >&2
        exit 1
    fi
else
    node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging" "$install_dir"
    staging=''
fi

marketplaces=$(codex plugin marketplace list --json)
previous_source=$(printf '%s' "$marketplaces" | node -e '
    const { marketplaces } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const entry = marketplaces.find(item => item.name === "wecom-local");
    if (entry?.marketplaceSource?.sourceType === "local") {
        process.stdout.write(entry.marketplaceSource.source);
    } else if (entry) {
        console.error("wecom-local 已被非本地插件源使用，请先检查 Codex 插件源配置。");
        process.exitCode = 1;
    }
')
if [ "$previous_source" != "$install_dir" ]; then
    if [ -n "$previous_source" ]; then
        codex plugin marketplace remove wecom-local
    fi
    if ! codex plugin marketplace add "$install_dir"; then
        if [ -n "$previous_source" ]; then
            codex plugin marketplace add "$previous_source"
        fi
        exit 1
    fi
fi
codex plugin add wecom-codex@wecom-local

manager="$install_dir/wecom-codex/runtime/manage.mjs"
if node "$manager" status >/dev/null 2>&1; then
    printf '%s\n' '已找到本机运行的企微连接。'
    node "$manager" update-bridge
    node "$manager" status
else
    workspace=${1:-}
    if [ -z "$workspace" ]; then
        workspace="$install_parent/workspace"
        mkdir -p "$workspace"
    fi
    node "$manager" setup "$workspace"
fi
