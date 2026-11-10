// Gemini client for video presence. REST only, no SDK. Retries 429/500/503 with backoff,
// because the key is shared and sometimes returns 503 "high demand".

const API = "https://generativelanguage.googleapis.com/v1beta";

export interface Part {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  file_data?: { mime_type: string; file_uri: string };
  video_metadata?: { fps?: number };
}

export async function generateJson<T>(args: {
  parts: Part[];
  schema: unknown;
  system?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  label?: string;
}): Promise<{ data: T; model: string; ms: number; attempts: number; usage?: unknown }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = args.model ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const body = JSON.stringify({
    system_instruction: args.system ? { parts: [{ text: args.system }] } : undefined,
    contents: [{ role: "user", parts: args.parts }],
    generation_config: {
      temperature: args.temperature ?? 0,
      response_mime_type: "application/json",
      response_schema: args.schema,
    },
  });
  const t0 = Date.now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), args.timeoutMs ?? 180_000);
    try {
      const res = await fetch(`${API}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
        signal: ctl.signal,
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini ${res.status}: ${json?.error?.message ?? ""}`.slice(0, 200));
        const wait = Math.min(30_000, 1500 * 2 ** (attempt - 1)) + Math.random() * 500;
        console.warn(`[gemini${args.label ? ":" + args.label : ""}] ${res.status}, retry ${attempt} in ${Math.round(wait)}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
      const text: string | undefined = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("");
      if (!text) throw new Error(`Gemini returned no text (finishReason ${json.candidates?.[0]?.finishReason})`);
      return { data: JSON.parse(text) as T, model, ms: Date.now() - t0, attempts: attempt, usage: json.usageMetadata };
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

/** Inline for small files; the Files API for anything over ~14 MB. */
export async function videoPart(bytes: Buffer, mime = "video/mp4", fps = 2): Promise<Part> {
  if (bytes.length <= 14 * 1024 * 1024) {
    return { inline_data: { mime_type: mime, data: bytes.toString("base64") }, video_metadata: { fps } };
  }
  const uri = await uploadFile(bytes, mime);
  return { file_data: { mime_type: mime, file_uri: uri }, video_metadata: { fps } };
}

async function uploadFile(bytes: Buffer, mime: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY!;
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: `their-cut-${Date.now()}` } }),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!url) throw new Error(`Gemini upload start failed: ${start.status}`);
  const up = await fetch(url, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(bytes.length) },
    body: new Uint8Array(bytes),
  });
  const f: any = (await up.json()).file;
  for (let i = 0; i < 60 && f.state !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s: any = await (await fetch(`${API}/${f.name}`, { headers: { "x-goog-api-key": key } })).json();
    f.state = s.state;
    if (s.state === "FAILED") throw new Error("Gemini file processing failed");
  }
  return f.uri;
}
