import { useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { MOCK_MODE } from "../../ipc/mock";
import { useSettings } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import type { AttachmentMeta, MessageDetail } from "../../ipc/types";
import { addressName, formatSize, hueOf, initials, longTime, relativeTime } from "../../lib/format";
import { adaptDocumentForDarkMode } from "../../lib/emailDark";
import { splitQuotedTail, stripQuoteMarkers } from "../../lib/quotes";
import { InviteCard } from "../calendar/InviteCard";

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
  const lastUndo = useUi((s) => s.lastUndo);
  // Draft queued in the undo-send window reads "Sending…", not "Draft".
  const isSendPending =
    message.isDraft && lastUndo?.type === "send" && lastUndo.reopen.draftId === message.id;
  const draftBadge = isSendPending ? t("thread:sendingBadge") : t("thread:draftBadge");

  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focused]);

  const hue = hueOf(message.from.email);

  if (!expanded) {
    return (
      <div
        ref={ref}
        className={`co-row flex cursor-default items-center gap-3 rounded-lg border border-hairline bg-bg1 px-4 py-2.5 ${
          focused ? "!border-accent/50" : ""
        }`}
        onClick={onToggle}
      >
        <Avatar hue={hue} text={initials(message.from)} />
        <span className="w-44 shrink-0 truncate text-[13px] font-medium text-ink-muted">
          {addressName(message.from)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint">
          {message.isDraft ? `${draftBadge} · ` : ""}
          {message.snippet}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-faint">{relativeTime(message.date)}</span>
      </div>
    );
  }

  return (
    <article
      ref={ref}
      className={`co-fade-in rounded-lg border bg-bg1 ${
        focused ? "border-accent/50" : "border-hairline"
      }`}
      style={{ boxShadow: "var(--elev-1)" }}
    >
      <header
        className="co-hairline-b flex cursor-default items-start gap-3 px-4 py-3"
        onClick={onToggle}
      >
        <Avatar hue={hue} text={initials(message.from)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold text-ink">
              {addressName(message.from)}
            </span>
            <span className="truncate text-[12px] text-ink-faint">{message.from.email}</span>
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
          <div className="truncate text-[12px] text-ink-faint">
            {t("thread:msgTo")} {message.to.map(addressName).join(", ") || "-"}
            {message.cc.length > 0 && <> · {t("thread:msgCc")} {message.cc.map(addressName).join(", ")}</>}
          </div>
        </div>
        <time className="shrink-0 pt-0.5 text-[11.5px] text-ink-faint">{longTime(message.date)}</time>
      </header>

      <div className="px-4 py-4 select-text">
        <InviteCard messageId={message.id} />
        <MessageBody message={message} />
      </div>

      {message.attachments.filter((a) => !a.isInline).length > 0 && (
        <footer className="flex flex-wrap gap-2 px-4 pb-4">
          {message.attachments
            .filter((a) => !a.isInline)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                className="co-chip cursor-pointer hover:!border-accent/50"
                title={a.mimeType ?? undefined}
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
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
                {a.filename ?? t("thread:attachment.fallbackName")}
                <span className="text-ink-faint">{formatSize(a.size)}</span>
              </button>
            ))}
        </footer>
      )}
    </article>
  );
}

function Avatar({ hue, text }: { hue: number; text: string }) {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold"
      style={{
        background: `color-mix(in srgb, hsl(${hue} 45% 55%) 22%, var(--bg2))`,
        color: `hsl(${hue} 32% 42%)`,
      }}
    >
      {text}
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
    return <HtmlBody html={message.htmlBody} />;
  }
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
              className="rounded-md border border-hairline bg-bg2 px-2.5 pb-1 text-[14px] leading-[10px] tracking-widest text-ink-faint hover:text-ink"
              title={t("compose:showQuoted")}
              aria-label={t("compose:showQuoted")}
              onClick={() => setShowQuoted(true)}
            >
              ⋯
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

/** Sanitized HTML rendered inside a sandboxed iframe with theme-matched CSS. */
function HtmlBody({ html }: { html: string }) {
  const { t } = useTranslation();
  // null = not measured yet; the skeleton keeps the space until then.
  const [height, setHeight] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const { data: settings } = useSettings();
  const loadRemoteImages = settings?.loadRemoteImages === true;

  const theme = useUi((s) => s.theme);
  const srcDoc = useMemo(() => {
    const root = getComputedStyle(document.documentElement);
    const text = root.getPropertyValue("--text").trim() || "#222";
    const muted = root.getPropertyValue("--text-muted").trim() || "#666";
    const accent = root.getPropertyValue("--accent").trim() || "#714cb6";
    const scheme = root.getPropertyValue("--iframe-scheme").trim() || "light";
    // On dark themes the email is blended in after load (adaptDocumentForDarkMode
    // in onLoad), once getComputedStyle can resolve its <style>/class colors.
    const body = html;
    // CSP inside the sandboxed iframe: remote http(s) images only when the
    // "load remote images" setting is on; inline/data images always allowed.
    const imgSrc = loadRemoteImages ? "data: cid: http: https:" : "data: cid:";
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}">
<base target="_blank">
<style>
  :root { color-scheme: ${scheme}; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: ${text}; overflow-wrap: break-word;
  }
  a { color: ${accent}; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; }
  blockquote { border-left: 2px solid ${muted}; margin-left: 0; padding-left: 12px; color: ${muted}; }
  table { max-width: 100%; }
</style></head><body>${body}</body></html>`;
  }, [html, loadRemoteImages, theme]);

  const measure = () => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(4000, doc.body.scrollHeight + 8));
  };

  const onLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    // Blend the email into the dark theme now that its CSS has resolved.
    const scheme = getComputedStyle(document.documentElement)
      .getPropertyValue("--iframe-scheme")
      .trim();
    if (scheme === "dark") adaptDocumentForDarkMode(doc.body);
    measure();
    // Keep the height in sync as images/fonts finish loading inside the
    // sandboxed doc (no scripts allowed there, so observe from out here).
    observerRef.current?.disconnect();
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(doc.body);
    doc.addEventListener("load", measure, true);
  };

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const measured = height !== null;
  return (
    <div className="relative">
      {!measured && <BodySkeleton />}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={onLoad}
        className={`w-full border-0 ${measured ? "co-fade-in" : "invisible absolute inset-x-0 top-0"}`}
        style={{ height: height ?? "100%", transition: "height 140ms ease-out" }}
        title={t("thread:messageBodyTitle")}
      />
    </div>
  );
}
