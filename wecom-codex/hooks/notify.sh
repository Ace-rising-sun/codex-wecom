#!/bin/sh

socket="$HOME/Library/Application Support/WeCom Codex/control.sock"
if [ -S "$socket" ]; then
    /usr/bin/curl --silent --max-time 2 --unix-socket "$socket" \
        --header 'Content-Type: application/json' --data-binary @- \
        --output /dev/null http://localhost/hook
fi
printf '{}\n'
