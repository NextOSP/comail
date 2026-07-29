# Customs verification log (mkmk10k/comail)

Evidence for the 12-TC matrix. **Do not claim a TC green without a dated row.**

## Round notes (Kimi-k3 via Rauta)

| Round | Served by | Gaps → fixes |
|-------|-----------|--------------|
| 1 | kimi-k3 (moonshot) | Fatal: install while NextOSP; theater TCs without keys; no wipe TC. **Applied:** P0 lock `UPDATE_CHANNEL=locked`; customs commit `00073c9`; pushback on P2-before-commit; wipe folded into playbook. |
| 2 | kimi-k3 (moonshot) | No CI gate; dead rollback; deferred≠blocked; UPD-00 unit-only. **Applied:** `ci.yml` check-customs; `ROLLBACK.md`; MANIFEST `updateChannel`; plugin-boundary vitest; KEY_CUSTODY “permanently locked until ceremony”. |
| 3 | kimi-k3 (moonshot) | Call-path≠artifact; rebuild must run check-customs. **Applied:** ROLLBACK.md gates + honesty note; plan must-not-claim wording. |

## Global DoD checklist

- [ ] All 12 TCs green with links/logs below
- [ ] TC-ROLLBACK-01 on real disk this week; last-known-good path documented
- [ ] CUSTOMS_MANIFEST matches disk; tamper / undocumented WIP ⇒ script fails
- [ ] TC-BOOT-CHANNEL green on **prod** profile
- [ ] Own minisign private key in ≥2 backups; KEY_CUSTODY.md rotation
- [ ] About channel marker == boot-check result
- [ ] ≥1 full L3 Update cycle with zero manual recovery
- [ ] TC-UPD-00 re-verified after every upstream rebase

## TC evidence

| ID | Status | Evidence |
|----|--------|----------|
| TC-CUSTOM-01 | L1 partial | `pnpm test` → `src/keyboard/targets.test.ts` (hover/multi/U keys). L3 dogfood TBD. AgentMail Trash: code in comail-core, cargo fixture TBD. |
| TC-UNSUB-01 | L1+L3 green | RFC 8058 One-Click: `cargo test -p comail-core --lib unsubscribe` (10); `pnpm test` unsubscribe toast honesty. Live POST 2026-07-29: `app.loops.so` → **201**, `account.microsoft.com/profile/unsubscribe` → **200** (tokens redacted). No browser on one-click path. |
| TC-UPD-00 | L1 green | `updateChannel.test.ts` + `updateChannel.pluginBoundary.test.ts` (plugin never invoked). L3: rebuild + Settings check shows no NextOSP offer. |
| TC-UPD-CONFIG | red (expected) | tauri.conf still NextOSP; MANIFEST `pubkey_ok=false` while locked |
| TC-UPD-04 | **BLOCKED** | no personal key (`minisign` missing) |
| TC-UPD-05 | **BLOCKED** | no personal key |
| TC-UPD-06 | **BLOCKED** | no personal key |
| TC-UPD-07 | **BLOCKED** | no personal key |
| TC-ROLLBACK-01 | deferred | signed mid-replace N/A while locked; locked rebuild path: `docs/ROLLBACK.md` |
| TC-PROBE-01 | deferred | deliberate-break run not yet executed |
| TC-PROBE-02 | L1 stub | `scripts/check-customs.sh` emits required JSON fields |
| TC-MERGE-GATE | partial | `ci.yml` runs check-customs + vitest; rauta-commit drop / monotonic version not yet |
| TC-BOOT-CHANNEL | deferred | no boot assert module yet |

## Must-not-claim (until evidenced)

- “Update path removed from shipped binary/bundle” — only **call path** locked today.
- “Locked mode is tamper-proof” — MANIFEST proves git consistency, not hostile rebuild resistance.
- “Rollback tested / ROLLBACK-01 green” — unsigned; L3 dogfood not done.
- “Merge-gate complete” — rauta-commit drop detection not verified.
- “Ready for daily-driver Updates” — say **permanently locked** until KEY_CUSTODY, not “temporarily disabled.”

## Blockers before daily-driver Update

1. Install `minisign`, generate keypair, ≥2 offline backups, fill `KEY_CUSTODY.md`
2. Bake pubkey + `mkmk10k/comail` `latest.json` into `tauri.conf.json`; set `UPDATE_CHANNEL=rauta`; **bundle-audit** updater points at our channel
3. Publish ≥1 signed release; run UPD-04/06/07 + ROLLBACK-01 on real disk
4. Complete Global DoD checkboxes with evidence

## One-click unsubscribe — production dogfood (post-build)

**Recon 2026-07-29:** both targets advertise RFC 8058 (`List-Unsubscribe` HTTPS + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`). Live IMAP verified; do not re-probe.

**DB caveat:** `messages.list_unsubscribe` was empty for all 7646 rows at recon time. Unsubscribe path must backfill from on-disk raw MIME (or live IMAP) before POST — see `backfill_unsubscribe_headers` in comail-core.

| # | Sender | Account | msg id | thread | Notes |
|---|--------|---------|--------|--------|-------|
| 1 | **SoFi** | `mikko.sj.kiiskila@gmail.com` (acct 2) | **7610** | t5408 | `no-reply@r.sofi.com` · “Stay on top of your money…” · AllMail uid 60977. Alt: **7408** / INBOX 37451 |
| 2 | **Mike / Refero** | `mikko.sampo.k@gmail.com` (acct 9) | **7169** | t5123 | `mike@mails.refero.design` · “Weekly design update is here” · INBOX uid 123. Alt: **6803** |

**Pass criteria (per sender):** toast reports one-click success (not “opened browser”); second press is honest no-op / already-done; no silent failure.

| Sender | Status | Evidence |
|--------|--------|----------|
| SoFi 7610 | pending | wait for local rebuild + `install-local-macos.sh` |
| Refero 7169 | pending | wait for local rebuild + `install-local-macos.sh` |

Backups if primary gone: Luma (api.luma.com one-click), Glide/SendGrid, Ford Careers, Spreaker.
