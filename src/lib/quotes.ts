/** Split a plain-text body into [visible, quoted-tail]. The tail is the
 *  trailing run of "> " lines plus the "On ... wrote:" attribution line
 *  above it. Used to collapse quote trails in the thread view. */
export function splitQuotedTail(text: string): [string, string | null] {
  const lines = text.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0 || !lines[i].startsWith(">")) return [text, null];

  let start = i;
  for (let j = i; j >= 0; j--) {
    const l = lines[j];
    if (l.startsWith(">") || l.trim() === "") {
      start = j;
      continue;
    }
    // include the attribution line directly above the quote
    if (/wrote:\s*$/.test(l.trim()) || /forwarded message/i.test(l.trim())) start = j;
    break;
  }
  const visible = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const quoted = lines.slice(start).join("\n").trim();
  if (!quoted) return [text, null];
  return [visible, quoted];
}
