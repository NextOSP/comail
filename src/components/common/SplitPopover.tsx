import { useQuery } from "@tanstack/react-query";
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

  // Which user rule (if any) routes this thread. routed_tab can't tell us for
  // targeted rules, so the backend re-runs the matcher.
  const { data: matchedRule } = useQuery({
    queryKey: ["matchingSplit", target],
    queryFn: () => call("find_matching_split", { threadId: target as number }),
    enabled: target != null,
    staleTime: 30_000,
  });

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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["splits"] });
    void queryClient.invalidateQueries({ queryKey: ["threads"] });
    void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    void queryClient.invalidateQueries({ queryKey: ["matchingSplit"] });
  };

  const create = async (name: string, needle: string) => {
    const created = await call("save_split", {
      split: {
        id: null,
        name,
        position: (splits ?? []).length,
        query: { senders: [needle] },
      },
    });
    invalidate();
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
  };

  // Add the needle to the matched rule's excludeSenders; the save reroutes the
  // thread out of the rule's tab automatically.
  const exclude = async (needle: string) => {
    if (!matchedRule) return;
    const existing = matchedRule.query.excludeSenders ?? [];
    if (!existing.includes(needle)) {
      await call("save_split", {
        split: {
          id: matchedRule.id,
          name: matchedRule.name,
          position: matchedRule.position,
          query: { ...matchedRule.query, excludeSenders: [...existing, needle] },
          target: matchedRule.target ?? null,
        },
      });
    }
    invalidate();
    close();
    pushToast({
      kind: "info",
      message: t("inbox:splitPopover.excluded", { name: matchedRule.name }),
      durationMs: 3000,
    });
  };

  const options: { key: string; title: string; sub: string; run: () => Promise<void> }[] = [
    {
      key: "sender",
      title: t("inbox:splitPopover.fromSender", { email }),
      sub: t("inbox:splitPopover.tabName", { name: sender.name || email.split("@")[0] }),
      run: () => create(sender.name || email.split("@")[0], email),
    },
    ...(domain
      ? [
          {
            key: "domain",
            title: t("inbox:splitPopover.fromDomain", { domain }),
            sub: t("inbox:splitPopover.tabName", {
              name: domain.replace(/\.(com|org|net|io|dev)$/i, ""),
            }),
            run: () => create(domain.replace(/\.(com|org|net|io|dev)$/i, ""), `@${domain}`),
          },
        ]
      : []),
    ...(matchedRule
      ? [
          {
            key: "exclude-sender",
            title: t("inbox:splitPopover.excludeSender", { email }),
            sub: matchedRule.name,
            run: () => exclude(email),
          },
          ...(domain
            ? [
                {
                  key: "exclude-domain",
                  title: t("inbox:splitPopover.excludeDomain", { domain }),
                  sub: matchedRule.name,
                  run: () => exclude(`@${domain}`),
                },
              ]
            : []),
        ]
      : []),
  ];

  const run = async (opt: (typeof options)[number]) => {
    if (busy) return;
    setBusy(true);
    try {
      await opt.run();
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
            void run(options[cursor]);
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
              onClick={() => void run(o)}
            >
              <span className="text-[13.5px] text-ink">{o.title}</span>
              <span className="ml-auto truncate pl-3 text-[11.5px] text-ink-faint">
                {o.sub}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
