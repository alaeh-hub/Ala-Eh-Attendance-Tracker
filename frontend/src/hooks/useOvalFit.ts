import { CSSProperties, RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The face window's width as a fraction of its height (CameraView draws it with aspect-ratio 0.78). */
export const OVAL_ASPECT = 0.78;

/** A screen at most this tall is laid out in the compact landscape arrangement. */
export const SHORT_SCREEN = 520;

/** The oval keeps at least this much room on each side, so it never touches the edge of a narrow phone. */
const SIDE_MARGIN = 16;

export interface Size {
  width: number;
  height: number;
}

export interface OvalLayout {
  /** The full screen box the camera fills. */
  container: Size;
  /** Bottom edge of the top bar, in px from the top of the container (0 when there is none). */
  barBottom: number;
  /** Height of the control dock from the bottom edge of the container (0 when it is hidden or absent). */
  dockHeight: number;
  /** px from the top of the container that must stay clear for the prompt / instruction banner. */
  topReserve: number;
  /** The oval is never shorter than this share of the container's height: the size it had before it was measured. */
  floorShare: number;
  /** Breathing room kept between the oval and the bar and the dock, in px. */
  gap?: number;
  /** Never taller than this share of the container's height. */
  maxShare?: number;
  /**
   * Never taller than this many times its floor. The server wants the face to fill a set share of
   * the oval, so a much bigger oval would mean standing much closer; "a little bit bigger" it is.
   */
  maxGrowth?: number;
  /** Never shorter than this many px, however cramped the screen is. */
  minHeight?: number;
}

/**
 * Where the oval goes and how big it is. It takes the space between the top bar (and the banner
 * under it) and the control dock, limited by the screen's width, and is centred in that space.
 * It never gets smaller than `floorShare` of the screen, so a layout whose controls leave little
 * room (landscape) keeps the size it had instead of shrinking.
 */
export function computeOval(layout: OvalLayout): { top: number; height: number } {
  const { container, barBottom, dockHeight, topReserve, floorShare, gap = 8, maxShare = 0.72, maxGrowth = 1.3, minHeight = 140 } = layout;
  const topEdge = Math.max(barBottom, topReserve) + gap;
  const bottomEdge = container.height - dockHeight - gap;
  const available = bottomEdge - topEdge;

  const widest = (container.width - 2 * SIDE_MARGIN) / OVAL_ASPECT;
  const fitted = Math.min(available, widest);
  const floor = Math.min(floorShare * container.height, widest);
  const ceiling = Math.max(floor, Math.min(floor * maxGrowth, container.height * maxShare));
  const height = Math.round(Math.min(Math.max(Math.min(fitted, ceiling), floor, minHeight), widest));

  // Centred in the free space, but always fully on screen.
  const top = Math.round(Math.min(container.height - height / 2, Math.max(height / 2, topEdge + available / 2)));
  return { top, height };
}

export interface OvalFitOptions {
  container: RefObject<HTMLElement>;
  /** The top bar; the oval starts below it. */
  top: RefObject<HTMLElement>;
  /** The control dock; the oval ends above it. It may be hidden for a moment (while a result shows). */
  bottom: RefObject<HTMLElement>;
  /** See OvalLayout.topReserve and floorShare; they depend on the screen, so they are given the container's size. */
  topReserve: (container: Size) => number;
  floorShare: (container: Size) => number;
}

/**
 * Measures the real layout and sizes the oval with computeOval, so it adapts to any phone, tablet,
 * rotation or window size instead of relying on percentages tuned for one device. Returns undefined
 * until it can be measured (the caller keeps its fallback classes meanwhile).
 */
export function useOvalFit({ container, top, bottom, topReserve, floorShare }: OvalFitOptions): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>();
  // The dock's height is remembered, so the oval doesn't jump while the dock is hidden for a result.
  const lastDockHeight = useRef(0);
  // The callers pass inline functions; keep the latest without re-measuring on every render.
  const reserve = useRef({ topReserve, floorShare });
  reserve.current = { topReserve, floorShare };

  const measure = useCallback(() => {
    const box = container.current?.getBoundingClientRect();
    if (!box || box.width < 50 || box.height < 50) return setStyle(undefined);

    const size = { width: box.width, height: box.height };
    const dock = bottom.current?.getBoundingClientRect();
    if (dock && dock.height > 0) lastDockHeight.current = box.bottom - dock.top;
    const { top: centre, height } = computeOval({
      container: size,
      barBottom: top.current ? top.current.getBoundingClientRect().bottom - box.top : 0,
      dockHeight: lastDockHeight.current,
      topReserve: reserve.current.topReserve(size),
      floorShare: reserve.current.floorShare(size),
    });
    setStyle((prev) => (prev && prev.top === `${centre}px` && prev.height === `${height}px` ? prev : { top: `${centre}px`, height: `${height}px` }));
  }, [container, top, bottom]);

  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const elements = [container.current, top.current, bottom.current].filter((el): el is HTMLElement => !!el);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    elements.forEach((el) => ro?.observe(el));
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [container, top, bottom, measure]);

  return style;
}
