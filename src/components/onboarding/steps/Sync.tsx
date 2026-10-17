import { animate, AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { prefersReducedMotion } from "../../../lib/reducedMotion";
import { aggregateSyncStatuses } from "../../../lib/syncStatus";
import { useAccounts } from "../../../queries/hooks";
import { useUi } from "../../../stores/ui";
import { Icon } from "../../ui/Icon";
import { Item, PrimaryCta, SPRING, Stagger, StepHeader } from "../flowParts";

type Phase = "connecting" | "fetching" | "ready";

const AUTO_OPEN_MS = 2200; // linger on "ready" before landing in the inbox
const OFFER_ESCAPE_MS = 6000; // a slow server never holds the user hostage

/** The first sync, made visible: a live message count and the preview's
 *  skeleton rows resolving into mail. Lands in the inbox once it's usable. */
export function SyncStep({ onFinish, onFill }: { onFinish: () => void; onFill: (fill: number) => void }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const statuses = useUi((s) => s.syncStatuses);
  const [escape, setEscape] = useState(false);

  const ids = useMemo(() => new Set(accounts?.map((a) => a.id) ?? []), [accounts]);
  const known = Object.values(statuses).some((s) => ids.has(s.accountId));
  const agg = aggregateSyncStatuses(statuses, null);
  const phase: Phase = !known ? "connecting" : agg.foregroundSyncing ? "fetching" : "ready";
  const bg = agg.background;
  const ratio = bg && bg.total > 0 ? bg.done / bg.total : 0;

  const fill = phase === "connecting" ? 0.15 : phase === "fetching" ? 0.4 + 0.45 * ratio : 1;
  useEffect(() => onFill(fill), [fill, onFill]);

  useEffect(() => {
    const id = window.setTimeout(() => setEscape(true), OFFER_ESCAPE_MS);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (phase !== "ready") return;
    const id = window.setTimeout(onFinish, AUTO_OPEN_MS);
    return () => window.clearTimeout(id);
  }, [phase, onFinish]);

  const first = accounts?.[0];
  const name = first?.displayName?.split(" ")[0]?.replace(/\.+$/, "");

  return (
    <Stagger className="flex flex-col">
      <StepHeader
        title={name ? t("onboarding:flow.sync.title", { name }) : t("onboarding:flow.sync.titleNoName")}
      />
      <Item className="mt-7">
        <div className="co-sync-card">
          <div className="flex items-center gap-3">
            <PhaseIcon phase={phase} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={phase}
                className="text-base text-ink"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: SPRING }}
                exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              >
                {t(`onboarding:flow.sync.${phase}`)}
              </motion.span>
            </AnimatePresence>
          </div>
          {bg && bg.total > 0 && (
            <div className="mt-4">
              <div className="flex items-baseline gap-1.5">
                <Counter value={bg.done} />
                <span className="text-sm text-ink-faint">
                  {t("onboarding:flow.sync.ofTotal", { count: bg.total, total: bg.total.toLocaleString() })}
                </span>
              </div>
              <div className="co-sync-track">
                <motion.div className="co-sync-fill" animate={{ scaleX: Math.max(0.02, ratio) }} transition={SPRING} />
              </div>
            </div>
          )}
          {phase === "ready" && bg && <p className="mt-3 text-xs text-ink-faint">{t("onboarding:flow.sync.history")}</p>}
        </div>
      </Item>
      <Item className="mt-8">
        {(phase === "ready" || escape) && (
          <PrimaryCta onClick={onFinish}>
            {phase === "ready" ? t("onboarding:flow.sync.open") : t("onboarding:flow.sync.openAnyway")}
          </PrimaryCta>
        )}
      </Item>
    </Stagger>
  );
}

function PhaseIcon({ phase }: { phase: Phase }) {
  if (phase === "ready") {
    return (
      <motion.span
        className="co-onb-check is-ok size-6"
        initial={{ scale: 0 }}
        animate={{ scale: 1, transition: { ...SPRING, stiffness: 560 } }}
      >
        <Icon name="check" size={13} />
      </motion.span>
    );
  }
  return <span className="co-spinner size-5 rounded-full border-2 border-hairline-strong border-t-accent" />;
}

/** A count that rolls up to each new value instead of jumping. */
function Counter({ value }: { value: number }) {
  const mv = useMotionValue(prefersReducedMotion() ? value : 0);
  const text = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    if (prefersReducedMotion()) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [value, mv]);
  return <motion.span className="text-[34px] leading-none font-semibold tracking-tight text-ink tabular-nums">{text}</motion.span>;
}
