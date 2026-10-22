# Permanent deletion from Trash: protocol spike and implementation plan

## Status and scope

This draft starts at upstream `master` (`fab31c385d9940da8b06d59bf3ce2f5f4f2cdae8`).
It is **not a finished user-facing fix**. It adds an IMAP primitive and isolated
integration probes; it does not add an app IPC endpoint, action-queue handler,
Trash button, or Empty Trash operation. Do not merge as a complete feature yet.

Today, `ActionKind::Trash` moves messages to the Trash folder and skips messages
already there. Repeating that action is not permanent deletion. The existing
`expunge_all` helper deletes all messages bearing `\\Deleted` in the selected
folder, which is too broad for deleting only the user's selection.

## Protocol contract demonstrated by this branch

`imap::uid_delete_permanently(session, uid)`:

1. Reject UID zero.
2. Check that the authenticated server advertises `UIDPLUS`.
3. Issue `UID STORE <uid> +FLAGS (\\Deleted)`.
4. Issue `UID EXPUNGE <uid>` and drain the response.

There is deliberately **no plain EXPUNGE fallback**. If UIDPLUS is absent, fail
before STORE. This initial policy is conservative, including for servers that
advertise only IMAP4rev2; broader capability support needs separate verification.
The caller must select and validate the intended folder and UIDVALIDITY. This
low-level helper does not know whether a folder is Trash or own a database row.
A timeout can leave a partial operation; discard the session, reconnect,
revalidate identity, and retry. A successful retry against an absent UID is a
no-op, provided the folder and UIDVALIDITY are unchanged.

## Executed validation

Two loopback-only Dovecot 2.4.5 containers, using synthetic messages and an isolated
user (`permanentdeleteprobe`), never real account credentials or app data:

- UIDPLUS server: only the selected UID disappears; an unrelated normal message
  and an unrelated message already marked `\\Deleted` remain.
- Reconnect and repeat the same deletion: succeeds without deleting remaining mail.
- UID zero: rejected without removing messages.
- Control: ordinary EXPUNGE subsequently removes the unrelated flagged message,
  demonstrating why it is not a safe selective-delete fallback.
- Server configured not to advertise UIDPLUS: request rejected; every message
  remains and none acquires the `\\Deleted` flag.

Results: **2 live protocol tests passed, 0 ignored** when explicitly invoked;
**339 core library tests passed, 3 existing tests ignored**. The library suite
also reports an existing unused `ms207` import warning in `caldav/push.rs`.
The protocol tests are explicitly ignored in normal test runs because they
require disposable servers; a normal green CI run does not prove they executed.

These results validate the Rust helper against a local IMAP endpoint, **not an
app IPC endpoint or the complete delete feature**. Gmail, Outlook, arbitrary
providers, UIDVALIDITY reset, crash recovery, concurrent moves, and the macOS
WebView have not been verified by these probes.

## Reproduction

Docker and Rust are required. Reserve container names and loopback ports
11993/12993 for these disposable fixtures. Use only synthetic mail. The second
server deliberately hides UIDPLUS to exercise the fail-closed behavior; it is
not evidence about every real server that lacks the extension.

```sh
IMAGE=dovecot/dovecot@sha256:43c14def08a57f25107593cbcf64a0a6fbae84a7b9de7aa038513c9b21e91914

docker run -d --name comail-permanent-delete-probe \
  -e USER_PASSWORD='{plain}pass' \
  -p 127.0.0.1:11993:31993 "$IMAGE"

docker run -d --name comail-permanent-delete-no-uidplus \
  -e USER_PASSWORD='{plain}pass' \
  -p 127.0.0.1:12993:31993 "$IMAGE" \
  /dovecot/sbin/dovecot -F -o 'imap_capability=IMAP4rev1'

# Configure the actual worker processes too: a master -o override alone did
# not remove UIDPLUS from authenticated CAPABILITY in this Docker image.
CONFIG=$(mktemp)
docker cp comail-permanent-delete-no-uidplus:/etc/dovecot/dovecot.conf "$CONFIG"
python3 - "$CONFIG" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
assert 'imap4rev2_enable = yes' in text
p.write_text(text.replace('imap4rev2_enable = yes',
                         'imap4rev2_enable = no\nimap_capability = IMAP4rev1'))
PY
docker cp "$CONFIG" comail-permanent-delete-no-uidplus:/etc/dovecot/dovecot.conf
docker restart comail-permanent-delete-no-uidplus
# Wait for the Dovecot startup log before running the tests.

cd src-tauri
COMAIL_TLS_INSECURE=1 cargo test -p comail-core \
  --test permanent_delete_probe -- --ignored --nocapture
cargo test -p comail-core --lib
```

TLS certificate verification is disabled only in the probe process for these
self-signed loopback fixtures. Never export that variable for a production app.
The probes create uniquely named folders and deliberately do not reset any
existing mailbox. Remove the two disposable containers and their fixture volumes
when finished; do not reuse an account containing real mail for these tests.

## Proposed application implementation

### 1. Selected-message deletion first

Add a `delete_permanently` action via the existing Tauri `perform_action` command and
frontend action types. The UI can operate on selected threads, but the backend
must resolve **only messages currently in Trash**, not every message sharing
the thread. Keep ordinary Trash behavior outside Trash unchanged. Add a clear,
non-undoable confirmation dialog and explicit pending/failure feedback. No fake
Undo toast after irreversible deletion.

Inspect other generic action consumers (MCP tools, automation, keyboard commands,
mock IPC and batch actions) when extending the enum; do not accidentally expose
irreversible deletion through an unconfirmed generic action path.

### 2. Validate identity and serialize actions

Before enqueueing, verify account ownership, Trash role, concrete folder ID,
nonzero remote UID and known UIDVALIDITY. Reject or defer messages with an
unresolved UID after a pending move rather than reporting deletion success.
Snapshot account, folder, UID and UIDVALIDITY in a durable payload. Serialize
against moves and sync for the same message/account. Re-select and revalidate
Trash membership and UIDVALIDITY at execution and on every retry. If validity
changes, stop and resync; never reuse a stale UID in a new UID namespace.

UIDPLUS absence and policy violations need explicit terminal error categories,
not the queue's current string-based transient-error heuristic. A network error
may be retried, but with a fresh connection and revalidated identity.

### 3. Remote-first completion and local cleanup

Keep enough local state to retry until the server operation is confirmed. Do not
delete the DB row first or claim success merely because the request was queued.
After remote success, transactionally finish the pending action, remove the
message and its dependent records, and recompute the surviving thread/counts.
Verify foreign-key cascades and search/vector index cleanup explicitly; the
existing `messages::delete` only directly deletes FTS and the message row.
Schedule safe body/attachment-cache cleanup without deleting files referenced by
surviving records. Emit `MailUpdated` and invalidate list/detail/count/search
queries. Handle the crash window between remote deletion and local commit with
an idempotent retry. Coordinate with expunge reconciliation, which currently
skips messages with pending actions.

### 4. Empty Trash as a separate follow-up

Ship selected deletion before bulk deletion. For Empty Trash, show explicit
account/folder scope and confirmation. Snapshot remote UIDs so messages arriving
after confirmation are not included, and account for mail not downloaded locally.
Use bounded batches of targeted UID EXPUNGE, progress, partial failure reporting,
and cancellation of work not yet sent. Do not implement it by blindly calling
`expunge_all` or by deleting only the currently loaded thread-list page.

## Required acceptance tests before ready-for-review

- Core/DB: reject non-Trash, wrong-account, unknown UID, changed UIDVALIDITY and
  pending moves; preserve Inbox/Sent members of a mixed-folder thread.
- Queue: failure before/after STORE, disconnect during EXPUNGE, crash after remote
  success, retry after message disappearance, no resurrection by sync, and no
  success notification while the operation is merely pending.
- UI: confirmation/cancel, multi-select, unread badges, detail/list/search cache,
  keyboard/context menu paths, unsupported-server and partial-failure messages.
- Full Core-to-IMAP integration on disposable Dovecot, not just the helper.
- Dedicated test accounts for Gmail and Outlook provider semantics before claiming
  broad compatibility; no destructive testing on the user's production mailbox.
- macOS DMG smoke test after the IPC and UI are implemented.
