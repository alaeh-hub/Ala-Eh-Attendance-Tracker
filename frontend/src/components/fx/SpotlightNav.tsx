import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { animate } from "motion";
import { useReducedMotion } from "motion/react";
import Icon, { IconName } from "../Icon";
import { cn } from "../../lib/utils";

export interface SpotlightItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  badge?: number;
}

/*
 * A nav bar whose light follows the pointer and settles under the active item.
 * Adapted from Vengeance UI "spotlight-navbar" (MIT, https://www.vengenceui.com), re-wired to NavLink and the app tokens.
 */
export function SpotlightNav({ items, className }: { items: SpotlightItem[]; className?: string }) {
  const navRef = useRef<HTMLElement>(null);
  const x = useRef(0);
  const placed = useRef(false);
  const reduce = useReducedMotion();
  const { pathname } = useLocation();

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const paint = (v: number) => {
      x.current = v;
      nav.style.setProperty("--spot-x", `${v}px`);
    };
    const activeCentre = () => {
      const el = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!el) return null;
      const n = nav.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.left - n.left + r.width / 2;
    };
    const settle = () => {
      const target = activeCentre();
      nav.dataset.hover = "0";
      if (target === null) return;
      // First placement snaps (no slide in from the left edge); later route changes glide.
      if (reduce || !placed.current) {
        placed.current = true;
        return paint(target);
      }
      animate(x.current, target, { type: "spring", stiffness: 220, damping: 22, onUpdate: paint });
    };
    const move = (e: PointerEvent) => {
      nav.dataset.hover = "1";
      paint(e.clientX - nav.getBoundingClientRect().left);
    };
    settle();
    nav.addEventListener("pointermove", move);
    nav.addEventListener("pointerleave", settle);
    window.addEventListener("resize", settle);
    return () => {
      nav.removeEventListener("pointermove", move);
      nav.removeEventListener("pointerleave", settle);
      window.removeEventListener("resize", settle);
    };
  }, [pathname, items.length, reduce]);

  return (
    <nav ref={navRef} className={cn("spot-nav", className)} aria-label="Main">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} title={item.label} className="spot-nav-item">
          <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
          <span className="hidden xl:inline">{item.label}</span>
          {!!item.badge && item.badge > 0 && (
            <span className="absolute -right-1 top-3.5 min-w-[1.1rem] rounded-full bg-red-500 px-1 text-center text-[10px] font-bold leading-[1.1rem] tabular-nums text-white">{item.badge > 99 ? "99+" : item.badge}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
