# rauta: patch index

| Commit / id | Summary | Risk (update path? profile storage?) |
|-------------|---------|--------------------------------------|
| `00073c9` | Bundle: hover-target + U archive/unsub + AgentMail Trash + UPDATE_CHANNEL lock + MANIFEST/check-customs/VERIFICATION | **Touches update path** (lock only). TCs L1: UPD-00, CUSTOM-01 partial. Excludes: signed Update, BOOT-CHANNEL |
| hover-target-triage | Pointer hover beats cursor for triage targets; multi-select still wins | No update path |
| u-archive-unsubscribe | `U` = archive + List-Unsubscribe when present; `Shift+U` = read toggle | No update path |
| **one-click-unsubscribe** | RFC 8058 One-Click POST in Rust (`unsubscribe_message`); honest toasts; migration `019_list_unsubscribe_post`; `header_raw` fix for List-Unsubscribe Address parse | No update path |
| agentmail-archive-to-trash | Archive falls through to Trash when no Archive/All Mail; Shift+E restores | No update path |
| update-channel-lock | `UPDATE_CHANNEL=locked` refuses check/install until personal channel | **Touches update path** |

FaceTime/WhatsApp presets: already merged on `master` (prior PRs).

### One-click design notes (defensible)

- **RFC 2369** carries `List-Unsubscribe` HTTPS and/or mailto URIs (angle brackets preferred; some ESPs send bare HTTPS).
- **RFC 8058** adds `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Clients MUST POST `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded`, HTTPS only, no cookies/credentials; senders MUST NOT redirect the POST. Success = HTTP 2xx.
- **Gmail/Yahoo (2024+) / Microsoft (2025+)** require One-Click for bulk marketing/subscribed mail. DKIM must cover both headers (sender-side).
- Comail previously opened the URL with GET in a browser and claimed success — wrong verb/layer. Mailto opened a composer and never sent.