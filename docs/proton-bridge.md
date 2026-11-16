# Connect Proton Mail Bridge

Run Proton Mail Bridge on the same computer as Comail and sign in to your
Proton account before adding it to Comail.

## Add the account

1. Open your account's **Mailbox details** in Bridge. Keep its hostname,
   ports, username, and generated password available.
2. Open **Settings > Advanced settings > Export TLS certificates** in Bridge.
   Open the exported public certificate in a text editor. Copy the block from
   `-----BEGIN CERTIFICATE-----` through `-----END CERTIFICATE-----`.
   Keep the exported private key out of Comail.
3. Open **Settings > Accounts > Add account (IMAP)** in Comail and select
   **Custom**.
4. Enter Bridge's username in **Email** and its generated password in
   **Password**. Use the hostname and ports from Bridge. With its default ports, use `127.0.0.1` for both
   hosts, `1143` for IMAP, and `1025` for SMTP.
5. Set **IMAP security** to **STARTTLS**, matching Bridge's connection mode.
   Paste the public certificate into **Trusted certificate (PEM)**.
6. Click **Connect**. The account appears in **Settings > Accounts**, and its
   inbox starts syncing. Keep Bridge running while using this account.

Comail uses the imported certificates as this account's trust store for IMAP
and SMTP. Platform certificate and hostname checks remain enabled.

See [Proton's Bridge settings guide](https://proton.me/support/comprehensive-guide-to-bridge-settings)
for certificate export and connection-mode settings.
