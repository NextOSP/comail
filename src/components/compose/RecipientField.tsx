import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import type { Address } from "../../ipc/types";
import { addressName, isValidEmail } from "../../lib/format";

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  accountId,
}: {
  label: string;
  value: Address[];
  onChange: (v: Address[]) => void;
  autoFocus?: boolean;
  /** Scope contact suggestions to this account; undefined shows all accounts. */
  accountId?: number;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<Address[]>([]);
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced contact autocomplete.
  useEffect(() => {
    const q = input.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void call("list_contacts", { prefix: q, accountId, limit: 6 }).then((hits) => {
        if (!cancelled) {
          setSuggestions(hits.filter((h) => !value.some((v) => v.email === h.email)));
          setCursor(0);
        }
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [input, value, accountId]);

  const commit = (a: Address) => {
    if (!value.some((v) => v.email.toLowerCase() === a.email.toLowerCase())) {
      onChange([...value, a]);
    }
    setInput("");
    setSuggestions([]);
  };

  const commitRaw = () => {
    const raw = input.trim().replace(/,$/, "");
    if (!raw) return true;
    if (suggestions[cursor]) {
      commit(suggestions[cursor]);
      return true;
    }
    if (isValidEmail(raw)) {
      commit({ name: null, email: raw });
      return true;
    }
    return false;
  };

  return (
    <div className="co-hairline-b relative flex min-h-9 flex-wrap items-center gap-1.5 py-1.5">
      <span className="w-8 shrink-0 text-[12px] text-ink-faint">{label}</span>
      {value.map((a) => (
        <span key={a.email} className="co-chip !py-0.5">
          {addressName(a)}
          <button
            className="text-ink-faint hover:text-danger"
            onClick={() => onChange(value.filter((v) => v.email !== a.email))}
            tabIndex={-1}
            aria-label={t("compose:removeNamed", { name: a.email })}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        autoFocus={autoFocus}
        onChange={(e) => setInput(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commitRaw();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && suggestions.length > 0) {
            e.preventDefault();
            setCursor((c) => Math.min(suggestions.length - 1, c + 1));
          } else if (e.key === "ArrowUp" && suggestions.length > 0) {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && input.trim())) {
            if (input.trim()) {
              e.preventDefault();
              commitRaw();
            }
          } else if (e.key === "Backspace" && input === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        className="min-w-32 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
        placeholder={value.length === 0 ? t("compose:recipientPlaceholder") : ""}
        spellCheck={false}
      />
      {focused && suggestions.length > 0 && (
        <div
          className="absolute top-full left-8 z-10 mt-1 min-w-72 rounded-lg border border-hairline bg-bg1 p-1"
          style={{ boxShadow: "var(--elev-2)" }}
        >
          {suggestions.map((s, i) => (
            <button
              key={s.email}
              className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left ${
                i === cursor ? "bg-[var(--selected-bg)]" : "hover:bg-bg2"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s);
                inputRef.current?.focus();
              }}
              onMouseMove={() => setCursor(i)}
            >
              <span className="text-[13px] text-ink">{addressName(s)}</span>
              <span className="truncate text-[11.5px] text-ink-faint">{s.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
