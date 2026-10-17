import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ai";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control whitespace-nowrap transition-[background-color,color,filter,transform] duration-100 disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent font-semibold text-on-accent hover:brightness-110 active:scale-[0.98]",
  secondary: "border border-hairline text-ink-muted hover:bg-bg2 hover:text-ink",
  ghost: "text-ink-muted hover:bg-bg2 hover:text-ink",
  danger: "border border-hairline text-danger hover:bg-bg2",
  ai: "co-ai-border font-medium text-ink hover:brightness-[1.03] active:scale-[0.98]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-sm",
  md: "h-8 px-3.5 text-sm",
};

/** Class string for surfaces that must stay a non-<button> element (links,
 *  labels) but should look like a Button. */
export function buttonCls(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = "") {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows the shared spinner and the busy sheen; also disables the button. */
  busy?: boolean;
  /** Leading icon. AI buttons default to the sparkle. */
  icon?: IconName;
  children?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", busy = false, icon, className = "", disabled, children, type = "button", ...rest },
  ref,
) {
  const lead = icon ?? (variant === "ai" ? "sparkle" : undefined);
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${buttonCls(variant, size)} ${busy ? "co-btn-busy" : ""} ${className}`}
      {...rest}
    >
      {busy ? (
        <Spinner />
      ) : lead ? (
        <Icon name={lead} size={13} className={variant === "ai" ? "co-ai-icon" : undefined} />
      ) : null}
      {children}
    </button>
  );
});

/** Square icon-only button (toolbars, row quick actions, close buttons). */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: IconName;
    /** Accessible name; also used as the tooltip. */
    label: string;
    size?: "xs" | "sm" | "md";
    active?: boolean;
    filled?: boolean;
  }
>(function IconButton({ icon, label, size = "sm", active = false, filled = false, className = "", type = "button", ...rest }, ref) {
  const box = size === "xs" ? "size-5" : size === "sm" ? "size-7" : "size-8";
  const glyph = size === "xs" ? 13 : 15;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={`inline-flex ${box} shrink-0 items-center justify-center rounded-control transition-colors duration-100 hover:bg-bg2 hover:text-ink disabled:pointer-events-none disabled:opacity-50 ${
        active ? "text-ink" : "text-ink-muted"
      } ${className}`}
      {...rest}
    >
      <Icon name={icon} size={glyph} filled={filled} />
    </button>
  );
});
