import { RefObject, useEffect } from "react";
import { animate, stagger } from "animejs";
import { motionOK } from "../lib/motion";

/*
 * Page choreography with anime.js. Anything that appears inside the page container (a table's rows once their data
 * arrives, stat figures, feed items, bars) rises into place in a quick stagger; bars grow from their left edge. Rows that React merely re-renders are not animated again, only newly inserted ones.
 *
 * It watches the DOM instead of asking each page to opt in, so a new table or list gets the same treatment for free.
 * Opt out per element with data-no-motion.
 */
const ITEMS = "tbody > tr, .stat, .reveal-item";
const BARS = "[data-grow]";

export function usePageChoreography(ref: RefObject<HTMLElement>, key: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !motionOK()) return;
    const seen = new WeakSet<Element>();

    const fresh = (nodes: Iterable<Node>, selector: string) => {
      const out: HTMLElement[] = [];
      for (const n of nodes) {
        if (n.nodeType !== 1) continue;
        const el = n as HTMLElement;
        const hits = el.matches(selector) ? [el] : [];
        hits.push(...Array.from(el.querySelectorAll<HTMLElement>(selector)));
        for (const h of hits) if (!seen.has(h) && !h.closest("[data-no-motion]")) (seen.add(h), out.push(h));
      }
      return out;
    };

    const rise = (all: HTMLElement[]) => {
      // A table can have thousands of rows. Only the first screenful is animated; the rest simply appear.
      const els = all.slice(0, 40);
      if (!els.length) return;
      // A long list should still finish in about a second.
      const per = Math.min(38, 700 / els.length);
      els.forEach((e) => (e.style.opacity = "0"));
      animate(els, {
        opacity: [0, 1],
        translateY: [14, 0],
        duration: 560,
        ease: "outExpo",
        delay: stagger(per),
        onComplete: () => els.forEach((e) => ((e.style.opacity = ""), (e.style.transform = ""))),
      });
    };
    const grow = (els: HTMLElement[]) => {
      if (!els.length) return;
      els.forEach((e) => ((e.style.transformOrigin = "left center"), (e.style.transform = "scaleX(0)")));
      animate(els, {
        scaleX: [0, 1],
        duration: 900,
        ease: "outExpo",
        delay: stagger(70, { start: 150 }),
        onComplete: () => els.forEach((e) => (e.style.transform = "")),
      });
    };
    const scan = (nodes: Iterable<Node>) => {
      rise(fresh(nodes, ITEMS));
      grow(fresh(nodes, BARS));
    };

    scan([root]);

    const mo = new MutationObserver((records) => {
      for (const r of records) if (r.addedNodes.length) scan(Array.from(r.addedNodes));
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [ref, key]);
}
