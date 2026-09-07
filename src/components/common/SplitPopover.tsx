import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { queryClient } from "../../queries/client";
import { findCachedSummary } from "../../queries/actions";
import { useAccounts, useLabels, useSplits } from "../../queries/hooks";
import { domainSplitPrefill } from "../../lib/splitPrefill";
import { nextTabPosition } from "../../lib/splitOrder";
import { useUi } from "../../stores/ui";
import { describeCondition } from "../settings/ConditionBuilder";
import { Modal } from "../ui/Modal";

/** Quick "split by sender / domain" popover (palette: Split by sender). */
export function SplitPopover() {
  const { t } = useTranslation();
  const target = useUi((s) => s.splitTarget);
  const set = useUi((s) => s.set);
  const pushToast = useUi((s) => s.pushToast);
  const { data: accounts } = useAccounts();
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Why the thread sits where it does: the leaf conditions of the rule that
  // matched (or none, when the AI classifier or heuristic routed it).
  const { data: explanation } = useQuery({
    queryKey: ["explainRoute", target],
    queryFn: () => call("explain_route", { threadId: target as number }),
    enabled: target != null,
    staleTime: 30_000,
  });
  const matchedTrace = explanation?.decision.rules.find((r) => r.matched);
  // A split whose AI check said yes (decided asynchronously, so the trace only
  // knows the condition let it through).
  const aiTrace = matchedTrace
    ? undefined
    : explanation?.decision.rules.find(
        (r) => r.aiCheck && explanation.current === `split:${r.splitId}`,
      );

  const close = () => {
    set({ splitTarget: null });
    setCursor(0);
  };

  // Nothing to split by (no cached participants): close from an effect, not
  // during render.
  const noSender = target != null && !sender;
  useEffect(() => {
    if (noSender) set({ splitTarget: null });
  }, [noSender, set]);

  // Listbox semantics: keyboard focus follows the highlighted option.
  useEffect(() => {
    optionRefs.current[cursor]?.focus();
  }, [cursor, target]);

  if (target == null || !sender) return null;

  const email = sender.email.trim().toLowerCase();
  const domainPrefill = domainSplitPrefill(email);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["splits"] });
    void queryClient.invalidateQueries({ queryKey: ["threads"] });
    void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    void queryClient.invalidateQueries({ queryKey: ["matchingSplit"] });
    void queryClient.invalidateQueries({ queryKey: ["explainRoute"] });
  };

  const create = async (name: string, needle: string) => {
    const created = await call("save_split", {
      split: {
        id: null,
        name,
        position: nextTabPosition(splits, labels),
        query: { senders: [needle] },
        countAll: false,
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
          countAll: matchedRule.countAll ?? false,
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
    ...(domainPrefill
      ? [
          {
            key: "domain",
            title: t("inbox:splitPopover.fromDomain", { domain: domainPrefill.domain }),
            sub: t("inbox:splitPopover.tabName", {
              name: domainPrefill.name,
            }),
            run: () => create(domainPrefill.name, domainPrefill.sender),
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
          ...(domainPrefill
            ? [
                {
                  key: "exclude-domain",
                  title: t("inbox:splitPopover.excludeDomain", {
                    domain: domainPrefill.domain,
                  }),
                  sub: matchedRule.name,
                  run: () => exclude(domainPrefill.sender),
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
    <Modal onClose={close} width={420} top="22vh" labelledBy={titleId}>
      <div
        className="p-2"
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
        <p id={titleId} className="co-hairline-b px-3 py-2 text-sm font-semibold tracking-wide text-ink-faint uppercase">
          {t("inbox:splitPopover.title")}
        </p>
        <p className="px-3 pt-2 text-xs text-ink-faint">
          {matchedTrace
            ? t("settings:splits.why.rule", {
                name: matchedTrace.name,
                conditions: matchedTrace.leaves
                  .filter((l) => l.passed)
                  .map((l) => describeCondition(l.condition, t, labels ?? []))
                  .join(", "),
              })
            : aiTrace
              ? t("settings:splits.why.ai", { name: aiTrace.name })
              : t("settings:splits.why.noRule")}
        </p>
        <div className="pt-1" role="listbox" aria-labelledby={titleId}>
          {options.map((o, i) => (
            <button
              key={o.key}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              role="option"
              aria-selected={i === cursor}
              tabIndex={i === cursor ? 0 : -1}
              disabled={busy}
              className={`flex w-full items-baseline gap-2 rounded-control px-3 py-2 text-start ${
                i === cursor ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseMove={() => setCursor(i)}
              onClick={() => void run(o)}
            >
              <span className="text-base text-ink">{o.title}</span>
              <span className="ms-auto truncate ps-3 text-xs text-ink-faint">
                {o.sub}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
