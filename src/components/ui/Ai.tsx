import type { ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * AI identity primitives. Every AI entry point or output uses these so the
 * gradient, sparkle and wording read as one system (Superhuman-style).
 */

/** Sparkle glyph in the AI color. */
export function AiSparkle({ size = 13, className = "" }: { size?: number; className?: string }) {
  return <Icon name="sparkle" size={size} className={`co-ai-icon ${className}`} />;
}

/** Inline "✦ AI" marker (or a custom label) in gradient text. */
export function AiBadge({ label = "AI", className = "" }: { label?: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${className}`}>
      <AiSparkle size={12} />
      <span className="co-ai-text">{label}</span>
    </span>
  );
}

/** Gradient-ringed container for AI-owned input/output (⌘J bar, summary,
 *  Ask answer, AI quick-add). */
export function AiSurface({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "form";
}) {
  return <Tag className={`co-ai-border rounded-card ${className}`}>{children}</Tag>;
}
