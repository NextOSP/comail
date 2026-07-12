# Contributing to Comail

Comail is a keyboard-first, offline-first desktop email client: a Tauri 2 shell
around a Tauri-free Rust core (`comail-core`) and a React/TypeScript frontend.
This guide covers setup, the test suites, and the project conventions that are
easy to trip over.

## Setup

System packages (Debian/Ubuntu):

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libdbus-1-dev
```

Toolchain: Rust (rustup, stable), Node 20+, pnpm.

```bash
pnpm install
pnpm tauri dev        # full app (Rust + webview)
pnpm dev              # frontend only, in a browser with mock data
```

**Mock mode** is the fastest way to work on UI: `pnpm dev` serves the app at
`localhost:1420` with a fully scripted backend (`src/ipc/mock.ts`) — threads,
splits, labels, settings, AI, everything. If a feature needs a new IPC command,
add a mock implementation so the browser workflow keeps working.

## Project layout

| Path | What lives there |
|---|---|
| `src-tauri/crates/comail-core` | All email logic, no Tauri dependency: IMAP sync actors, SMTP, MIME, SQLite (WAL + FTS5), offline action queue, OAuth (PKCE + loopback), auto-label classifier, embeddings |
| `src-tauri/src` | Thin adapter: Tauri command handlers call `Core`; core events forward to the UI |
| `src/` | React UI: TanStack Query over IPC, zustand UI store, one command registry driving keymap + palette + help |
| `src/ipc/types.ts` | The IPC contract (see conventions below) |
| `src/i18n/locales/<lang>/*.json` | All user-visible strings |

## Tests

```bash
# Rust unit tests (fast; in-memory SQLite via db::testutil)
cd src-tauri && cargo test -p comail-core --lib

# Frontend unit tests (vitest, pure logic, no DOM)
pnpm test

# Typecheck
pnpm typecheck
```

### End-to-end suites (env-gated, auto-skip without the env vars)

The sync/threading/split/label/undo/snooze suite runs against a throwaway
Dovecot:

```bash
docker run -d --name comail-dovecot -e USER_PASSWORD='{plain}pass' \
  -p 10993:31993 -p 10143:31143 -p 10587:31587 dovecot/dovecot:latest
cd src-tauri && COMAIL_TEST_IMAP=1 cargo test -p comail-core
```

The send suite additionally needs the SMTP sink **started by hand** (the test
does not spawn it):

```bash
openssl req -x509 -newkey rsa:2048 -keyout /tmp/sink-key.pem -out /tmp/sink-cert.pem \
  -days 30 -nodes -subj "/CN=127.0.0.1"
python3 crates/comail-core/tests/support/smtp_sink.py /tmp/sink-out /tmp/sink-cert.pem /tmp/sink-key.pem &
COMAIL_TEST_IMAP=1 COMAIL_TEST_SINK_DIR=/tmp/sink-out cargo test -p comail-core --test send_e2e
```

Gotchas: a stale sink squatting on port 10588 makes `send_e2e` time out —
kill it first. Run the integration binaries one at a time; parallel runs can
exceed Dovecot's per-user connection cap and stall.

Perf suite (100k messages, latency budgets): `COMAIL_TEST_PERF=1 cargo test -p comail-core --test perf --release`.

Dev/test env switches (never for real accounts): `COMAIL_TLS_INSECURE=1`,
`COMAIL_CREDENTIALS_INSECURE_FILE=<path>`.

## Conventions that bite

**The IPC contract is hand-mirrored.** `src/ipc/types.ts` and
`comail-core/src/models.rs` describe the same shapes (serde renames to
camelCase). Change one, change the other in the same commit.

**Adding a `Settings` field touches five places**, all in one commit:
1. `models.rs` (`Settings` struct — give it a `#[serde(default)]` so old blobs
   still deserialize — plus the `Default` impl)
2. `src/ipc/types.ts`
3. `DEFAULT_SETTINGS` in `src/components/settings/SettingsPanel.tsx`
4. `DEFAULT_MOCK_SETTINGS` in `src/ipc/mock.ts`
5. The settings literal in `src/keyboard/context.ts` (`setTheme`)

There is a unit test (`settings::tests::old_blob_gets_field_defaults`) that
catches forgetting the serde default.

**Split-id convention:** `-1` = implicit Important, `-2` = implicit Other,
`> 0` = a `split_rules` row, `null` = whole inbox. Important/Other are not
stored rows — they are `is_automated` filters computed at sync time.

**Auto labels are local-only.** The Marketing/News/Social/Pitch rows in
`labels` carry `is_auto = 1`, are classified in `autolabel/` during
`store_headers`, and are **never pushed to IMAP**. Two guards protect this:
`reconcile_keywords` skips `is_auto` labels, and the action path skips the
keyword enqueue. If you touch label sync, keep the regression test
`labels::tests::reconcile_skips_auto_labels` passing.

**Message-IDs are stored without angle brackets** (mail-parser strips them);
sent-message dedupe depends on this.

**Migrations are append-only** and numbered; check `db/migrations.rs` for the
next free number right before you land (parallel branches collide here).

**Every user-visible string goes through i18n**: add the key to
`src/i18n/locales/en/<ns>.json` and use `t("ns:key")`. No hardcoded UI strings,
and no em dashes in UI copy (use periods or `·`).

**Unit-test placement:** Rust tests live in `#[cfg(test)]` modules next to the
code, using `crate::db::testutil` for a migrated in-memory DB. Frontend tests
are `src/**/*.test.ts`, vitest in node mode — pure logic only; UI behavior is
covered by mock-mode scenarios and the e2e suites. Extract logic into
`src/lib/` when it's worth testing (see `quotes.ts`).

## Before you open a PR

```bash
pnpm typecheck && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy && cargo test -p comail-core --lib
```

CI runs exactly these plus a full Linux `tauri build`. Keep commits focused;
write messages that state what changed and why. Releases are cut by tagging
`v*.*.*` (see README for the version-bump checklist across `package.json`,
`tauri.conf.json`, and the two `Cargo.toml`s).
