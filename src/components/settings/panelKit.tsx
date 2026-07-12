// Shared building blocks for the management panels (Settings / Snippets / Splits).
// Visual language matches the palette + help overlays: hairline borders,
// bg1 surface, elev-2 shadow, accent only for focus/selection.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function PanelShell({
  title,
  onClose,
  children,
  width = 560,
  tabs,
  search,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  /** Optional tab bar rendered below the header; stays fixed while the body scrolls. */
  tabs?: React.ReactNode;
  /** Optional search field rendered in the header row, right-aligned. */
  search?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="co-overlay flex items-start justify-center pt-[10vh]" onMouseDown={onClose}>
      <div
        className="co-pop-in flex max-h-[78vh] flex-col overflow-hidden rounded-xl border border-hairline bg-bg1"
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
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
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

export const primaryBtnCls =
  "rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-transform hover:brightness-110 active:scale-[0.99] disabled:opacity-50";

export const ghostBtnCls =
  "rounded-lg border border-hairline px-3.5 py-1.5 text-[12.5px] text-ink-muted hover:bg-bg2";
