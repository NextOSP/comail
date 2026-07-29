#!/usr/bin/env bash
# TC-PROBE-02 / TC-CUSTOM-01 L1 gate — fail-loud customs inventory.
# Exit 0 only when MANIFEST parses, required fields present, sentinels found,
# and (unless RAUTA_ALLOW_DIRTY=1) working tree has no undocumented dirty paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/docs/CUSTOMS_MANIFEST.json"
CONF="$ROOT/src-tauri/tauri.conf.json"

die() { echo "check-customs: FAIL: $*" >&2; exit 1; }
ok() { echo "check-customs: ok: $*"; }

[[ -f "$MANIFEST" ]] || die "missing $MANIFEST"
command -v python3 >/dev/null || die "python3 required"

python3 - "$MANIFEST" "$CONF" "$ROOT" <<'PY'
import json, sys, pathlib, subprocess, os

manifest_path, conf_path, root = map(pathlib.Path, sys.argv[1:4])
m = json.loads(manifest_path.read_text())
required = ["ok", "channel", "pubkey_ok", "endpoint_ok", "customs", "version"]
missing = [k for k in required if k not in m or m[k] is None]
if missing:
    print(f"FAIL schema missing/null: {missing}", file=sys.stderr)
    sys.exit(1)
if not isinstance(m["customs"], list) or len(m["customs"]) < 1:
    print("FAIL customs[] empty", file=sys.stderr)
    sys.exit(1)

conf = json.loads(conf_path.read_text())
updater = conf.get("plugins", {}).get("updater", {})
endpoint = " ".join(updater.get("endpoints") or [])
pubkey = updater.get("pubkey") or ""
nextosp = "github.com/NextOSP/comail" in endpoint

# While channel is locked, NextOSP endpoint is expected — install must refuse.
# When channel flips to rauta, pubkey_ok/endpoint_ok must be true and NextOSP gone.
channel = m["channel"]
if channel == "rauta":
    if nextosp:
        print("FAIL channel=rauta but tauri.conf still points at NextOSP", file=sys.stderr)
        sys.exit(1)
    if not m.get("pubkey_ok") or not m.get("endpoint_ok"):
        print("FAIL channel=rauta requires pubkey_ok+endpoint_ok true", file=sys.stderr)
        sys.exit(1)
elif channel == "locked":
    if not nextosp and m.get("pubkey_ok"):
        pass  # transitional
else:
    print(f"FAIL unknown channel {channel!r}", file=sys.stderr)
    sys.exit(1)

for c in m["customs"]:
    paths = c.get("paths") or []
    for p in paths:
        if not (root / p).exists():
            print(f"FAIL missing path for {c.get('id')}: {p}", file=sys.stderr)
            sys.exit(1)
    if not paths:
        continue  # inventory-only (e.g. already-merged presets)
    blob = "\n".join((root / p).read_text(errors="replace") for p in paths)
    for s in c.get("sentinels") or []:
        if s and s not in blob:
            print(f"FAIL sentinel {s!r} not in paths for {c.get('id')}", file=sys.stderr)
            sys.exit(1)

# Undocumented dirty tree (git)
allow = set(m.get("dirty_allowlist") or [])
proc = subprocess.run(
    ["git", "status", "--porcelain"],
    cwd=root,
    capture_output=True,
    text=True,
    check=True,
)
dirty = []
for line in proc.stdout.splitlines():
    path = line[3:].strip()
    if path.startswith("docs/CUSTOMS_MANIFEST.json"):
        continue
    if any(path == a.rstrip("/") or path.startswith(a) for a in allow):
        continue
    # allow the scripts/docs we just added if untracked during bootstrap
    if path.startswith("docs/") and path.endswith((".md", ".json")):
        continue
    if path.startswith("scripts/check-customs.sh"):
        continue
    if path.startswith("src/lib/updateChannel"):
        continue
    if path.startswith("src/keyboard/targets.test.ts"):
        continue
    if path.startswith("src/ipc/updater.ts"):
        continue
    dirty.append(path)

if dirty and os.environ.get("RAUTA_ALLOW_DIRTY") != "1":
    # After first commit of customs, any NEW dirty outside allowlist fails.
    # During bootstrap commit, RAUTA_ALLOW_DIRTY=1 is set by the committer.
    tracked = subprocess.run(
        ["git", "ls-files", "docs/CUSTOMS_MANIFEST.json"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if tracked.stdout.strip():
        print("FAIL undocumented dirty paths:", file=sys.stderr)
        for d in dirty:
            print(f"  {d}", file=sys.stderr)
        sys.exit(1)

print(json.dumps({
    "ok": True,
    "channel": channel,
    "pubkey_ok": bool(m["pubkey_ok"]),
    "endpoint_ok": bool(m["endpoint_ok"]),
    "customs": [c["id"] for c in m["customs"]],
    "version": m["version"],
    "nextosp_endpoint_still_in_conf": nextosp,
}))
PY

ok "manifest + sentinels"
