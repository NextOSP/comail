/** Detection for the compose body's @-mention feature: given the text leading
 *  up to the caret, find an active "@query" the user is typing so a colleague
 *  search dropdown can open. Kept as a pure function so the caret surgery in
 *  RichBody stays testable in isolation. */

export interface MentionMatch {
  /** The text typed after "@", up to the caret (may be empty for a bare "@"). */
  query: string;
  /** Index of the "@" within `textBeforeCaret`. */
  at: number;
}

/** Return the active @-mention at the end of `textBeforeCaret`, or null.
 *
 *  Trigger rules (Slack-style):
 *  - "@" must sit at the start of the string or right after whitespace, so an
 *    email address typed inline ("bd@nextwaves") never triggers.
 *  - The query is the run of non-whitespace characters after "@" and stops at
 *    the first space, so "@gia " closes the mention.
 *  - A bare "@" (empty query) is valid and shows the top contacts.
 *  - A second "@" inside the query ends it (so "a@b" is not a query). */
export function activeMention(textBeforeCaret: string): MentionMatch | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCaret);
  if (!m) return null;
  // m[0] may include the leading whitespace; the "@" is just before the query.
  const at = m.index + m[0].length - m[1].length - 1;
  return { query: m[1], at };
}
