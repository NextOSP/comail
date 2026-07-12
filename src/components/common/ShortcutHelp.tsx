import { useTranslation } from "react-i18next";
import { getCommands, shortcutFor } from "../../keyboard/registry";
import { useUi } from "../../stores/ui";

const SECTION_ORDER = ["Triage", "Navigation", "Go to", "Compose", "AI", "Calendar", "Meta"];

export function ShortcutHelp() {
  const { t } = useTranslation();
  const open = useUi((s) => s.helpOpen);
  const set = useUi((s) => s.set);
  if (!open) return null;

  const bySection = new Map<string, { title: string; shortcut: string }[]>();
  for (const cmd of getCommands()) {
    const sc = shortcutFor(cmd);
    if (!sc) continue;
    const title = cmd.title ? cmd.title() : t(cmd.titleKey, cmd.titleParams);
    const list = bySection.get(cmd.section) ?? [];
    if (!list.some((x) => x.title === title)) {
      list.push({ title, shortcut: sc });
    }
    bySection.set(cmd.section, list);
  }

  return (
    <div className="co-overlay flex items-center justify-center" onMouseDown={() => set({ helpOpen: false })}>
      <div
        className="co-pop-in max-h-[80vh] w-[720px] overflow-y-auto rounded-xl border border-hairline bg-bg1 p-6"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold text-ink">{t("common:shortcutHelp.title")}</h2>
          <span className="text-[12px] text-ink-faint">{t("common:shortcutHelp.escToClose")}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-5">
          {SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => (
            <div key={section}>
              <h3 className="mb-2 text-[11.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
                {t(`commands:section.${section}`)}
              </h3>
              <ul className="flex flex-col gap-1">
                {bySection.get(section)!.map((c) => (
                  <li key={c.title} className="flex items-center justify-between gap-4 py-0.5">
                    <span className="text-[13px] text-ink-muted">{c.title}</span>
                    <span className="flex gap-1">
                      {c.shortcut.split(" then ").map((part, i, arr) => (
                        <span key={i} className="flex items-center gap-1">
                          <kbd className="co-kbd">{part}</kbd>
                          {i < arr.length - 1 && (
                            <span className="text-[11px] text-ink-faint">{t("common:shortcutHelp.then")}</span>
                          )}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
