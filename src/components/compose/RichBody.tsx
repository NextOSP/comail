import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { captureOutsideSelection } from "../../lib/selection";
import { textToHtml } from "../../lib/richtext";

export interface RichBodyHandle {
  focus(): void;
  /** Focus with the caret at the very start (replies: type above the quote). */
  focusStart(): void;
  /** Insert plain text at the caret (snippet browser). */
  insertText(text: string): void;
  /** Insert an HTML fragment at the caret (availability slots). */
  insertHtml(html: string): void;
}

/** Replace `range` with `text` (newlines become <br>) and collapse the selection
 *  just after the inserted content. Engine-independent — the Range API works
 *  reliably in WebKitGTK where a programmatic execCommand("insertText") can be a
 *  silent no-op. */
function replaceRangeWithText(range: Range, sel: Selection, text: string) {
  range.deleteContents();
  const frag = document.createDocumentFragment();
  text.split("\n").forEach((part, i) => {
    if (i > 0) frag.appendChild(document.createElement("br"));
    frag.appendChild(document.createTextNode(part));
  });
  const last = frag.lastChild;
  range.insertNode(frag);
  const after = document.createRange();
  if (last?.nodeType === Node.TEXT_NODE) {
    after.setStart(last, last.textContent?.length ?? 0);
  } else if (last) {
    after.setStartAfter(last);
  } else {
    after.setStart(range.startContainer, range.startOffset);
  }
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}

type Cmd =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "insertUnorderedList"
  | "insertOrderedList";

/** Rich-text editing surface for the composer and the signature editor: a
 *  contenteditable div with a formatting toolbar (bold/italic/underline/strike,
 *  lists, quote, inline images, links). The parent owns the HTML string;
 *  external changes (AI draft, quick replies, signature) are synced in without
 *  disturbing typing. */
export const RichBody = forwardRef<
  RichBodyHandle,
  {
    value: string;
    onChange: (html: string) => void;
    placeholder: string;
    minHeightClass: string;
    /** ";shortcut " typed inline: return the replacement text, or null. */
    expandShortcut?: (shortcut: string) => string | null;
    /** Fired after the editor loses focus and its latest HTML is emitted. */
    onBlur?: () => void;
  }
>(function RichBody(
  { value, onChange, placeholder, minHeightClass, expandShortcut, onBlur },
  ref,
) {
  const { t } = useTranslation();
  const elRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastEmittedRef = useRef(value);
  // Selection captured when a popover opens (inputs steal focus, so we restore
  // the editor's range before applying the command).
  const savedRangeRef = useRef<Range | null>(null);
  const [empty, setEmpty] = useState(true);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const refreshEmpty = useCallback((el: HTMLDivElement) => {
    setEmpty(el.textContent?.trim() === "" && !el.querySelector("img"));
  }, []);

  // Sync external value -> DOM (only when it actually differs, so typing
  // never fights the caret).
  useEffect(() => {
    const el = elRef.current;
    if (el && el.innerHTML !== value) {
      el.innerHTML = value;
      lastEmittedRef.current = value;
      refreshEmpty(el);
    }
  }, [value, refreshEmpty]);

  const emit = useCallback(() => {
    const el = elRef.current;
    if (!el || el.innerHTML === lastEmittedRef.current) return;
    lastEmittedRef.current = el.innerHTML;
    refreshEmpty(el);
    onChange(el.innerHTML);
  }, [onChange, refreshEmpty]);

  const exec = useCallback(
    (cmd: Cmd | "blockquote" | "image") => {
      const el = elRef.current;
      if (!el) return;
      // Text selected in the thread above (message body or its iframe) wins:
      // "select part of the previous email, press quote" inserts it as a
      // quotation. Read before focus() - focusing moves the doc selection.
      const outside = cmd === "blockquote" ? captureOutsideSelection(el) : null;
      el.focus();
      if (cmd === "image") {
        fileRef.current?.click();
        return;
      }
      if (cmd === "blockquote") {
        if (outside) {
          // focus() alone leaves the document selection on the (non-editable)
          // message text, where insertHTML is a no-op - move the caret into
          // the editor first (keep it if it's already there, else go to end).
          const sel = document.getSelection();
          if (sel && (!sel.anchorNode || !el.contains(sel.anchorNode))) {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          document.execCommand(
            "insertHTML",
            false,
            `<blockquote>${textToHtml(outside)}</blockquote><div><br></div>`,
          );
          refreshActive();
          emit();
          return;
        }
        const cur = document.queryCommandValue("formatBlock").toLowerCase();
        // Angle brackets: the only form WebKit and Gecko both accept.
        document.execCommand(
          "formatBlock",
          false,
          cur === "blockquote" ? "<div>" : "<blockquote>",
        );
      } else {
        document.execCommand(cmd, false);
      }
      refreshActive();
      emit();
    },
    [emit],
  );

  const refreshActive = () => {
    setActive({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      strikeThrough: document.queryCommandState("strikeThrough"),
      insertUnorderedList: document.queryCommandState("insertUnorderedList"),
      insertOrderedList: document.queryCommandState("insertOrderedList"),
      blockquote: document.queryCommandValue("formatBlock").toLowerCase() === "blockquote",
    });
  };

  // Toolbar states follow the caret; also remember the last in-editor caret so
  // insertions made while focus is elsewhere (snippet picker, quick replies)
  // land where the user actually was rather than at the end.
  useEffect(() => {
    const handler = () => {
      const el = elRef.current;
      const sel = document.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      if (sel.rangeCount) savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      refreshActive();
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

  /** Focus the editor and guarantee a selection range *inside* it, so an
   *  insertion has somewhere to land. When called after focus has been elsewhere
   *  (snippet picker, quick-reply button), WebKit leaves the selection outside
   *  the element; restore the user's last caret, or fall back to the end of the
   *  content. Returns false if the element is gone. */
  const ensureCaret = (): boolean => {
    const el = elRef.current;
    if (!el) return false;
    el.focus();
    const sel = document.getSelection();
    if (!sel) return false;
    if (sel.rangeCount > 0 && el.contains(sel.anchorNode)) return true;
    const saved = savedRangeRef.current;
    const range = document.createRange();
    if (saved && el.contains(saved.startContainer)) {
      // Restore the last caret the user had before focus moved away.
      range.setStart(saved.startContainer, saved.startOffset);
      range.setEnd(saved.endContainer, saved.endOffset);
    } else {
      // Stale/absent: fall back to the end of the content.
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  };

  useImperativeHandle(ref, () => ({
    focus: () => elRef.current?.focus(),
    focusStart: () => {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      const sel = document.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(el, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    },
    insertText: (text: string) => {
      if (!ensureCaret()) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      replaceRangeWithText(sel.getRangeAt(0), sel, text);
      emit();
    },
    insertHtml: (html: string) => {
      if (!ensureCaret()) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      const last = tpl.content.lastChild;
      range.insertNode(tpl.content);
      const after = document.createRange();
      if (last) after.setStartAfter(last);
      else after.setStart(range.startContainer, range.startOffset);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      emit();
    },
  }));

  /**
   * ";shortcut" typed at the caret expands in place. A trailing space/nbsp
   * triggers it while typing; pressing Enter or Tab (`atCaretEnd`) commits the
   * shortcut sitting right before the caret with no separator. Returns true
   * when an expansion happened so callers can swallow the key.
   */
  const maybeExpandSnippet = (atCaretEnd = false): boolean => {
    if (!expandShortcut) return false;
    const el = elRef.current;
    const sel = document.getSelection();
    if (!el || !sel || !sel.isCollapsed || sel.rangeCount === 0) return false;

    // Resolve the caret to a text node + offset. On replies, focusStart leaves an
    // element-level caret and WebKit keeps anchorNode on the contenteditable div
    // rather than the text node — descend into the preceding text child so the
    // shortcut is still seen.
    let node = sel.anchorNode;
    let offset = sel.anchorOffset;
    if (node && node.nodeType === Node.ELEMENT_NODE) {
      const child = node.childNodes[offset - 1];
      if (child && child.nodeType === Node.TEXT_NODE) {
        node = child;
        offset = child.textContent?.length ?? 0;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return false;

    // Text leading up to the caret. WebKit splits a line into adjacent text
    // nodes around IME commits (Vietnamese input) and nbsp insertion, so the
    // ";", the shortcut, and the separator may each live in a different node \u2014
    // walk preceding text siblings instead of reading only the caret's node.
    const chain: Text[] = [node as Text];
    let upto = (node.textContent ?? "").slice(0, offset);
    for (
      let prev = node.previousSibling;
      prev?.nodeType === Node.TEXT_NODE && upto.length < 80;
      prev = prev.previousSibling
    ) {
      chain.unshift(prev as Text);
      upto = (prev.textContent ?? "") + upto;
    }

    const m = (atCaretEnd ? /;([a-z0-9_-]+)()$/i : /;([a-z0-9_-]+)([ \u00a0])$/i).exec(upto);
    if (!m) return false;
    const replacement = expandShortcut(m[1]);
    if (replacement == null) return false;

    // Map the match start back onto a (text node, offset) pair \u2014 it may sit
    // in an earlier node than the caret's.
    let startIdx = upto.length - m[0].length;
    let startNode: Text = node as Text;
    for (const part of chain) {
      const len = part === node ? offset : (part.textContent?.length ?? 0);
      if (startIdx <= len) {
        startNode = part;
        break;
      }
      startIdx -= len;
    }

    // Replace ";shortcut<sep>" in place, keeping the trailing separator.
    const range = document.createRange();
    range.setStart(startNode, startIdx);
    range.setEnd(node, offset);
    replaceRangeWithText(range, sel, replacement + m[2]);
    emit();
    return true;
  };

  const insertImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const el = elRef.current;
      if (!el || typeof reader.result !== "string") return;
      el.focus();
      document.execCommand("insertImage", false, reader.result);
      emit();
    };
    reader.readAsDataURL(file);
  };

  /** Snapshot the current editor selection before a popover steals focus. */
  const saveSelection = () => {
    const sel = document.getSelection();
    const el = elRef.current;
    savedRangeRef.current =
      sel && sel.rangeCount && el?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };

  /** Refocus the editor and re-apply the saved selection. */
  const restoreSelection = () => {
    const el = elRef.current;
    if (!el) return;
    el.focus();
    const range = savedRangeRef.current;
    if (range) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  /** Existing anchor href at the caret, for prefilling the link popover. */
  const currentLinkHref = (): string => {
    const sel = document.getSelection();
    let node: Node | null = sel?.anchorNode ?? null;
    while (node && node !== elRef.current) {
      if (node instanceof HTMLAnchorElement) return node.getAttribute("href") ?? "";
      node = node.parentNode;
    }
    return "";
  };

  const openLink = () => {
    saveSelection();
    setLinkUrl(currentLinkHref());
    setLinkOpen(true);
  };

  const applyLink = () => {
    const raw = linkUrl.trim();
    restoreSelection();
    if (raw) {
      // Bare hostnames get https:// so they aren't treated as relative paths.
      const href = /^(https?:|mailto:|tel:|#|\/)/i.test(raw) ? raw : `https://${raw}`;
      const sel = document.getSelection();
      if (sel && sel.isCollapsed) {
        document.execCommand("insertHTML", false, `<a href="${href.replace(/"/g, "&quot;")}">${href}</a>`);
      } else {
        document.execCommand("createLink", false, href);
      }
    } else {
      document.execCommand("unlink", false);
    }
    setLinkOpen(false);
    emit();
  };

  const buttons: { cmd: Cmd | "blockquote" | "image"; label: React.ReactNode; title: string }[] = [
    { cmd: "bold", label: <span className="font-bold">B</span>, title: t("compose:fmt.bold") },
    { cmd: "italic", label: <span className="italic">I</span>, title: t("compose:fmt.italic") },
    { cmd: "underline", label: <span className="underline">U</span>, title: t("compose:fmt.underline") },
    { cmd: "strikeThrough", label: <span className="line-through">S</span>, title: t("compose:fmt.strike") },
    {
      cmd: "insertUnorderedList",
      label: (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" />
          <circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" />
        </svg>
      ),
      title: t("compose:fmt.bullets"),
    },
    {
      cmd: "blockquote",
      label: (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z" />
        </svg>
      ),
      title: t("compose:fmt.quote"),
    },
    {
      cmd: "image",
      label: (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" /><path d="M21 15l-5-5L5 21" />
        </svg>
      ),
      title: t("compose:fmt.image"),
    },
  ];

  return (
    <div className="flex min-h-0 flex-col">
      {/* toolbar */}
      <div className="relative flex items-center gap-0.5 pt-2 pb-1" data-testid="fmt-toolbar">
        {buttons.map((b) => (
          <button
            key={b.cmd}
            type="button"
            tabIndex={-1}
            title={b.title}
            aria-label={b.title}
            // mousedown, so the editor selection is never lost
            onMouseDown={(e) => {
              e.preventDefault();
              exec(b.cmd);
            }}
            className={`flex size-6.5 items-center justify-center rounded-md text-[12px] transition-colors ${
              active[b.cmd]
                ? "bg-accent/15 text-accent"
                : "text-ink-faint hover:bg-bg2 hover:text-ink"
            }`}
          >
            {b.label}
          </button>
        ))}

        {/* link */}
        <button
          type="button"
          tabIndex={-1}
          title={t("compose:fmt.link")}
          aria-label={t("compose:fmt.link")}
          data-testid="fmt-link"
          onMouseDown={(e) => {
            e.preventDefault();
            openLink();
          }}
          className={`flex size-6.5 items-center justify-center rounded-md transition-colors ${
            linkOpen ? "bg-accent/15 text-accent" : "text-ink-faint hover:bg-bg2 hover:text-ink"
          }`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
            <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
          </svg>
        </button>

        {linkOpen && (
          <div
            className="absolute top-9 left-0 z-20 flex items-center gap-1.5 rounded-lg border border-hairline bg-bg0 p-1.5 shadow-lg"
            data-testid="link-popover"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); applyLink(); }
                else if (e.key === "Escape") { e.preventDefault(); setLinkOpen(false); }
              }}
              placeholder={t("compose:fmt.linkPlaceholder")}
              className="h-7 w-56 rounded-md border border-hairline bg-bg1 px-2 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); applyLink(); }}
              className="h-7 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-white hover:opacity-90"
            >
              {t("compose:fmt.linkApply")}
            </button>
          </div>
        )}

      </div>

      <div
        ref={elRef}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        data-testid="rich-body"
        data-empty={empty}
        spellCheck
        className={`co-richbody ${minHeightClass} w-full flex-1 py-2 text-[14px] leading-relaxed text-ink outline-none select-text`}
        data-placeholder={placeholder}
        onMouseDown={() => {
          if (linkOpen) setLinkOpen(false);
        }}
        onKeyDown={(e) => {
          // Enter or Tab commits a ";shortcut" sitting at the caret. Swallow the
          // key only when an expansion actually fired so normal newlines/tabs are
          // unaffected. Skipped mid-IME-composition (Enter confirms the compose).
          if (
            (e.key === "Enter" && !e.shiftKey) ||
            (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey)
          ) {
            if (!(e.nativeEvent as KeyboardEvent).isComposing && maybeExpandSnippet(true)) {
              e.preventDefault();
            }
          }
        }}
        onInput={(e) => {
          // Never rewrite the DOM mid-IME-composition (Vietnamese input):
          // WebKit would drop or duplicate the composed text. The
          // compositionend handler below re-runs the check.
          if (!(e.nativeEvent as InputEvent).isComposing) maybeExpandSnippet();
          emit();
        }}
        onCompositionEnd={() => {
          maybeExpandSnippet();
          emit();
        }}
        onBlur={() => {
          emit();
          onBlur?.();
        }}
        onPaste={(e) => {
          // Pasted images (screenshots) land inline.
          const item = [...(e.clipboardData?.items ?? [])].find((i) =>
            i.type.startsWith("image/"),
          );
          if (item) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              insertImageFile(file);
            }
          }
        }}
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          for (const f of e.target.files ?? []) insertImageFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
});
