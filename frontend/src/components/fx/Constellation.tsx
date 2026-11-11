import { useEffect, useRef } from "react";

/*
 * A drifting yellow constellation: dots wander slowly and join with fading lines when they're close. Kept cheap on purpose —
 * a capped dot count scaled to the area, one canvas, DPR capped at 2, time-based motion so it stays smooth at any frame rate,
 * and the loop stops while the tab is hidden. Under reduced motion it draws one still frame.
 */
type Dot = { x: number; y: number; vx: number; vy: number; r: number };

/** True while a dialog is open or the user is typing in a field: the animation yields the CPU/GPU to the task at hand. */
function busy() {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || (a as HTMLElement).isContentEditable);
}

/** `animated={false}` paints one still frame (every page except the dashboard). */
export function Constellation({ className = "fixed inset-0", intensity = 1, animated = true }: { className?: string; intensity?: number; animated?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim() || "#f5c000";
    const still = !animated || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    let paused = false;
    let lastCheck = 0;

    let w = 0;
    let h = 0;
    let dots: Dot[] = [];
    let link = 140;
    let raf = 0;
    let last = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      link = w < 640 ? 100 : 140;
      const count = Math.min(70, Math.max(24, Math.round((w * h) / 20000)));
      dots = Array.from({ length: count }, () => {
        const a = Math.random() * Math.PI * 2;
        const s = 8 + Math.random() * 14; // px per second
        return { x: Math.random() * w, y: Math.random() * h, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 1 + Math.random() * 1.2 };
      });
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = accent;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      const max2 = link * link;
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i];
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < max2) {
            ctx.globalAlpha = (1 - d2 / max2) * 0.12 * intensity;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = Math.min(1, 0.3 * intensity);
      for (const d of dots) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      if (now - lastCheck > 400) {
        lastCheck = now;
        paused = busy();
      }
      if (paused) {
        last = now; // no time jump when it resumes
        raf = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      for (const d of dots) {
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        if (d.x < -10) d.x = w + 10;
        else if (d.x > w + 10) d.x = -10;
        if (d.y < -10) d.y = h + 10;
        else if (d.y > h + 10) d.y = -10;
      }
      draw();
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (still || raf) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onResize = () => {
      resize();
      if (still) draw();
    };

    resize();
    draw();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
    };
  }, [intensity, animated]);

  return <canvas ref={ref} className={`pointer-events-none block h-full w-full ${className}`} aria-hidden="true" />;
}
