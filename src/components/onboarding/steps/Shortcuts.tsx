import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ALL_COMMANDS } from "../../../keyboard/commands";
import { normalizeEvent } from "../../../keyboard/registry";
import { MOD_LABEL } from "../../../lib/format";
import { Icon } from "../../ui/Icon";
import type { PreviewBeatKind } from "../PreviewInbox";
import { Item, keyParts, Keycap, PrimaryCta, SPRING, Stagger, StepHeader } from "../flowParts";

export type Lesson = "basics" | "ai";
/** Where the sandbox window is, which decides what a contextual key does. */
type Where = "list" | "thread" | "draft" | "search";

interface Move {
  kind: PreviewBeatKind;
  /** The key sequence to teach, as registry tokens ("r", "mod+j"). */
  keys: string[];
}

/** The binding the app really uses, so the lesson can never drift from it. */
function bindingFor(command: string, fallback: string): string {
  return ALL_COMMANDS.find((c) => c.id === command)?.keys[0] ?? fallback;
}

const K = {
  down: bindingFor("next-thread", "j"),
  up: bindingFor("prev-thread", "k"),
  search: bindingFor("search", "/"),
  done: bindingFor("mark-done", "e"),
  star: bindingFor("star", "s"),
  snooze: bindingFor("snooze", "h"),
  reply: bindingFor("reply", "r"),
  palette: bindingFor("palette", "mod+k"),
  ai: bindingFor("ai-summarize", "mod+j"),
  proofread: bindingFor("ai-proofread", "mod+shift+p"),
};

const LESSONS: Record<Lesson, { group: string; moves: Move[] }[]> = {
  basics: [
    {
      group: "navigate",
      moves: [
        { kind: "down", keys: [K.down] },
        { kind: "up", keys: [K.up] },
        { kind: "search", keys: [K.search] },
      ],
    },
    {
      group: "triage",
      moves: [
        { kind: "done", keys: [K.done] },
        { kind: "star", keys: [K.star] },
        { kind: "snooze", keys: [K.snooze] },
      ],
    },
    {
      group: "act",
      moves: [
        { kind: "reply", keys: [K.reply] },
        { kind: "palette", keys: [K.palette] },
      ],
    },
  ],
  ai: [
    {
      group: "ai",
      moves: [
        { kind: "summarize", keys: [K.ai] },
        { kind: "aiWrite", keys: [K.reply, K.ai] },
        { kind: "proofread", keys: [K.reply, K.proofread] },
        { kind: "ask", keys: [K.search, K.ai] },
      ],
    },
  ],
};

const movesOf = (lesson: Lesson) => LESSONS[lesson].flatMap((g) => g.moves);

/** What a key does in the sandbox, given where the window is: the same
 *  contextual rules as the app (⌘J summarizes a thread, writes in a draft,
 *  flips search to Ask AI). Returns the beat and the window's next place. */
function resolve(token: string, where: Where): { kind: PreviewBeatKind; where: Where } | null {
  switch (token) {
    case K.down:
      return { kind: "down", where: "list" };
    case K.up:
      return { kind: "up", where: "list" };
    case K.done:
      return { kind: "done", where: "list" };
    case K.snooze:
      return { kind: "snooze", where: "list" };
    case K.star:
      return { kind: "star", where };
    case K.reply:
      return { kind: "reply", where: "draft" };
    case K.search:
      return { kind: "search", where: "search" };
    case K.palette:
      return { kind: "palette", where };
    case K.ai:
      if (where === "draft") return { kind: "aiWrite", where };
      if (where === "search") return { kind: "ask", where };
      return { kind: "summarize", where: "thread" };
    case K.proofread:
      return where === "draft" ? { kind: "proofread", where } : null;
    case "escape":
      return where === "list" ? null : { kind: "back", where: "list" };
  }
  return null;
}

/** A keyboard sandbox, one lesson per step: the basics, then the AI keys.
 *  Every key acts out in the preview, in any order (both lessons' keys work
 *  in either step); the prompt suggests the next untried move. Keys are caught on window in the capture phase, so the
 *  app's real commands never fire underneath and the flow's own Esc/Enter
 *  (on document) only sees what the sandbox leaves alone. */
export function ShortcutsStep({
  lesson,
  onNext,
  onBeat,
}: {
  lesson: Lesson;
  onNext: () => void;
  onBeat: (kind: PreviewBeatKind) => void;
}) {
  const { t } = useTranslation();
  const [tried, setTried] = useState<Set<PreviewBeatKind>>(new Set());
  const [pressed, setPressed] = useState<string | null>(null);
  // The AI lesson opens on a conversation, where ⌘J has something to read.
  const where = useRef<Where>(lesson === "ai" ? "thread" : "list");
  const allowed = new Set(movesOf(lesson).flatMap((m) => m.keys));
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;

  // Each lesson starts on a fresh sandbox (the AI demo content is written
  // for its first conversation, which the AI lesson opens on).
  useEffect(() => onBeatRef.current(lesson === "ai" ? "resetThread" : "reset"), []);

  const play = (kind: PreviewBeatKind, next: Where) => {
    where.current = next;
    setTried((s) => new Set(s).add(kind));
    onBeatRef.current(kind);
  };
  /** Clicking a chip plays its whole sequence. */
  const playMove = (m: Move) => {
    let at: Where = "list";
    let last: PreviewBeatKind | null = null;
    for (const k of m.keys) {
      const r = resolve(k, at);
      if (!r) continue;
      at = r.where;
      last = r.kind;
      if (m.keys.length > 1 && k !== m.keys[m.keys.length - 1]) onBeatRef.current(r.kind);
    }
    if (last) play(last, at);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      const token = normalizeEvent(e);
      if (!token) return;
      // Only this lesson's keys (and Esc) play, so the sandbox stays on the
      // conversation the lesson's demo content was written for.
      if (token !== "escape" && !allowed.has(token)) return;
      const r = resolve(token, where.current);
      if (!r) return;
      e.preventDefault();
      e.stopPropagation();
      setPressed(token);
      if (!e.repeat) play(r.kind, r.where);
    };
    const up = () => setPressed(null);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moves = movesOf(lesson);

  const triedHere = moves.filter((m) => tried.has(m.kind)).length;
  const suggest = moves.find((m) => !tried.has(m.kind));

  return (
    <Stagger className="flex flex-col">
      {lesson === "ai" ? (
        <StepHeader title={t("onboarding:flow.ai.title", { mod: MOD_LABEL })} body={t("onboarding:flow.ai.body", { mod: MOD_LABEL })} />
      ) : (
        <StepHeader title={t("onboarding:flow.shortcuts.title")} body={t("onboarding:flow.shortcuts.body")} />
      )}

      {/* The prompt: the next untried move, its keys big. */}
      <Item className="mt-6 min-h-[84px]">
        <AnimatePresence mode="wait" initial={false}>
          {suggest ? (
            <motion.div
              key={`${lesson}:${suggest.kind}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: SPRING }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
            >
              <div className="flex items-center gap-2.5">
                <span className="text-sm text-ink-faint">{t("onboarding:flow.shortcuts.press")}</span>
                {suggest.keys.map((k, i) => (
                  <span key={k} className="flex items-center gap-2.5">
                    {i > 0 && <span className="text-sm text-ink-faint">{t("onboarding:flow.shortcuts.then")}</span>}
                    <span className="flex gap-1.5">
                      {keyParts(k).map((p) => (
                        <Keycap key={p} label={p} pressed={pressed === k} />
                      ))}
                    </span>
                  </span>
                ))}
              </div>
              <p className="mt-3 text-md text-ink">{t(`onboarding:flow.shortcuts.${suggest.kind}`)}</p>
            </motion.div>
          ) : (
            <motion.p
              key={`${lesson}:all`}
              className="text-md text-ink"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: SPRING }}
            >
              {lesson === "ai"
                ? t("onboarding:flow.shortcuts.aiDone", { mod: MOD_LABEL })
                : t("onboarding:flow.shortcuts.allDone")}
            </motion.p>
          )}
        </AnimatePresence>
      </Item>

      {/* Every move in this lesson, ticked off as it is tried. */}
      <Item className="mt-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={lesson}
            className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3.5"
            initial={{ opacity: 0, x: lesson === "ai" ? 12 : -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: lesson === "ai" ? -12 : 12, transition: { duration: 0.1 } }}
            transition={{ duration: 0.2 }}
          >
            {LESSONS[lesson].map((g) => (
              <div key={g.group} className="contents">
                <span className="pt-1.5 text-xs text-ink-faint">{t(`onboarding:flow.shortcuts.groups.${g.group}`)}</span>
                <div className="flex flex-wrap gap-1.5">
                  {g.moves.map((m) => (
                    <button
                      key={m.kind}
                      type="button"
                      className={`co-move ${tried.has(m.kind) ? "is-done" : ""} ${
                        pressed && m.keys.includes(pressed) ? "is-pressed" : ""
                      }`}
                      onClick={() => playMove(m)}
                    >
                      <span className="flex items-center gap-0.5">
                        {m.keys.map((k, i) => (
                          <span key={k} className="flex items-center gap-0.5">
                            {i > 0 && <span className="px-0.5 text-2xs text-ink-faint">›</span>}
                            {keyParts(k).map((p) => (
                              <kbd key={p} className="co-kbd">
                                {p}
                              </kbd>
                            ))}
                          </span>
                        ))}
                      </span>
                      {t(`onboarding:flow.shortcuts.${m.kind}Short`)}
                      {tried.has(m.kind) && <Icon name="check" size={11} className="text-ok" />}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        </AnimatePresence>
      </Item>

      <Item className="mt-8 flex items-center gap-4">
        <PrimaryCta onClick={onNext}>{t("onboarding:flow.continue")}</PrimaryCta>
        <span className="text-sm text-ink-faint tabular-nums">
          {t("onboarding:flow.shortcuts.progress", { n: triedHere, total: moves.length })}
        </span>
      </Item>
    </Stagger>
  );
}
