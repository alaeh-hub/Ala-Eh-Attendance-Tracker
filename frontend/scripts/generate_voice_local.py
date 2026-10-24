#!/usr/bin/env python3
"""
Generates the spoken prompts as MP3 files in public/voice/ (one per phrase in
src/utils/voiceClips.json) with Kokoro, a free open-source (Apache-2.0) text-to-speech model that
runs on this computer: no account, no key, no internet after the first download.

    py -3.11 -m venv .voice-venv
    .voice-venv\\Scripts\\pip install -r scripts/requirements-voice.txt
    .voice-venv\\Scripts\\python scripts/generate_voice_local.py

The model (about 350 MB) is downloaded once into ~/.cache/kokoro-onnx.

Options
  --voice NAME   voice id (default af_heart). af_* / am_* are American female / male, bf_* / bm_* are
                 British. Run --list-voices to see them all.
  --speed X      speaking speed, 1.0 is normal (default 0.95, a little slower so it is easy to follow)
  --force        regenerate clips that already exist (default: only the missing ones)
  --dry-run      list what would be generated without loading the model
  --list-voices  print the available voices and exit
  --out DIR      write the clips here instead of public/voice (for trying other voices)

The clips are plain MP3s named after the phrase key, so a recording by a person works just as well:
save it as public/voice/<key>.mp3.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIPS_FILE = ROOT / "src" / "utils" / "voiceClips.json"
OUT_DIR = ROOT / "public" / "voice"
DEFAULT_MODEL_DIR = Path.home() / ".cache" / "kokoro-onnx"

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
# name -> exact size in bytes, so a partial download can never be mistaken for the whole file
MODEL_FILES = {"kokoro-v1.0.onnx": 325_532_387, "voices-v1.0.bin": 28_214_398}

SILENCE_THRESHOLD = 0.01  # fraction of full scale; the model pads its output with near-silence
EDGE_PAD_SECONDS = 0.08
PEAK_TARGET = 0.9  # every clip is brought to the same peak so none is much quieter than the rest
MP3_KBPS = 96


def download(name: str, model_dir: Path) -> Path:
    target = model_dir / name
    if target.exists() and target.stat().st_size == MODEL_FILES[name]:
        return target
    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {name} (one time, saved in {model_dir}) ...")
    part = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(f"{RELEASE}/{name}", timeout=60) as response, open(part, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while chunk := response.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    if part.stat().st_size != MODEL_FILES[name]:
        part.unlink()
        raise SystemExit(f"{name} came down incomplete or changed upstream; run the script again.")
    part.replace(target)  # only a complete file ever gets the real name
    return target


def tidy(samples):
    """Trim the silent edges, keep a short pad, and bring the clip to a common peak."""
    import numpy as np

    loud = np.flatnonzero(np.abs(samples) > SILENCE_THRESHOLD)
    if loud.size:
        pad = int(EDGE_PAD_SECONDS * 24000)
        samples = samples[max(0, loud[0] - pad) : loud[-1] + pad]
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    return samples * (PEAK_TARGET / peak) if peak > 0 else samples


def to_mp3(samples, sample_rate: int) -> bytes:
    import lameenc
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(MP3_KBPS)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(1)
    encoder.set_quality(2)
    return bytes(encoder.encode(pcm.tobytes()) + encoder.flush())


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the spoken prompts locally with Kokoro.")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=0.95)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list-voices", action="store_true")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    args = parser.parse_args()
    if not 0.5 <= args.speed <= 2.0:
        parser.error("--speed must be between 0.5 and 2.0")

    clips: dict[str, str] = json.loads(CLIPS_FILE.read_text(encoding="utf-8"))
    todo = {key: text for key, text in clips.items() if args.force or not (args.out / f"{key}.mp3").exists()}

    if args.dry_run:
        if not todo:
            print(f"Nothing to do: all {len(clips)} clips already exist in {args.out} (use --force to redo them).")
        else:
            print(f"Would generate {len(todo)} of {len(clips)} clips with {args.voice} at speed {args.speed}:")
            for key, text in todo.items():
                print(f'  {key}.mp3  "{text}"')
        return 0
    if not todo and not args.list_voices:
        print(f"Nothing to do: all {len(clips)} clips already exist in {args.out} (use --force to redo them).")
        return 0

    try:
        from kokoro_onnx import Kokoro
    except ImportError:
        print("Install the dependencies first:  pip install -r scripts/requirements-voice.txt", file=sys.stderr)
        return 1

    model = download("kokoro-v1.0.onnx", args.model_dir)
    voices = download("voices-v1.0.bin", args.model_dir)
    kokoro = Kokoro(str(model), str(voices))
    available = sorted(kokoro.get_voices())
    if args.list_voices:
        print("\n".join(available))
        return 0
    if args.voice not in available:
        print(f'Unknown voice "{args.voice}". Try --list-voices. Some: {", ".join(available[:8])} ...', file=sys.stderr)
        return 1

    lang = "en-gb" if args.voice.startswith("b") else "en-us"
    args.out.mkdir(parents=True, exist_ok=True)
    print(f"Generating {len(todo)} of {len(clips)} clips with {args.voice} ({lang}) at speed {args.speed}:")
    for key, text in todo.items():
        samples, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=lang)
        audio = to_mp3(tidy(samples), rate)
        target = args.out / f"{key}.mp3"
        part = target.with_suffix(".mp3.part")
        part.write_bytes(audio)  # write, then rename, so an interrupted run never leaves a half-written clip
        part.replace(target)
        print(f"  wrote {key}.mp3  ({len(audio) / 1024:.1f} KB)")
    print("Done. Reload the enrollment screen to hear them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
