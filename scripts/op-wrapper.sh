#!/bin/bash
export OP_SERVICE_ACCOUNT_TOKEN="$1"
shift
export OP_CONFIG_DIR="$HOME/.config/nanoclaw/op-config"
exec /opt/homebrew/bin/op "$@"
