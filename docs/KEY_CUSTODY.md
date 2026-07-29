# Key custody (personal Comail update channel)

**Status: BLOCKED — `minisign` not installed on this machine; no keypair generated this session.**

Do **not** flip `tauri.conf.json` pubkey/endpoint or `UPDATE_CHANNEL` to `rauta` until this checklist is green.

## Checklist

- [ ] `brew install minisign` (or equivalent)
- [ ] Generate keypair: `minisign -G -p docs/rauta-update.pub -s ~/.config/comail/rauta-update.key`
- [ ] Backup 1 location: ________________ (offline / encrypted)
- [ ] Backup 2 location: ________________ (separate medium)
- [ ] Restore test: restore backup → verify can sign a dummy file
- [ ] Bake **public** key only into `src-tauri/tauri.conf.json`
- [ ] Private key never in git, never in CI plaintext
- [ ] Rotation procedure (below) dry-run documented after first publish

## Rotation (when needed)

1. Hold endpoint (empty/null `latest.json` or unpublish)
2. Generate new keypair; update backups
3. Re-sign last-known-good with version > last published
4. Ship client with new pubkey (users on old pubkey reject — TC-UPD-04 variant)
5. Record rotation in VERIFICATION.md
