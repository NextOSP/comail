import type { ComposeMode, Settings, Signature } from "../ipc/types";

export type { ComposeMode };

/** The signature to pre-fill for a given account and compose mode, honoring the
 *  Gmail-style defaults: `newId` for fresh mail, `replyId` for replies/forwards.
 *  Returns null when the account has no matching default configured. */
export function pickSignature(
  settings: Pick<Settings, "signatureList" | "signatureDefaults">,
  accountId: number,
  mode: ComposeMode,
): Signature | null {
  const defs = settings.signatureDefaults[String(accountId)];
  if (!defs) return null;
  const id = mode === "new" ? defs.newId : defs.replyId;
  if (!id) return null;
  return (
    settings.signatureList.find((s) => s.id === id && s.accountId === accountId) ?? null
  );
}

/** All signatures belonging to one account, in list order. */
export function signaturesForAccount(
  settings: Pick<Settings, "signatureList">,
  accountId: number,
): Signature[] {
  return settings.signatureList.filter((s) => s.accountId === accountId);
}
