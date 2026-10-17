import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton, Pill, PillDivider, useViewerKeys } from "./common";

type Slide = { lines: string[] };

/**
 * Presentation viewer for text-extracted decks: a filmstrip of mini slides on
 * the left and one 16:9 slide on stage (title + bullets), paged with ↑/↓.
 */
export function SlidesViewer({ slides }: { slides: Slide[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (i: number) => setActive(Math.max(0, Math.min(slides.length - 1, i)));

  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useViewerKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case "ArrowDown":
      case "PageDown":
      case "j":
      case " ":
        go(active + 1);
        return true;
      case "ArrowUp":
      case "PageUp":
      case "k":
        go(active - 1);
        return true;
      case "Home":
        go(0);
        return true;
      case "End":
        go(slides.length - 1);
        return true;
    }
    return false;
  });

  if (slides.length === 0) return null;

  return (
    <div className="flex h-full min-h-0">
      {slides.length > 1 && (
        <div className="co-viewer-scroll co-hairline-r flex w-[176px] shrink-0 flex-col gap-3 overflow-y-auto px-4 py-4">
          {slides.map((s, i) => (
            <button
              key={i}
              ref={(el) => void (itemRefs.current[i] = el)}
              type="button"
              className="group flex cursor-pointer items-start gap-2 text-left focus:outline-none"
              onClick={() => go(i)}
              aria-current={i === active ? "true" : undefined}
              aria-label={t("thread:attachment.preview.slide", { n: i + 1 })}
            >
              <span className={`w-4 pt-0.5 text-right text-[10.5px] tabular-nums ${i === active ? "font-semibold text-ink" : "text-ink-faint"}`}>
                {i + 1}
              </span>
              <span
                className={`co-slide aspect-video w-full overflow-hidden rounded-[4px] p-2 ring-2 transition-shadow ${
                  i === active ? "ring-accent" : "ring-transparent group-hover:ring-hairline-strong"
                }`}
              >
                <span className="line-clamp-2 block text-[7px] leading-tight font-semibold">{s.lines[0] ?? ""}</span>
                {s.lines.slice(1, 4).map((l, j) => (
                  <span key={j} className="mt-0.5 block truncate text-[5px] leading-tight opacity-60">
                    {l}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="relative min-w-0 flex-1">
        <div className="flex h-full items-center justify-center p-8 pb-20">
          <SlideCard key={active} slide={slides[active]} />
        </div>
        {slides.length > 1 && (
          <Pill>
            <IconButton icon="chevronUp" label={t("thread:attachment.preview.prevSlide")} shortcut="↑" disabled={active === 0} onClick={() => go(active - 1)} size={28} />
            <span className="px-2 text-[12px] text-ink-muted tabular-nums">
              {t("thread:attachment.preview.counter", { n: active + 1, total: slides.length })}
            </span>
            <IconButton
              icon="chevronDown"
              label={t("thread:attachment.preview.nextSlide")}
              shortcut="↓"
              disabled={active >= slides.length - 1}
              onClick={() => go(active + 1)}
              size={28}
            />
            <PillDivider />
            <span className="px-1.5 text-[11.5px] text-ink-faint">{t("thread:attachment.preview.textOnly")}</span>
          </Pill>
        )}
      </div>
    </div>
  );
}

function SlideCard({ slide }: { slide: Slide }) {
  const { t } = useTranslation();
  const [title, ...rest] = slide.lines;
  return (
    <section
      className="co-slide co-fade-in flex aspect-video w-full max-w-[min(1100px,calc((100vh-220px)*16/9))] flex-col overflow-hidden rounded-md px-[6%] py-[5%]"
      style={{ boxShadow: "0 2px 6px rgb(0 0 0 / 0.35), 0 12px 40px rgb(0 0 0 / 0.35)", containerType: "inline-size" }}
    >
      {slide.lines.length === 0 ? (
        <div className="m-auto text-[2.2cqw] opacity-50">{t("thread:attachment.preview.emptySlide")}</div>
      ) : (
        <>
          <h2 className="text-[4.2cqw] leading-tight font-bold tracking-tight select-text">{title}</h2>
          {rest.length > 0 && (
            <ul className="mt-[3cqw] flex min-h-0 flex-col gap-[1.2cqw] overflow-hidden text-[2.3cqw] leading-snug select-text">
              {rest.map((line, i) => (
                <li key={i} className="flex gap-[1.2cqw]">
                  <span className="mt-[0.9cqw] h-[0.7cqw] w-[0.7cqw] shrink-0 rounded-full bg-[var(--slide-accent)]" />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
