import { useTranslation } from "react-i18next";
import { getCommands, shortcutFor } from "../../keyboard/registry";
import { useUi } from "../../stores/ui";
import { SectionLabel } from "../ui/Field";
import { Modal } from "../ui/Modal";

const SECTION_ORDER = ["Triage", "Navigation", "Go to", "Compose", "AI", "Calendar", "Meta"];
const AI_HERE_KEY = "mod+j";

export function ShortcutHelp() {
  const { t } = useTranslation();
  const open = useUi((s) => s.helpOpen);
  const set = useUi((s) => s.set);
  if (!open) return null;

  const bySection = new Map<string, { title: string; hint?: string; shortcut: string }[]>();
  for (const cmd of getCommands()) {
    const sc = shortcutFor(cmd);
    if (!sc) continue;
    // ⌘J is contextual (write in compose, summary in a thread, Ask in
    // search), so its per-context commands collapse into one "AI here" row.
    const aiHere = cmd.keys.includes(AI_HERE_KEY);
    const title = aiHere
      ? t("commands:aiHere.title")
      : cmd.title
        ? cmd.title()
        : t(cmd.titleKey, cmd.titleParams);
    const list = bySection.get(cmd.section) ?? [];
    if (!list.some((x) => x.title === title)) {
      list.push({ title, hint: aiHere ? t("commands:aiHere.hint") : undefined, shortcut: sc });
    }
    bySection.set(cmd.section, list);
  }

  return (
    <Modal
      onClose={() => set({ helpOpen: false })}
      center
      width={720}
      className="max-h-[80vh] overflow-y-auto p-6"
    >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-md font-semibold text-ink">{t("common:shortcutHelp.title")}</h2>
          <span className="text-sm text-ink-faint">{t("common:shortcutHelp.escToClose")}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-5">
          {SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => (
            <div key={section}>
              <SectionLabel>{t(`commands:section.${section}`)}</SectionLabel>
              <ul className="flex flex-col gap-1">
                {bySection.get(section)!.map((c) => (
                  <li key={c.title} className="flex items-center justify-between gap-4 py-0.5">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-base text-ink-muted">{c.title}</span>
                      {c.hint && <span className="text-xs text-ink-faint">{c.hint}</span>}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {c.shortcut.split(" then ").map((part, i, arr) => (
                        <span key={i} className="flex items-center gap-1">
                          <kbd className="co-kbd">{part}</kbd>
                          {i < arr.length - 1 && (
                            <span className="text-xs text-ink-faint">{t("common:shortcutHelp.then")}</span>
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
    </Modal>
  );
}
