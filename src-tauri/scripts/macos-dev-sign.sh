#!/usr/bin/env bash
# Cargo `runner` used by local macOS development (wired up by
# scripts/macos-dev-cert.sh, which writes src-tauri/.cargo/config.toml).
#
# `tauri dev` launches the app via `cargo run`, and cargo hands the freshly
# built binary to this runner. We re-sign it with the stable, local
# "comail-dev" identity and a FIXED bundle identifier BEFORE running it. That
# gives every debug build the same code-signing "designated requirement", so
# the macOS login keychain keeps honoring its "Always Allow" grant for comail's
# stored secrets instead of re-prompting on every rebuild.
#
# It is a no-op (just runs the binary as-is) when the dev identity isn't
# installed, so teammates and CI are unaffected.
set -euo pipefail

BIN="$1"
shift

IDENTITY="comail-dev"
# Must match bundle.identifier in tauri.conf.json so the dev signature lines up
# with release builds.
BUNDLE_ID="com.deanoss.comail"

if [ "$(uname)" = "Darwin" ] \
  && [ "$(basename "$BIN")" = "comail" ] \
  && security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" \
    --timestamp=none "$BIN" >/dev/null 2>&1 \
    || echo "macos-dev-sign: codesign failed; running unsigned" >&2
fi

exec "$BIN" "$@"
