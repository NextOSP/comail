/**
 * Update channel lock for the mkmk10k/comail personal fork.
 *
 * Tauri Update is whole-binary + one pubkey. Until OUR pubkey + endpoint are
 * baked into tauri.conf.json AND key custody is verified, install MUST refuse
 * — otherwise NextOSP-signed latest.json wipes rauta: customs again.
 *
 * Flip to "rauta" only after: personal minisign pubkey in tauri.conf, endpoint
 * points at mkmk10k/comail releases, KEY_CUSTODY.md backups verified.
 */
export type UpdateChannel = "locked" | "rauta";

/** Runtime channel. Keep "locked" until P2 cutover evidence exists. */
export const UPDATE_CHANNEL: UpdateChannel = "locked";

/** NextOSP endpoint substring — any build still pointing here must refuse install. */
export const NEXTOSP_UPDATE_ENDPOINT_NEEDLE = "github.com/NextOSP/comail";

export function updatesInstallAllowed(channel: UpdateChannel = UPDATE_CHANNEL): boolean {
  return channel === "rauta";
}

/** Fail-loud reason for UI / tests when install is refused. */
export function updateInstallBlockedReason(
  channel: UpdateChannel = UPDATE_CHANNEL,
): string | null {
  if (updatesInstallAllowed(channel)) return null;
  return (
    "Updates locked: personal Rauta release channel not configured. " +
    "Refusing install to protect customs (TC-UPD-00)."
  );
}
