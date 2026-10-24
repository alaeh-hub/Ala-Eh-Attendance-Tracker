import { useEffect } from "react";
import voiceClips from "./voiceClips.json";

// One AudioContext for the page's lifetime: browsers cap how many can exist, and a new one per
// chime eventually stops making sound. It starts "suspended" until the first user gesture.
let audioCtx: AudioContext | null = null;
export function audio(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = Ctor ? new Ctor() : null;
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

export function chime(success: boolean) {
  try {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
    const notes = success ? [880, 1318.5] : [330, 262];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch {
    /* audio is optional */
  }
}

/** The browser's own voice. Does nothing where speech isn't available. `onEnd` runs when it has finished (or straight away if it can't speak). */
export function speak(text: string, onEnd?: () => void) {
  try {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      onEnd?.();
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (onEnd) utterance.onend = onEnd;
    synth.speak(utterance);
  } catch {
    onEnd?.();
  }
}

/* ---- Recorded voice prompts ---------------------------------------------------------------
 * Each phrase in voiceClips.json is played from /voice/<key>.mp3 (made once with
 * `npm run voice`, or recorded by a person). A clip that is missing falls back to the browser
 * voice, so the app works the same with or without the files. */

export type VoiceKey = keyof typeof voiceClips;
export const isVoiceKey = (key: string): key is VoiceKey => key in voiceClips;

// null = known to be missing. The server answers a missing file with the app's HTML page,
// which the audio element reports as an error, the same as a real failure to load.
const clipEls = new Map<VoiceKey, HTMLAudioElement | null>();
let playing: HTMLAudioElement | null = null;
// What happens when the clip that is playing ends: the next prompt of a sequence, if there is one.
let afterPlaying: (() => void) | null = null;
let pendingSay: ReturnType<typeof setTimeout> | undefined;
// Bumped by every stopSpeaking(), so a sequence that was stopped can't carry on to its next prompt.
let generation = 0;

function clip(key: VoiceKey): HTMLAudioElement | null {
  if (clipEls.has(key)) return clipEls.get(key)!;
  let el: HTMLAudioElement | null = null;
  try {
    el = new Audio(`/voice/${key}.mp3`);
    el.preload = "auto";
    const loaded = el;
    loaded.addEventListener(
      "error",
      () => {
        clipEls.set(key, null);
        // It failed while it was meant to be playing: say it with the browser voice instead.
        if (playing === loaded) {
          const next = afterPlaying;
          playing = null;
          afterPlaying = null;
          speak(voiceClips[key], next ?? undefined);
        }
      },
      { once: true }
    );
  } catch {
    el = null;
  }
  clipEls.set(key, el);
  return el;
}

/** Fetch every clip ahead of time so the first prompt isn't late. */
export function preloadVoice() {
  (Object.keys(voiceClips) as VoiceKey[]).forEach(clip);
}

function playOne(key: VoiceKey, next?: () => void) {
  const el = clip(key);
  if (!el) {
    speak(voiceClips[key], next);
    return;
  }
  playing = el;
  afterPlaying = next ?? null;
  el.onended = () => {
    if (playing !== el) return;
    playing = null;
    afterPlaying = null;
    next?.();
  };
  try {
    el.currentTime = 0;
    // play() rejects when it is interrupted or blocked until a tap; both are fine to ignore.
    el.play()?.catch?.(() => undefined);
  } catch {
    /* audio is optional */
  }
}

function playList(keys: VoiceKey[], gen: number) {
  const [key, ...rest] = keys;
  if (key === undefined) return;
  playOne(key, rest.length ? () => gen === generation && playList(rest, gen) : undefined);
}

/**
 * Say a prompt: the recorded clip when there is one, otherwise the browser voice. Replaces whatever is
 * being said. Give a list to say several in order ("Captured." then the next pose). `delayMs` waits
 * first (for example, until a chime has finished); a later say() or stopSpeaking() cancels a prompt
 * that is still waiting.
 */
export function say(keys: VoiceKey | VoiceKey[], delayMs = 0) {
  stopSpeaking();
  const list = Array.isArray(keys) ? keys : [keys];
  const gen = generation;
  if (delayMs > 0) pendingSay = setTimeout(() => playList(list, gen), delayMs);
  else playList(list, gen);
}

const lastSaid = new Map<VoiceKey, number>();

/** Like say(), but not again within `gapMs`: for prompts that would otherwise repeat on every scan. */
export function sayOnce(key: VoiceKey, gapMs: number, delayMs = 0) {
  const now = Date.now();
  if (now - (lastSaid.get(key) ?? -Infinity) < gapMs) return;
  lastSaid.set(key, now);
  say(key, delayMs);
}

export function stopSpeaking() {
  generation++;
  clearTimeout(pendingSay);
  pendingSay = undefined;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* speech is optional */
  }
  try {
    if (playing) playing.onended = null;
    playing?.pause();
  } catch {
    /* audio is optional */
  }
  playing = null;
  afterPlaying = null;
}
/** Browsers only let audio play after a user gesture: wake the shared AudioContext on the first one. */
export function useAudioUnlock() {
  useEffect(() => {
    const unlock = () => {
      audio()?.resume().catch(() => undefined);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}
