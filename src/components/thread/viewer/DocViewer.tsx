import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { reclaimIframeFocus } from "../../../keyboard/registry";

/**
 * Ammonia-sanitized HTML (docx / markdown / html conversions) in a sandboxed,
 * scriptless iframe - same isolation as email bodies - styled as a sheet of
 * paper so it reads as a document regardless of the app theme.
 */
export function DocViewer({ html }: { html: string }) {
  const { t } = useTranslation();
  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<base target="_blank">
<style>
  :root { color-scheme: light; }
  html { background: #fff; }
  body {
    margin: 0 auto; max-width: 72ch; padding: 64px 72px 96px;
    font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1c1e22; overflow-wrap: break-word;
  }
  h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.01em; margin: 1.4em 0 0.5em; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
  body > :first-child { margin-top: 0; }
  a { color: #5b3a9e; }
  img { max-width: 100%; height: auto; }
  pre, code { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: #f4f4f6; border-radius: 4px; }
  code { padding: 0.1em 0.3em; } pre { padding: 12px 14px; white-space: pre-wrap; }
  pre code { padding: 0; background: none; }
  blockquote { border-left: 3px solid #d6d6dc; margin-left: 0; padding-left: 14px; color: #5c6068; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  td, th { border: 1px solid #dcdde1; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f6f8; }
  hr { border: 0; border-top: 1px solid #e3e4e8; margin: 2em 0; }
</style></head><body>${html}</body></html>`,
    [html],
  );
  return (
    <div className="flex h-full justify-center px-8 pt-8">
      <iframe
        data-app-iframe
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        // Clicking inside steals keyboard focus, and WKWebView delivers keydowns
        // in a scriptless sandboxed frame to no listener at all - hand focus
        // back to the parent after each click so shortcuts keep working.
        onLoad={(e) => e.currentTarget.contentDocument?.addEventListener("mouseup", reclaimIframeFocus)}
        className="co-fade-in h-full w-full max-w-[860px] rounded-t-[3px] border-0 bg-white"
        style={{ boxShadow: "0 2px 6px rgb(0 0 0 / 0.35), 0 12px 40px rgb(0 0 0 / 0.35)" }}
        title={t("thread:attachment.preview.documentTitle")}
      />
    </div>
  );
}
