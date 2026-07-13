# Development guide

Contributing? Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the test suites
and project conventions.

## Setup (Linux)

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
in-memory fixture data, no account or backend required. The screenshots in the
README were taken from it.

## Tests

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

## Architecture

- `src-tauri/crates/comail-core` is the Tauri-free Rust core: the IMAP sync
  engine (one actor per account), SMTP, MIME parse, build, and sanitize, SQLite
  (WAL) with FTS5, the offline action queue with optimistic mutations, the
  snooze and send-later scheduler, the CalDAV client (discovery, two-way sync,
  RRULE expansion, offline push queue), OAuth (PKCE and loopback), OS keyring
  credential storage, the attachment preview converters, and the local
  embedding index.
- `src-tauri/src` is a thin adapter. Tauri commands call the core, core events
  are forwarded to the UI (with mail:updated coalescing), and the updater and
  single-instance plugins live here. It also detects the GPU on Linux and
  configures the WebKitGTK renderer accordingly.
- `src/` is the React UI: TanStack Query over the IPC boundary (events
  invalidate queries), zustand for UI state, and a single command registry that
  powers both the keymap and the Cmd+K palette.

Data lives in `~/.local/share/comail/` (the SQLite database and raw `.eml`
files). Secrets live in the OS keyring, never in the database.

### Local semantic search

Comail bundles a small embedding model (bge-small) and indexes mail into a
local vector store. Queries fuse two searches: keyword matching (SQLite FTS5)
and vector similarity, combined with reciprocal rank fusion so precise terms
and fuzzy intent both count. None of it phones home, and it keeps working with
the network off. A hosted embedding model can be configured instead; the
default is local.

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

## Updater signing

Comail ships Tauri's updater. Update packages are signed. The public key lives
in `tauri.conf.json`; the private key never leaves your hands. To publish
updates from CI you generate a key pair once:

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
  desktop platforms in a matrix and assembles a GitHub Release with the assets
  and the signed updater manifest attached.
  - Linux x64: `.deb`, `.AppImage`
  - macOS universal: `.dmg`
  - Windows x64: `.msi`, NSIS setup `.exe`
- `check-signing.yml` is a manual ~30s sanity check for the macOS code-signing
  secrets; run it after touching the `APPLE_*` secrets, before cutting a tag.
  See [src-tauri/CODESIGNING.md](../src-tauri/CODESIGNING.md).

### Cutting a release

The version lives in three files that must stay in sync: `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.

```bash
# bump all of them to X.Y.Z, commit, then:
git tag vX.Y.Z
git push origin master --tags
```

The workflow builds every OS and publishes the release, which is also what
makes the update available to existing installs.
