import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../Icon";
import { IconButton } from "../ui";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  /** Accessible name when the visible label alone is ambiguous across rows (e.g. "Delete Maria Santos"). */
  ariaLabel?: string;
}

/**
 * A "more actions" button that opens a small menu. The menu is portalled and positioned from the button's rectangle,
 * so a table's overflow clipping never cuts it off. Escape, an outside press, scrolling or choosing an item closes it.
 */
export default function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const below = r.bottom + 8;
    const flip = below + items.length * 44 + 16 > window.innerHeight;
    setPos({ top: flip ? Math.max(8, r.top - 8 - items.length * 44) : below, right: Math.max(8, window.innerWidth - r.right) });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const close = () => setOpen(false);
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <IconButton ref={btn} label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" className="h-4 w-4" />
      </IconButton>
      {open &&
        pos &&
        createPortal(
          <div ref={menu} role="menu" aria-label={label} className="pop fixed z-[var(--z-dropdown)] w-48 p-1" style={{ top: pos.top, right: pos.right }}>
            {items.map((it) => (
              <button
                key={it.label}
                role="menuitem"
                type="button"
                disabled={it.disabled}
                aria-label={it.ariaLabel}
                className={`menu-item ${it.danger ? "text-red-300 hover:!text-red-200" : ""} disabled:opacity-50`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
