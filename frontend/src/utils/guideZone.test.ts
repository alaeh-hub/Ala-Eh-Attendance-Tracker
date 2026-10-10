import { describe, expect, it } from "vitest";
import { guideZone } from "./guideZone";

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function video(box: DOMRect, videoWidth: number, videoHeight: number) {
  return { getBoundingClientRect: () => box, videoWidth, videoHeight } as unknown as HTMLVideoElement;
}
const oval = (box: DOMRect) => ({ getBoundingClientRect: () => box }) as unknown as HTMLElement;

describe("guideZone", () => {
  it("maps a centred oval to the centre of the frame", () => {
    // 1280x720 camera shown cropped to fill a 1000x1000 square; oval centred, 400 wide x 600 tall.
    const z = guideZone(video(rect(0, 0, 1000, 1000), 1280, 720), oval(rect(300, 200, 400, 600)))!;
    expect(z.cx).toBeCloseTo(0.5, 3);
    expect(z.cy).toBeCloseTo(0.5, 3);
    // The camera is scaled up by 1000/720; the oval's radii shrink back into frame fractions.
    expect(z.ry).toBeCloseTo(300 / (1000 / 720) / 720, 3);
    expect(z.rx).toBeCloseTo(200 / (1000 / 720) / 1280, 3);
  });

  it("mirrors left and right: an oval on the screen's left is on the frame's right", () => {
    const z = guideZone(video(rect(0, 0, 1280, 720), 1280, 720), oval(rect(100, 260, 200, 200)))!;
    expect(z.cx).toBeCloseTo(1 - 200 / 1280, 3); // centre at screen x=200 -> frame x=1080
    expect(z.cy).toBeCloseTo(360 / 720, 3);
  });

  it("accounts for the part of the frame cropped off by object-cover", () => {
    // Portrait screen 500x1000 over a 1280x720 camera: scale 1000/720, sides cropped.
    const z = guideZone(video(rect(0, 0, 500, 1000), 1280, 720), oval(rect(0, 0, 500, 1000)))!;
    expect(z.cx).toBeCloseTo(0.5, 3);
    expect(z.rx).toBeCloseTo(250 / (1000 / 720) / 1280, 3);
    expect(z.rx).toBeLessThan(0.2); // only the middle slice of the frame is visible
  });

  it("returns null when it cannot measure", () => {
    expect(guideZone(null, null)).toBeNull();
    expect(guideZone(video(rect(0, 0, 100, 100), 0, 0), oval(rect(0, 0, 10, 10)))).toBeNull();
  });
});
