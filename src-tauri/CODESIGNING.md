# macOS code signing

Why this matters: the login keychain ties its "Always Allow" grant for comail's
stored secrets (OAuth tokens, passwords) to the app's **code signature**. An
unsigned / ad-hoc build gets a new signature on every rebuild, so macOS treats
each build as a new app and re-prompts. A **stable** signature fixes it.

There are two independent tracks.

---

## 1. Local development (already set up)

Run once per machine:

```sh
bash src-tauri/scripts/macos-dev-cert.sh
```

This creates a stable, self-signed `comail-dev` code-signing identity and writes
a **gitignored** `src-tauri/.cargo/config.toml` whose cargo `runner`
(`scripts/macos-dev-sign.sh`) re-signs every `tauri dev` / `cargo run` build with
that identity + the fixed `com.deanoss.comail` identifier.

On the first launch afterward you'll get **one** keychain prompt (the old ad-hoc
grant doesn't match the new stable signature) — click **Always Allow**. You
won't be asked again on subsequent rebuilds.

Revert: delete `src-tauri/.cargo/config.toml` and remove the `comail-dev`
certificate from Keychain Access.

Verify the current dev build carries the stable requirement:

```sh
codesign -d -r- src-tauri/target/debug/comail 2>&1 | grep designated
# => identifier "com.deanoss.comail" and certificate leaf = H"..."   (NOT cdhash)
```

---

## 2. Distributed builds (release.yml) — needs an Apple Developer ID

The release workflow already reads the secrets below; until they're set, the
shipped `.app` stays ad-hoc (users get repeated keychain prompts across updates
+ a Gatekeeper warning). To fix it for real you need an Apple Developer Program
membership ($99/yr) and a **Developer ID Application** certificate.

### Get the certificate

1. Enroll at https://developer.apple.com/programs/ (if not already).
2. Check what you already have locally:
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
3. If none: create one at
   https://developer.apple.com/account/resources/certificates/list
   (type "Developer ID Application"), download it, and double-click to install
   into your login keychain.
4. Export it as a `.p12` (Keychain Access → right-click the identity → Export),
   choosing a password. Then base64-encode it for GitHub:
   ```sh
   base64 -i DeveloperID.p12 | pbcopy
   ```

### GitHub secrets to add (repo → Settings → Secrets → Actions)

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the `.p12` (step 4) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` — copy exactly from `security find-identity -v -p codesigning` |
| `APPLE_ID` | your Apple ID email (for notarization) |
| `APPLE_PASSWORD` | an app-specific password from https://account.apple.com → Sign-In & Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | your 10-char Team ID (developer.apple.com → Membership) |

Once all six exist, the next tagged release signs with Developer ID, notarizes,
and staples automatically. Users then get **no** repeated keychain prompts across
updates and no Gatekeeper warning.

> App-Store-Connect API-key notarization (`APPLE_API_KEY` / `APPLE_API_ISSUER` /
> `APPLE_API_KEY_PATH`) is an alternative to `APPLE_ID` + `APPLE_PASSWORD` if you
> prefer a key over an app-specific password.
