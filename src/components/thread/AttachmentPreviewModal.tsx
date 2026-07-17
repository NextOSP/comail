import { useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { MOCK_MODE } from "../../ipc/mock";
import { useUi } from "../../stores/ui";
import { reclaimIframeFocus } from "../../keyboard/registry";
import type { AttachmentPreview, SheetPreview } from "../../ipc/types";
import { formatSize } from "../../lib/format";

/**
 * Safe in-app viewer for attachments. All document parsing happens in Rust
 * (comail-core/src/preview.rs); this modal only renders inert payloads:
 * sanitized HTML goes into the same sandboxed-iframe pattern as email bodies,
 * PDFs are rasterized locally with bundled pdf.js, images arrive as data URIs.
 */
export function AttachmentPreviewModal() {
  const { t } = useTranslation();
  const attachment = useUi((s) => s.attachmentPreview);
  const pushToast = useUi((s) => s.pushToast);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => useUi.getState().set({ attachmentPreview: null });

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!attachment) return;
    let stale = false;
    call("preview_attachment", { attachmentId: attachment.id })
      .then((p) => {
        if (!stale) setPreview(p);
      })
      .catch((e) => {
        if (!stale) setError(errorMessage(e));
      });
    return () => {
      stale = true;
    };
  }, [attachment?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (attachment) requestAnimationFrame(() => panelRef.current?.focus());
  }, [attachment]);

  if (!attachment) return null;

  const openExternally = async () => {
    try {
      const path = await call("get_attachment", { attachmentId: attachment.id });
      if (!MOCK_MODE) await openPath(path);
    } catch (e) {
      pushToast({
        kind: "error",
        message: t("thread:attachment.openFailed", { detail: errorMessage(e) }),
      });
    }
  };

  const name = attachment.filename ?? t("thread:attachment.fallbackName");

  const download = async () => {
    if (MOCK_MODE) {
      pushToast({ kind: "info", message: t("thread:attachment.savedMock", { name }) });
      return;
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({ defaultPath: name });
      if (!dest) return; // user cancelled
      await call("save_attachment", { attachmentId: attachment.id, dest });
      pushToast({ kind: "info", message: t("thread:attachment.preview.downloaded", { name }) });
    } catch (e) {
      pushToast({
        kind: "error",
        message: t("thread:attachment.openFailed", { detail: errorMessage(e) }),
      });
    }
  };

  return (
    <div
      className="co-overlay flex items-center justify-center p-[4vh]"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        data-testid="attachment-preview"
        className="co-fade-in flex h-full w-full max-w-[960px] flex-col rounded-xl border border-hairline bg-bg1 outline-none"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="co-hairline-b flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold text-ink" title={name}>
              {name}
            </div>
            <div className="text-[11.5px] text-ink-faint">
              {[attachment.mimeType, formatSize(attachment.size)].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            type="button"
            className="co-chip flex items-center gap-1.5 cursor-pointer hover:!border-accent/50"
            onClick={() => void download()}
            title={t("thread:attachment.preview.download")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            {t("thread:attachment.preview.download")}
          </button>
          <button
            type="button"
            className="co-chip cursor-pointer hover:!border-accent/50"
            onClick={() => void openExternally()}
          >
            {t("thread:attachment.preview.openExternally")}
          </button>
          <button
            type="button"
            className="co-chip cursor-pointer hover:!border-accent/50"
            aria-label={t("common:close")}
            onClick={close}
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-bg0 p-4">
          {error ? (
            <Notice text={t("thread:attachment.preview.failed", { detail: error })} />
          ) : !preview ? (
            <Notice text={t("thread:attachment.preview.loading")} />
          ) : (
            <PreviewBody preview={preview} />
          )}
        </div>
      </div>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
      {text}
    </div>
  );
}

function PreviewBody({ preview }: { preview: AttachmentPreview }) {
  const { t } = useTranslation();
  switch (preview.kind) {
    case "image":
      return (
        <div className="flex min-h-full items-center justify-center">
          <img
            src={preview.dataUri}
            alt=""
            className="max-h-full max-w-full rounded-md"
            style={{ boxShadow: "var(--elev-1)" }}
          />
        </div>
      );
    case "pdf":
      return <PdfPages base64={preview.base64} />;
    case "html":
      return <SandboxedHtml html={preview.html} />;
    case "sheet":
      return <SheetTabs sheets={preview.sheets} />;
    case "slides":
      return (
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          {preview.slides.map((s, i) => (
            <section key={i} className="rounded-lg border border-hairline bg-bg1 px-4 py-3">
              <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                {t("thread:attachment.preview.slide", { n: i + 1 })}
              </div>
              {s.lines.length === 0 ? (
                <div className="text-[13px] text-ink-faint">
                  {t("thread:attachment.preview.emptySlide")}
                </div>
              ) : (
                s.lines.map((line, j) => (
                  <p
                    key={j}
                    className={
                      j === 0
                        ? "text-[14.5px] font-semibold text-ink"
                        : "text-[13px] leading-[1.55] text-ink"
                    }
                  >
                    {line}
                  </p>
                ))
              )}
            </section>
          ))}
        </div>
      );
    case "text":
      return (
        <>
          <pre className="mx-auto max-w-[90ch] font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap text-ink select-text">
            {preview.text}
          </pre>
          {preview.truncated && <Truncated />}
        </>
      );
    case "unsupported":
      return (
        <Notice
          text={t(
            preview.reason === "too_large"
              ? "thread:attachment.preview.tooLarge"
              : "thread:attachment.preview.unsupported",
          )}
        />
      );
  }
}

function Truncated() {
  const { t } = useTranslation();
  return (
    <div className="mt-2 text-center text-[11.5px] text-ink-faint">
      {t("thread:attachment.preview.truncated")}
    </div>
  );
}

/** Ammonia-sanitized HTML in a sandboxed iframe (same isolation as email bodies). */
function SandboxedHtml({ html }: { html: string }) {
  const { t } = useTranslation();
  const theme = useUi((s) => s.theme);
  const srcDoc = useMemo(() => {
    const root = getComputedStyle(document.documentElement);
    const text = root.getPropertyValue("--text").trim() || "#222";
    const muted = root.getPropertyValue("--text-muted").trim() || "#666";
    const accent = root.getPropertyValue("--accent").trim() || "#714cb6";
    const scheme = root.getPropertyValue("--iframe-scheme").trim() || "light";
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<base target="_blank">
<style>
  :root { color-scheme: ${scheme}; }
  body {
    margin: 0 auto; max-width: 82ch;
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: ${text}; overflow-wrap: break-word;
  }
  a { color: ${accent}; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; }
  blockquote { border-left: 2px solid ${muted}; margin-left: 0; padding-left: 12px; color: ${muted}; }
  table { border-collapse: collapse; max-width: 100%; }
  td, th { border: 1px solid ${muted}; padding: 4px 8px; }
</style></head><body>${html}</body></html>`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, theme]);
  return (
    <iframe
      data-app-iframe
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      // Clicking inside steals keyboard focus, and WKWebView delivers keydowns
      // in a scriptless sandboxed frame to no listener at all - hand focus
      // back to the parent after each click so shortcuts keep working.
      onLoad={(e) =>
        e.currentTarget.contentDocument?.addEventListener("mouseup", reclaimIframeFocus)
      }
      className="h-full w-full rounded-md border-0 bg-bg1"
      title={t("thread:attachment.preview.documentTitle")}
    />
  );
}

function SheetTabs({ sheets }: { sheets: SheetPreview[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div className="flex h-full flex-col gap-2">
      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              className={`co-chip cursor-pointer ${i === active ? "!border-accent/60 text-ink" : ""}`}
              onClick={() => setActive(i)}
            >
              {s.name || t("thread:attachment.preview.sheetFallback", { n: i + 1 })}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline bg-bg1">
        <table className="text-[12px] text-ink select-text">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "font-semibold" : ""}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="max-w-[320px] truncate border border-hairline px-2 py-1 align-top"
                    title={cell.length > 40 ? cell : undefined}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated && <Truncated />}
    </div>
  );
}

/** Renders each PDF page to a canvas with lazily-loaded, bundled pdf.js. */
function PdfPages({ base64 }: { base64: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let task: { destroy(): Promise<unknown> } | null = null;

    (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const loadingTask = pdfjs.getDocument({ data: bytes });
      task = loadingTask;
      const loaded = await loadingTask.promise;
      if (cancelled) return;
      setState("ready");

      const width = Math.min(880, container.clientWidth - 8);
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= loaded.numPages && !cancelled; n++) {
        const page = await loaded.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.className = "mx-auto mb-3 block rounded-md bg-white";
        canvas.style.boxShadow = "var(--elev-1)";
        container.appendChild(canvas);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      }
    })().catch(() => {
      if (!cancelled) setState("error");
    });

    return () => {
      cancelled = true;
      container.replaceChildren();
      void task?.destroy();
    };
  }, [base64]);

  return (
    <div>
      {state === "loading" && <Notice text={t("thread:attachment.preview.loading")} />}
      {state === "error" && <Notice text={t("thread:attachment.preview.failed", { detail: "PDF" })} />}
      <div ref={containerRef} />
    </div>
  );
}
