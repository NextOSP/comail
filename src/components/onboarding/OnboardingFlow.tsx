import { AnimatePresence, motion, MotionConfig, type Variants } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeEvent } from "../../keyboard/registry";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { useAccounts } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { SPRING } from "./flowParts";
import { IntroMark } from "./IntroMark";
import { PreviewInbox, type PreviewBeat, type PreviewBeatKind, type PreviewMode } from "./PreviewInbox";
import { ConnectStep } from "./steps/Connect";
import { PersonalizeStep } from "./steps/Personalize";
import { ShortcutsStep } from "./steps/Shortcuts";
import { SyncStep } from "./steps/Sync";
import { WelcomeStep } from "./steps/Welcome";

/**
 * First-run guided setup: welcome -> connect -> personalize -> shortcuts ->
 * AI keys -> sync -> the inbox. Split like Notion Mail's setup: the step on the left,
 * the real inbox UI on the right (PreviewInbox), cropped by the stage edge,
 * acting out each step and re-skinning with the theme pickers. Keyboard-first:
 * Enter continues, Esc goes back.
 */

const STEPS = ["welcome", "connect", "personalize", "shortcuts", "ai", "sync"] as const;

const LEAVE_MS = 650;

const SLIDE: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: 32 * dir }),
  center: { opacity: 1, x: 0, transition: { ...SPRING, staggerChildren: 0.055 } },
  exit: (dir: number) => ({ opacity: 0, x: -24 * dir, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] as const } }),
};

export function OnboardingFlow({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const [[index, dir], setNav] = useState<[number, number]>([0, 1]);
  const [beat, setBeat] = useState<PreviewBeat>(null);
  const [waiting, setWaiting] = useState(false);
  const [syncFill, setSyncFill] = useState(0.15);
  const [leaving, setLeaving] = useState(false);
  const beatN = useRef(0);
  const { ref: stageRef, vars: stageVars } = useStageFit();
  const step = STEPS[index];
  const hasAccount = (accounts?.length ?? 0) > 0;
  const first = accounts?.[0];
  const account = first
    ? { label: first.displayName?.trim() || first.email, detail: first.displayName?.trim() ? first.email : undefined }
    : undefined;

  const finish = useCallback(() => {
    setLeaving((was) => {
      if (!was) window.setTimeout(onDone, prefersReducedMotion() ? 0 : LEAVE_MS);
      return true;
    });
  }, [onDone]);

  const goTo = useCallback((to: number) => {
    setNav(([from]) => [Math.max(0, Math.min(STEPS.length - 1, to)), to >= from ? 1 : -1]);
  }, []);
  const next = useCallback(() => {
    if (index >= STEPS.length - 1) finish();
    else goTo(index + 1);
  }, [index, finish, goTo]);
  const back = useCallback(() => goTo(index - 1), [index, goTo]);

  const canNext = step !== "sync" && (step !== "connect" || hasAccount);
  const canBack = index > 0 && step !== "sync";

  // Enter / Esc drive the flow - unless typing, a real button has focus (it
  // handles Enter itself), or an app overlay (Settings) is on top.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const token = normalizeEvent(e);
      if (token !== "enter" && token !== "escape") return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (token === "enter" && el?.closest("button, a")) return;
      const ui = useUi.getState();
      if (ui.panel != null || ui.paletteOpen) return;
      if (token === "enter" && canNext) {
        e.preventDefault();
        e.stopPropagation();
        next();
      } else if (token === "escape" && canBack) {
        e.preventDefault();
        e.stopPropagation();
        back();
      }
    };
    // On document (not window): steps that own keys (the shortcuts sandbox) listen
    // on window in the capture phase, which runs first and can stop it here.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [canNext, canBack, next, back]);

  const onBeat = useCallback((kind: PreviewBeatKind) => {
    beatN.current += 1;
    setBeat({ kind, n: beatN.current });
  }, []);

  const mode: PreviewMode =
    step === "connect"
      ? hasAccount
        ? "connected"
        : waiting
          ? "waiting"
          : "connect"
      : step === "ai"
        ? "shortcuts"
        : step;

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="co-onb"
        data-tauri-drag-region
        initial={{ opacity: 0 }}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={{ duration: leaving ? LEAVE_MS / 1000 : 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Left: the step. */}
        <section className="co-onb-panel" data-tauri-drag-region>
          <header className="flex items-center gap-2.5" data-tauri-drag-region>
            <IntroMark className="size-5" />
            <span className="text-sm font-semibold tracking-[0.14em] text-ink-faint uppercase">Comail</span>
            <IconButton
              icon="settings"
              size="md"
              label={t("onboarding:settingsAria")}
              title={t("onboarding:settingsTitle")}
              className="ml-auto"
              onClick={() => useUi.getState().set({ panel: "settings" })}
            />
          </header>

          <div className="co-onb-content">
            <AnimatePresence mode="wait" custom={dir}>
              <motion.div
                key={step}
                custom={dir}
                variants={SLIDE}
                initial="enter"
                animate="center"
                exit="exit"
                className="w-full"
              >
                {step === "welcome" && <WelcomeStep onNext={next} />}
                {step === "connect" && <ConnectStep onNext={next} onWaiting={setWaiting} />}
                {step === "personalize" && <PersonalizeStep onNext={next} />}
                {step === "shortcuts" && <ShortcutsStep lesson="basics" onNext={next} onBeat={onBeat} />}
                {step === "ai" && <ShortcutsStep lesson="ai" onNext={next} onBeat={onBeat} />}
                {step === "sync" && <SyncStep onFinish={finish} onFill={setSyncFill} />}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="flex h-9 items-center gap-4">
            <AnimatePresence initial={false}>
              {canBack && (
                <motion.button
                  type="button"
                  className="co-onb-link flex items-center gap-1"
                  onClick={back}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6 }}
                >
                  <Icon name="chevronLeft" size={13} />
                  {t("onboarding:flow.back")}
                </motion.button>
              )}
            </AnimatePresence>
            <Pager index={index} />
          </footer>
        </section>

        {/* Right: the stage - a gradient room with the live preview in it. */}
        <section className="co-onb-stage" aria-hidden ref={stageRef} style={stageVars}>
          <motion.div
            className="co-onb-window"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          >
            <PreviewInbox mode={mode} beat={beat} syncFill={syncFill} account={account} />
          </motion.div>
        </section>
      </motion.div>
    </MotionConfig>
  );
}

// The preview window is the app's real layout at a fixed SCALE, sized in its
// own pixels to fill the stage: inset INSET from the top-left and always
// running BLEED past the right and bottom edges, so it reads as the app
// cropped by the frame at any window size (text never grows or shrinks).
const SCALE = 0.82;
const INSET = 56;
const BLEED = 48;

function useStageFit() {
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!size) return { ref, vars: undefined };
  const px = (stage: number) => `${Math.round((stage - INSET + BLEED) / SCALE)}px`;
  return {
    ref,
    vars: { "--pv-scale": String(SCALE), "--pv-w": px(size.w), "--pv-h": px(size.h) } as React.CSSProperties,
  };
}

/** Linear-style dots; the active one stretches into a pill. */
function Pager({ index }: { index: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="ml-auto flex items-center gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={STEPS.length}
      aria-valuenow={index + 1}
      aria-label={t("onboarding:flow.stepOf", { n: index + 1, total: STEPS.length })}
    >
      {STEPS.map((s, i) => (
        <motion.span
          key={s}
          className="co-onb-dot"
          animate={{ width: i === index ? 20 : 6, opacity: i <= index ? 1 : 0.35 }}
          transition={SPRING}
        />
      ))}
    </div>
  );
}
