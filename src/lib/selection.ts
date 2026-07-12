/** Text currently selected anywhere OUTSIDE the given element - the top
 *  document (e.g. a plain-text message body) or any same-origin iframe
 *  (HTML message bodies render in sandboxed iframes). Used by the composer's
 *  Quote button: quoting a selection from the thread beats formatting an
 *  empty blockquote. Must be read BEFORE focusing the editor, which moves
 *  the document selection. */
export function captureOutsideSelection(exclude: HTMLElement | null): string | null {
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) {
    const inExcluded = exclude != null && sel.anchorNode != null && exclude.contains(sel.anchorNode);
    if (!inExcluded) {
      const text = sel.toString().trim();
      if (text) return text;
    }
  }
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      const s = frame.contentWindow?.getSelection();
      if (s && !s.isCollapsed) {
        const text = s.toString().trim();
        if (text) return text;
      }
    } catch {
      // cross-origin frame: not ours, skip
    }
  }
  return null;
}
