import { motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { IS_MAC, MOD_LABEL } from "../../lib/format";

/** Shared building blocks for the onboarding steps. */

export const SPRING = { type: "spring", stiffness: 380, damping: 34, mass: 0.9 } as const;

const STAGGER: Variants = {
  enter: {},
  center: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
  exit: { transition: { staggerChildren: 0.025, staggerDirection: -1 } },
};
const ITEM: Variants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0, transition: SPRING },
  exit: { opacity: 0, y: -6, transition: { duration: 0.14 } },
};

/** A step's content column: children marked <Item> cascade in, then out. */
export function Stagger({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={STAGGER} className={className}>
      {children}
    </motion.div>
  );
}

export function Item({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={ITEM} className={className}>
      {children}
    </motion.div>
  );
}

export function StepHeader({ title, body }: { title: string; body?: string }) {
  return (
    <>
      <Item>
        <h1 className="co-onb-title">{title}</h1>
      </Item>
      {body && (
        <Item>
          <p className="co-onb-body">{body}</p>
        </Item>
      )}
    </>
  );
}

/** The flow's primary action, with the Enter key it answers to. */
export function PrimaryCta({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      className="co-onb-cta"
      onClick={onClick}
      disabled={disabled}
      whileTap={{ scale: 0.97 }}
    >
      {children}
      <kbd className="co-onb-cta-kbd">↵</kbd>
    </motion.button>
  );
}

/** A physical-looking key that depresses while `pressed`. */
export function Keycap({ label, pressed, pulse }: { label: string; pressed?: boolean; pulse?: boolean }) {
  return (
    <span className={`co-keycap ${pressed ? "is-pressed" : ""} ${pulse ? "is-pulse" : ""}`}>{label}</span>
  );
}

/** "mod+k" -> ["⌘", "K"] (macOS) or ["Ctrl", "K"]. */
export function keyParts(token: string): string[] {
  return token.split("+").map((p) => (p === "mod" ? MOD_LABEL : p === "shift" ? (IS_MAC ? "⇧" : "Shift") : p.toUpperCase()));
}
