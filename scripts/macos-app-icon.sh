#!/usr/bin/env bash
# Precompile the Icon Composer app icon (src-tauri/icons/Icon.icon) into
# Assets.car, and write a tauri config overlay that ships it instead of letting
# tauri-bundler run actool itself.
#
# Why this exists: tauri-bundler (2.11-2.12) compiles Icon.icon with actool
# from inside `tauri build`. Without --verbose actool fails with "Bad file
# descriptor"; inside tauri-action on the macOS runner it crashes ibtoold
# ("attempt to insert nil object"). The same actool call run from a plain
# shell works every time, so CI does that here and hands tauri the result:
#
#   bash scripts/macos-app-icon.sh
#   pnpm tauri build --config src-tauri/gen/app-icon/tauri.icon.conf.json
#
# Local `tauri build -v` does not need this. Drop it once tauri fixes actool.
set -euo pipefail

cd "$(dirname "$0")/.."
out=src-tauri/gen/app-icon
rm -rf "$out"
mkdir -p "$out"

actool src-tauri/icons/Icon.icon --compile "$out" \
  --output-format human-readable-text --notices --warnings --errors \
  --output-partial-info-plist "$out/assetcatalog_generated_info.plist" \
  --app-icon Icon --include-all-app-icons --enable-on-demand-resources NO \
  --development-region en --target-device mac \
  --minimum-deployment-target 26.0 --platform macosx
test -f "$out/Assets.car"

# CFBundleIconName points macOS at the "Icon" entry inside Assets.car; the
# bundled icon.icns stays as CFBundleIconFile for older systems.
cat > "$out/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIconName</key>
  <string>Icon</string>
</dict>
</plist>
PLIST

# Same icon list minus Icon.icon (so tauri skips actool), plus the compiled
# catalog. `files` merges with tauri.conf's, keeping Metadata.appintents.
python3 - <<'PY'
import json

conf = json.load(open("src-tauri/tauri.conf.json"))
icons = [i for i in conf["bundle"]["icon"] if not i.endswith(".icon")]
overlay = {
    "bundle": {
        "icon": icons,
        "macOS": {
            "infoPlist": "gen/app-icon/Info.plist",
            "files": {"Resources/Assets.car": "gen/app-icon/Assets.car"},
        },
    }
}
with open("src-tauri/gen/app-icon/tauri.icon.conf.json", "w") as f:
    json.dump(overlay, f, indent=2)
PY

echo "app icon ready: $out/Assets.car (config overlay: $out/tauri.icon.conf.json)"
