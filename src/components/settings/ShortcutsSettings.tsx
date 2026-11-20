import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "../../ipc/types";
import { buildCommandContext } from "../../keyboard/context";
import {
  CHORD_TIMEOUT,
  commandKeys,
  displayShortcut,
  getCommands,
  isReachableKey,
  normalizeEvent,
  type Command,
  type KeyOverrides,
} from "../../keyboard/registry";
import {
  bindKey,
  findConflicts,
  recordStep,
  resetConflicts,
  resetKeys,
  sampleContexts,
  SHORTCUT_SECTIONS,
  shortcutRows,
  unbindSlot,
  type Conflict,
} from "../../keyboard/shortcuts";
import { Icon } from "../ui/Icon";
import { Button, ConfirmButton, IconButton, inputCls, SettingsGroup } from "./panelKit";
import { updateSettings } from "./SettingsPanel";

/** Where the recorder writes: a key slot of a command, or a new key (null). */
type Target = { row: string; id: string; slot: number | null };

/** "⌘K" or "G then I" as key caps. */
function Keys({ keys }: { keys: string }) {
  const { t } = useTranslation();
  const parts = displayShortcut(keys).split(" then ");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          <kbd className="co-kbd">{part}</kbd>
          {i < parts.length - 1 && <span className="text-xs text-ink-faint">{t("common:shortcutHelp.then")}</span>}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Command `when`s read focus (Tab cycling only from a resting focus, select-all
 * not in a text field). Judge clashes as the app would see them, not with
 * focus on the Settings button that asked.
 */
function withRestingFocus<T>(fn: () => T): T {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return fn();
  el.blur();
  try {
    return fn();
  } finally {
    el.focus({ preventScroll: true });
  }
}

const contexts = () => sampleContexts(buildCommandContext());

export function ShortcutsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const map: KeyOverrides = settings.keyboardShortcuts ?? {};
  const commands = getCommands();
  const [filter, setFilter] = useState("");
  const [rec, setRec] = useState<Target | null>(null);
  /** first key of a sequence being recorded */
  const [first, setFirst] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ row: string; text: string } | null>(null);
  const [ask, setAsk] = useState<{ row: string; text: string; apply: () => void } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const titleOf = (cmd: Command) => (cmd.title ? cmd.title() : t(cmd.titleKey, cmd.titleParams));
  const titleOfId = (id: string) => {
    const cmd = commands.find((c) => c.id === id);
    return cmd ? titleOf(cmd) : id;
  };
  const save = (next: KeyOverrides) => void updateSettings({ keyboardShortcuts: next });

  /** Ask before taking keys off other commands; apply right away otherwise. */
  const confirmOrApply = (row: string, conflicts: Conflict[], apply: (unbind: Conflict[]) => void) => {
    if (conflicts.length === 0) {
      apply([]);
      return;
    }
    const keys = [...new Set(conflicts.map((c) => displayShortcut(c.clashesWith)))].join(", ");
    const users = [
      ...new Set(
        conflicts.map((c) =>
          c.key === c.clashesWith ? titleOfId(c.id) : `${titleOfId(c.id)} (${displayShortcut(c.key)})`,
        ),
      ),
    ].join(", ");
    setAsk({
      row,
      text: t("settings:shortcuts.conflict", { keys, commands: users }),
      apply: () => {
        setAsk(null);
        apply(conflicts);
      },
    });
  };

  const commit = (target: Target, keys: string) => {
    const cmd = commands.find((c) => c.id === target.id);
    if (!cmd) return;
    const current = commandKeys(cmd, map);
    if (target.slot == null ? current.includes(keys) : current[target.slot] === keys) return;
    const conflicts = withRestingFocus(() => findConflicts(target.id, keys, commands, map, contexts));
    confirmOrApply(target.row, conflicts, (unbind) =>
      save(bindKey(map, commands, target.id, target.slot, keys, unbind)),
    );
  };

  const reset = (row: string, ids: string[]) => {
    setAsk(null);
    const conflicts = withRestingFocus(() => resetConflicts(map, commands, ids, contexts));
    confirmOrApply(row, conflicts, (unbind) => save(resetKeys(map, commands, ids, unbind)));
  };

  const start = (target: Target, el: HTMLElement) => {
    setAsk(null);
    setNotice(null);
    setFirst(null);
    setRec(target);
    // Out of the button, so Space/Enter record instead of clicking it again.
    returnFocus.current = el;
    el.blur();
  };

  // The recorder: while it runs it gets every key before the app's keymap.
  useEffect(() => {
    if (!rec) return;
    let pending: string | null = null;
    let timer: number | undefined;
    const stop = (refocus: boolean) => {
      window.clearTimeout(timer);
      setRec(null);
      setFirst(null);
      setNotice(null);
      const el = returnFocus.current;
      returnFocus.current = null;
      if (refocus && el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
    };
    const finish = (keys: string) => {
      stop(true);
      commit(rec, keys);
    };
    const onKey = (e: KeyboardEvent) => {
      const step = recordStep(pending, normalizeEvent(e));
      e.stopImmediatePropagation();
      // A reserved key keeps its usual job (Tab moves focus, Alt+F4 closes).
      if (step.kind !== "reserved") e.preventDefault();
      if (e.repeat) return;
      if (step.kind === "cancel") stop(true);
      else if (step.kind === "reserved") {
        setNotice({ row: rec.row, text: t("settings:shortcuts.reserved", { keys: displayShortcut(step.key) }) });
      } else if (step.kind === "pending") {
        pending = step.first;
        setFirst(step.first);
        setNotice(null);
        timer = window.setTimeout(() => finish(step.first), CHORD_TIMEOUT);
      } else if (step.kind === "done") finish(step.keys);
    };
    const onPointer = () => stop(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("blur", onPointer);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("blur", onPointer);
    };
    // Restarts only for a new target; `commit` reads the settings current then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec]);

  // Esc dismisses the clash prompt instead of closing Settings.
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setAsk(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ask]);

  const q = filter.trim().toLowerCase();
  const rows = shortcutRows(commands, titleOf).filter(
    (row) =>
      !q ||
      row.title.toLowerCase().includes(q) ||
      row.ids.some((id) => {
        const cmd = commands.find((c) => c.id === id);
        return cmd != null && commandKeys(cmd, map).some((k) => displayShortcut(k).toLowerCase().includes(q));
      }),
  );
  const customized = Object.keys(map).length > 0;

  const recordingLabel = (
    <span className="flex items-center gap-1 text-xs text-accent">
      {first ? (
        <>
          <Keys keys={first} />
          <span>{t("common:shortcutHelp.then")} …</span>
        </>
      ) : (
        t("settings:shortcuts.recording")
      )}
    </span>
  );

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <input
          className={`${inputCls} !w-[260px] !py-1.5`}
          placeholder={t("settings:shortcuts.filter")}
          aria-label={t("settings:shortcuts.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        {customized && (
          <ConfirmButton
            label={t("settings:shortcuts.resetAll")}
            confirmLabel={t("settings:shortcuts.resetAllConfirm")}
            onConfirm={() => {
              setAsk(null);
              save({});
            }}
          />
        )}
      </div>

      {rows.length === 0 && (
        <p className="py-6 text-center text-base text-ink-faint">
          {t("settings:shortcuts.noMatches", { query: filter.trim() })}
        </p>
      )}

      {SHORTCUT_SECTIONS.filter((s) => rows.some((r) => r.section === s)).map((section) => (
        <SettingsGroup key={section} title={t(`commands:section.${section}`)}>
          {rows
            .filter((r) => r.section === section)
            .map((row) => {
              const rowKey = row.ids[0];
              const slots = row.ids.flatMap((id) => {
                const cmd = commands.find((c) => c.id === id)!;
                return commandKeys(cmd, map)
                  .map((keys, slot) => ({ id, slot, keys }))
                  .filter((s) => isReachableKey(s.keys));
              });
              const adding = rec?.row === rowKey && rec.slot == null;
              const changed = row.ids.some((id) => map[id] != null);
              return (
                <div key={rowKey}>
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate text-base text-ink">{row.title}</span>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {slots.length === 0 && !adding && (
                        <span className="text-sm text-ink-faint">{t("settings:shortcuts.none")}</span>
                      )}
                      {slots.map((s) => {
                        const recording = rec?.id === s.id && rec.slot === s.slot;
                        const label = displayShortcut(s.keys);
                        return (
                          <span
                            key={`${s.id}:${s.slot}`}
                            className={`inline-flex items-center rounded-control border ${
                              recording ? "border-accent/60 bg-accent/10" : "border-hairline bg-bg0"
                            }`}
                          >
                            <button
                              type="button"
                              className="flex items-center gap-1 rounded-control py-0.5 ps-1 pe-0.5 hover:bg-bg2"
                              aria-label={t("settings:shortcuts.change", { keys: label, command: row.title })}
                              title={t("settings:shortcuts.change", { keys: label, command: row.title })}
                              onClick={(e) => start({ row: rowKey, id: s.id, slot: s.slot }, e.currentTarget)}
                            >
                              {recording ? recordingLabel : <Keys keys={s.keys} />}
                            </button>
                            <button
                              type="button"
                              className="flex size-5 items-center justify-center rounded-control text-ink-faint hover:bg-bg2 hover:text-ink"
                              aria-label={t("settings:shortcuts.remove", { keys: label, command: row.title })}
                              title={t("settings:shortcuts.remove", { keys: label, command: row.title })}
                              onClick={() => {
                                setAsk(null);
                                save(unbindSlot(map, commands.find((c) => c.id === s.id)!, s.slot));
                              }}
                            >
                              <Icon name="close" size={10} />
                            </button>
                          </span>
                        );
                      })}
                      {adding && (
                        <span className="inline-flex items-center rounded-control border border-accent/60 bg-accent/10 px-1.5 py-0.5">
                          {recordingLabel}
                        </span>
                      )}
                      <IconButton
                        icon="plus"
                        size="xs"
                        label={t("settings:shortcuts.add", { command: row.title })}
                        onClick={(e) => start({ row: rowKey, id: rowKey, slot: null }, e.currentTarget)}
                      />
                      {changed && (
                        <IconButton
                          icon="refresh"
                          size="xs"
                          label={t("settings:shortcuts.reset", { command: row.title })}
                          onClick={() => reset(rowKey, row.ids)}
                        />
                      )}
                    </div>
                  </div>
                  {rec?.row === rowKey && (
                    <p className="mt-1.5 text-xs text-ink-faint">{t("settings:shortcuts.recordHint")}</p>
                  )}
                  {notice?.row === rowKey && <p className="mt-1.5 text-xs text-danger">{notice.text}</p>}
                  {ask?.row === rowKey && (
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-control bg-bg2 px-3 py-2">
                      <span className="text-sm text-ink-muted">{ask.text}</span>
                      <span className="flex shrink-0 gap-1.5">
                        <Button size="sm" variant="primary" onClick={ask.apply}>
                          {t("settings:shortcuts.replace")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAsk(null)}>
                          {t("settings:shortcuts.cancel")}
                        </Button>
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
        </SettingsGroup>
      ))}
    </>
  );
}
