// Tiny JSON store. One file, in memory, saved on change. On Render's free tier the disk is
// ephemeral, so workspaces reset on redeploy; the demo reseeds itself.
// The ledger is append-only and hash-chained for tamper evidence.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StateCode } from "./rules/states.js";
import type { Evaluation, Interval } from "./rules/engine.js";
import type { PresenceResult } from "./analysis/presence.js";

export interface Child {
  id: string;
  name: string;
  birthDate: string;
  color: string;
  trustEmail: string;
  trustLabel: string;
}

export interface Adjustment {
  at: string;
  childId: string;
  before: Interval[];
  after: Interval[];
  reason: string;
}

export interface PayoutItem {
  childId: string;
  amountCents: number;
  kind: "share" | "catch-up";
  forDealIds: string[];
  senderItemId: string;
  payoutItemId?: string;
  transactionId?: string;
  status?: string;
}

export type DealStatus =
  | "draft"
  | "analysing"
  | "analysed"
  | "invoiced"
  | "paid"
  | "paying"
  | "settled"
  | "nothing-owed"
  | "error";

export interface Deal {
  id: string;
  createdAt: string;
  date: string;
  brand: string;
  brandEmail: string;
  amountCents: number;
  videoId: string;
  videoTitle: string;
  durationSec: number;
  state: StateCode;
  status: DealStatus;
  seeded?: boolean;
  analysis?: PresenceResult & { source: "cached" | "live" };
  /** Presence after the parent's adjustments. This is what the rules use. */
  presence?: Record<string, Interval[]>;
  adjustments: Adjustment[];
  evaluation?: Evaluation;
  explanation?: { text: string; source: "ai" | "template"; at: string };
  approvals: { kind: string; childId?: string; at: string; note?: string }[];
  invoice?: { id: string; status: string; payerUrl?: string; paidVia?: "paypal" | "sandbox-api"; paidAt?: string };
  payout?: { senderBatchId: string; batchId?: string; status?: string; items: PayoutItem[] };
  setAsideCents: Record<string, number>;
  log: { at: string; step: string; message: string; level?: "info" | "warn" | "error" }[];
  error?: string;
}

export interface LedgerEntry {
  seq: number;
  at: string;
  dealId: string;
  type: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

export interface Workspace {
  id: string;
  createdAt: string;
  family: { name: string; state: StateCode; creatorEmail: string };
  children: Child[];
  deals: Deal[];
  ledger: LedgerEntry[];
  invoiceIndex: Record<string, string>; // invoiceId -> dealId
}

interface Db {
  workspaces: Record<string, Workspace>;
  invoiceToWorkspace: Record<string, string>;
  payoutToWorkspace: Record<string, string>;
}

const FILE = resolve(process.env.DATA_DIR ?? "data", "db.json");
let db: Db = load();

function load(): Db {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { workspaces: {}, invoiceToWorkspace: {}, payoutToWorkspace: {} };
  }
}

let saveTimer: NodeJS.Timeout | null = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE + ".tmp", JSON.stringify(db));
    renameSync(FILE + ".tmp", FILE);
  }, 200);
}

export const store = {
  get: (id: string) => db.workspaces[id],
  all: () => Object.values(db.workspaces),
  put(ws: Workspace) {
    db.workspaces[ws.id] = ws;
    save();
  },
  remove(id: string) {
    delete db.workspaces[id];
    save();
  },
  indexInvoice(invoiceId: string, wsId: string) {
    db.invoiceToWorkspace[invoiceId] = wsId;
    save();
  },
  workspaceForInvoice: (invoiceId: string) => db.invoiceToWorkspace[invoiceId],
  indexPayout(batchId: string, wsId: string) {
    db.payoutToWorkspace[batchId] = wsId;
    save();
  },
  workspaceForPayout: (batchId: string) => db.payoutToWorkspace[batchId],
};

export const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function canonical(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  return `{${Object.keys(x as object)
    .sort()
    .filter((k) => (x as any)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((x as any)[k])}`)
    .join(",")}}`;
}

export function hashEntry(e: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

export function appendLedger(ws: Workspace, dealId: string, type: string, data: unknown): LedgerEntry {
  const prev = ws.ledger[ws.ledger.length - 1];
  // deep copy: the entry must never change after it is hashed
  const base = { seq: ws.ledger.length, at: new Date().toISOString(), dealId, type, data: JSON.parse(JSON.stringify(data ?? null)), prevHash: prev?.hash ?? "0".repeat(64) };
  const entry = { ...base, hash: hashEntry(base) };
  ws.ledger.push(entry);
  save();
  return entry;
}

export function verifyLedger(ws: Workspace): { ok: boolean; brokenAt?: number } {
  let prev = "0".repeat(64);
  for (const e of ws.ledger) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || hashEntry(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}

export function log(deal: Deal, step: string, message: string, level: "info" | "warn" | "error" = "info") {
  deal.log.push({ at: new Date().toISOString(), step, message, level });
  save();
}
