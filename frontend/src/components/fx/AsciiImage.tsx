import { useEffect, useRef } from "react";

/*
 * Draws an image as coloured ASCII on a canvas, the way ascii-magic.com stylises a photo: a brightness ramp, per-cell colour
 * taken from the picture, a decode-in, and characters that scramble near the pointer.
 *
 * Once, on load: the glyphs decode in, a scan line sweeps down the frame, and everything it has passed becomes the real
 * image. The loop then stops on the finished picture. Under reduced motion the real image is drawn straight away.
 */
const RAMP = " .,:;i1tfLCG08@";
const SCRAMBLE = "01<>/\\|+*#%&";

export const DECODE_S = 0.9; // glyphs resolve top to bottom
export const HOLD_S = 0.25; // a beat of finished ASCII
export const SCAN_S = 1.7; // the sweep
export const BAND = 0.16; // fraction of the height where glyphs dissolve into the picture, trailing the scan line

/** Shared start time, so the logo and the glyph layer over the form run one timeline. */
export type ScanClock = { born: number };

type Cell = { ch: string; r: number; g: number; b: number; a: number; lum: number };

export const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export function AsciiImage({ src, cols = 72, className, label, onReveal, clock }: { src: string; cols?: number; className?: string; label: string; onReveal?: () => void; clock?: ScanClock }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const css = getComputedStyle(document.documentElement);
    const fontFamily = css.getPropertyValue("--font-mono").trim() || "monospace";
    const accent = css.getPropertyValue("--color-accent").trim() || "#f5c000";
    let cells: Cell[][] = [];
    let raf = 0;
    let alive = true;
    let finished = false;
    let pointer: { x: number; y: number } | null = null;
    const own: ScanClock = { born: 0 };
    const shared = clock ?? own;
    const img = new Image();

    const sample = () => {
      const aspect = img.naturalHeight / img.naturalWidth;
      const rows = Math.max(1, Math.round(cols * aspect * 0.5)); // characters are about twice as tall as wide
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return;
      octx.drawImage(img, 0, 0, cols, rows);
      const data = octx.getImageData(0, 0, cols, rows).data;
      cells = [];
      for (let y = 0; y < rows; y++) {
        const row: Cell[] = [];
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3] / 255;
          const lum = ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * a;
          row.push({ ch: RAMP[Math.min(RAMP.length - 1, Math.floor(lum * RAMP.length))], r, g, b, a, lum });
        }
        cells.push(row);
      }
    };

    const size = (ctx: CanvasRenderingContext2D) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const rows = cells.length;
      const cw = w / cols;
      const ch = cw * 2;
      const h = ch * rows;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h, cw, ch, rows };
    };

    const drawFinal = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx || !cells.length) return;
      const { w, h } = size(ctx);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
    };

    const draw = (now: number) => {
      if (!alive || !cells.length) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { w, h, cw, ch, rows } = size(ctx);
      if (!shared.born) shared.born = now;
      const t = (now - shared.born) / 1000;
      const scanT = (t - DECODE_S - HOLD_S) / SCAN_S;
      if (reduce || scanT >= 1) {
        finished = true;
        drawFinal();
        onRevealRef.current?.();
        return; // one load, one pass: stop on the real image
      }

      ctx.clearRect(0, 0, w, h);
      const p = Math.max(0, scanT);
      const scanY = easeInOut(p) * (h * (1 + BAND));
      const band = h * BAND;

      // The real image, revealed above the scan line.
      if (scanY > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, Math.min(h, scanY));
        ctx.clip();
        ctx.drawImage(img, 0, 0, w, h);
        ctx.restore();
      }

      // The glyphs: whole below the line, dissolving across the band, gone above it.
      ctx.font = `700 ${ch * 0.95}px ${fontFamily}`;
      ctx.textBaseline = "top";
      const decode = Math.min(1, t / DECODE_S);
      for (let y = 0; y < rows; y++) {
        const cy = (y + 0.5) * ch;
        const above = scanY - cy; // > 0 once the line has passed this row
        if (above > band) continue;
        const fade = above > 0 ? 1 - above / band : 1;
        for (let x = 0; x < cols; x++) {
          const c = cells[y][x];
          if (c.a < 0.08 || c.lum < 0.04) continue;
          const settled = decode >= 1 || y / rows < decode * 1.15 - Math.random() * 0.15;
          let glyph = settled ? c.ch : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
          let boost = 0;
          if (pointer && scanT < 0) {
            const d = Math.hypot((x + 0.5) * cw - pointer.x, cy - pointer.y);
            if (d < 70) {
              boost = 1 - d / 70;
              if (Math.random() < boost * 0.7) glyph = SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
            }
          }
          // Inside the band the glyphs flicker as they hand over to the picture.
          if (above > 0 && Math.random() < 0.35) glyph = SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
          const shimmer = Math.sin(t * 1.6 + x * 0.35 + y * 0.5) * 0.06;
          const alpha = Math.max(0.25, Math.min(1, 0.45 + c.lum * 0.7 + shimmer + boost * 0.4)) * fade;
          ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
          ctx.fillText(glyph, x * cw, y * ch);
        }
      }

      // The scan line: a hot edge with a soft trail behind it.
      if (scanT > 0 && scanY < h + band) {
        const y = Math.min(scanY, h);
        const trail = ctx.createLinearGradient(0, y - band * 0.9, 0, y);
        trail.addColorStop(0, "transparent");
        trail.addColorStop(1, accent);
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = trail;
        ctx.fillRect(0, y - band * 0.9, w, band * 0.9);
        ctx.globalAlpha = 1;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 22;
        ctx.fillStyle = accent;
        ctx.fillRect(0, y - 1, w, 2);
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => (pointer = null);
    const onResize = () => {
      if (finished) drawFinal();
    };

    img.onload = () => {
      sample();
      raf = requestAnimationFrame(draw);
    };
    img.src = src;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [src, cols]);

  return <canvas ref={canvasRef} className={className} role="img" aria-label={label} style={{ width: "100%", display: "block" }} />;
}
