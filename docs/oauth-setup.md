# OAuth setup: Gmail and Microsoft

> Connect your own Google and Microsoft mailboxes to Comail, step by step.

Comail signs into Gmail and Microsoft mailboxes with **OAuth 2.0** (authorization
code + PKCE over a localhost loopback redirect). Because Comail is not a hosted
service, **you bring your own app registration**: a client ID that tells
Google/Microsoft "this app is allowed to ask for mail access."

> [!TIP]
> You only do this **once per provider**. After that, adding any number of
> accounts is just clicking **Sign in with Google / Microsoft**.

### Where the values go

Either method works. Environment variables win if both are set.

| Method | Google | Microsoft |
| --- | --- | --- |
| Settings UI (`Cmd/Ctrl` + `,` &rarr; **OAuth apps**) | Google client ID + secret | Microsoft client ID |
| Environment variables | `COMAIL_GOOGLE_CLIENT_ID`, `COMAIL_GOOGLE_CLIENT_SECRET` | `COMAIL_MS_CLIENT_ID` |

### Contents

- [Part 1: Google (Gmail)](#part-1-google-gmail)
- [Part 2: Microsoft (Outlook.com / Microsoft 365)](#part-2-microsoft-outlookcom--microsoft-365)
- [Part 3: Testing the flow end to end](#part-3-testing-the-flow-end-to-end)
- [Troubleshooting](#troubleshooting)
- [Where things are stored](#where-things-are-stored)

---

## Part 1: Google (Gmail)

> **Goal:** a **Client ID** (`...apps.googleusercontent.com`) and a
> **Client secret** (`GOCSPX-...`).

### Step 1 &middot; Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in.
2. Top bar &rarr; project picker &rarr; **New project**. Name it e.g. `comail`,
   click **Create**, then select it.

### Step 2 &middot; Configure the OAuth consent screen

1. Menu &rarr; **APIs & Services** &rarr; **OAuth consent screen**.
2. User type: **External** (unless you have a Workspace org, in which case
   Internal is simpler and skips verification entirely). Click **Create**.
3. Fill in the app name (`Comail`), and your email as user support + developer
   contact. Save through the steps.
4. **Scopes** step: click **Add or remove scopes**, paste
   `https://mail.google.com/` into the manual entry box, add it, and save.
   This is the only scope Google accepts for IMAP/SMTP XOAUTH2; Comail also
   requests `openid email` to learn the account address.
5. **Test users** step: add the Gmail address(es) you will sign in with.

> [!IMPORTANT]
> **7-day token expiry.** While the consent screen is in *Testing* status,
> Google expires refresh tokens after 7 days, and the account flips to "needs
> reauth" weekly. Once things work, return to the consent screen and click
> **Publish app** (Production). Google warns about verification for the
> sensitive scope; for personal use you can stay unverified and just click
> through an "unverified app" interstitial at sign-in (**Advanced** &rarr;
> **Go to Comail**).

### Step 3 &middot; Create the OAuth client

1. **APIs & Services** &rarr; **Credentials** &rarr; **Create credentials**
   &rarr; **OAuth client ID**.
2. Application type: **Desktop app**. Name: `Comail desktop`. Click **Create**.
3. Copy the **Client ID** and the **Client secret**.

> [!NOTE]
> For Desktop-app clients, Google does not treat the secret as confidential, so
> storing it on your machine is the intended model. No redirect URI setup is
> needed: Desktop clients automatically accept `http://127.0.0.1:<any-port>`,
> which is exactly what Comail's loopback listener uses. You also do **not**
> need to enable the Gmail API, since IMAP/SMTP XOAUTH2 does not go through it.

### Step 4 &middot; Enter the values in Comail

1. Launch Comail &rarr; `Cmd/Ctrl` + `,` (Settings) &rarr; **OAuth apps**.
2. Paste the client ID and client secret. Fields save on blur/Enter.

---

## Part 2: Microsoft (Outlook.com / Microsoft 365)

> **Goal:** one **Application (client) ID**. That is all.

> [!NOTE]
> There is no client secret, no certificate, and no API key for the Microsoft
> setup. Comail is a desktop app, which Microsoft treats as a *public client*
> that cannot keep a secret. If a guide or the portal nudges you toward
> **Certificates & secrets**, skip it; Comail never asks for a secret.

### "Entra is for enterprise, I just have a normal Outlook.com account"

This is the most common source of confusion, so read this first.

**Registering the app and using your mailbox are two different things.** The
app registration is done once, in the Entra / Azure portal, and it is the same
portal for everyone. There is **no** separate consumer portal for a personal
`@outlook.com` / `@hotmail.com` / `@live.com` account.

> [!IMPORTANT]
> A **personal Microsoft account** can register an app for free. When you sign
> into <https://entra.microsoft.com/> (or <https://portal.azure.com/>) with your
> personal account, Microsoft automatically creates a free **default directory**
> (a personal Entra tenant) behind the scenes. App registration lives there.
> You do **not** need an Azure subscription, a paid plan, a company, or a credit
> card. Registering an app is free.

Keep these two roles separate:

| Role | What it is | Example |
| --- | --- | --- |
| The account you **register the app with** | Signs into the portal and owns the app registration. Any Microsoft account works, including a personal one. | Your `@outlook.com` login for entra.microsoft.com |
| The mailbox(es) you **sign into Comail** | The inbox Comail actually syncs. Can be personal *or* work/school. | Any `@outlook.com`, `@hotmail.com`, or Microsoft 365 mailbox |

They can be the same account or completely different ones. The point of picking
**multitenant + personal** in Step 1 is exactly so that one app registration can
sign in *any* kind of mailbox, personal or work.

> [!TIP]
> If <https://entra.microsoft.com/> shows a confusing or restricted view with a
> personal account, use <https://portal.azure.com/> instead and search for
> **App registrations** in the top search bar. Both reach the same registration;
> the Azure portal path is often smoother for personal accounts.

### Step 1 &middot; Register an app in Entra

1. Open <https://entra.microsoft.com/> &rarr; **Identity** &rarr;
   **Applications** &rarr; **App registrations** &rarr; **New registration**.
   (The same thing lives at portal.azure.com &rarr; "App registrations".)
2. Name: `Comail`. Users see this name on the sign-in consent screen, so spell
   it the way you want it shown.
3. Supported account types: pick the third option, **Accounts in any
   organizational directory (Any Microsoft Entra ID tenant, Multitenant) and
   personal Microsoft accounts (e.g. Skype, Xbox)**.
4. Redirect URI: choose platform **Public client/native (mobile & desktop)**
   and enter `http://localhost`.
5. Click **Register**, then copy the **Application (client) ID** shown on the
   Overview page.

> [!IMPORTANT]
> The account type is **not** a preference. Comail signs users in through the
> shared `login.microsoftonline.com/common` endpoint, which only accepts apps
> registered for **multitenant + personal**.

<details>
<summary><b>What each account-type choice does with Comail</b></summary>

<br>

| Option | What happens with Comail |
| --- | --- |
| Single tenant (my org only) | Sign-in fails with `AADSTS50194` (app not configured as multi-tenant) |
| Any org directory, no personal | Work/school mailboxes sign in, personal Outlook.com fails with `AADSTS9002331` |
| Personal accounts only | Outlook.com works, org mailboxes fail |
| **Multitenant + personal** | **Everything works. Use this.** |

Yes, even if you only care about your own Microsoft 365 org today: multitenant
costs nothing, and "who can actually sign in" is still controlled by each
mailbox's own credentials and your tenant's policies, not by this switch.

</details>

> [!WARNING]
> Do **not** add the redirect URI as a **Web** platform. That variant expects a
> client secret and fails with a redirect mismatch. Loopback redirects on any
> port are accepted once it is registered under **Mobile and desktop**, and
> Comail picks a free port at sign-in time.

### Step 2 &middot; Add API permissions

1. In the app: **API permissions** &rarr; **Add a permission** &rarr;
   **Microsoft Graph**.
2. You now get two big boxes: **Delegated permissions** and **Application
   permissions**. Pick **Delegated**, because Comail accesses mail *as the
   signed-in user*.
3. Use the search field to find and tick each of these five:

   | Permission | Why |
   | --- | --- |
   | `IMAP.AccessAsUser.All` | Read and manage mail over IMAP |
   | `SMTP.Send` | Send mail |
   | `offline_access` | Refresh token, so you are not re-prompted to sign in |
   | `openid` | Sign-in itself |
   | `email` | Lets Comail read the account's address to label the account |

4. Click **Add permissions**. The default `User.Read` that Entra adds on
   registration is harmless, so leave it.

> [!TIP]
> If you pick **Application** by mistake, the permission list looks completely
> different: searching "email" turns up AccessReview, Agent\*, and other
> unrelated Graph APIs, and none of the five above exist. That mismatch is the
> tell that you are in the wrong box.

### Step 3 &middot; Admin consent: who needs it?

| Account kind | Who needs to consent |
| --- | --- |
| **Personal Outlook.com** | Nobody. The user accepts the consent prompt at first sign-in. Ignore the "Grant admin consent" button and its warning banner. |
| **Your own Microsoft 365 tenant** | None of the five permissions requires admin consent by default, but many tenants require admin approval for *any* new app. See the note below. |
| **Other people's tenants** (distributing your build) | Their admins may need to do the same on their side; nothing you can pre-configure here. |

> [!NOTE]
> If sign-in ends with **"Need admin approval"**, a tenant admin must either
> click **Grant admin consent for &lt;tenant&gt;** on this app's API permissions
> page, or approve it once through the consent request that Microsoft emails
> them.

### Step 4 &middot; Enter the value in Comail

Settings (`Cmd/Ctrl` + `,`) &rarr; **OAuth apps** &rarr; paste the Application
(client) ID into **Microsoft client ID**. Then Settings &rarr; **Accounts**
&rarr; **Sign in with Microsoft**.

> [!WARNING]
> **Microsoft 365 note.** Some tenants disable IMAP/SMTP AUTH per-mailbox. If
> sign-in succeeds but sync errors, the tenant admin needs to enable IMAP and
> Authenticated SMTP for the mailbox (Microsoft 365 admin center &rarr; user
> &rarr; Mail &rarr; Manage email apps).

---

## Part 3: Testing the flow end to end

### A &middot; Happy path

1. Start Comail (`pnpm tauri dev` or the installed build).
2. Settings &rarr; **Accounts** &rarr; **Sign in with Google** (or Microsoft).
3. Expected sequence:
   - Your default browser opens the provider's consent page.
   - Google testing-mode: "Google hasn't verified this app" &rarr; **Advanced**
     &rarr; **Go to Comail**; then a checkbox page asking for Gmail access.
   - After approving, the browser shows Comail's "You can close this window"
     page and the app returns with a toast **"Account connected, syncing..."**.
4. Verify in the UI:
   - The account appears under Settings &rarr; Accounts with a blue (syncing)
     then green (idle) dot.
   - `Cmd/Ctrl` + `1..9` filters to that account; inbox threads stream in
     (recent mail first, then history backfill).
5. Verify SMTP: compose (`C`), mail yourself, and send. The message must land in
   the inbox *and* appear once (not twice) in Sent. Comail appends to Sent only
   when the server does not do it automatically.
6. Verify token refresh: quit Comail fully (tray &rarr; Quit), then relaunch.
   The account must come back without re-prompting the browser. Access tokens
   last about 1 hour; a sync after that exercises the refresh path silently.

### B &middot; Failure paths worth checking once

| What to do | What should happen |
| --- | --- |
| Click sign-in with no client ID configured | Immediate error toast: "no OAuth app configured for gmail: add a client ID in Settings...". No browser opens. |
| Close the browser tab without approving | Comail times out after 5 min with a clean error; retry works |
| Click **Cancel/Deny** on the consent page | Error toast, no half-created account in the list |
| Revoke access afterwards (Google: myaccount.google.com &rarr; Security &rarr; Third-party access; MS: account.live.com/consent/Manage) | On next sync the account flips to a red **needs reauth** dot; signing in again repairs it |
| Paste a wrong client ID | Provider's error page in the browser (`invalid_client` / `unauthorized_client`) |

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| **`redirect_uri_mismatch` (Google)** | The OAuth client type is not "Desktop app". Recreate it with the right type; Web clients do not accept loopback redirects. |
| **`AADSTS50011` redirect mismatch (Microsoft)** | The `http://localhost` redirect URI is missing, or was added under "Web" instead of "Mobile and desktop applications". |
| **`AADSTS50194` "not configured as multi-tenant" (Microsoft)** | The app registration's account type is Single tenant. Comail signs in through the `/common` endpoint, which needs **multitenant + personal** (Part 2, Step 1). Fix under **Authentication** &rarr; **Supported account types**, or in the **Manifest** set `signInAudience` to `AzureADandPersonalMicrosoftAccount`. |
| **`AADSTS9002331` (Microsoft, personal account)** | The registration excludes personal Microsoft accounts; same fix as above. |
| **"Need admin approval" (Microsoft work account)** | The tenant requires admin consent for new apps; see Part 2, Step 3. |
| **Account works, then dies after ~7 days (Google)** | Consent screen still in Testing. Publish to Production (Part 1, Step 2 note). |
| **Browser never opens** | The URL is also logged; check the terminal running `pnpm tauri dev` (look for the `accounts.google.com` / `login.microsoftonline.com` URL and open it by hand). |
| **Sign-in OK but IMAP fails (Microsoft work account)** | Tenant has IMAP/SMTP AUTH disabled; see the Microsoft 365 note in Part 2, Step 4. |

---

## Where things are stored

For verification and cleanup:

- **Refresh + access tokens:** OS keyring (Secret Service / Keychain), service
  `comail`, per-account entries. Removing the account in Settings deletes them.
- **Client ID/secret from Settings:** the local SQLite settings table
  (`~/.local/share/comail/` on Linux). A client ID is not a user credential; it
  identifies the *app*, not you.
