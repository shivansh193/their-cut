// Builds demo videos and their ground truth from fixtures/videos/spec.json.
// Footage: Pexels-licensed clips in fixtures/videos/source (see ASSETS.md).
// Narration: offline Windows SAPI voice, so the build needs Windows + ffmpeg.
// Run: npx tsx scripts/build-fixtures.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeIntervals, measure, type Interval } from "../server/rules/engine.js";

const ROOT = resolve(import.meta.dirname, "..");
const FX = join(ROOT, "fixtures", "videos");
const spec = JSON.parse(readFileSync(join(FX, "spec.json"), "utf8"));
const FONT = "C\\:/Windows/Fonts/segoeuib.ttf";
const W = 1280, H = 720, FPS = 25;

type Say = { text: string; subjects: string[] };
type Seg =
  | { card: string; dur: number; say?: Say[] }
  | { clip: string; in: number; out: number; visible: string[]; notes?: string; say?: Say[] };

function ff(args: string[]) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}
function probeDur(file: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}
function esc(t: string) {
  return t.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019");
}

function tts(lines: { text: string; out: string }[]) {
  const job = join(FX, ".tts-job.json");
  writeFileSync(job, JSON.stringify(lines));
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$s.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($l in (Get-Content -Raw '${job.replace(/'/g, "''")}' | ConvertFrom-Json)) {
  $s.SetOutputToWaveFile($l.out, $fmt); $s.Speak($l.text); $s.SetOutputToNull()
}`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
}

for (const v of spec.videos as { id: string; title: string; segments: Seg[] }[]) {
  const dir = join(FX, v.id);
  const tmp = join(dir, ".build");
  mkdirSync(tmp, { recursive: true });
  console.log(`\n== ${v.id}`);

  // 1. render each segment to a normalised 1280x720@25 mp4 (no audio)
  let t = 0;
  const parts: string[] = [];
  const visual: Record<string, Interval[]> = {};
  const sayQueue: { text: string; subjects: string[]; at: number; segEnd: number }[] = [];
  const timeline: any[] = [];
  v.segments.forEach((s, i) => {
    const out = join(tmp, `seg${String(i).padStart(2, "0")}.mp4`);
    let dur: number;
    if ("card" in s) {
      dur = s.dur;
      ff([
        "-f", "lavfi", "-i", `color=c=0xF4ECE1:s=${W}x${H}:r=${FPS}:d=${dur}`,
        "-vf", `drawbox=x=0:y=ih-16:w=iw:h=16:color=0xE07A5F:t=fill,drawtext=fontfile='${FONT}':text='${esc(s.card)}':fontcolor=0x2D2A26:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23", out,
      ]);
      timeline.push({ start: t, end: t + dur, kind: "card", text: s.card, visible: [] });
    } else {
      dur = +(s.out - s.in).toFixed(3);
      ff([
        "-ss", String(s.in), "-t", String(dur), "-i", join(FX, "source", `${s.clip}.mp4`),
        "-vf", `scale=${W}:${H},fps=${FPS}`, "-an",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23", out,
      ]);
      for (const c of s.visible) (visual[c] ??= []).push({ start: +t.toFixed(3), end: +(t + dur).toFixed(3) });
      timeline.push({ start: t, end: t + dur, kind: "clip", clip: s.clip, in: s.in, out: s.out, visible: s.visible, notes: s.notes });
    }
    let at = t + 0.5;
    for (const l of s.say ?? []) {
      sayQueue.push({ ...l, at, segEnd: t + dur });
      at += 0.01; // placed for real after measuring the audio
    }
    parts.push(out);
    t += dur;
  });
  const total = +t.toFixed(3);

  // 2. narration audio
  const lines = sayQueue.map((l, i) => ({ text: l.text, out: join(tmp, `say${String(i).padStart(2, "0")}.wav`) }));
  tts(lines);
  const narration: { start: number; end: number; text: string; subjects: string[] }[] = [];
  let cursor = 0;
  sayQueue.forEach((l, i) => {
    const d = probeDur(lines[i].out);
    const start = +Math.max(l.at, cursor + 0.3).toFixed(3);
    const end = +(start + d).toFixed(3);
    narration.push({ start, end, text: l.text, subjects: l.subjects });
    cursor = end;
  });

  // 3. concat video, mix narration, mux
  const list = join(tmp, "list.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  const silent = join(tmp, "video.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
  const inputs = lines.flatMap((l) => ["-i", l.out]);
  const delays = narration.map((n, i) => `[${i + 1}:a]adelay=${Math.round(n.start * 1000)}:all=1[a${i}]`).join(";");
  const mix = `${delays};${narration.map((_, i) => `[a${i}]`).join("")}amix=inputs=${narration.length}:normalize=0,apad,atrim=0:${total}[aout]`;
  ff(["-i", silent, ...inputs, "-filter_complex", mix, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", join(dir, "video.mp4")]);

  // 4. ground truth
  const childIds: string[] = spec.children.map((c: any) => c.id);
  const narr: Record<string, Interval[]> = {};
  for (const n of narration) for (const c of n.subjects) (narr[c] ??= []).push({ start: n.start, end: n.end });
  const truth = {
    id: v.id,
    title: v.title,
    durationSec: total,
    labelling: "Visual presence labelled per edit segment after 1 fps frame-by-frame review of each source clip; narration intervals are the exact spans of each generated narration line.",
    children: Object.fromEntries(
      childIds.map((c) => {
        const vis = mergeIntervals(visual[c] ?? [], total);
        const nar = mergeIntervals(narr[c] ?? [], total);
        const all = mergeIntervals([...vis, ...nar], total);
        return [c, { visual: vis, narration: nar, presence: all, presencePct: +((measure(all) / total) * 100).toFixed(2) }];
      }),
    ),
    narration,
    timeline,
  };
  writeFileSync(join(dir, "truth.json"), JSON.stringify(truth, null, 2));
  writeFileSync(
    join(dir, "narration.srt"),
    narration
      .map((n, i) => `${i + 1}\n${srt(n.start)} --> ${srt(n.end)}\n${n.text}\n`)
      .join("\n"),
  );
  console.log(`  ${total}s`, Object.entries(truth.children).map(([c, x]: any) => `${c}=${x.presencePct}%`).join(" "));
}

// reference stills for the parent's tags
const refDir = join(FX, "references");
mkdirSync(refDir, { recursive: true });
for (const r of spec.references) {
  const [x, y, w, h] = r.box;
  ff([
    "-ss", String(r.t), "-i", join(FX, "source", `${r.clip}.mp4`), "-frames:v", "1",
    "-vf", `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=-2:360`, join(refDir, `${r.childId}.jpg`),
  ]);
}
if (!existsSync(join(refDir, "context.jpg")))
  ff(["-ss", "2", "-i", join(FX, "source", "5135467.mp4"), "-frames:v", "1", "-vf", "scale=960:-2", join(refDir, "context.jpg")]);

function srt(s: number) {
  const ms = Math.round(s * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
