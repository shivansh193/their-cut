export type StateCode = "IL" | "CA" | "UT";

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Request failed (${r.status})`), { status: r.status });
  return j as T;
}

const KEY = "their-cut.workspace";
export function getWsId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
export function setWsId(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: workspace lasts for this tab only */
  }
}

export async function ensureWorkspace(): Promise<any> {
  const id = getWsId();
  if (id) {
    try {
      return await api("GET", `/api/ws/${id}`);
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
  }
  const ws = await api("POST", "/api/ws", {});
  setWsId(ws.id);
  return ws;
}

export const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const pct = (x: number, d = 1) => `${x.toFixed(d)}%`;
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function navigate(hash: string) {
  window.location.hash = hash;
}
