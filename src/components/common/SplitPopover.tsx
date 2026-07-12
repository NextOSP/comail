import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { queryClient } from "../../queries/client";
import { findCachedSummary } from "../../queries/actions";
import { useAccounts, useSplits } from "../../queries/hooks";
import { useUi } from "../../stores/ui";

/** Quick "split by sender / domain" popover (palette: Split by sender). */
export function SplitPopover() {
  const { t } = useTranslation();
  const target = useUi((s) => s.splitTarget);
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const { data: accounts } = useAccounts();
  const { data: splits } = useSplits();
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  const selfEmails = useMemo(
    () => new Set((accounts ?? []).map((a) => a.email.toLowerCase())),
    [accounts],
  );

  const summary = target != null ? findCachedSummary(target) : null;
  const sender =
    summary?.participants.find((p) => !selfEmails.has(p.email.toLowerCase())) ??
    summary?.participants[0];

  if (target == null) return null;

  const close = () => {
    set({ splitTarget: null });
    setCursor(0);
  };

  if (!sender) {
    close();
    return null;
  }

  const email = sender.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const options = [
    {
      key: "sender",
      title: t("inbox:splitPopover.fromSender", { email }),
      name: sender.name || email.split("@")[0],
      senders: [email],
    },
    ...(domain
      ? [
          {
            key: "domain",
            title: t("inbox:splitPopover.fromDomain", { domain }),
            name: domain.replace(/\.(com|org|net|io|dev)$/i, ""),
            senders: [`@${domain}`],
          },
        ]
      : []),
  ];

  const create = async (opt: (typeof options)[number]) => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await call("save_split", {
        split: {
          id: null,
          name: opt.name,
          position: (splits ?? []).length,
          query: { senders: opt.senders },
        },
      });
      void queryClient.invalidateQueries({ queryKey: ["splits"] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      close();
      // land in the new tab
      useUi.getState().set({
        view: "inbox",
        splitId: created.id,
        selectedIndex: 0,
        selectedThreadId: null,
        selection: [],
      });
      pushToast({
        kind: "info",
        message: t("inbox:splitPopover.created", { name: created.name }),
        durationMs: 3000,
      });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="co-overlay flex items-start justify-center pt-[22vh]" onMouseDown={close}>
      <div
        className="co-pop-in w-[420px] rounded-xl border border-hairline bg-bg1 p-2"
        style={{ boxShadow: "var(--elev-2)" }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(options.length - 1, c + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            void create(options[cursor]);
          }
        }}
      >
        <p className="co-hairline-b px-3 py-2 text-[12px] font-semibold tracking-wide text-ink-faint uppercase">
          {t("inbox:splitPopover.title")}
        </p>
        <div className="pt-1">
          {options.map((o, i) => (
            <button
              key={o.key}
              autoFocus={i === 0}
              disabled={busy}
              className={`flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left ${
                i === cursor ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => void create(o)}
            >
              <span className="text-[13.5px] text-ink">{o.title}</span>
              <span className="ml-auto truncate pl-3 text-[11.5px] text-ink-faint">
                {t("inbox:splitPopover.tabName", { name: o.name })}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
