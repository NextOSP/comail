# Comail

Email that keeps up with you. Comail is a fast, keyboard-driven desktop mail
client that stores your whole mailbox locally, searches it by meaning without
sending anything to the cloud, and stays out of your way. Built on Tauri 2 with
a React front end and a Rust core.

![Comail inbox](docs/screenshot.png)

## Why Comail

- **It is fast.** Native window, Rust core, and a local database. Opening,
  searching, and triaging happen instantly because your mail is already on disk.
- **It works offline.** The full mailbox syncs into SQLite. Read, search,
  compose, and triage on a plane. Everything you do queues and replays when you
  reconnect.
- **It is private.** Semantic search and the default embedding model run on your
  machine. Credentials live in the OS keyring, never in a file. Bring your own
  AI key only if you want the optional cloud features.
- **It is yours.** Free and open source under the AGPL, no account, no
  telemetry, no subscription.

## Ask your inbox, on your machine

Comail understands what you mean, not just the words you typed. It bundles a
small embedding model (bge-small) and indexes your mail into a local vector
store, so you can ask "what did Ana want changed on the roadmap deck" and get the
right thread back even if it never used those words.

Under the hood it fuses two searches: keyword matching (SQLite FTS5) and vector
similarity, combined with reciprocal rank fusion so precise terms and fuzzy
intent both count. None of it phones home. There is no API call and no account,
and it keeps working with the network off. Prefer a hosted embedding model? Point
Comail at one. The default is local.

## Features

- **Every account in one place.** Generic IMAP/SMTP with a password or app
  password, Gmail (OAuth2), and Microsoft 365 / Outlook (OAuth2).
- **Keyboard first.** `J`/`K` to move, `E` to mark done, `H` to snooze, `C` to
  compose, `Cmd/Ctrl+K` for the command palette, `?` for every shortcut.
- **Search that finds it.** Instant keyword search with `from:`, `in:`, `is:`,
  and `has:` operators, plus the local semantic search above.
- **A calmer inbox.** Split inbox (Important, Other, and your own rules), snooze,
  send later, and undo send with a delayed dispatch you can actually cancel.
- **Write faster.** Snippets, one-key unsubscribe (`Cmd+U`), and optional AI over
  any OpenAI-compatible endpoint for thread summaries, reply drafting, and
  drafting in your own voice learned from your sent mail.
- **Attachments both ways.** Open what you receive, attach files to drafts.
- **Calendar built in.** Meeting invites are parsed into a local agenda with a
  day or week peek (`0` / `2`).
- **Always running, out of the way.** Lives in the tray and keeps syncing after
  you close the window.
- **Looks right anywhere.** Snow and Carbon light and dark themes, a UI in
  English, Spanish, French, Chinese, and Vietnamese, and a Linux build that
  detects your GPU and picks the correct renderer on its own.
- **Updates itself.** Comail checks GitHub Releases on launch and installs new
  signed builds in place. See [Updates](#updates).

## Development setup (Linux)

System dependencies (Debian/Ubuntu):

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libdbus-1-dev
```

Rust (via [rustup](https://rustup.rs)) and Node 20+ with pnpm.

```bash
pnpm install
pnpm tauri dev        # full app
pnpm dev              # front end only, in the browser with mock data
```

The mock mode is worth knowing about: `pnpm dev` runs the real UI against
in-memory fixture data, no account or backend required. The screenshot above was
taken from it.

Rust tests: `cargo test` inside `src-tauri/`. The end-to-end suite runs the full
sync engine against a throwaway Dovecot and is gated behind an env var:

```bash
docker run -d --name comail-dovecot -e USER_PASSWORD='{plain}pass' \
  -p 10993:31993 -p 10143:31143 -p 10587:31587 dovecot/dovecot:latest
COMAIL_TEST_IMAP=1 cargo test -p comail-core
```

The send test also needs a local SMTP sink (STARTTLS and AUTH, stores deliveries
as files):

```bash
openssl req -x509 -newkey rsa:2048 -keyout /tmp/sink-key.pem -out /tmp/sink-cert.pem \
  -days 30 -nodes -subj "/CN=127.0.0.1"
python3 crates/comail-core/tests/support/smtp_sink.py /tmp/sink-out /tmp/sink-cert.pem /tmp/sink-key.pem &
COMAIL_TEST_IMAP=1 COMAIL_TEST_SINK_DIR=/tmp/sink-out cargo test -p comail-core --test send_e2e
```

Dev and test switches (never set these for real accounts):

- `COMAIL_TLS_INSECURE=1` skips TLS certificate verification, for self-signed
  servers.
- `COMAIL_CREDENTIALS_INSECURE_FILE=<path>` uses a plaintext-JSON credential
  store, for machines without an OS keyring or Secret Service.

## OAuth setup (optional, for Gmail and Microsoft accounts)

Bring your own app registration and enter it in Settings, OAuth apps
(`Cmd/Ctrl+,`). There is a full walkthrough including testing in
[docs/oauth-setup.md](docs/oauth-setup.md). Env vars override the Settings values
when set:

- Google (Google Cloud Console, OAuth client, type "Desktop app"; the consent
  screen must be in Production or refresh tokens expire in 7 days):
  `COMAIL_GOOGLE_CLIENT_ID`, `COMAIL_GOOGLE_CLIENT_SECRET`.
- Microsoft (Entra ID app registration, platform "Mobile and desktop
  applications", redirect `http://localhost`, no secret): `COMAIL_MS_CLIENT_ID`.

Generic IMAP/SMTP accounts (Fastmail, iCloud, self-hosted, and the like) need no
setup. Use an app password.

## Architecture

- `src-tauri/crates/comail-core` is the Tauri-free Rust core: the IMAP sync
  engine (one actor per account), SMTP, MIME parse, build, and sanitize, SQLite
  (WAL) with FTS5, the offline action queue with optimistic mutations, the
  snooze and send-later scheduler, OAuth (PKCE and loopback), OS keyring
  credential storage, and the local embedding index.
- `src-tauri/src` is a thin adapter. Tauri commands call the core, core events
  are forwarded to the UI (with mail:updated coalescing), and the updater and
  single-instance plugins live here. It also detects the GPU on Linux and
  configures the WebKitGTK renderer accordingly.
- `src/` is the React UI: TanStack Query over the IPC boundary (events
  invalidate queries), zustand for UI state, and a single command registry that
  powers both the keymap and the Cmd+K palette.

Data lives in `~/.local/share/comail/` (the SQLite database and raw `.eml`
files). Secrets live in the OS keyring, never in the database.

## Linux GPU handling

WebKitGTK's DMABUF renderer is broken on many Linux GPU and Wayland
combinations and quietly falls back to software compositing, which pins a core
and makes scrolling stutter. Comail detects the situation at startup and picks
the right path on its own:

- Intel, AMD, nouveau, or any X11 session: the DMABUF renderer is disabled.
- Proprietary NVIDIA driver on Wayland: the DMABUF renderer stays on and is
  routed through NVIDIA's GBM backend, which is the fast path there.

You never have to choose a launch script. Setting `WEBKIT_DISABLE_DMABUF_RENDERER`
yourself still overrides the detection if you want manual control.

## Updates

Comail ships Tauri's updater. On launch it asks the GitHub Releases endpoint for
a newer signed build, and if one exists it offers to install and relaunch. There
is a manual check in Settings, General, under About, next to the version number.

Update packages are signed. The public key lives in `tauri.conf.json`; the
private key never leaves your hands. To publish updates from CI you generate a
key pair once:

```bash
pnpm tauri signer generate -w src-tauri/.tauri/comail.key
```

Put the public key in `plugins.updater.pubkey` in `tauri.conf.json`, and add the
private key and its password to the repository as the Actions secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private
key file is gitignored. On Linux the updater replaces AppImage installs; deb
users update by installing a new package.

The updater reads from the release tagged `latest`, so a GitHub release only
serves updates once it is published (a draft or prerelease will not).

## CI and releases

GitHub Actions (`.github/workflows/`):

- `ci.yml` runs on every push and PR to `master`: `pnpm typecheck`, `cargo fmt
  --check`, `cargo clippy`, `cargo test -p comail-core` (the IMAP and SMTP e2e
  tests are env-gated and auto-skip), and a full Linux `tauri build` to catch
  packaging breakage.
- `release.yml` runs on a `v*.*.*` tag: it builds installers for all three
  desktop platforms in a matrix and assembles a draft GitHub Release with the
  assets and the signed updater manifest attached.
  - Linux x64: `.deb`, `.AppImage`
  - macOS universal: `.dmg`
  - Windows x64: `.msi`, NSIS setup `.exe`

### Cutting a release

The version lives in three files that must stay in sync: `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (plus
`src-tauri/crates/comail-core/Cargo.toml`).

```bash
# bump all of them to X.Y.Z, commit, then:
git tag vX.Y.Z
git push origin master --tags
```

The workflow builds every OS and creates a draft release. Review the assets, add
notes, and publish. Publishing is also what makes the update available to
existing installs.

### Unsigned installers

The installers are not code-signed for macOS or Windows yet, so the OS warns on
first launch:

- macOS: right-click the app and choose Open, or run
  `xattr -dr com.apple.quarantine /Applications/Comail.app`.
- Windows: SmartScreen, More info, Run anyway.

The pipeline is ready for it. Add the `APPLE_*` or Windows certificate secrets and
the matching `bundle.macOS` or `bundle.windows` config and the same workflow will
sign the installers.

## License

Comail is free software, released under the GNU Affero General Public License
v3.0. See [LICENSE](LICENSE).
