#!/usr/bin/env bash
# Install a local Comail build without Keychain prompt loops.
# - Signs with Developer ID (never ad-hoc)
# - Points COMAIL_CREDENTIALS_INSECURE_FILE at ~/.config/comail/credentials-local.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Comail.app}"
IDENTITY="${COMAIL_CODESIGN_IDENTITY:-Developer ID Application: Mikko Kiiskilae (Z27G4HWLJE)}"
DEST="/Applications/Comail.app"
CRED_FILE="${COMAIL_CREDENTIALS_INSECURE_FILE:-$HOME/.config/comail/credentials-local.json}"
mkdir -p "$(dirname "$CRED_FILE")"
[[ -d "$SRC" ]] || { echo "missing app: $SRC (build first)"; exit 1; }
osascript -e 'quit app "Comail"' 2>/dev/null || true
sleep 1
pkill -x comail 2>/dev/null || true
sleep 1
rm -rf "$DEST.bak"
[[ -d "$DEST" ]] && mv "$DEST" "$DEST.bak"
ditto "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true
PLIST="$DEST/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :LSEnvironment' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :LSEnvironment dict' "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:COMAIL_CREDENTIALS_INSECURE_FILE string $CRED_FILE" "$PLIST"
# No hardened-runtime for local dogfood — avoids Keychain partition / auth loops.
codesign --force --deep --timestamp --sign "$IDENTITY" "$DEST"
codesign --verify --deep --strict "$DEST"
open -a Comail
echo "installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist")"
echo "credentials file: $CRED_FILE (Keychain bypass)"
