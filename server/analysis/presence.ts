// Presence measurement: how much of a video each child is in.
// 1. Visual: Gemini watches the video at 2 fps and matches people only against the
//    parent's own reference stills. There's no external face database and no stored templates.
// 2. Oral narrative: Gemini transcribes the audio with timestamps and marks each line whose
//    subject is a child, including pronoun references it resolves from context.
// Both run in parallel. The output is per-child intervals with confidence and evidence.

import { generateJson, videoPart, type Part } from "./gemini.js";
import { mergeIntervals, measure, type Interval } from "../rules/engine.js";

export interface ChildTag {
  id: string;
  name: string;
  description?: string;
  /** Reference still(s) the parent marked as "this is <name>". JPEG bytes. */
  images: Buffer[];
}

export interface ScoredInterval extends Interval {
  confidence: number;
  evidence?: string;
}

export interface NarrationLine {
  start: number;
  end: number;
  text: string;
  subjects: { childId: string; how: "name" | "pronoun" | "description"; confidence: number }[];
}

export interface ChildPresence {
  childId: string;
  name: string;
  visual: ScoredInterval[];
  narration: ScoredInterval[];
  presence: Interval[]; // union, merged
  presencePct: number;
  visualPct: number;
  narrationOnlySec: number; // narrated while not on screen
}

export interface PresenceResult {
  durationSec: number;
  model: string;
  analysedAt: string;
  ms: { visual: number; narration: number };
  children: ChildPresence[];
  transcript: NarrationLine[];
  privacy: string;
}

const VISUAL_SCHEMA = {
  type: "OBJECT",
  properties: {
    children: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          child_id: { type: "STRING" },
          intervals: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                start: { type: "NUMBER", description: "seconds from the start of the video" },
                end: { type: "NUMBER", description: "seconds from the start of the video" },
                confidence: { type: "NUMBER", description: "0 to 1" },
                evidence: { type: "STRING", description: "what was seen, e.g. 'girl in green top at the counter, left of frame'" },
              },
              required: ["start", "end", "confidence"],
            },
          },
        },
        required: ["child_id", "intervals"],
      },
    },
  },
  required: ["children"],
};

const NARRATION_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          start: { type: "NUMBER" },
          end: { type: "NUMBER" },
          text: { type: "STRING" },
          subjects: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                child_id: { type: "STRING" },
                how: { type: "STRING", enum: ["name", "pronoun", "description"] },
                confidence: { type: "NUMBER" },
              },
              required: ["child_id", "how", "confidence"],
            },
          },
        },
        required: ["start", "end", "text", "subjects"],
      },
    },
  },
  required: ["lines"],
};

/**
 * Gemini reports timestamps at roughly 1 s resolution (we sample video at 2 fps), so a child
 * who is continuously present often comes back as [5,21] [21.5,33]. Gaps no longer than the
 * timestamp resolution are closed. Set from the model's resolution, not tuned on the eval set.
 */
export const GAP_SEC = 1.0;

export function bridgeGaps(xs: Interval[], gap: number): Interval[] {
  const out: Interval[] = [];
  for (const i of xs) {
    const last = out[out.length - 1];
    if (last && i.start - last.end <= gap) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export async function analysePresence(args: {
  video: Buffer;
  durationSec: number;
  children: ChildTag[];
  minConfidence?: number;
}): Promise<PresenceResult> {
  const minConf = args.minConfidence ?? 0.5;
  const maxSec = Number(process.env.AI_MAX_VIDEO_SEC ?? 180);
  if (args.durationSec > maxSec) throw new Error(`Videos longer than ${maxSec}s aren't analysed in the demo (cost cap).`);
  const vid = await videoPart(args.video, "video/mp4", 2);

  const refParts: Part[] = [];
  for (const c of args.children) {
    refParts.push({ text: `Reference for child_id "${c.id}" (${c.name}${c.description ? `: ${c.description}` : ""}):` });
    for (const img of c.images) refParts.push({ inline_data: { mime_type: "image/jpeg", data: img.toString("base64") } });
  }
  const ids = args.children.map((c) => `"${c.id}" (${c.name})`).join(", ");

  const visualP = generateJson<{ children: { child_id: string; intervals: ScoredInterval[] }[] }>({
    label: "visual",
    schema: VISUAL_SCHEMA,
    system:
      "You measure on-screen time for a child-earnings compliance tool. Match people ONLY against the reference images given; never identify anyone by name beyond these references. Be precise about timestamps and conservative about identity.",
    parts: [
      ...refParts,
      vid,
      {
        text: `The video is ${args.durationSec.toFixed(1)} seconds long. For each child (${ids}), list every time interval in which that child is VISIBLE on screen, even partly, small or in the background. A child counts as visible if any recognisable part of them (face, head, body) is in frame. Title cards or shots with nobody in them are not presence.
Rules:
- Use seconds from the start of the video (decimals allowed). Intervals must lie in [0, ${args.durationSec.toFixed(1)}].
- Start a new interval whenever the child leaves the frame or the shot cuts away from them.
- Clothes may differ between scenes; match on face, hair, build and apparent age.
- confidence = how sure you are that this person is that child (0..1).
- evidence = a short description of what you saw.
Return every child_id, with an empty intervals array if they never appear.`,
      },
    ],
  });

  const narrationP = generateJson<{ lines: NarrationLine[] & { subjects: { child_id: string; how: string; confidence: number }[] }[] }>({
    label: "narration",
    mediaResolution: "MEDIA_RESOLUTION_LOW", // only the audio matters here

    schema: NARRATION_SCHEMA,
    system:
      "You transcribe narration for a child-earnings compliance tool and decide which child, if any, each spoken line is about. A child is the subject when the line talks about them, by name, by pronoun (he, she, they) referring to them, or by an unambiguous description. Do not mark a child just because they are on screen. Generic group references ('the kids', 'everyone', 'the family') do not make any specific child the subject unless context makes clear which child is meant.",
    parts: [
      { text: `The children in this family: ${args.children.map((c) => `child_id "${c.id}" is ${c.name}${c.description ? ` (${c.description})` : ""}`).join("; ")}.` },
      vid,
      {
        text: `Transcribe every spoken line in the audio with precise start and end times in seconds (decimals allowed, within [0, ${args.durationSec.toFixed(1)}]). One entry per sentence. For each line, list the children who are the subject of what is said, with how they are referred to (name, pronoun or description) and your confidence. Resolve pronouns using earlier lines. Lines about adults, products or the recipe have an empty subjects array.`,
      },
    ],
  });

  const [visual, narration] = await Promise.all([visualP, narrationP]);
  const dur = args.durationSec;
  const clamp = (i: Interval) => ({ start: Math.max(0, Math.min(dur, i.start)), end: Math.max(0, Math.min(dur, i.end)) });

  const transcript: NarrationLine[] = narration.data.lines
    .map((l: any) => ({
      ...clamp(l),
      text: l.text,
      subjects: (l.subjects ?? [])
        .filter((s: any) => args.children.some((c) => c.id === s.child_id))
        .map((s: any) => ({ childId: s.child_id, how: s.how, confidence: s.confidence }))
        // the model sometimes lists one child twice (by name and by pronoun); keep the most confident
        .sort((a: any, b: any) => b.confidence - a.confidence)
        .filter((s: any, i: number, arr: any[]) => arr.findIndex((x) => x.childId === s.childId) === i),
    }))
    .filter((l) => l.end > l.start)
    .sort((a, b) => a.start - b.start);

  const children: ChildPresence[] = args.children.map((c) => {
    const v = (visual.data.children.find((x) => x.child_id === c.id)?.intervals ?? [])
      .map((i) => ({ ...clamp(i), confidence: i.confidence ?? 0.5, evidence: i.evidence }))
      .filter((i) => i.end > i.start)
      .sort((a, b) => a.start - b.start);
    const n: ScoredInterval[] = transcript.flatMap((l) =>
      l.subjects
        .filter((s) => s.childId === c.id)
        .map((s) => ({ start: l.start, end: l.end, confidence: s.confidence, evidence: `“${l.text}” (${s.how})` })),
    );
    const vKeep = bridgeGaps(mergeIntervals(v.filter((i) => i.confidence >= minConf), dur), GAP_SEC);
    const nKeep = bridgeGaps(mergeIntervals(n.filter((i) => i.confidence >= minConf), dur), GAP_SEC);
    const presence = mergeIntervals([...vKeep, ...nKeep], dur);
    return {
      childId: c.id,
      name: c.name,
      visual: v,
      narration: n,
      presence,
      presencePct: (measure(presence) / dur) * 100,
      visualPct: (measure(vKeep) / dur) * 100,
      narrationOnlySec: measure(presence) - measure(vKeep),
    };
  });

  return {
    durationSec: dur,
    model: visual.model,
    analysedAt: new Date().toISOString(),
    ms: { visual: visual.ms, narration: narration.ms },
    children,
    transcript,
    privacy:
      "Matched only against the parent's own reference stills for this video. No external face database, no biometric templates stored; reference stills are discarded after analysis.",
  };
}
