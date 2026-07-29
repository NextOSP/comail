# Locked-build rollback (no personal signing key yet)

**When:** a `rauta:` commit on a locked build regresses customs (e.g. AgentMail Trash mapping wrong) and users need a known-good binary again.

**Constraint:** while `UPDATE_CHANNEL=locked`, there is no signed Update path. Rollback is **rebuild + reinstall**, not in-app Update.

## Procedure

1. Identify last-known-good commit (customs green + dogfood OK), e.g. parent of bad commit.
2. `git checkout <good-sha>` on a throwaway branch; confirm `./scripts/check-customs.sh` and `pnpm test` green.
3. Rebuild/install via `scripts/install-local-macos.sh` (or project equivalent).
4. Verify TC-CUSTOM-01 L3 on the reinstalled app.
5. Log incident in `docs/VERIFICATION.md` (which gate failed; never “just hand-reapply”).
6. Fix forward on `feat/…` with a new `rauta:` commit; do not force-push `master`.

## Explicit non-goals until keys exist

- No `scripts/restore-last-known-good.sh` binary archive restore (P2 / TC-ROLLBACK-01).
- No endpoint hold / re-sign (requires KEY_CUSTODY ceremony).
