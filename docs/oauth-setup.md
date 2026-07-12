# OAuth setup - Gmail & Microsoft, step by step

Comail signs into Gmail and Microsoft mailboxes with OAuth 2.0 (authorization
code + PKCE over a localhost loopback redirect). Because Comail is not a
hosted service, **you bring your own app registration** - a client ID that
tells Google/Microsoft "this app is allowed to ask for mail access."

You only do this once per provider. After that, adding any number of accounts
is just clicking **Sign in with Google / Microsoft**.

Where the values go (either works; env vars win if both are set):

| Method | Google | Microsoft |
|---|---|---|
| Settings UI (`Cmd/Ctrl+,` → **OAuth apps**) | Google client ID + secret | Microsoft client ID |
| Environment variables | `COMAIL_GOOGLE_CLIENT_ID`, `COMAIL_GOOGLE_CLIENT_SECRET` | `COMAIL_MS_CLIENT_ID` |

---

## Part 1 - Google (Gmail)

### 1. Create a Google Cloud project
1. Open <https://console.cloud.google.com/> and sign in.
2. Top bar → project picker → **New project**. Name it e.g. `comail`, click
   **Create**, then select it.

### 2. Configure the OAuth consent screen
1. Menu → **APIs & Services → OAuth consent screen**.
2. User type: **External** (unless you have a Workspace org - then Internal
   is simpler and skips verification entirely). Click **Create**.
3. Fill in the app name (`Comail`), your email as user support + developer
   contact. Save through the steps.
4. **Scopes** step: click **Add or remove scopes**, paste
   `https://mail.google.com/` into the manual entry box, add it, save.
   (This is the only scope Google accepts for IMAP/SMTP XOAUTH2; Comail also
   requests `openid email` to learn the account address.)
5. **Test users** step: add the Gmail address(es) you'll sign in with.

> **Important - 7-day token expiry:** while the consent screen is in
> *Testing* status, Google expires refresh tokens after 7 days, and the
> account will flip to "needs reauth" weekly. Once things work, go back to
> the consent screen and click **Publish app** (Production). Google will
> warn about verification for the sensitive scope - for personal use you can
> stay unverified; you'll just see an "unverified app" interstitial at
> sign-in (click *Advanced → Go to Comail*).

### 3. Create the OAuth client
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name: `Comail desktop`. **Create**.
3. Copy the **Client ID** (`…apps.googleusercontent.com`) and the
   **Client secret** (`GOCSPX-…`). For Desktop-app clients Google does not
   treat the secret as confidential - storing it on your machine is the
   intended model.

No redirect URI configuration is needed: Desktop-app clients automatically
accept `http://127.0.0.1:<any-port>`, which is exactly what Comail's loopback
listener uses. You also do **not** need to enable the Gmail API - IMAP/SMTP
XOAUTH2 doesn't go through it.

### 4. Enter the values in Comail
1. Launch Comail → `Cmd/Ctrl+,` (Settings) → **OAuth apps**.
2. Paste the client ID and client secret. Fields save on blur/Enter.

---

## Part 2 - Microsoft (Outlook.com / Microsoft 365)

### 1. Register an app in Entra
1. Open <https://entra.microsoft.com/> → **Identity → Applications →
   App registrations → New registration**.
   (Same thing lives at portal.azure.com → "App registrations".)
2. Name: `Comail`.
3. Supported account types: **Accounts in any organizational directory and
   personal Microsoft accounts** - this covers both Outlook.com and
   work/school mailboxes.
4. Redirect URI: platform **Public client/native (mobile & desktop)**, value
   `http://localhost`. (Loopback redirects on any port are then accepted.)
5. **Register**, then copy the **Application (client) ID** from the Overview
   page. No client secret - desktop apps are public clients.

### 2. Add API permissions
1. In the app: **API permissions → Add a permission → Microsoft Graph →
   Delegated permissions**.
2. Add: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`, `openid`,
   `email`.
3. No admin consent is needed for personal accounts; work/school tenants may
   require an admin to consent depending on tenant policy.

### 3. Enter the value in Comail
Settings (`Cmd/Ctrl+,`) → **OAuth apps** → paste into **Microsoft client ID**.

> **Microsoft 365 note:** some tenants disable IMAP/SMTP AUTH per-mailbox.
> If sign-in succeeds but sync errors, the tenant admin needs to enable
> IMAP and Authenticated SMTP for the mailbox (Microsoft 365 admin center →
> user → Mail → Manage email apps).

---

## Part 3 - Testing the flow end to end

### A. Happy path
1. Start Comail (`pnpm tauri dev` or the installed build).
2. Settings → **Accounts** → **Sign in with Google** (or Microsoft).
3. Expected sequence:
   - Your default browser opens the provider's consent page.
   - Google testing-mode: "Google hasn't verified this app" → *Advanced →
     Go to Comail*; then a checkbox page asking for Gmail access.
   - After approving, the browser shows Comail's "You can close this window"
     page and the app comes back with a toast **"Account connected -
     syncing…"**.
4. Verify in the UI:
   - The account appears under Settings → Accounts with a blue (syncing) →
     green (idle) dot.
   - `Cmd/Ctrl+1..9` filters to that account; inbox threads stream in
     (recent mail first, then history backfill).
5. Verify SMTP: compose (`C`), mail yourself, send. The message must land in
   the inbox *and* appear once (not twice) in Sent - Comail appends to Sent
   only when the server doesn't do it automatically.
6. Verify token refresh: quit Comail fully (tray → Quit), relaunch - the
   account must come back without re-prompting the browser. (Access tokens
   last ~1h; a sync after that exercises the refresh path silently.)

### B. Failure paths worth checking once
| What to do | What should happen |
|---|---|
| Click sign-in with no client ID configured | Immediate error toast: "no OAuth app configured for gmail: add a client ID in Settings…" - no browser opens |
| Close the browser tab without approving | Comail times out after 5 min with a clean error; retry works |
| Click **Cancel/Deny** on the consent page | Error toast, no half-created account in the list |
| Revoke access afterwards (Google: myaccount.google.com → Security → Third-party access; MS: account.live.com/consent/Manage) | On next sync the account flips to a red **needs reauth** dot; signing in again repairs it |
| Paste a wrong client ID | Provider's error page in the browser (`invalid_client` / `unauthorized_client`) |

### C. Troubleshooting
- **`redirect_uri_mismatch` (Google)** - the OAuth client type isn't
  "Desktop app". Recreate it with the right type; Web clients don't accept
  loopback redirects.
- **`AADSTS50011` redirect mismatch (Microsoft)** - the `http://localhost`
  redirect URI is missing, or was added under "Web" instead of
  "Mobile and desktop applications".
- **Account works, then dies after ~7 days (Google)** - consent screen still
  in Testing. Publish to Production (Part 1, step 2 note).
- **Browser never opens** - the URL is also logged; check the terminal
  running `pnpm tauri dev` (look for the `accounts.google.com` /
  `login.microsoftonline.com` URL and open it by hand).
- **Sign-in OK but IMAP fails (Microsoft work account)** - tenant has
  IMAP/SMTP AUTH disabled; see the Microsoft 365 note above.

### D. Where things are stored (for verification/cleanup)
- Refresh + access tokens: OS keyring (Secret Service / Keychain), service
  `comail`, per-account entries. Removing the account in Settings deletes
  them.
- Client ID/secret from Settings: the local SQLite settings table
  (`~/.local/share/comail/` on Linux). A client ID is not a user credential -
  it identifies the *app*, not you.
