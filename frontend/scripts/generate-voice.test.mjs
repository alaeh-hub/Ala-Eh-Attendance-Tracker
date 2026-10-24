import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSsml, hintFor, readCredentials } from "./generate-voice.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "generate-voice.mjs");
// Run without a key, whatever the developer's shell has set.
const env = { ...process.env, AZURE_SPEECH_KEY: "", AZURE_SPEECH_REGION: "" };
const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });

describe("generate-voice", () => {
  it("builds SSML with the voice's language and escapes the text", () => {
    const ssml = buildSsml(`That didn't work & "so" <on>`, "en-PH-RosaNeural", "");
    expect(ssml).toContain('xml:lang="en-PH"');
    expect(ssml).toContain('<voice name="en-PH-RosaNeural">');
    expect(ssml).toContain("That didn&apos;t work &amp; &quot;so&quot; &lt;on&gt;");
    expect(ssml).not.toContain("<prosody");
  });

  it("adds the speaking rate when asked", () => {
    expect(buildSsml("Hi", "fil-PH-BlessicaNeural", "-10%")).toContain('<prosody rate="-10%">Hi</prosody>');
  });

  it("lists the clips on a dry run without needing a key", () => {
    const out = execFileSync(process.execPath, [script, "--dry-run", "--force"], { env, encoding: "utf8" });
    expect(out).toContain("Would generate");
    expect(out).toContain("pose.frontal.mp3");
    expect(out).toContain("done.mp3");
  });

  it("refuses to run for real without a key", () => {
    const r = run("--force");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AZURE_SPEECH_KEY");
  });

  it("catches a placeholder or truncated key before calling Azure", () => {
    for (const key of ["<key>", "your key here", "abc123"]) {
      const r = spawnSync(process.execPath, [script, "--force"], { env: { ...env, AZURE_SPEECH_KEY: key, AZURE_SPEECH_REGION: "southeastasia" }, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("doesn't look like a real key");
    }
  });

  it("tidies quotes and spaces, and accepts the region's display name", () => {
    const key = "a".repeat(32);
    expect(readCredentials({ AZURE_SPEECH_KEY: ` "${key}" `, AZURE_SPEECH_REGION: "Southeast Asia" })).toEqual({ key, region: "southeastasia" });
    expect(() => readCredentials({ AZURE_SPEECH_KEY: key, AZURE_SPEECH_REGION: "south-east" })).toThrow(/looks wrong/);
    expect(() => readCredentials({ AZURE_SPEECH_KEY: "", AZURE_SPEECH_REGION: "eastus" })).toThrow(/Set AZURE_SPEECH_KEY/);
  });

  it("explains a 401 instead of printing an empty error", () => {
    const text = hintFor(401, "southeastasia");
    expect(text).toContain("Location/Region");
    expect(text).toContain('"southeastasia"');
    expect(hintFor(403, "eastus")).toContain("The key was refused");
    expect(hintFor(500, "eastus")).toBe("");
  });

  it("rejects a malformed voice name and unknown options", () => {
    expect(run("--voice", "not a voice", "--dry-run").status).toBe(1);
    expect(run("--bogus").stderr).toContain("Unknown option");
    expect(run("--rate", "fast", "--dry-run").status).toBe(1);
  });
});
