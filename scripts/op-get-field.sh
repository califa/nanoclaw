#!/bin/bash
# Completely isolated op call. Called with: <token> <item> <vault> <field_type> <field_name>
# field_type: "field" for --fields, "otp" for --otp
export OP_SERVICE_ACCOUNT_TOKEN="$1"
export OP_CONFIG_DIR="$HOME/.config/nanoclaw/op-config"
# Unset any 1Password desktop app integration vars
unset OP_BIOMETRIC_UNLOCK_ENABLED
unset OP_DEVICE
unset OP_CONNECT_HOST
unset OP_CONNECT_TOKEN

ITEM="$2"
VAULT="$3"
TYPE="$4"
FIELD="$5"

if [ "$TYPE" = "otp" ]; then
    /opt/homebrew/bin/op item get "$ITEM" --vault "$VAULT" --otp 2>/dev/null
else
    /opt/homebrew/bin/op item get "$ITEM" --vault "$VAULT" --fields "$FIELD" --reveal 2>/dev/null
fi
