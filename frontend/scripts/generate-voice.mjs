#!/usr/bin/env node
/**
 * Generates the spoken prompts as MP3 files in public/voice/ (one per phrase in
 * src/utils/voiceClips.json), using Azure Speech text-to-speech.
 *
 *   AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=southeastasia npm run voice
 *
 * Options
 *   --voice <name>   neural voice (default en-PH-RosaNeural; others: en-PH-JamesNeural,
 *                    fil-PH-BlessicaNeural, fil-PH-AngeloNeural, en-US-JennyNeural ...)
 *   --rate <value>   speaking rate, e.g. -10% for slower, +10% for faster (default: the voice's own)
 *   --force          regenerate clips that already exist (default: only the missing ones)
 *   --dry-run        list what would be generated without calling Azure or needing a key
 *
 * The files are plain MP3s named after the phrase key, so recording them yourself (or generating
 * them with any other service) works just as well: save them as public/voice/<key>.mp3.
 * Only the fixed phrases in voiceClips.json are sent; no employee data is involved.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clipsFile = join(root, "src", "utils", "voiceClips.json");
const outDir = join(root, "public", "voice");

function parseArgs(argv) {
  const opts = { voice: "en-PH-RosaNeural", rate: "", force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--voice" || a === "--rate") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = value;
    } else throw new Error(`Unknown option ${a}`);
  }
  if (!/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+$/.test(opts.voice)) throw new Error(`"${opts.voice}" doesn't look like a voice name (e.g. en-PH-RosaNeural)`);
  if (opts.rate && !/^[+-]?\d{1,3}%$/.test(opts.rate)) throw new Error(`--rate must look like -10% or +5%`);
  return opts;
}

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function buildSsml(text, voice, rate) {
  const lang = voice.split("-").slice(0, 2).join("-");
  const body = rate ? `<prosody rate="${rate}">${escapeXml(text)}</prosody>` : escapeXml(text);
  return `<speak version="1.0" xml:lang="${lang}"><voice name="${voice}">${body}</voice></speak>`;
}

async function synthesize(ssml, key, region) {
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "attendance-voice-generator",
    },
    body: ssml,
  });
  if (!res.ok) {
    const detail = (await res.text()).trim().slice(0, 300);
    throw new Error(`Azure answered ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}${hintFor(res.status, region)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Azure's 401 has an empty body, so say what usually causes it. */
export function hintFor(status, region) {
  if (status === 401 || status === 403) {
    return (
      `\n\nThe key was refused. The usual causes, most likely first:\n` +
      `  1. The region doesn't match the key. A key only works in the region its resource was created in\n` +
      `     (it is using "${region}"). In the Azure portal open your Speech resource > Keys and Endpoint and\n` +
      `     copy its "Location/Region" value exactly (for example eastasia, southeastasia, eastus).\n` +
      `  2. The key is for a different kind of resource. It must belong to a Speech (or multi-service AI Services) resource.\n` +
      `  3. The key was disabled or regenerated. Copy KEY 1 again from the same page.\n` +
      `  4. The free tier's quota or the subscription is suspended (check the resource's status in the portal).`
    );
  }
  if (status === 400) return `\n\nAzure rejected the request. Check that the voice name exists in region "${region}" (some voices are not available everywhere).`;
  if (status === 429) return `\n\nToo many requests. Wait a minute and run it again; clips already written are skipped.`;
  return "";
}

/** Reads the credentials from the environment, tidying the usual copy/paste slips and rejecting placeholders. */
export function readCredentials(env) {
  const key = (env.AZURE_SPEECH_KEY || "").trim().replace(/^["']|["']$/g, "");
  // "Southeast Asia" (the portal's display name) and "southeastasia" (the region id) are the same region.
  const region = (env.AZURE_SPEECH_REGION || "").trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/\s+/g, "");
  if (!key || !region) throw new Error("Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (e.g. southeastasia), or use --dry-run.");
  if (/[<>\s]/.test(key) || key.length < 20) {
    throw new Error(`AZURE_SPEECH_KEY doesn't look like a real key (it looks like a placeholder or was cut short). Paste KEY 1 from the Speech resource's Keys and Endpoint page, with no < > brackets.`);
  }
  if (!/^[a-z0-9]+$/.test(region)) throw new Error(`AZURE_SPEECH_REGION "${region}" looks wrong (expected something like southeastasia).`);
  return { key, region };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const clips = JSON.parse(readFileSync(clipsFile, "utf8"));
  const todo = Object.entries(clips).filter(([key]) => opts.force || !existsSync(join(outDir, `${key}.mp3`)));

  if (todo.length === 0) {
    console.log(`Nothing to do: all ${Object.keys(clips).length} clips already exist in public/voice/ (use --force to redo them).`);
    return;
  }
  console.log(`${opts.dryRun ? "Would generate" : "Generating"} ${todo.length} of ${Object.keys(clips).length} clips with ${opts.voice}${opts.rate ? ` at ${opts.rate}` : ""}:`);
  for (const [key, text] of todo) console.log(`  ${key}.mp3  "${text}"`);
  if (opts.dryRun) return;

  const { key, region } = readCredentials(process.env);

  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of todo) {
    const audio = await synthesize(buildSsml(text, opts.voice, opts.rate), key, region);
    const target = join(outDir, `${name}.mp3`);
    // Write then rename, so an interrupted run never leaves a half-written clip that would play as noise.
    writeFileSync(`${target}.part`, audio);
    renameSync(`${target}.part`, target);
    console.log(`  wrote ${name}.mp3 (${(audio.length / 1024).toFixed(1)} KB)`);
  }
  console.log("Done. Reload the enrollment screen to hear them.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
