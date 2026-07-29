# rauta: patch index

| Commit / id | Summary | Risk (update path? profile storage?) |
|-------------|---------|--------------------------------------|
| `00073c9` | Bundle: hover-target + U archive/unsub + AgentMail Trash + UPDATE_CHANNEL lock + MANIFEST/check-customs/VERIFICATION | **Touches update path** (lock only). TCs L1: UPD-00, CUSTOM-01 partial. Excludes: signed Update, BOOT-CHANNEL |
| hover-target-triage | Pointer hover beats cursor for triage targets; multi-select still wins | No update path |
| u-archive-unsubscribe | `U` = archive + List-Unsubscribe when present; `Shift+U` = read toggle | No update path |
| agentmail-archive-to-trash | Archive falls through to Trash when no Archive/All Mail; Shift+E restores | No update path |
| update-channel-lock | `UPDATE_CHANNEL=locked` refuses check/install until personal channel | **Touches update path** |

FaceTime/WhatsApp presets: already merged on `master` (prior PRs).
