// Demo videos shipped in the repo, with cached analysis, so the hosted demo is instant
// and costs nothing unless someone asks for a fresh AI run.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures", "videos");
const spec = JSON.parse(readFileSync(join(FIXTURES_DIR, "spec.json"), "utf8"));

export interface DemoVideo {
  id: string;
  title: string;
  durationSec: number;
  sizeBytes: number;
  hasCachedAnalysis: boolean;
  suggestedBrand: string;
  suggestedAmountCents: number;
}

const BRANDS: Record<string, [string, number]> = {
  "saturday-breakfast": ["Sunny Oats", 250_000],
  "sunday-lunch": ["Green Crate", 180_000],
  "blender-review": ["Brightblend", 60_000],
};

export function demoVideos(): DemoVideo[] {
  return spec.videos.map((v: any) => {
    const truth = JSON.parse(readFileSync(join(FIXTURES_DIR, v.id, "truth.json"), "utf8"));
    const [brand, amt] = BRANDS[v.id] ?? ["Acme", 100_000];
    return {
      id: v.id,
      title: v.title,
      durationSec: truth.durationSec,
      sizeBytes: statSync(join(FIXTURES_DIR, v.id, "video.mp4")).size,
      hasCachedAnalysis: existsSync(join(FIXTURES_DIR, v.id, "analysis.json")),
      suggestedBrand: brand,
      suggestedAmountCents: amt,
    };
  });
}

export const demoChildren = () =>
  spec.children as { id: string; name: string; birthDate: string; description: string }[];

export function cachedAnalysis(videoId: string) {
  const f = join(FIXTURES_DIR, videoId, "analysis.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

export function truthFor(videoId: string) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, videoId, "truth.json"), "utf8"));
}

export const videoPath = (id: string) => join(FIXTURES_DIR, id, "video.mp4");
export const referencePath = (childId: string) => join(FIXTURES_DIR, "references", `${childId}.jpg`);
