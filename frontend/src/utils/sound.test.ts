import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import voiceClips from "./voiceClips.json";

type Handler = () => void;

/** Just enough of HTMLAudioElement to see what the player does with it. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  preload = "";
  currentTime = 0;
  onended: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  private handlers = new Map<string, Handler[]>();
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, fn: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string) {
    (this.handlers.get(type) ?? []).forEach((fn) => fn());
  }
}

class FakeUtterance {
  onend: (() => void) | null = null;
  constructor(public text: string) {}
}

const synth = { speak: vi.fn(), cancel: vi.fn() };

// The player keeps what it has learned about each clip in module state, so every test starts from a fresh copy.
const load = async () => {
  vi.resetModules();
  return import("./sound");
};

beforeEach(() => {
  FakeAudio.instances = [];
  synth.speak = vi.fn();
  synth.cancel = vi.fn();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const spoken = () => synth.speak.mock.calls.map(([u]) => (u as FakeUtterance).text);

describe("voice prompts", () => {
  it("plays the recorded clip for a phrase and does not use the browser voice", async () => {
    const { say } = await load();
    say("pose.left");

    const [el] = FakeAudio.instances;
    expect(el.src).toBe("/voice/pose.left.mp3");
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(spoken()).toEqual([]);
  });

  it("starts the clip from the beginning each time and reuses the loaded file", async () => {
    const { say } = await load();
    say("pose.left");
    FakeAudio.instances[0].currentTime = 3;
    say("pose.left");

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].currentTime).toBe(0);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(2);
  });

  it("speaks the phrase instead when the clip turns out to be missing while it plays", async () => {
    const { say } = await load();
    say("retry");
    FakeAudio.instances[0].fire("error"); // the server answered with the app's HTML page, not audio

    expect(spoken()).toEqual([voiceClips.retry]);
  });

  it("remembers a missing clip and goes straight to the browser voice next time", async () => {
    const { preloadVoice, say } = await load();
    preloadVoice();
    FakeAudio.instances.find((a) => a.src === "/voice/done.mp3")!.fire("error"); // found missing while preloading

    say("done");
    expect(spoken()).toEqual([voiceClips.done]);
    expect(FakeAudio.instances.find((a) => a.src === "/voice/done.mp3")!.play).not.toHaveBeenCalled();
  });

  it("preloads every clip once", async () => {
    const { preloadVoice } = await load();
    preloadVoice();
    preloadVoice();

    expect(FakeAudio.instances.map((a) => a.src).sort()).toEqual(Object.keys(voiceClips).map((k) => `/voice/${k}.mp3`).sort());
    expect(FakeAudio.instances.every((a) => a.preload === "auto")).toBe(true);
  });

  it("stops the previous prompt when a new one starts, and when told to stop", async () => {
    const { say, stopSpeaking } = await load();
    say("pose.left");
    say("pose.right");
    const [left, right] = FakeAudio.instances;
    expect(left.pause).toHaveBeenCalled();
    expect(right.play).toHaveBeenCalled();

    stopSpeaking();
    expect(right.pause).toHaveBeenCalled();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("stays quiet when a blocked play() rejects", async () => {
    const { say } = await load();
    say("pose.up");
    const [el] = FakeAudio.instances;
    el.play.mockReturnValueOnce(Promise.reject(new DOMException("blocked", "NotAllowedError")));
    expect(() => say("pose.up")).not.toThrow();
    await Promise.resolve();
    expect(spoken()).toEqual([]);
  });

  it("waits for the delay before playing (for example until a chime has finished)", async () => {
    vi.useFakeTimers();
    const { say } = await load();
    say("kiosk.time_in", 400);

    vi.advanceTimersByTime(399);
    expect(FakeAudio.instances).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(["/voice/kiosk.time_in.mp3"]);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
  });

  it("drops a prompt that is still waiting when a newer one starts or when told to stop", async () => {
    vi.useFakeTimers();
    const { say, stopSpeaking } = await load();

    say("done", 400);
    say("retry"); // replaces it straight away
    vi.advanceTimersByTime(1000);
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(["/voice/retry.mp3"]);

    say("kiosk.verified", 400);
    stopSpeaking();
    vi.advanceTimersByTime(1000);
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(["/voice/retry.mp3"]);
  });

  it("plays a list in order, each prompt starting when the one before it has ended", async () => {
    const { say } = await load();
    say(["enroll.captured", "pose.left"]);

    expect(FakeAudio.instances.map((a) => a.src)).toEqual(["/voice/enroll.captured.mp3"]);
    FakeAudio.instances[0].onended?.();
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(["/voice/enroll.captured.mp3", "/voice/pose.left.mp3"]);
    expect(FakeAudio.instances[1].play).toHaveBeenCalledTimes(1);
  });

  it("does not carry on with a list once it has been stopped or replaced", async () => {
    const { say, stopSpeaking } = await load();
    say(["enroll.captured", "pose.left"]);
    const staleHandler = FakeAudio.instances[0].onended;
    stopSpeaking();
    staleHandler?.(); // an 'ended' that arrives after the stop
    expect(FakeAudio.instances).toHaveLength(1);

    say(["enroll.cleared", "pose.right"]);
    const first = FakeAudio.instances.find((a) => a.src.includes("cleared"))!;
    say("retry"); // replaces the list before its first prompt ends
    first.onended?.();
    expect(FakeAudio.instances.some((a) => a.src.includes("pose.right"))).toBe(false);
  });

  it("carries on with a list after a missing clip is spoken by the browser voice", async () => {
    const { say } = await load();
    say(["enroll.captured", "pose.left"]);
    FakeAudio.instances[0].fire("error");

    expect(spoken()).toEqual([voiceClips["enroll.captured"]]);
    expect(FakeAudio.instances).toHaveLength(1);
    (synth.speak.mock.calls[0][0] as FakeUtterance).onend?.(); // the browser voice finished
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(["/voice/enroll.captured.mp3", "/voice/pose.left.mp3"]);
  });

  it("sayOnce does not repeat a prompt within the gap, then allows it again", async () => {
    vi.useFakeTimers();
    const { sayOnce } = await load();
    sayOnce("kiosk.blink", 6000);
    sayOnce("kiosk.blink", 6000);
    vi.advanceTimersByTime(5999);
    sayOnce("kiosk.blink", 6000);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    sayOnce("kiosk.blink", 6000);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(2);
  });

  it("sayOnce keeps a separate gap for each prompt", async () => {
    const { sayOnce } = await load();
    sayOnce("kiosk.blink", 6000);
    sayOnce("kiosk.hold_still", 6000);
    expect(FakeAudio.instances.map((a) => a.src).sort()).toEqual(["/voice/kiosk.blink.mp3", "/voice/kiosk.hold_still.mp3"]);
  });

  it("recognises only phrases that exist", async () => {
    const { isVoiceKey } = await load();
    expect(isVoiceKey("pose.frontal")).toBe(true);
    expect(isVoiceKey("pose.sideways")).toBe(false);
  });
});
