import { KeyboardEvent, ReactNode, useRef } from "react";

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
    <div role="tablist" aria-label={label} className={`mb-4 flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-fit animate-fade-up ${className}`}>
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
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-all sm:flex-none ${selected ? "bg-brand-500 text-black" : "text-neutral-400 hover:text-white"}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function tabPanelProps(idPrefix: string, key: string) {
  return { role: "tabpanel", id: `${idPrefix}-panel-${key}`, "aria-labelledby": `${idPrefix}-tab-${key}` } as const;
}
