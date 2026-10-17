// Shared building blocks for the management panels (Settings / Snippets / Splits).
// Generic controls live in components/ui and are re-exported here so panel
// code keeps one import site. Visual language: hairline borders, bg1 surface,
// elev-2 shadow, accent only for focus/selection.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, buttonCls } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";

export { BusyLabel, Spinner } from "../ui/Spinner";
export {
  Checkbox,
  EmptyState,
  FormField,
  inputCls,
  SectionLabel,
  Segmented,
  Select,
  selectCls,
  Toggle,
} from "../ui/Field";
export { Button, IconButton, buttonCls } from "../ui/Button";

/** @deprecated use <Button variant="primary"> */
export const primaryBtnCls = buttonCls("primary", "md");
/** @deprecated use <Button variant="secondary"> */
export const ghostBtnCls = buttonCls("secondary", "md");

export function PanelShell({
  title,
  onClose,
  children,
  width = 560,
  tabs,
  sidebar,
  search,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Optional tab bar rendered below the header; stays fixed while the body scrolls. */
  tabs?: ReactNode;
  /** Optional left navigation. When present, it and the body scroll independently. */
  sidebar?: ReactNode;
  /** Optional search field rendered in the header row, right-aligned. */
  search?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      onClose={onClose}
      width={width}
      top="6vh"
      sheet
      className="flex max-h-[86vh] flex-col overflow-hidden"
    >
      <header className="co-hairline-b flex shrink-0 items-center justify-between gap-4 px-5 py-3">
        <h2 className="shrink-0 text-md font-semibold text-ink">{title}</h2>
        {search ? (
          search
        ) : (
          <span className="text-xs text-ink-faint">{t("common:shortcutHelp.escToClose")}</span>
        )}
      </header>
      {tabs && <div className="co-hairline-b flex shrink-0 gap-1 px-4">{tabs}</div>}
      {sidebar ? (
        <div className="flex min-h-0 flex-1">
          <aside className="co-scroll-none w-[204px] shrink-0 overflow-y-auto border-r border-hairline bg-bg0/55 p-3">
            {sidebar}
          </aside>
          {/* Stable gutter keeps the content from shifting when its scrollbar
              appears, and gives that single bar clean breathing room. */}
          <div className="min-w-0 flex-1 overflow-y-auto p-7" style={{ scrollbarGutter: "stable" }}>
            {children}
          </div>
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      )}
    </Modal>
  );
}

/** A single tab button for a PanelShell `tabs` bar. */
export function PanelTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-base transition-colors ${
        active
          ? "border-accent font-medium text-ink"
          : "border-transparent text-ink-faint hover:text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}

/** Top of a settings page: title, one-line description, optional actions. */
export function PageHeader({
  title,
  description,
  badge,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** e.g. <AiBadge /> on AI pages */
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink">
          {title}
          {badge}
        </h2>
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A titled card of settings. Children are usually SettingRows; direct children
 * get hairline dividers so rows never need their own borders.
 */
export function SettingsGroup({
  title,
  description,
  badge,
  actions,
  children,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** No inner padding/dividers (for lists that render their own rows). */
  flush?: boolean;
}) {
  return (
    <section className="mb-6">
      {(title || actions) && (
        <div className="mb-2 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
                {title}
                {badge}
              </h3>
            )}
            {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div
        className={`rounded-card border border-hairline bg-bg1 ${
          flush ? "" : "divide-y divide-hairline [&>*]:px-4 [&>*]:py-3"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

/** Setting row: label + optional hint on the left, control on the right. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-base text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Danger button with an inline confirm step that disarms after 3s. */
export function ConfirmButton({
  label,
  ariaLabel,
  confirmLabel,
  onConfirm,
  size = "sm",
}: {
  label: string;
  /** fuller accessible name for the unarmed state (e.g. "Delete GitHub") */
  ariaLabel?: string;
  confirmLabel: string;
  onConfirm: () => void;
  size?: "sm" | "md";
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <Button
      size={size}
      variant="danger"
      aria-label={armed ? undefined : ariaLabel}
      className={armed ?"border-danger bg-danger font-semibold text-on-accent hover:bg-danger" : ""}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/** Token editor: each value renders as a removable pill with a text input to
 *  add more. Commits a token on comma, semicolon, newline, Enter, or blur, and
 *  splits pasted separated lists; Backspace on an empty input drops the last
 *  chip. Values are de-duplicated case-insensitively. */
export function ChipInput({
  values,
  onChange,
  placeholder,
  ariaLabel,
  removeLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Accessible prefix for a chip's delete button, e.g. "Remove". */
  removeLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string[]) => {
    const next = [...values];
    for (const token of raw) {
      const v = token.trim();
      if (v && !next.some((e) => e.toLowerCase() === v.toLowerCase())) next.push(v);
    }
    if (next.length !== values.length) onChange(next);
  };

  return (
    <div
      className="flex w-full flex-wrap items-center gap-1.5 rounded-control border border-hairline bg-bg0 px-2 py-1.5 focus-within:border-accent/60"
      onMouseDown={(e) => {
        // A click on the field's own padding focuses the input; clicks that land
        // on a chip or its delete button keep their native behaviour.
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}
    >
      {values.map((v, i) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-md bg-bg2 py-0.5 pr-1 pl-2 text-sm text-ink"
        >
          {v}
          <button
            type="button"
            aria-label={removeLabel ? `${removeLabel} ${v}` : undefined}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="flex size-4 items-center justify-center rounded text-ink-faint hover:bg-bg3 hover:text-ink"
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-base text-ink outline-none placeholder:text-ink-faint"
        value={draft}
        placeholder={values.length === 0 ? placeholder : ""}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,;\n]/.test(v)) {
            const parts = v.split(/[,;\n]/);
            const tail = parts.pop() ?? "";
            add(parts);
            setDraft(tail);
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            add([draft]);
            setDraft("");
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) {
            add([draft]);
            setDraft("");
          }
        }}
      />
    </div>
  );
}
