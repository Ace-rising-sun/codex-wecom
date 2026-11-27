#!/bin/sh
set -eu

runtime=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
node_binary=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' \
    "$HOME/Library/LaunchAgents/local.wecom-codex.plist" 2>/dev/null || true)
if [ ! -x "$node_binary" ]; then
    node_binary=$(command -v node)
fi
exec "$node_binary" "$runtime/settings-server.mjs"
