#!/usr/bin/env bash
# Sync the freshest Tauri Linux bundles into ./build so the Run-Comail*.sh
# launchers and the installed .desktop entry always point at the CURRENT build.
#
# Why this exists: `pnpm tauri build` writes to src-tauri/target/release/bundle,
# NOT to ./build. Without this step ./build/Comail.AppImage keeps pointing at a
# stale binary — that's the "why does it run an old version?" trap. Run this
# right after `pnpm tauri build`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="$root/src-tauri/target/release/bundle"
dest="$root/build"

deb="$(ls -t "$bundle"/deb/*.deb 2>/dev/null | head -1 || true)"
appimage="$(ls -t "$bundle"/appimage/*.AppImage 2>/dev/null | head -1 || true)"
if [[ -z "${deb}" || -z "${appimage}" ]]; then
  echo "error: no bundles found in $bundle — run 'pnpm tauri build' first" >&2
  exit 1
fi

mkdir -p "$dest"
# Drop stale versioned artifacts (leave the Comail.AppImage symlink in place).
find "$dest" -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.deb' \) -delete

cp -f "$appimage" "$deb" "$dest/"
chmod +x "$dest/$(basename "$appimage")"
ln -sfn "$(basename "$appimage")" "$dest/Comail.AppImage"

echo "Synced to build/:"
echo "  $(basename "$appimage")  ->  Comail.AppImage"
echo "  $(basename "$deb")"

# Refresh desktop + icon caches so the launcher and app menu show the current
# icon/metadata instead of a cached older one.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi
echo "Done. Launch with: build/Run-Comail.sh (or Run-Comail-NVIDIA.sh)"
