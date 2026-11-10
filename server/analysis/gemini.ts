// Gemini client for video presence. REST only. Two backends:
//   AI_BACKEND=vertex   → Vertex AI on GCP (default when GOOGLE_CLOUD_PROJECT is set)
//   AI_BACKEND=aistudio → Gemini API key (GEMINI_API_KEY)
// Retries 429/500/503 with backoff. Every call goes through a spend guard: cost is estimated
// from usageMetadata and logged, and calls are refused past the daily or total cap. Only
// Flash-tier models are allowed, to keep cost low.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Part {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  file_data?: { mime_type: string; file_uri: string };
  video_metadata?: { fps?: number };
}

export class BudgetError extends Error {}

// ---------- spend guard ----------

const SPEND_FILE = resolve(process.env.AI_SPEND_FILE ?? "data/ai-spend.json");
const DAILY_CAP = Number(process.env.AI_DAILY_BUDGET_USD ?? 0.5);
const TOTAL_CAP = Number(process.env.AI_TOTAL_BUDGET_USD ?? 3);
// Conservative per-million-token estimates for Flash-tier models. Real prices are usually lower.
const PRICE_IN = Number(process.env.AI_PRICE_IN_PER_M ?? 0.5);
const PRICE_OUT = Number(process.env.AI_PRICE_OUT_PER_M ?? 3.0);

interface SpendLog {
  totalUsd: number;
  days: Record<string, number>;
  calls: { at: string; label?: string; model: string; inTok: number; outTok: number; usd: number }[];
}

function readSpend(): SpendLog {
  try {
    return JSON.parse(readFileSync(SPEND_FILE, "utf8"));
  } catch {
    return { totalUsd: 0, days: {}, calls: [] };
  }
}

export function spendSummary() {
  const s = readSpend();
  const today = new Date().toISOString().slice(0, 10);
  return { todayUsd: s.days[today] ?? 0, totalUsd: s.totalUsd, dailyCapUsd: DAILY_CAP, totalCapUsd: TOTAL_CAP, calls: s.calls.length };
}

// Global call-rate limits, independent of the dollar caps. They hold even if the cost estimate is off.
const MAX_PER_HOUR = Number(process.env.AI_MAX_CALLS_PER_HOUR ?? 20);
const MAX_PER_DAY = Number(process.env.AI_MAX_CALLS_PER_DAY ?? 60);
const callTimes: number[] = [];

export function rateSummary() {
  const now = Date.now();
  return {
    lastHour: callTimes.filter((t) => now - t < 3600_000).length,
    lastDay: callTimes.filter((t) => now - t < 86_400_000).length,
    maxPerHour: MAX_PER_HOUR,
    maxPerDay: MAX_PER_DAY,
  };
}

function checkBudget() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] > 86_400_000) callTimes.shift();
  const r = rateSummary();
  if (r.lastHour >= MAX_PER_HOUR) throw new BudgetError(`AI is rate-limited (${MAX_PER_HOUR} calls/hour across all visitors). Cached results are still served.`);
  if (r.lastDay >= MAX_PER_DAY) throw new BudgetError(`AI daily call limit reached (${MAX_PER_DAY}/day). Cached results are still served.`);
  const s = spendSummary();
  if (s.todayUsd >= DAILY_CAP) throw new BudgetError(`AI daily budget reached ($${s.todayUsd.toFixed(3)} of $${DAILY_CAP}). Cached results are still served.`);
  if (s.totalUsd >= TOTAL_CAP) throw new BudgetError(`AI total budget reached ($${s.totalUsd.toFixed(3)} of $${TOTAL_CAP}).`);
}

function recordSpend(model: string, usage: any, label?: string): number {
  const inTok = usage?.promptTokenCount ?? 0;
  const outTok = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  const usd = (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6;
  const s = readSpend();
  const today = new Date().toISOString().slice(0, 10);
  s.totalUsd += usd;
  s.days[today] = (s.days[today] ?? 0) + usd;
  s.calls.push({ at: new Date().toISOString(), label, model, inTok, outTok, usd: +usd.toFixed(5) });
  if (!existsSync(dirname(SPEND_FILE))) mkdirSync(dirname(SPEND_FILE), { recursive: true });
  writeFileSync(SPEND_FILE, JSON.stringify(s, null, 2));
  return usd;
}

// ---------- backends ----------

function backend(): "vertex" | "aistudio" {
  const b = process.env.AI_BACKEND ?? (process.env.GOOGLE_CLOUD_PROJECT ? "vertex" : "aistudio");
  return b === "vertex" ? "vertex" : "aistudio";
}

let vertexToken: { token: string; exp: number } | null = null;

async function vertexAuth(): Promise<string> {
  if (vertexToken && vertexToken.exp > Date.now() + 60_000) return vertexToken.token;
  let token: string;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    token = (await (await auth.getClient()).getAccessToken()).token!;
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // e.g. a Render secret file at /etc/secrets/vertex-sa.json
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    token = (await (await auth.getClient()).getAccessToken()).token!;
  } else {
    // Local development: the developer's own gcloud login.
    token = execFileSync("gcloud", ["auth", "print-access-token"], { shell: process.platform === "win32" }).toString().trim();
  }
  vertexToken = { token, exp: Date.now() + 45 * 60_000 };
  return token;
}

async function endpoint(model: string): Promise<{ url: string; headers: Record<string, string> }> {
  if (backend() === "vertex") {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const loc = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
    if (!project) throw new Error("GOOGLE_CLOUD_PROJECT not set");
    const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
    return {
      url: `https://${host}/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`,
      headers: { Authorization: `Bearer ${await vertexAuth()}`, "Content-Type": "application/json" },
    };
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
  };
}

// ---------- generate ----------

export async function generateJson<T>(args: {
  parts: Part[];
  schema: unknown;
  system?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  label?: string;
  /** LOW cuts video tokens about 4×. Fine when only the audio matters. */
  mediaResolution?: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM";
}): Promise<{ data: T; model: string; ms: number; attempts: number; usage?: any; usd: number }> {
  const model = args.model ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  if (!/flash/i.test(model)) throw new BudgetError(`Model ${model} is not Flash-tier; only cheap models are allowed.`);
  checkBudget();
  callTimes.push(Date.now()); // counts attempts, not just successes
  const body = JSON.stringify({
    system_instruction: args.system ? { parts: [{ text: args.system }] } : undefined,
    contents: [{ role: "user", parts: args.parts }],
    generation_config: {
      temperature: args.temperature ?? 0,
      response_mime_type: "application/json",
      response_schema: args.schema,
      ...(args.mediaResolution ? { media_resolution: args.mediaResolution } : {}),
    },
  });
  const t0 = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), args.timeoutMs ?? 180_000);
    try {
      const { url, headers } = await endpoint(model);
      const res = await fetch(url, { method: "POST", headers, body, signal: ctl.signal });
      const json: any = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini ${res.status}: ${json?.error?.message ?? ""}`.slice(0, 200));
        if (/per day|exceeded your current quota/i.test(json?.error?.message ?? "")) throw lastErr; // daily quota: retrying won't help
        const wait = Math.min(30_000, 1500 * 2 ** (attempt - 1)) + Math.random() * 500;
        console.warn(`[gemini${args.label ? ":" + args.label : ""}] ${res.status}, retry ${attempt} in ${Math.round(wait)}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
      const usd = recordSpend(model, json.usageMetadata, args.label);
      const text: string | undefined = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("");
      if (!text) throw new Error(`Gemini returned no text (finishReason ${json.candidates?.[0]?.finishReason})`);
      return { data: JSON.parse(text) as T, model, ms: Date.now() - t0, attempts: attempt, usage: json.usageMetadata, usd };
    } catch (e: any) {
      lastErr = e;
      if (e?.name === "AbortError") {
        console.warn(`[gemini${args.label ? ":" + args.label : ""}] timeout, retry ${attempt}`);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Inline video (≤ 14 MB). Larger uploads are rejected to keep cost and latency bounded. */
export async function videoPart(bytes: Buffer, mime = "video/mp4", fps = 2): Promise<Part> {
  if (bytes.length > 14 * 1024 * 1024) throw new Error("Video too large for analysis (max 14 MB). Trim or compress it first.");
  return { inline_data: { mime_type: mime, data: bytes.toString("base64") }, video_metadata: { fps } };
}
