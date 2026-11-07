import { KeyboardEvent, ReactNode, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * Accessible segmented tabs (role="tablist"/"tab", aria-selected, arrow-key
 * navigation). Panels should use `tabPanelProps(idPrefix, key)`.
 */
export default function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className = "",
}: {
  tabs: readonly { key: K; label: ReactNode }[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  idPrefix: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduce = useReducedMotion();

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className={`mb-4 flex gap-6 border-b border-ink-700 sm:w-fit animate-fade-up ${className}`}>
      {tabs.map((t, i) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`relative -mb-px flex-1 border-b-2 border-transparent px-1 py-2.5 text-sm font-semibold transition-colors sm:flex-none ${selected ? "text-brand-400" : "text-neutral-400 hover:text-white"}`}
          >
            {t.label}
            {selected && (
              <motion.span
                layoutId={`${idPrefix}-tab-underline`}
                className="absolute inset-x-0 -bottom-0.5 h-0.5 bg-brand-500"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function tabPanelProps(idPrefix: string, key: string) {
  return { role: "tabpanel", id: `${idPrefix}-panel-${key}`, "aria-labelledby": `${idPrefix}-tab-${key}` } as const;
}
