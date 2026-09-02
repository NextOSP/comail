export interface DomainSplitPrefill {
  domain: string;
  name: string;
  sender: string;
}

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * Build the editable defaults for a whole-domain split rule.
 *
 * The suggested name intentionally mirrors the existing quick-split UI:
 * common one-part suffixes are removed, while less predictable suffixes are
 * left intact instead of guessing at the registrable domain.
 */
export function domainSplitPrefill(rawEmail: string): DomainSplitPrefill | null {
  const email = rawEmail.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;

  const domain = email.slice(at + 1);
  if (!DOMAIN_PATTERN.test(domain) || domain.includes("..")) return null;

  return {
    domain,
    name: domain.replace(/\.(com|org|net|io|dev)$/i, "") || domain,
    sender: `@${domain}`,
  };
}
