import { CSSProperties, useMemo } from "react";
import { cn } from "../../lib/utils";

/*
 * Letters that flip in one after another. Adapted from Vengeance UI "flip-text" (MIT, https://www.vengenceui.com).
 * The keyframes are in index.css (.flip-char); a single pass by default.
 */
export function FlipText({ children, className, delay = 0, duration = 0.9, loop = false }: { children: string; className?: string; delay?: number; duration?: number; loop?: boolean }) {
  const words = useMemo(() => children.split(" "), [children]);
  let n = 0;
  const total = children.length;
  return (
    <span className={cn("flip-text inline-block", className)} aria-label={children}>
      {words.map((w, wi) => (
        <span key={wi} className="inline-block whitespace-nowrap" aria-hidden="true">
          {w.split("").map((c) => {
            const i = n++;
            const style = { "--flip-delay": `${delay + (i / total) * duration * 0.6}s`, "--flip-dur": `${duration}s`, "--flip-n": loop ? "infinite" : "1" } as CSSProperties;
            return (
              <span key={i} className="flip-char" style={style}>
                {c}
              </span>
            );
          })}
          {wi < words.length - 1 && " "}
        </span>
      ))}
    </span>
  );
}
