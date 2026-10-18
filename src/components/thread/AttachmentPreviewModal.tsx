import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { MOCK_MODE } from "../../ipc/mock";
import type { AttachmentMeta, AttachmentPreview } from "../../ipc/types";
import { fileKind, type FileKind } from "../../lib/fileKind";
import { addressName, formatSize, longTime } from "../../lib/format";
import { prefetchAttachmentPreview, useAttachmentPreview } from "../../queries/hooks";
import { useUi, type AttachmentViewerState } from "../../stores/ui";
import { Avatar } from "../inbox/Avatar";
import { AttachmentThumb } from "./viewer/AttachmentThumb";
import {
  EmptyState,
  FileBadge,
  IconButton,
  LoadingPage,
  ViewerActionsContext,
  ViewerFallbackActions,
  ViewerIcon,
  useViewerKeys,
} from "./viewer/common";
import { DocViewer } from "./viewer/DocViewer";
import { ImageViewer } from "./viewer/ImageViewer";
import { PdfViewer } from "./viewer/PdfViewer";
import { SheetViewer } from "./viewer/SheetViewer";
import { SlidesViewer } from "./viewer/SlidesViewer";
import { TextViewer } from "./viewer/TextViewer";

const INFO_KEY = "comail.viewer.info";

/**
 * Safe in-app viewer for attachments. All document parsing happens in Rust
 * (comail-core/src/preview.rs); this only renders inert payloads: sanitized
 * HTML goes into the same sandboxed-iframe pattern as email bodies, PDFs are
 * rasterized locally with bundled pdf.js, images arrive as data URIs.
 *
 * Always a dark stage (the `.co-viewer` scope re-points the theme tokens) so
 * documents and photos read the same in every app theme.
 */
export function AttachmentPreviewModal() {
  const state = useUi((s) => s.attachmentPreview);
  if (!state || state.items.length === 0) return null;
  return <Viewer state={state} />;
}

function Viewer({ state }: { state: AttachmentViewerState }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { items, from, date, subject } = state;
  const index = Math.min(Math.max(0, state.index), items.length - 1);
  const attachment = items[index];
  const kind = fileKind(attachment.filename, attachment.mimeType);
  const name = attachment.filename ?? t("thread:attachment.fallbackName");
  const preview = useAttachmentPreview(attachment.id);
  const [info, setInfo] = useState(() => {
    try {
      return localStorage.getItem(INFO_KEY) === "1";
    } catch {
      return false;
    }
  });
  const rootRef = useRef<HTMLDivElement>(null);

  const close = () => useUi.getState().set({ attachmentPreview: null });
  const goTo = (i: number) => {
    if (i < 0 || i >= items.length || i === index) return;
    useUi.getState().set({ attachmentPreview: { ...state, index: i } });
  };
  const toggleInfo = () =>
    setInfo((v) => {
      try {
        localStorage.setItem(INFO_KEY, v ? "0" : "1");
      } catch {
        /* storage unavailable - session-only */
      }
      return !v;
    });

  // Focus the dialog on open and hand focus back to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => rootRef.current?.focus());
    return () => opener?.focus?.();
  }, []);

  // Paging should feel instant: warm the neighbours.
  useEffect(() => {
    if (items[index + 1]) prefetchAttachmentPreview(items[index + 1].id);
    if (items[index - 1]) prefetchAttachmentPreview(items[index - 1].id);
  }, [items, index]);

  const openExternally = async () => {
    try {
      if (MOCK_MODE) {
        pushToast({ kind: "info", message: t("thread:attachment.savedMock", { name }) });
        return;
      }
      await call("open_attachment", { attachmentId: attachment.id });
    } catch (e) {
      pushToast({ kind: "error", message: t("thread:attachment.openFailed", { detail: errorMessage(e) }) });
    }
  };

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
      pushToast({ kind: "error", message: t("thread:attachment.openFailed", { detail: errorMessage(e) }) });
    }
  };

  const actions = useMemo(
    () => ({ download: () => void download(), openExternally: () => void openExternally() }),
    [attachment.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Renderer keys register first (child effects run before the parent's), so
  // a sheet's arrow-key cell navigation wins over attachment paging here.
  useViewerKeys((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      void download();
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case "ArrowLeft":
        goTo(index - 1);
        return items.length > 1;
      case "ArrowRight":
        goTo(index + 1);
        return items.length > 1;
      case "i":
        toggleInfo();
        return true;
      case "o":
        void openExternally();
        return true;
    }
    return false;
  });

  const meta = [kindName(kind, t), formatSize(attachment.size), from && addressName(from)].filter(Boolean).join(" · ");

  return (
    <ViewerActionsContext.Provider value={actions}>
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        data-testid="attachment-preview"
        className="co-viewer co-viewer-in fixed inset-0 z-40 flex flex-col outline-none"
      >
        <header className="co-hairline-b flex h-14 shrink-0 items-center gap-3 pr-3 pl-4">
          <FileBadge kind={kind} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold text-ink" title={name}>
              {name}
            </div>
            <div className="truncate text-[11.5px] text-ink-faint">{meta}</div>
          </div>

          {items.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-lg bg-bg2 p-0.5">
              <IconButton icon="chevronLeft" label={t("thread:attachment.preview.prevFile")} shortcut="←" disabled={index === 0} onClick={() => goTo(index - 1)} size={28} />
              <span className="px-1.5 text-[12px] font-medium text-ink-muted tabular-nums">
                {t("thread:attachment.preview.counter", { n: index + 1, total: items.length })}
              </span>
              <IconButton
                icon="chevronRight"
                label={t("thread:attachment.preview.nextFile")}
                shortcut="→"
                disabled={index === items.length - 1}
                onClick={() => goTo(index + 1)}
                size={28}
              />
            </div>
          )}

          <div className="flex items-center gap-1">
            <IconButton icon="info" label={t("thread:attachment.preview.details")} shortcut="I" active={info} onClick={toggleInfo} />
            <IconButton icon="external" label={t("thread:attachment.preview.openExternally")} shortcut="O" onClick={() => void openExternally()} />
            <button type="button" className="co-viewer-action is-primary ml-1" onClick={() => void download()} title={`${t("thread:attachment.preview.download")} (⌘S)`}>
              <ViewerIcon name="download" size={14} />
              {t("thread:attachment.preview.download")}
            </button>
            <span className="mx-1.5 h-5 w-px bg-hairline-strong" aria-hidden />
            <IconButton icon="close" label={t("action.close")} shortcut="Esc" onClick={close} />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1 bg-bg0">
            {preview.isError ? (
              <EmptyState
                icon={<span className="text-danger"><ViewerIcon name="alert" size={40} /></span>}
                title={t("thread:attachment.preview.failedTitle")}
                body={errorMessage(preview.error)}
              >
                <ViewerFallbackActions />
              </EmptyState>
            ) : !preview.data ? (
              <LoadingPage />
            ) : (
              <PreviewBody key={attachment.id} preview={preview.data} kind={kind} />
            )}
          </main>

          {info && (
            <aside className="co-viewer-scroll co-hairline-l w-[300px] shrink-0 overflow-y-auto bg-bg1 p-5 text-[12.5px]">
              {from && (
                <Section title={t("thread:attachment.preview.sentBy")}>
                  <div className="flex items-center gap-2.5">
                    <Avatar address={from} size={32} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{addressName(from)}</div>
                      <div className="truncate text-ink-faint select-text">{from.email}</div>
                    </div>
                  </div>
                  {date != null && <div className="mt-2 text-ink-muted">{longTime(date)}</div>}
                </Section>
              )}
              {subject && (
                <Section title={t("thread:attachment.preview.subject")}>
                  <div className="leading-snug text-ink select-text">{subject}</div>
                </Section>
              )}
              <Section title={t("thread:attachment.preview.fileDetails")}>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                  <dt className="text-ink-faint">{t("thread:attachment.preview.type")}</dt>
                  <dd className="truncate text-ink">{kindName(kind, t)}</dd>
                  {attachment.size != null && (
                    <>
                      <dt className="text-ink-faint">{t("thread:attachment.preview.size")}</dt>
                      <dd className="text-ink">{formatSize(attachment.size)}</dd>
                    </>
                  )}
                  {attachment.mimeType && (
                    <>
                      <dt className="text-ink-faint">MIME</dt>
                      <dd className="truncate font-mono text-[11px] text-ink-muted select-text" title={attachment.mimeType}>
                        {attachment.mimeType}
                      </dd>
                    </>
                  )}
                </dl>
              </Section>
              {items.length > 1 && (
                <Section title={t("thread:attachment.preview.inMessage", { count: items.length })}>
                  <div className="-mx-2 flex flex-col">
                    {items.map((a, i) => (
                      <SiblingRow key={a.id} attachment={a} active={i === index} onClick={() => goTo(i)} />
                    ))}
                  </div>
                </Section>
              )}
            </aside>
          )}
        </div>

        {items.length > 1 && (
          <footer className="co-hairline-t flex h-[68px] shrink-0 items-center justify-center gap-2 overflow-x-auto px-4">
            {items.map((a, i) => (
              <button
                key={a.id}
                type="button"
                className={`co-viewer-film ${i === index ? "is-active" : ""}`}
                onClick={() => goTo(i)}
                title={a.filename ?? t("thread:attachment.fallbackName")}
                aria-label={a.filename ?? t("thread:attachment.fallbackName")}
                aria-current={i === index ? "true" : undefined}
              >
                <AttachmentThumb attachment={a} size={44} />
              </button>
            ))}
          </footer>
        )}
      </div>
    </ViewerActionsContext.Provider>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="co-hairline-b mb-4 pb-4 last:mb-0 last:border-0 last:pb-0">
      <h3 className="mb-2 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

function SiblingRow({ attachment, active, onClick }: { attachment: AttachmentMeta; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${active ? "bg-bg3" : "hover:bg-bg2"}`}
    >
      <AttachmentThumb attachment={attachment} size={28} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${active ? "font-medium text-ink" : "text-ink-muted"}`}>
          {attachment.filename ?? t("thread:attachment.fallbackName")}
        </span>
        <span className="block text-[11px] text-ink-faint">{formatSize(attachment.size)}</span>
      </span>
    </button>
  );
}

/** Friendly file-type name ("PDF document", "Spreadsheet", "SKETCH file"). */
function kindName(kind: FileKind, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (kind.family === "other") {
    return kind.ext ? t("thread:attachment.kind.other", { ext: kind.ext.toUpperCase() }) : t("thread:attachment.kind.file");
  }
  return t(`thread:attachment.kind.${kind.family}`);
}

function PreviewBody({ preview, kind }: { preview: AttachmentPreview; kind: FileKind }) {
  const { t } = useTranslation();
  switch (preview.kind) {
    case "image":
      return <ImageViewer src={preview.dataUri} />;
    case "pdf":
      return <PdfViewer base64={preview.base64} />;
    case "html":
      return <DocViewer html={preview.html} />;
    case "sheet":
      return <SheetViewer sheets={preview.sheets} />;
    case "slides":
      return <SlidesViewer slides={preview.slides} />;
    case "text":
      return <TextViewer text={preview.text} truncated={preview.truncated} />;
    case "unsupported":
      return (
        <EmptyState
          icon={<FileBadge kind={kind} size={72} />}
          title={preview.reason === "too_large" ? t("thread:attachment.preview.tooLargeTitle") : t("thread:attachment.preview.noPreviewTitle")}
          body={t(preview.reason === "too_large" ? "thread:attachment.preview.tooLarge" : "thread:attachment.preview.unsupported")}
        >
          <ViewerFallbackActions />
        </EmptyState>
      );
  }
}
