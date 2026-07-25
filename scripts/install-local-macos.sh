#!/usr/bin/env bash
# Install a local Comail build to /Applications with Mikko's Developer ID
# (never ad-hoc — ad-hoc breaks Keychain ACLs and spams Allow prompts).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Comail.app}"
IDENTITY="${COMAIL_CODESIGN_IDENTITY:-Developer ID Application: Mikko Kiiskilae (Z27G4HWLJE)}"
DEST="/Applications/Comail.app"
[[ -d "$SRC" ]] || { echo "missing app: $SRC (build first)"; exit 1; }
osascript -e 'quit app "Comail"' 2>/dev/null || true
sleep 1
pkill -x comail 2>/dev/null || true
sleep 1
rm -rf "$DEST.bak"
[[ -d "$DEST" ]] && mv "$DEST" "$DEST.bak"
ditto "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true
codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$DEST"
codesign --verify --deep --strict "$DEST"
open -a Comail
echo "installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist") signed as $IDENTITY"
