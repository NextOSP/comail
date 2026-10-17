import type { ReactNode, SelectHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={`mb-2 text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase ${className}`}>
      {children}
    </h3>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-control border border-hairline bg-bg0 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm transition-colors duration-100 ${
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
        className={`absolute top-[2px] left-0 size-[14px] rounded-full bg-bg0 shadow-elev-1 transition-transform duration-150 ${
          checked ? "translate-x-[16px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

/** Themed checkbox + label (replaces raw `<input type="checkbox">`). */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 ${disabled ? "pointer-events-none opacity-50" : ""}`}>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={`mt-[1px] flex size-4 shrink-0 items-center justify-center rounded border transition-colors duration-100 ${
          checked ? "border-accent bg-accent text-on-accent" : "border-hairline-strong bg-bg0"
        }`}
      >
        {checked && <Icon name="check" size={11} />}
      </span>
      <span className="min-w-0">
        <span className="block text-base text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-control border border-hairline bg-bg0 px-3 py-2 text-base text-ink outline-none placeholder:text-ink-faint focus:border-accent/60";

// A native <select> and an <input> with identical CSS still render at slightly
// different heights (the browser gives selects their own box metrics). Stripping
// the native appearance makes the box follow our padding/line-height exactly,
// matching inputCls to the pixel, so we draw our own chevron instead.
export const selectCls =
  "w-full cursor-pointer appearance-none rounded-control border border-hairline bg-bg0 py-2 pr-9 pl-3 text-base text-ink outline-none focus:border-accent/60";

/** Native <select> restyled to line up with inputCls fields, with a custom
 *  chevron. Width/extra classes go on `className` (applied to the select). */
export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex">
      <select className={`${selectCls} ${className}`} {...props}>
        {children}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint">
        <Icon name="chevronDown" size={12} />
      </span>
    </span>
  );
}

/** Empty list placeholder: dashed card with icon, title, hint, optional action. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-hairline-strong px-6 py-8 text-center">
      {icon && (
        <span className="mb-1 text-ink-faint">
          <Icon name={icon} size={18} />
        </span>
      )}
      <div className="text-base font-medium text-ink">{title}</div>
      {hint && <div className="max-w-[360px] text-xs text-ink-faint">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
