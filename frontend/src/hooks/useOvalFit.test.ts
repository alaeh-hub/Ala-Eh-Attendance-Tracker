import { describe, expect, it } from "vitest";
import { OVAL_ASPECT, computeOval } from "./useOvalFit";

const base = { gap: 8 };

describe("computeOval", () => {
  it("fills the room between the top bar and the controls, centred in it (portrait phone)", () => {
    const { top, height } = computeOval({ ...base, container: { width: 390, height: 844 }, barBottom: 80, dockHeight: 252, topReserve: 140, floorShare: 0.42 });
    // free space: 148 .. 584  ->  436 px tall, centred at 366
    expect(height).toBe(436);
    expect(top).toBe(366);
    // and it fits the width with room to spare
    expect(height * OVAL_ASPECT).toBeLessThan(390 - 32);
  });

  it("starts below the banner even when the top bar is shorter than it", () => {
    const a = computeOval({ ...base, container: { width: 390, height: 844 }, barBottom: 60, dockHeight: 252, topReserve: 140, floorShare: 0.42 });
    const b = computeOval({ ...base, container: { width: 390, height: 844 }, barBottom: 140, dockHeight: 252, topReserve: 0, floorShare: 0.42 });
    expect(a).toEqual(b);
  });

  it("keeps the size it had before when the controls leave less room (landscape)", () => {
    const { height } = computeOval({ ...base, container: { width: 1280, height: 800 }, barBottom: 112, dockHeight: 190, topReserve: 156, floorShare: 0.56 });
    // only 438 px are free, but the oval was 56% of 800 = 448 and must not shrink
    expect(height).toBe(448);
  });

  it("is only a little bigger than before, however much room there is", () => {
    const { height } = computeOval({ ...base, container: { width: 800, height: 1280 }, barBottom: 88, dockHeight: 190, topReserve: 216, floorShare: 0.46 });
    // 858 px are free, but the growth is capped at 30% over 46% of 1280 = 589
    expect(height).toBe(765);
    expect(height / (0.46 * 1280)).toBeLessThanOrEqual(1.3);
  });

  it("never grows past the screen's width", () => {
    const { height } = computeOval({ ...base, container: { width: 300, height: 900 }, barBottom: 60, dockHeight: 200, topReserve: 140, floorShare: 0.42 });
    expect(height).toBe(344); // (300 - 2 x 16) / 0.78
    expect(height * OVAL_ASPECT).toBeLessThanOrEqual(300 - 32 + 1);
  });

  it("is never absurdly small, and stays fully on screen", () => {
    const { top, height } = computeOval({ ...base, container: { width: 200, height: 200 }, barBottom: 60, dockHeight: 80, topReserve: 0, floorShare: 0.3 });
    expect(height).toBe(140);
    expect(top - height / 2).toBeGreaterThanOrEqual(0);
    expect(top + height / 2).toBeLessThanOrEqual(200);
  });

  it("honours the floor even when it is above the usual share cap", () => {
    const { height } = computeOval({ ...base, container: { width: 2000, height: 1000 }, barBottom: 0, dockHeight: 0, topReserve: 0, floorShare: 0.9, maxGrowth: 2 });
    expect(height).toBe(900); // the floor (90% of 1000) wins over the 72% cap, and nothing is added on top of it
  });

  it("lets a caller allow more growth", () => {
    const common = { ...base, container: { width: 800, height: 1280 }, barBottom: 88, dockHeight: 190, topReserve: 216, floorShare: 0.46 };
    expect(computeOval({ ...common, maxGrowth: 1.1 }).height).toBeLessThan(computeOval({ ...common, maxGrowth: 1.3 }).height);
  });
});
