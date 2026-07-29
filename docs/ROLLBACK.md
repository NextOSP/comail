# Locked-build rollback (no personal signing key yet)

**When:** a `rauta:` commit on a locked build regresses customs (e.g. AgentMail Trash mapping wrong) and users need a known-good binary again.

**Constraint:** while `UPDATE_CHANNEL=locked`, there is no signed Update path. Rollback is **rebuild + reinstall**, not in-app Update.

## Procedure

1. Identify last-known-good commit (customs green + dogfood OK), e.g. parent of bad commit.
2. `git checkout <good-sha>` on a throwaway branch.
3. **Required:** `./scripts/check-customs.sh` and `pnpm test` must both exit 0 before rebuild (same gates as CI — a locked rebuild must not drift past undocumented dirty / broken sentinels).
4. Rebuild/install via `scripts/install-local-macos.sh` (or project equivalent).
5. Verify TC-CUSTOM-01 L3 on the reinstalled app.
6. Log incident in `docs/VERIFICATION.md` (which gate failed; never “just hand-reapply”).
7. Fix forward on `feat/…` with a new `rauta:` commit; do not force-push `master`.

## Honesty note (Kimi Round 3)

Locked mode kills the **call path** (`checkForUpdate` / `installUpdate` refuse). The `@tauri-apps/plugin-updater` capability may still be present in the bundle until P2 cutover removes/repoints it. Do **not** claim “updater artifact absent from binary” until an explicit bundle audit exists.