import { useTranslation } from "react-i18next";
import type { Settings } from "../../ipc/types";
import { Icon } from "../ui/Icon";

type InboxUi = Settings["inboxUi"];

/**
 * First block of Preferences: pick the inbox UI by clicking a picture of it.
 * Each card is a tiny static mock of that list style, so the choice reads at a
 * glance instead of hiding behind a label.
 */
export function InboxUiPicker({
  value,
  onChange,
}: {
  value: InboxUi;
  onChange: (value: InboxUi) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="text-base text-ink">{t("settings:inboxUi.label")}</div>
      <div className="mt-0.5 text-xs text-ink-faint">{t("settings:inboxUi.hint")}</div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {(["classic", "avatar"] as const).map((ui) => {
          const selected = value === ui;
          return (
            <button
              key={ui}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(ui)}
              className={`group relative flex flex-col overflow-hidden rounded-card border-2 text-left transition-colors ${
                selected ? "border-accent" : "border-hairline hover:border-hairline-strong"
              }`}
            >
              <div className="h-[118px] bg-bg0 px-3 py-2.5">
                {ui === "classic" ? <ClassicMock /> : <AvatarMock />}
              </div>
              <div className="flex items-center justify-between border-t border-hairline bg-bg1 px-3 py-2">
                <span className={`text-base ${selected ? "font-semibold text-ink" : "text-ink-muted"}`}>
                  {t(`settings:inboxUi.${ui}`)}
                </span>
                <span
                  className={`flex size-4 items-center justify-center rounded-full ${
                    selected ? "bg-accent text-on-accent" : "border border-hairline-strong text-transparent"
                  }`}
                >
                  <Icon name="check" size={10} />
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Bar placeholder for mock text. */
function Bar({ w, strong = false }: { w: string; strong?: boolean }) {
  return <span className={`h-[5px] shrink-0 rounded-full ${strong ? "bg-ink-muted/70" : "bg-ink-faint/35"}`} style={{ width: w }} />;
}

function ClassicMock() {
  const rows = [
    ["26%", "58%"],
    ["20%", "64%"],
    ["30%", "50%"],
    ["22%", "60%"],
    ["28%", "54%"],
    ["24%", "62%"],
    ["18%", "56%"],
  ];
  return (
    <div className="flex flex-col gap-[9px] pt-1">
      {rows.map(([a, b], i) => (
        <div key={i} className="flex items-center gap-2">
          <span className={`size-[5px] shrink-0 rounded-full ${i < 3 ? "bg-info" : "bg-transparent"}`} />
          <Bar w={a} strong={i < 3} />
          <Bar w={b} />
        </div>
      ))}
    </div>
  );
}

function AvatarMock() {
  const hues = [210, 25, 145];
  return (
    <div className="flex flex-col gap-[11px] pt-0.5">
      {hues.map((h, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="size-[5px] shrink-0 rounded-full bg-info" />
          <span
            className="size-[18px] shrink-0 rounded-full"
            style={{ background: `color-mix(in srgb, hsl(${h} 45% 55%) 45%, var(--bg2))` }}
          />
          <Bar w="22%" strong />
          <Bar w="24%" strong />
          <Bar w="30%" />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="size-[5px] shrink-0 rounded-full bg-info" />
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-hairline-strong" />
        <Bar w="20%" strong />
        {[0, 1, 2].map((c) => (
          <span key={c} className="flex items-center gap-1">
            <span className="size-[9px] rounded-full" style={{ background: `hsl(${c * 110 + 40} 60% 60%)` }} />
            <Bar w="18px" />
          </span>
        ))}
      </div>
    </div>
  );
}
