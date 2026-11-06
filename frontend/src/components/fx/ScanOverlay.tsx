import { useEffect, useRef } from "react";
import { BAND, DECODE_S, HOLD_S, SCAN_S, ScanClock, easeInOut } from "./AsciiImage";

/*
 * The glyph layer that hides a block of UI while the page loads: it covers its container in ASCII, then the same scan line
 * that crosses the logo sweeps down and everything it passes is the real interface. It shares a clock with <AsciiImage>
 * so both halves of the card are scanned by one line. Pointer events pass through; it removes itself when done and is not
 * drawn at all under reduced motion.
 */
const GLYPHS = "01<>/\\|+*#%&;:.,=-itfLC08@";
const CELL_W = 9;
const CELL_H = 17;

export function ScanOverlay({ clock, onDone, tone = "--color-paper-2", className = "absolute inset-0" }: { clock: ScanClock; onDone?: () => void; tone?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      canvas.style.display = "none";
      onDoneRef.current?.();
      return;
    }
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--color-accent").trim() || "#f5c000";
    const paper = css.getPropertyValue(tone).trim() || "#111";
    const mono = css.getPropertyValue("--font-mono").trim() || "monospace";
    let raf = 0;
    let alive = true;
    let grid: string[] = [];
    let lastShuffle = 0;

    const draw = (now: number) => {
      if (!alive) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!clock.born) clock.born = now;
      const t = (now - clock.born) / 1000;
      const scanT = (t - DECODE_S - HOLD_S) / SCAN_S;
      if (scanT >= 1) {
        canvas.style.display = "none";
        onDoneRef.current?.();
        return;
      }

      const cols = Math.ceil(w / CELL_W);
      const rows = Math.ceil(h / CELL_H);
      if (now - lastShuffle > 70 || grid.length !== cols * rows) {
        lastShuffle = now;
        grid = Array.from({ length: cols * rows }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]);
      }

      ctx.clearRect(0, 0, w, h);
      const band = h * BAND;
      const scanY = easeInOut(Math.max(0, scanT)) * (h * (1 + BAND));

      // Opaque below the line, fading out across the band above it.
      const solidFrom = Math.min(h, Math.max(0, scanY));
      ctx.fillStyle = paper;
      ctx.fillRect(0, solidFrom, w, h - solidFrom);
      if (scanY > 0) {
        const g = ctx.createLinearGradient(0, scanY - band, 0, scanY);
        g.addColorStop(0, "transparent");
        g.addColorStop(1, paper);
        ctx.fillStyle = g;
        ctx.fillRect(0, Math.max(0, scanY - band), w, Math.min(band, scanY));
      }

      // Glyphs: dim and sparse, brightest near the line, gone once it has passed.
      ctx.font = `700 ${CELL_H * 0.82}px ${mono}`;
      ctx.textBaseline = "top";
      ctx.fillStyle = accent;
      for (let r = 0; r < rows; r++) {
        const cy = (r + 0.5) * CELL_H;
        const above = scanY - cy;
        if (above > band) continue;
        const fade = above > 0 ? 1 - above / band : 1;
        const near = scanT > 0 ? Math.max(0, 1 - Math.abs(cy - scanY) / (h * 0.25)) : 0;
        for (let c = 0; c < cols; c++) {
          const k = r * cols + c;
          // Roughly one cell in three carries a glyph, so the form reads as ASCII rain, not a wall.
          if ((k * 2654435761) % 3 !== 0) continue;
          ctx.globalAlpha = Math.min(1, (0.2 + near * 0.6 + Math.sin(t * 3 + c * 0.7 + r) * 0.08) * fade);
          ctx.fillText(grid[k], c * CELL_W, r * CELL_H);
        }
      }
      ctx.globalAlpha = 1;

      // The same scan line as the logo's, continuing across the form.
      if (scanT > 0 && scanY < h + band) {
        const y = Math.min(scanY, h);
        ctx.save();
        ctx.shadowColor = accent;
        ctx.shadowBlur = 22;
        ctx.fillStyle = accent;
        ctx.fillRect(0, y - 1, w, 2);
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [clock, tone]);

  return <canvas ref={ref} aria-hidden="true" className={`pointer-events-none z-[4] h-full w-full ${className}`} />;
}
