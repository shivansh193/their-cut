import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { store, verifyLedger, type Workspace, type Deal } from "./store.js";
import {
  createWorkspace, newDeal, runAgent, simulateBrandPayment, refreshInvoice, refreshPayout, approve,
  adjustPresence, reexplain, pendingApprovals, tracker, startPoller, onInvoicePaid, evaluateDeal, retry,
} from "./agent.js";
import { evaluate } from "./rules/engine.js";
import { STATE_RULES, DISCLAIMER, type StateCode } from "./rules/states.js";
import { demoVideos, videoPath, referencePath, truthFor } from "./fixtures.js";
import { spendSummary, BudgetError } from "./analysis/gemini.js";
import * as paypal from "./paypal.js";

const app = express();
const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web", "dist");

// Raw body for the webhook (signature verification needs the exact bytes), JSON elsewhere.
app.use("/api/webhooks/paypal", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "256kb" }));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

function ws(req: Request): Workspace {
  const w = store.get(String(req.params.ws));
  if (!w) throw Object.assign(new Error("Workspace not found. Start a new demo."), { status: 404 });
  return w;
}
function deal(w: Workspace, req: Request): Deal {
  const d = w.deals.find((x) => x.id === req.params.id);
  if (!d) throw Object.assign(new Error("Deal not found"), { status: 404 });
  return d;
}
const isState = (s: unknown): s is StateCode => s === "IL" || s === "CA" || s === "UT";

function dealView(w: Workspace, d: Deal) {
  return { ...d, pendingApprovals: pendingApprovals(d) };
}
function wsView(w: Workspace) {
  return {
    id: w.id,
    createdAt: w.createdAt,
    family: w.family,
    children: w.children.map((c) => ({ ...c, trustEmail: c.trustEmail ? c.trustEmail.replace(/^(.{6}).*(@.*)$/, "$1…$2") : "" })),
    deals: w.deals
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({
        id: d.id, date: d.date, brand: d.brand, amountCents: d.amountCents, videoId: d.videoId, videoTitle: d.videoTitle, status: d.status, seeded: d.seeded, state: d.state,
        presencePct: Object.fromEntries((d.analysis?.children ?? []).map((c) => [c.childId, c.presencePct])),
        owedCents: Object.fromEntries((d.evaluation?.children ?? []).map((c) => [c.childId, c.owedCents])),
        setAsideCents: d.setAsideCents,
        pending: pendingApprovals(d).length,
      })),
    tracker: tracker(w),
    ledger: { entries: w.ledger.length, ...verifyLedger(w) },
  };
}

// ---------------- config ----------------

app.get("/api/config", (_req, res) => {
  res.json({
    bryntumLicenseKey: process.env.BRYNTUM_LICENSE_KEY ?? "",
    paypalEnv: "sandbox",
    disclaimer: DISCLAIMER,
    rules: STATE_RULES,
    videos: demoVideos(),
    spend: spendSummary(),
    aiBackend: process.env.AI_BACKEND ?? "vertex",
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  });
});

// ---------------- workspaces ----------------

const createLimiter = new Map<string, number[]>();
app.post("/api/ws", wrap((req, res) => {
  const ip = String(req.headers["x-forwarded-for"] ?? req.ip).split(",")[0];
  const now = Date.now();
  const hits = (createLimiter.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (hits.length >= 20) throw Object.assign(new Error("Too many demo workspaces from this address; try again later."), { status: 429 });
  createLimiter.set(ip, [...hits, now]);
  // keep the store small on a free instance
  const all = store.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const old of all.slice(0, Math.max(0, all.length - 300))) store.remove(old.id);
  const w = createWorkspace(isState(req.body?.state) ? req.body.state : "IL");
  res.status(201).json(wsView(w));
}));

app.get("/api/ws/:ws", wrap((req, res) => res.json(wsView(ws(req)))));

app.patch("/api/ws/:ws/family", wrap((req, res) => {
  const w = ws(req);
  if (!isState(req.body?.state)) throw Object.assign(new Error("state must be IL, CA or UT"), { status: 400 });
  w.family.state = req.body.state;
  store.put(w);
  res.json(wsView(w));
}));

app.get("/api/ws/:ws/ledger", wrap((req, res) => {
  const w = ws(req);
  res.json({ verify: verifyLedger(w), entries: w.ledger });
}));

app.get("/api/ws/:ws/children/:cid/ledger", wrap((req, res) => {
  const w = ws(req);
  const c = w.children.find((x) => x.id === req.params.cid);
  if (!c) throw Object.assign(new Error("Child not found"), { status: 404 });
  const rows = w.deals
    .filter((d) => d.evaluation)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const ev = d.evaluation!.children.find((x) => x.childId === c.id);
      const items = (d.payout?.items ?? []).filter((i) => i.childId === c.id);
      return {
        dealId: d.id,
        date: d.date,
        video: d.videoTitle,
        brand: d.brand,
        state: d.state,
        presencePct: d.analysis?.children.find((x) => x.childId === c.id)?.presencePct ?? 0,
        adjusted: d.adjustments.some((a) => a.childId === c.id),
        windowPresencePct: (ev?.windowPresence ?? 0) * 100,
        eligible: ev?.eligible ?? false,
        grossCents: d.amountCents,
        owedCents: ev?.owedCents ?? 0,
        setAsideCents: d.setAsideCents[c.id] ?? 0,
        status: d.status,
        seeded: !!d.seeded,
        invoiceId: d.invoice?.id,
        payoutBatchId: d.payout?.batchId,
        transactionIds: items.map((i) => i.transactionId).filter(Boolean),
        payoutStatus: items.map((i) => i.status).filter(Boolean).join(", "),
        evidence: (d.analysis?.children.find((x) => x.childId === c.id)?.narration ?? []).slice(0, 2).map((n) => n.evidence),
      };
    });
  res.json({ child: { id: c.id, name: c.name, birthDate: c.birthDate, trustLabel: c.trustLabel }, rows, totalSetAsideCents: rows.reduce((s, r) => s + r.setAsideCents, 0) });
}));

// ---------------- deals ----------------

app.post("/api/ws/:ws/deals", wrap(async (req, res) => {
  const w = ws(req);
  if (w.deals.filter((d) => !d.seeded).length >= 12) throw Object.assign(new Error("This demo workspace has enough deals; start a new demo."), { status: 429 });
  const d = newDeal(w, {
    videoId: String(req.body?.videoId),
    brand: String(req.body?.brand ?? "Brand"),
    amountCents: Math.round(Number(req.body?.amountCents)),
    state: isState(req.body?.state) ? req.body.state : undefined,
  });
  store.put(w);
  res.status(201).json(dealView(w, d));
  void runAgent(w, d); // the agent keeps working; the page polls
}));

app.get("/api/ws/:ws/deals/:id", wrap((req, res) => {
  const w = ws(req);
  res.json(dealView(w, deal(w, req)));
}));

app.get("/api/ws/:ws/deals/:id/compare", wrap((req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  if (!d.presence) return res.json({});
  const out: Record<string, unknown> = {};
  for (const s of ["IL", "CA", "UT"] as StateCode[]) {
    const saved = d.state;
    d.state = s;
    const ev = evaluateDeal(w, { ...d, approvals: [] } as Deal);
    d.state = saved;
    out[s] = { totalOwedCents: ev.totalOwedCents, children: ev.children.map((c) => ({ childId: c.childId, owedCents: c.owedCents, eligible: c.eligible })), flags: ev.flags.map((f) => f.kind) };
  }
  evaluateDeal(w, d); // restore
  res.json(out);
}));

// Per-visitor limits on anything that calls the AI (the global caps live in analysis/gemini.ts).
const hits = new Map<string, number[]>();
function limit(req: Request, bucket: string, max: number, windowMs: number, what: string) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.ip).split(",")[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const xs = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (xs.length >= max) throw Object.assign(new Error(`${what} is limited to ${max} per ${windowMs >= 86_400_000 ? "day" : "hour"} per visitor, to keep AI costs down. Cached results are still shown.`), { status: 429 });
  xs.push(now);
  hits.set(key, xs);
}

app.post("/api/ws/:ws/deals/:id/analyse", wrap(async (req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  if (d.invoice?.paidAt) throw Object.assign(new Error("This deal is already paid; its measurement is locked."), { status: 409 });
  limit(req, "live", Number(process.env.AI_LIVE_RUNS_PER_IP_PER_DAY ?? 2), 86_400_000, "Re-running the AI analysis");
  try {
    d.analysis = undefined;
    await runAgent(w, d, { live: true });
  } catch (e) {
    if (e instanceof BudgetError) throw Object.assign(e, { status: 429 });
    throw e;
  }
  res.json(dealView(w, d));
}));

app.post("/api/ws/:ws/deals/:id/simulate-payment", wrap(async (req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  await simulateBrandPayment(w, d);
  res.json(dealView(w, d));
}));

app.post("/api/ws/:ws/deals/:id/refresh", wrap(async (req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  if (d.status === "invoiced") await refreshInvoice(w, d);
  if (d.status === "paying") await refreshPayout(w, d);
  if (d.status === "error") await retry(w, d);
  else if (d.status === "analysed" && !d.invoice) await runAgent(w, d);
  res.json(dealView(w, d));
}));

app.post("/api/ws/:ws/deals/:id/approve", wrap(async (req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  const items = Array.isArray(req.body?.items) ? req.body.items : pendingApprovals(d).map((f) => ({ kind: f.kind, childId: f.childId }));
  await approve(w, d, items, req.body?.note);
  res.json(dealView(w, d));
}));

app.patch("/api/ws/:ws/deals/:id/presence", wrap(async (req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  if (d.invoice?.paidAt) throw Object.assign(new Error("Already paid: the measurement is locked."), { status: 409 });
  adjustPresence(w, d, String(req.body?.childId), Array.isArray(req.body?.intervals) ? req.body.intervals : [], String(req.body?.reason ?? ""));
  res.json(dealView(w, d));
}));

app.post("/api/ws/:ws/deals/:id/explain", wrap(async (req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  limit(req, "explain", 10, 3600_000, "Asking the AI for a new explanation");
  await reexplain(w, d);
  res.json(dealView(w, d));
}));

app.get("/api/ws/:ws/deals/:id/record", wrap((req, res) => {
  const w = ws(req);
  const d = deal(w, req);
  res.setHeader("Content-Disposition", `attachment; filename="their-cut-${d.id}.json"`);
  res.json({
    about: "Their Cut deal record: the records Illinois SB 1782 and Cal. Fam. Code § 6652 require, plus the hash-chained audit trail.",
    disclaimer: DISCLAIMER,
    family: w.family,
    deal: d,
    ledger: w.ledger.filter((e) => e.dealId === d.id),
    ledgerVerification: verifyLedger(w),
  });
}));

app.get("/api/videos/:id/truth", wrap((req, res) => res.json(truthFor(String(req.params.id)))));
app.get("/api/spend", (_req, res) => res.json(spendSummary()));

app.get("/api/eval", wrap(async (_req, res) => {
  const { iou, lineLevel } = await import("./eval/metrics.js");
  const { cachedAnalysis } = await import("./fixtures.js");
  let errSum = 0, iouSum = 0, pairs = 0, videos = 0, model = "";
  const nl = { tp: 0, fp: 0, fn: 0 };
  for (const v of demoVideos()) {
    const a = cachedAnalysis(v.id);
    if (!a) continue;
    videos++;
    model = a.model;
    const t = truthFor(v.id);
    for (const c of a.children) {
      const tc = t.children[c.childId];
      errSum += Math.abs(c.presencePct - tc.presencePct);
      iouSum += iou(c.presence, tc.presence);
      pairs++;
    }
    const l = lineLevel(
      a.transcript.map((x: any) => ({ start: x.start, end: x.end, subjects: x.subjects.filter((s: any) => s.confidence >= 0.5).map((s: any) => s.childId) })),
      t.narration,
    );
    nl.tp += l.tp; nl.fp += l.fp; nl.fn += l.fn;
  }
  res.json({
    videos, pairs, model,
    maePts: pairs ? errSum / pairs : 0,
    meanIou: pairs ? iouSum / pairs : 0,
    narration: { precision: nl.tp / Math.max(1, nl.tp + nl.fp), recall: nl.tp / Math.max(1, nl.tp + nl.fn) },
  });
}));

// ---------------- PayPal webhook ----------------

app.post("/api/webhooks/paypal", wrap(async (req, res) => {
  const raw = (req.body as Buffer).toString("utf8");
  let ok = false;
  try {
    ok = await paypal.verifyWebhookSignature(req.headers as any, raw);
  } catch (e) {
    console.warn("[webhook] verification error:", (e as Error).message);
  }
  if (!ok) return res.status(400).json({ error: "signature verification failed" });
  const ev = JSON.parse(raw);
  const type: string = ev.event_type;
  console.log(`[webhook] ${type} ${ev.id}`);
  if (type.startsWith("INVOICING.INVOICE.")) {
    const invId = ev.resource?.invoice?.id ?? ev.resource?.id;
    const wsId = invId && store.workspaceForInvoice(invId);
    const w = wsId && store.get(wsId);
    const d = w ? w.deals.find((x: Deal) => x.invoice?.id === invId) : undefined;
    if (w && d) {
      d.log.push({ at: new Date().toISOString(), step: "webhook", message: `Verified PayPal webhook ${type}.` });
      if (type === "INVOICING.INVOICE.PAID") {
        d.invoice!.status = "PAID";
        await onInvoicePaid(w, d, d.invoice?.paidVia ?? "paypal");
      }
      store.put(w);
    }
  } else if (type.startsWith("PAYMENT.PAYOUTS")) {
    const batchId = ev.resource?.batch_header?.payout_batch_id ?? ev.resource?.payout_batch_id;
    const wsId = batchId && store.workspaceForPayout(batchId);
    const w = wsId && store.get(wsId);
    const d = w ? w.deals.find((x: Deal) => x.payout?.batchId === batchId) : undefined;
    if (w && d) {
      d.log.push({ at: new Date().toISOString(), step: "webhook", message: `Verified PayPal webhook ${type}.` });
      await refreshPayout(w, d);
    }
  }
  res.json({ ok: true }); // events for other apps' invoices are acknowledged and ignored
}));

// ---------------- media + web ----------------

app.get("/media/videos/:id.mp4", (req, res, next) => {
  const id = String(req.params.id);
  if (!demoVideos().some((v) => v.id === id)) return next();
  res.sendFile(videoPath(id), { maxAge: "1d" });
});
app.get("/media/references/:id.jpg", (req, res, next) => {
  const p = referencePath(String(req.params.id).replace(/[^a-z]/g, ""));
  if (!existsSync(p)) return next();
  res.sendFile(p, { maxAge: "1d" });
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));

if (existsSync(WEB)) {
  app.use(express.static(WEB, { maxAge: "1h", index: false }));
  app.use((req, res, next) => (req.method === "GET" && !req.path.startsWith("/api/") ? res.sendFile(join(WEB, "index.html"), { headers: { "Cache-Control": "no-cache" } }) : next()));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? (err instanceof paypal.PayPalError ? 502 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? "Something went wrong", debugId: err.debugId });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Their Cut on http://localhost:${port} (PayPal sandbox, AI ${process.env.AI_BACKEND ?? "vertex"})`);
  startPoller();
});
