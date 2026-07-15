// Shared building blocks for the management panels (Settings / Snippets / Splits).
// Visual language matches the palette + help overlays: hairline borders,
// bg1 surface, elev-2 shadow, accent only for focus/selection.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  children: React.ReactNode;
  width?: number;
  /** Optional tab bar rendered below the header; stays fixed while the body scrolls. */
  tabs?: React.ReactNode;
  /** Optional left navigation. When present, it and the body scroll independently. */
  sidebar?: React.ReactNode;
  /** Optional search field rendered in the header row, right-aligned. */
  search?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="co-overlay flex items-start justify-center pt-[6vh]" onMouseDown={onClose}>
      <div
        className="co-pop-in flex max-h-[86vh] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-hairline bg-bg1"
        style={{ boxShadow: "var(--elev-2)", width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="co-hairline-b flex shrink-0 items-center justify-between gap-4 px-5 py-3">
          <h2 className="shrink-0 text-[15px] font-semibold text-ink">{title}</h2>
          {search ? (
            search
          ) : (
            <span className="text-[12px] text-ink-faint">{t("common:shortcutHelp.escToClose")}</span>
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
      </div>
    </div>
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
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
        active
          ? "border-accent font-medium text-ink"
          : "border-transparent text-ink-faint hover:text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11.5px] font-semibold tracking-[0.12em] text-ink-faint uppercase">
      {children}
    </h3>
  );
}

/** Setting row: label + optional hint on the left, control on the right. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13.5px] text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] text-ink-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-hairline bg-bg0 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-[12.5px] transition-colors duration-100 ${
            o.value === value
              ? "bg-bg2 font-medium text-ink"
              : "text-ink-faint hover:text-ink-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 ${
        checked ? "bg-accent" : "bg-bg4"
      }`}
    >
      <span
        className={`absolute top-[2px] left-0 size-[14px] rounded-full bg-bg0 transition-transform duration-150 ${
          checked ? "translate-x-[16px]" : "translate-x-[2px]"
        }`}
        style={{ boxShadow: "var(--elev-1)" }}
      />
    </button>
  );
}

/** Danger button with an inline confirm step that disarms after 3s. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      className={`rounded-md px-2.5 py-1 text-[12px] transition-colors duration-100 ${
        armed
          ? "bg-danger font-semibold text-white"
          : "border border-hairline text-danger hover:bg-bg2"
      }`}
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
    </button>
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
      className="flex w-full flex-wrap items-center gap-1.5 rounded-lg border border-hairline bg-bg0 px-2 py-1.5 focus-within:border-accent/60"
      onMouseDown={(e) => {
        // A click on the field's own padding focuses the input; clicks that land
        // on a chip or its delete button keep their native behaviour.
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}
    >
      {values.map((v, i) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-md bg-bg2 py-0.5 pr-1 pl-2 text-[12.5px] text-ink"
        >
          {v}
          <button
            type="button"
            aria-label={removeLabel ? `${removeLabel} ${v}` : undefined}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="flex size-4 items-center justify-center rounded text-ink-faint hover:bg-bg3 hover:text-ink"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
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

export function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-hairline bg-bg0 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60";

// A native <select> and an <input> with identical CSS still render at slightly
// different heights (the browser gives selects their own box metrics). Stripping
// the native appearance makes the box follow our padding/line-height exactly,
// matching inputCls to the pixel, so we draw our own chevron instead.
export const selectCls =
  "w-full cursor-pointer appearance-none rounded-lg border border-hairline bg-bg0 py-2 pr-9 pl-3 text-[13.5px] text-ink outline-none focus:border-accent/60";

/** Native <select> restyled to line up with inputCls fields, with a custom
 *  chevron. Width/extra classes go on `className` (applied to the select). */
export function Select({
  className = "",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex">
      <select className={`${selectCls} ${className}`} {...props}>
        {children}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  );
}

export const primaryBtnCls =
  "rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-transform hover:brightness-110 active:scale-[0.99] disabled:opacity-50";

export const ghostBtnCls =
  "rounded-lg border border-hairline px-3.5 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2";
