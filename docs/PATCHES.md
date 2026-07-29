# rauta: patch index

| Commit / id | Summary | Risk (update path? profile storage?) |
|-------------|---------|--------------------------------------|
| hover-target-triage | Pointer hover beats cursor for triage targets; multi-select still wins | No update path |
| u-archive-unsubscribe | `U` = archive + List-Unsubscribe when present; `Shift+U` = read toggle | No update path |
| agentmail-archive-to-trash | Archive falls through to Trash when no Archive/All Mail; Shift+E restores | No update path |
| update-channel-lock | `UPDATE_CHANNEL=locked` refuses check/install until personal channel | **Touches update path** |

FaceTime/WhatsApp presets: already merged on `master` (prior PRs).
