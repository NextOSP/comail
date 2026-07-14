import { useEffect, useMemo, useRef, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { MOCK_MODE } from "../../ipc/mock";
import { useSettings } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import type { Address, AttachmentMeta, MessageDetail } from "../../ipc/types";
import { addressName, formatSize, longTime, relativeTime } from "../../lib/format";
import { adaptDocumentForDarkMode, fixInvisibleText } from "../../lib/emailDark";
import {
  splitQuotedHtml,
  splitQuotedTail,
  stripQuoteMarkers,
  trimTrailingEmptyHtml,
} from "../../lib/quotes";
import { InviteCard } from "../calendar/InviteCard";
import { dispatchKeyboardEvent } from "../../keyboard/registry";

/** Maps a file to a short badge label + accent color by extension/mime. */
function fileKind(filename: string | null, mimeType: string | null): { label: string; color: string } {
  const ext = (filename?.split(".").pop() ?? "").toLowerCase();
  const mime = mimeType?.toLowerCase() ?? "";
  const pick = (label: string, color: string) => ({ label, color });
  if (ext === "pdf" || mime.includes("pdf")) return pick("PDF", "#e5484d");
  if (["doc", "docx", "rtf", "odt"].includes(ext) || mime.includes("word")) return pick("DOC", "#2f6fed");
  if (["xls", "xlsx", "csv", "ods"].includes(ext) || mime.includes("sheet") || mime.includes("excel"))
    return pick(ext === "csv" ? "CSV" : "XLS", "#1a9e5b");
  if (["ppt", "pptx", "odp"].includes(ext) || mime.includes("presentation") || mime.includes("powerpoint"))
    return pick("PPT", "#e8590c");
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || mime.includes("zip") || mime.includes("compressed"))
    return pick("ZIP", "#a16207");
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(ext) || mime.startsWith("image/"))
    return pick("IMG", "#8b5cf6");
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext) || mime.startsWith("video/")) return pick("VID", "#db2777");
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(ext) || mime.startsWith("audio/")) return pick("AUD", "#0891b2");
  if (["txt", "md", "log"].includes(ext) || mime.startsWith("text/")) return pick("TXT", "#64748b");
  return pick(ext ? ext.slice(0, 4).toUpperCase() : "FILE", "#64748b");
}

/** Clean, vertically-centered three-dot glyph for the "show trimmed content"
 *  toggle (the raw "⋯" character renders as a cramped, off-center box). */
function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

async function openAttachment(a: AttachmentMeta) {
  const { pushToast } = useUi.getState();
  try {
    const path = await call("get_attachment", { attachmentId: a.id });
    if (MOCK_MODE) {
      pushToast({
        kind: "info",
        message: i18n.t("thread:attachment.savedMock", {
          name: a.filename ?? i18n.t("thread:attachment.fallbackName"),
        }),
      });
      return;
    }
    await openPath(path);
  } catch (e) {
    pushToast({ kind: "error", message: i18n.t("thread:attachment.openFailed", { detail: errorMessage(e) }) });
  }
}

export function MessageCard({
  message,
  expanded,
  focused,
  onToggle,
}: {
  message: MessageDetail;
  expanded: boolean;
  focused: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const lastUndo = useUi((s) => s.lastUndo);
  // Draft queued in the undo-send window reads "Sending…", not "Draft".
  const isSendPending =
    message.isDraft && lastUndo?.type === "send" && lastUndo.reopen.draftId === message.id;
  const draftBadge = isSendPending ? t("thread:sendingBadge") : t("thread:draftBadge");

  useEffect(() => {
    // Only follow the keyboard cursor into view; pointer selection (hover/click)
    // must not scroll, or the view would jump as the mouse crosses messages.
    if (focused && useUi.getState().messageCursorSource === "keyboard") {
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focused]);

  const hasFile = message.attachments.some((a) => !a.isInline);
  const recipients = message.to.map(addressName).join(", ") || "-";
  // The backend sets `via` only when the transmitting party (Sender:,
  // Return-Path or DKIM d=) does NOT align with the From: domain — mailing
  // lists, ESPs, send-on-behalf, and mail whose From: is spoofed.
  const viaDomain = message.via ? (message.via.split("@")[1] ?? message.via) : null;

  if (!expanded) {
    return (
      <div
        ref={ref}
        className={`co-row flex cursor-pointer items-baseline gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg1 ${
          focused ? "bg-bg1 ring-1 ring-inset ring-accent/60" : ""
        }`}
        onClick={onToggle}
      >
        <span className="w-32 shrink-0 truncate text-[13.5px] font-medium text-ink">
          {addressName(message.from)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-faint">
          {message.isDraft ? `${draftBadge} · ` : ""}
          {message.snippet}
        </span>
        {hasFile && <PaperclipIcon className="self-center" />}
        <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">{relativeTime(message.date)}</span>
      </div>
    );
  }

  return (
    <article
      ref={ref}
      className="co-fade-in overflow-hidden bg-bg1"
      style={{
        // Square, uniform hairline — no left accent bar. The selected message
        // (reply target) reads clearly via a solid accent border plus a soft
        // accent ring, so it's obvious which message a reply will go to.
        boxShadow: focused
          ? "var(--elev-card), 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent)"
          : "var(--elev-card)",
        border: `1px solid ${focused ? "var(--accent)" : "var(--hairline)"}`,
      }}
    >
      <header
        className="flex cursor-default items-start justify-between gap-3 px-5 pt-4 pb-3"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="text-[14px] font-semibold text-ink">{addressName(message.from)}</span>
            <button
              type="button"
              className="flex min-w-0 cursor-pointer items-baseline gap-1 text-[13px] text-ink-faint transition-colors hover:text-ink"
              title={t("thread:details.toggle")}
              aria-expanded={detailsOpen}
              onClick={(e) => {
                e.stopPropagation();
                setDetailsOpen((v) => !v);
              }}
            >
              <span className="truncate">
                {t("thread:msgTo")} {recipients}
                {message.cc.length > 0 && <> · {t("thread:msgCc")} {message.cc.map(addressName).join(", ")}</>}
              </span>
              <svg
                className={`shrink-0 self-center transition-transform ${detailsOpen ? "rotate-180" : ""}`}
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {message.isDraft && (
              <span
                className={`rounded bg-bg2 px-1.5 text-[10.5px] font-semibold tracking-wide uppercase ${
                  isSendPending ? "text-accent" : "text-ink-faint"
                }`}
              >
                {draftBadge}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-ink-faint" title={message.from.email}>
            {message.from.email}
            {viaDomain && <> · {t("thread:details.via")} {viaDomain}</>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {hasFile && <PaperclipIcon />}
          <time className="text-[11.5px] whitespace-nowrap text-ink-faint">{longTime(message.date)}</time>
        </div>
      </header>

      {detailsOpen && <MessageDetails message={message} viaDomain={viaDomain} />}

      <div className="px-5 pb-4 select-text">
        <InviteCard messageId={message.id} />
        <MessageBody message={message} />
      </div>

      {message.attachments.filter((a) => !a.isInline).length > 0 && (
        <footer className="flex flex-wrap gap-2 px-5 pb-4">
          {message.attachments
            .filter((a) => !a.isInline)
            .map((a) => {
              const kind = fileKind(a.filename, a.mimeType);
              const size = formatSize(a.size);
              return (
                <button
                  key={a.id}
                  type="button"
                  className="group flex max-w-[16rem] cursor-pointer items-center gap-2.5 rounded-xl border border-hairline bg-bg1 py-1.5 pl-1.5 pr-2.5 text-left transition-colors hover:border-accent/40 hover:bg-bg2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title={`${t("thread:attachment.view")}${a.mimeType ? ` · ${a.mimeType}` : ""} · ${t("thread:attachment.openExternalHint")}`}
                  aria-label={`${t("thread:attachment.view")}: ${a.filename ?? t("thread:attachment.fallbackName")}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Plain click = safe in-app preview; Alt/middle-click keeps
                    // the old "open in the OS app" behavior.
                    if (e.altKey) void openAttachment(a);
                    else useUi.getState().set({ attachmentPreview: a });
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.stopPropagation();
                      void openAttachment(a);
                    }
                  }}
                >
                  {/* Colored file-type badge. */}
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold uppercase tracking-tight text-white"
                    style={{ backgroundColor: kind.color }}
                  >
                    {kind.label}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-medium leading-tight text-ink">
                      {a.filename ?? t("thread:attachment.fallbackName")}
                    </span>
                    <span className="mt-0.5 truncate text-[11px] leading-tight text-ink-faint">
                      {[kind.label, size].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {/* Explicit "view" affordance so the card reads as openable. */}
                  <svg
                    className="ml-auto shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-accent"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              );
            })}
        </footer>
      )}
    </article>
  );
}

/** Writes to the clipboard and confirms with a toast; surfaces the rare
 *  failure rather than silently dropping the copy. */
async function copyToClipboard(text: string, confirmation: string) {
  const { pushToast } = useUi.getState();
  try {
    await navigator.clipboard.writeText(text);
    pushToast({ kind: "info", message: confirmation });
  } catch {
    pushToast({ kind: "error", message: i18n.t("thread:details.copyFailed") });
  }
}

/** One recipient rendered as a copy-to-clipboard pill: display name plus the
 *  faint address, clicking copies the bare email. A transient check confirms
 *  the copy in place so it reads even with the toast off-screen. */
function AddressChip({ address }: { address: Address }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const name = addressName(address);
  // Skip the faint email when the "name" is already just the email localpart.
  const showEmail = name.toLowerCase() !== address.email.toLowerCase();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-bg1 py-0.5 pr-1.5 pl-2 text-[11.5px] transition-colors hover:border-accent/40 hover:bg-bg2"
      title={`${addressLine(address)} · ${t("thread:details.copyAddress")}`}
      onClick={(e) => {
        e.stopPropagation();
        void copyToClipboard(address.email, t("thread:details.copied", { value: address.email }));
        window.clearTimeout(timer.current);
        setCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <span className="shrink-0 font-medium text-ink">{name}</span>
      {showEmail && <span className="min-w-0 truncate text-ink-faint">{address.email}</span>}
      {copied ? (
        <CheckIcon className="shrink-0 text-accent" />
      ) : (
        <CopyIcon className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

/** A row of recipient chips with a trailing "copy all" when there's more than
 *  one address to grab in a single click. */
function AddressRow({ addresses }: { addresses: Address[] }) {
  const { t } = useTranslation();
  if (addresses.length === 0) return <span className="text-ink-faint">-</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {addresses.map((a, i) => (
        <AddressChip key={`${a.email}-${i}`} address={a} />
      ))}
      {addresses.length > 1 && (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-ink-faint transition-colors hover:bg-bg1 hover:text-accent"
          title={t("thread:details.copyAllHint")}
          onClick={(e) => {
            e.stopPropagation();
            const joined = addresses.map((a) => a.email).join(", ");
            void copyToClipboard(joined, t("thread:details.copiedAll", { count: addresses.length }));
          }}
        >
          <CopyIcon className="shrink-0" />
          {t("thread:details.copyAll")}
        </button>
      )}
    </div>
  );
}

/** `Name <email>` when a display name exists, bare email otherwise. */
function addressLine(a: { name: string | null; email: string }): string {
  return a.name && a.name.trim() ? `${a.name.trim()} <${a.email}>` : a.email;
}

/** Expanded header details (Gmail-style "show details"): full from/to/cc
 *  addresses as copyable chips, plus via, date and subject. Toggled from the
 *  recipient summary line. */
function MessageDetails({ message, viaDomain }: { message: MessageDetail; viaDomain: string | null }) {
  const { t } = useTranslation();
  // Address rows render as copyable chips; text rows stay plain.
  const addressRows: Array<[string, Address[]]> = [
    [t("thread:details.from"), [message.from]],
    [t("thread:details.to"), message.to],
  ];
  if (message.cc.length > 0) addressRows.push([t("thread:details.cc"), message.cc]);
  const textRows: Array<[string, string]> = [];
  if (viaDomain) {
    // Full via identity when we have one (an email); just the domain otherwise.
    textRows.push([
      t("thread:details.via"),
      message.via && message.via !== viaDomain ? `${viaDomain} (${message.via})` : viaDomain,
    ]);
  }
  textRows.push([t("thread:details.date"), longTime(message.date)]);
  textRows.push([t("thread:details.subject"), message.subject || t("thread:noSubject")]);
  return (
    <div className="co-fade-in mx-5 mb-3 grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5 rounded-lg border border-hairline bg-bg2/50 px-3.5 py-3 text-[12px] select-text">
      {addressRows.map(([label, addresses]) => (
        <div key={label} className="contents">
          <span className="self-center text-right text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
            {label}
          </span>
          <AddressRow addresses={addresses} />
        </div>
      ))}
      {textRows.map(([label, value]) => (
        <div key={label} className="contents">
          <span className="self-start pt-0.5 text-right text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
            {label}
          </span>
          <span className="min-w-0 break-words text-ink">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Two overlapping squares — the standard copy affordance. */
function CopyIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

/** Check confirming a chip's address landed on the clipboard. */
function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** Small paperclip marking a message that carries a real (non-inline) file. */
function PaperclipIcon({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={`shrink-0 text-ink-faint ${className}`}
      title={t("common:threadRow.hasAttachments")}
      aria-label={t("common:threadRow.attachment")}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
      </svg>
    </span>
  );
}

function MessageBody({ message }: { message: MessageDetail }) {
  const { t } = useTranslation();
  const [showQuoted, setShowQuoted] = useState(false);
  const [visible, quoted] = useMemo(
    () => splitQuotedTail(message.textBody ?? message.snippet),
    [message.textBody, message.snippet],
  );
  if (message.bodyState === "fetching" || (message.bodyState === "none" && !message.textBody)) {
    return <BodySkeleton snippet={message.snippet} />;
  }
  if (message.htmlBody) {
    return <HtmlBody html={message.htmlBody} messageId={message.id} />;
  }
  // (plaintext path below)
  return (
    <div>
      {visible && (
        <pre className="max-w-[90ch] font-sans text-[15px] leading-[1.6] whitespace-pre-wrap text-ink">
          {visible}
        </pre>
      )}
      {quoted && (
        <div className={visible ? "mt-3" : ""}>
          {!showQuoted ? (
            <button
              className="inline-flex h-5 items-center rounded-md border border-hairline bg-bg2 px-2 text-ink-faint transition-colors hover:border-accent/40 hover:text-ink"
              title={t("compose:showQuoted")}
              aria-label={t("compose:showQuoted")}
              onClick={() => setShowQuoted(true)}
            >
              <DotsIcon />
            </button>
          ) : (
            <div className="co-fade-in border-l-2 border-hairline-strong pl-3">
              <button
                className="mb-1 text-[11px] text-ink-faint hover:text-ink"
                onClick={() => setShowQuoted(false)}
              >
                {t("compose:hideQuoted")}
              </button>
              <pre className="max-w-[90ch] font-sans text-[13.5px] leading-[1.6] whitespace-pre-wrap text-ink-faint">
                {stripQuoteMarkers(quoted)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Placeholder shown while a body is being fetched: the snippet gives the
 *  reader something real immediately, shimmer lines hold the card's height
 *  so it doesn't jump open when the body lands. */
function BodySkeleton({ snippet }: { snippet?: string | null }) {
  return (
    <div aria-busy="true">
      {snippet && (
        <p className="mb-3 max-w-[90ch] text-[15px] leading-[1.6] text-ink-faint">{snippet}</p>
      )}
      <div className="flex flex-col gap-2.5">
        {[94, 100, 86, 68, 42].map((w, i) => (
          <div key={i} className="co-skeleton h-3.5 rounded" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** Sanitized HTML rendered inside a sandboxed iframe with theme-matched CSS.
 *  The trailing quoted/forwarded reply is collapsed behind a "⋯" toggle so a
 *  message shows just its new content, matching the plaintext path. */
function HtmlBody({ html: fullHtml, messageId }: { html: string; messageId: number }) {
  const { t } = useTranslation();
  const [showQuoted, setShowQuoted] = useState(false);
  const [visibleHtml, quotedHtml] = useMemo(() => splitQuotedHtml(fullHtml), [fullHtml]);
  const html = showQuoted || !quotedHtml ? fullHtml : visibleHtml;
  // null = not measured yet; the skeleton keeps the space until then.
  const [height, setHeight] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  // Current zoom applied to fit wide content; kept in a ref so measure() can
  // recover the natural width and converge without oscillating.
  const zoomRef = useRef(1);
  const { data: settings } = useSettings();
  const settingLoadImages = settings?.loadRemoteImages === true;
  // Per-message override for the "Load images" bar (independent of the setting).
  const [loadImagesOverride, setLoadImagesOverride] = useState(false);
  const loadRemoteImages = settingLoadImages || loadImagesOverride;
  // Emails whose layout leans on remote images collapse when those are blocked,
  // so offer to load them (only when the body actually references http(s) media).
  const hasRemoteImages = useMemo(
    () =>
      /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i.test(fullHtml) ||
      /background(?:-image)?\s*[:=][^;"']*url\(\s*["']?\s*https?:/i.test(fullHtml),
    [fullHtml],
  );

  const theme = useUi((s) => s.theme);
  const srcDoc = useMemo(() => {
    const root = getComputedStyle(document.documentElement);
    const text = root.getPropertyValue("--text").trim() || "#222";
    const muted = root.getPropertyValue("--text-muted").trim() || "#666";
    const accent = root.getPropertyValue("--accent").trim() || "#714cb6";
    const scheme = root.getPropertyValue("--iframe-scheme").trim() || "light";
    // On dark themes the email is blended in after load (adaptDocumentForDarkMode
    // in onLoad), once getComputedStyle can resolve its <style>/class colors.
    // Trailing blank spacers are dropped so a short reply isn't rendered into a
    // tall iframe of empty space.
    const body = trimTrailingEmptyHtml(html);
    // CSP inside the sandboxed iframe: remote http(s) images only when the
    // "load remote images" setting is on; inline/data images always allowed.
    // The app itself runs in a secure context, so plain http: images (still
    // common in marketing mail, e.g. TikTok's logo CDN) are blocked by the
    // webview as mixed content no matter what img-src allows. upgrade-
    // insecure-requests rewrites them to https: before the fetch, which the
    // hosts serving them invariably support.
    const imgSrc = loadRemoteImages ? "data: cid: http: https:" : "data: cid:";
    const upgrade = loadRemoteImages ? "; upgrade-insecure-requests" : "";
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}${upgrade}">
<base target="_top">
<style>
  :root { color-scheme: ${scheme}; }
  /* height:auto defeats emails whose layout is sized to height:100% — against
     the iframe's short default height those collapse and scrollHeight can't
     measure the real content, leaving the body clipped with an inner scrollbar. */
  html, body { margin: 0; padding: 0; background: transparent; height: auto !important; min-height: 0 !important; }
  body {
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: ${text}; overflow-wrap: break-word;
    /* The app sets a global user-select:none; make email text explicitly
       selectable so the user can copy content (e.g. an OTP) out of it. */
    -webkit-user-select: text; user-select: text;
    /* Contain child margins in a block-formatting context. Otherwise a leading/
       trailing <p> margin collapses through the margin-less body and escapes
       body.scrollHeight, so the frame is measured a margin short and clips the
       content behind an inner scrollbar. flow-root folds those margins back in. */
    display: flow-root;
  }
  /* Theme-consistent defaults for otherwise-unstyled emails. All accents are
     derived from the app's own text/accent via color-mix so they track both
     light and dark; every rule is low-specificity so an email's own CSS wins. */
  a { color: ${accent}; text-underline-offset: 2px;
    text-decoration-color: color-mix(in srgb, ${accent} 40%, transparent); }
  a:hover { text-decoration-line: underline; }
  ::selection { background: color-mix(in srgb, ${accent} 24%, transparent); }
  h1, h2, h3, h4, h5, h6 { color: ${text}; line-height: 1.3; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; height: 1px; background: color-mix(in srgb, ${text} 14%, transparent); margin: 1.25em 0; }
  code, kbd, samp { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em; background: color-mix(in srgb, ${text} 6%, transparent);
    padding: 0.12em 0.35em; border-radius: 5px; }
  pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: color-mix(in srgb, ${text} 4%, transparent); padding: 12px 14px;
    border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: inherit; }
  blockquote { border-left: 3px solid color-mix(in srgb, ${accent} 45%, transparent);
    margin: 0.8em 0; padding: 2px 0 2px 14px; color: ${muted}; }
  table { max-width: 100%; }
</style></head><body>${body}</body></html>`;
  }, [html, loadRemoteImages, theme]);

  // Wide emails (fixed-width layout tables, long unbreakable tokens) overflow
  // the card and would otherwise show a horizontal scrollbar. Zoom the whole
  // document down so it fits the available width instead — unlike a CSS
  // transform, `zoom` reflows the layout, so the content actually shrinks and
  // no scrollbar appears.
  //
  // Computed ONCE per load from the *unzoomed* natural width, deliberately NOT
  // from the ResizeObserver: applying zoom rewraps text (e.g. a long instanceId
  // token), which changes the natural width, which changes the zoom — a loop
  // that never converges and spins the CPU until the tab hangs. Measuring the
  // true width once (zoom cleared first) also avoids the stale `scrollWidth/cur`
  // estimate that could over-shrink an email that already fit.
  const fitWidth = () => {
    const iframe = iframeRef.current;
    const body = iframe?.contentDocument?.body;
    if (!iframe || !body) return;
    body.style.removeProperty("zoom");
    const avail = iframe.clientWidth;
    const natural = body.scrollWidth;
    // Fit wide content, but never below 55%: past that a single wide element
    // (e.g. an injected "external sender" banner) would shrink the whole email
    // into an unreadable strip. Beyond the floor we let it scroll instead.
    // Require a real overflow margin so tiny differences don't zoom.
    const zoom = avail > 200 && natural > avail + 4 ? Math.max(0.55, avail / natural) : 1;
    if (zoom < 1) body.style.setProperty("zoom", String(zoom));
    zoomRef.current = zoom;
  };

  // Height only — safe to run repeatedly from the ResizeObserver because it
  // never touches zoom or width, so it can't feed back into a reflow loop.
  // Measure from `body` only. documentElement.scrollHeight can never report
  // less than the iframe's own viewport height, so folding it into the max
  // ratchets the frame up: once it's tall (a quote was expanded, or the
  // skeleton's height on first load) it keeps re-measuring tall even after the
  // real content shrinks, leaving a dead gap below short emails. The forced
  // `html,body { height:auto !important }` above makes body.scrollHeight the
  // true content height in every case (verified against expanded quotes), so
  // body alone both grows and shrinks correctly (reading it forces reflow, so
  // it already reflects any applied zoom).
  const measure = () => {
    const body = iframeRef.current?.contentDocument?.body;
    if (!body) return;
    const contentHeight = Math.max(body.scrollHeight, body.offsetHeight);
    setHeight(Math.min(4000, contentHeight + 8));
  };

  const onLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    // Fresh document (srcDoc/theme change) starts unzoomed.
    zoomRef.current = 1;
    // Blend the email into the dark theme now that its CSS has resolved. On the
    // light theme instead, rescue near-white text whose dark background was lost
    // when the sanitizer stripped its <style>/class rule (it would render
    // invisibly on our light card).
    const rootStyle = getComputedStyle(document.documentElement);
    const scheme = rootStyle.getPropertyValue("--iframe-scheme").trim();
    if (scheme === "dark") {
      adaptDocumentForDarkMode(doc.body);
    } else {
      fixInvisibleText(doc.body, rootStyle.getPropertyValue("--text").trim() || "#222");
    }
    // Fit width once (may apply a zoom), then measure the resulting height.
    fitWidth();
    measure();
    if (import.meta.env.DEV) {
      performance.mark(`message-painted:${messageId}`);
    }
    // Keep the height in sync as images/fonts finish loading inside the
    // sandboxed doc (no scripts allowed there, so observe from out here).
    // The observer runs `measure` (height only) — never `fitWidth` — so a late
    // reflow can't restart the zoom feedback loop.
    observerRef.current?.disconnect();
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(doc.body);
    doc.addEventListener("load", measure, true);
    // Clicking inside the email moves keyboard focus into this sandboxed
    // iframe, so keydowns fire on its document — never the parent window that
    // the keyboard registry listens on, so app shortcuts (Esc to go back, Cmd+K
    // palette, J/K, R…) stop working. Route the iframe's keydowns through the
    // registry directly. It applies its own guards (typing in a field or
    // activating a focused link is left native), so we forward every key —
    // except the native clipboard/selection shortcuts. Those must stay native
    // so the user can select and copy text (e.g. an OTP code) out of the email;
    // forwarding Cmd/Ctrl+A would trigger the app's "select all" command and
    // Cmd/Ctrl+C/X could be swallowed before the webview copies.
    doc.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "a" || key === "c" || key === "x" || key === "v")) return;
      dispatchKeyboardEvent(e);
    });
    // The sandboxed iframe runs no scripts, so links can't reach a browser on
    // their own. Intercept clicks from out here and hand http(s)/mailto links to
    // the OS (default browser / mail client). If this ever misses, the link's
    // target="_top" escalates to a top navigation caught by the Rust
    // on_navigation backstop.
    doc.addEventListener(
      "click",
      (e) => {
        const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as
          | HTMLAnchorElement
          | null;
        const href = anchor?.href;
        if (href && /^(https?|mailto):/i.test(href)) {
          e.preventDefault();
          void openUrl(href).catch(() => {});
        }
      },
      true,
    );
  };

  useEffect(() => () => observerRef.current?.disconnect(), []);

  // macOS WKWebView discards the sandboxed iframe's rasterized backing store
  // while the app is hidden (Cmd+H) or fully occluded; on reactivation the
  // frame stays blank until something invalidates it (selecting text repaints
  // only the region it touches — hence the blank band above a selection). Force
  // the whole subframe to re-rasterize when the window becomes visible/focused:
  // compositing its <body> as a translucent layer for one frame (opacity != 1)
  // repaints the entire document, then we restore it. The change must span
  // frames — a same-frame round-trip (e.g. display none→block) is coalesced by
  // WebKit to the same computed value and never repaints the stale surface.
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    const repaint = () => {
      if (document.visibilityState === "hidden") return;
      const body = iframeRef.current?.contentDocument?.body;
      if (!body) return;
      body.style.opacity = "0.9999";
      // Two frames guarantee the translucent state is actually painted before
      // we revert, so the full re-raster can't be optimized away.
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          const b = iframeRef.current?.contentDocument?.body;
          if (b) b.style.opacity = "";
          measure();
        });
      });
    };
    document.addEventListener("visibilitychange", repaint);
    window.addEventListener("focus", repaint);
    // The DOM focus/visibility events don't always fire in a Tauri webview on
    // macOS app hide/unhide, so also listen to the native window focus event.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onFocusChanged(({ payload: focused }) => {
            if (focused) repaint();
          }),
        )
        .then((un) => {
          if (disposed) un();
          else unlisten = un;
        })
        .catch(() => {
          /* native focus tracking is a nicety, never fatal */
        });
    }
    return () => {
      disposed = true;
      unlisten?.();
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      document.removeEventListener("visibilitychange", repaint);
      window.removeEventListener("focus", repaint);
    };
  }, []);

  const measured = height !== null;
  return (
    <div className="relative">
      {hasRemoteImages && !loadRemoteImages && (
        <div className="mb-2 flex items-center gap-3 rounded-md border border-hairline bg-bg2 px-3 py-1.5 text-[12px] text-ink-muted">
          <span className="min-w-0 flex-1 truncate">{t("thread:remoteImages.hidden")}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-hairline px-2 py-0.5 font-medium text-accent hover:!border-accent/50"
            onClick={() => setLoadImagesOverride(true)}
          >
            {t("thread:remoteImages.load")}
          </button>
        </div>
      )}
      {!measured && <BodySkeleton />}
      <iframe
        ref={iframeRef}
        data-app-iframe
        // allow-top-navigation-by-user-activation lets a clicked link (base
        // target="_top") escalate to a top-level navigation, which the Rust
        // on_navigation backstop intercepts and opens in the OS browser if the
        // JS click handler below didn't already.
        sandbox="allow-same-origin allow-top-navigation-by-user-activation"
        srcDoc={srcDoc}
        onLoad={onLoad}
        className={`w-full border-0 ${measured ? "co-fade-in" : "invisible absolute inset-x-0 top-0"}`}
        style={{ height: height ?? "100%", transition: "height 140ms ease-out" }}
        title={t("thread:messageBodyTitle")}
      />
      {quotedHtml &&
        (!showQuoted ? (
          <button
            className="mt-1 inline-flex h-5 items-center rounded-md border border-hairline bg-bg2 px-2 text-ink-faint transition-colors hover:border-accent/40 hover:text-ink"
            title={t("compose:showQuoted")}
            aria-label={t("compose:showQuoted")}
            onClick={() => setShowQuoted(true)}
          >
            <DotsIcon />
          </button>
        ) : (
          <button
            className="mt-1 text-[11px] text-ink-faint hover:text-ink"
            onClick={() => setShowQuoted(false)}
          >
            {t("compose:hideQuoted")}
          </button>
        ))}
    </div>
  );
}
