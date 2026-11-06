import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useProcessStore } from "../stores/processStore";

const SHOW_AFTER_MS = 250; // quick requests never flash a dialog
const MIN_VISIBLE_MS = 500; // once shown it stays long enough to read
const FRAMES = ["|", "/", "-", "\\"];

/** A blocking "working on it" dialog for any save, delete or export that has not finished yet. */
export default function ProcessDialog() {
  const items = useProcessStore((s) => s.items);
  const busy = items.length > 0;
  const label = items[items.length - 1]?.label ?? "";
  const [visible, setVisible] = useState(false);
  const [shownAt, setShownAt] = useState(0);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (busy && !visible) {
      const t = setTimeout(() => {
        setVisible(true);
        setShownAt(Date.now());
      }, SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    if (!busy && visible) {
      const t = setTimeout(() => setVisible(false), Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt)));
      return () => clearTimeout(t);
    }
  }, [busy, visible, shownAt]);

  useEffect(() => {
    if (!visible) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 110);
    return () => clearInterval(t);
  }, [visible]);

  if (!visible) return null;
  return createPortal(
    <div className="process-backdrop" role="status" aria-live="polite" aria-busy="true">
      <div className="surface process-panel">
        <span className="process-glyph" aria-hidden="true">
          {FRAMES[frame]}
        </span>
        <div className="min-w-0">
          <p className="font-display text-lg font-bold text-white">{label || "Working on it"}</p>
          <p className="mt-0.5 text-sm text-neutral-400" style={{ fontFamily: "var(--font-mono)" }}>
            Please wait, this will close on its own.
          </p>
        </div>
        <span className="process-bar" aria-hidden="true" />
      </div>
    </div>,
    document.body
  );
}
