#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '请先安装带 npm 的 Node.js 22.19 或更新版本。' >&2
    exit 1
fi

source_dir=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
exec node "$source_dir/install.mjs" "$@"
