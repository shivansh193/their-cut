// The deal agent. For each brand deal it:
//   1. measures each child's presence (cached for demo videos, or a live Gemini run),
//   2. applies the family's state rule (deterministic engine),
//   3. explains the result in plain English (AI, numbers checked),
//   4. drafts and sends the PayPal invoice to the brand,
//   5. once PayPal confirms payment, pays each child's share into their trust via Payouts,
// and stops for the parent's approval on anything unusual (flags).

import { readFileSync } from "node:fs";
import { evaluate, amountsFor, mergeIntervals, type Deal as EngineDeal } from "./rules/engine.js";
import { STATE_RULES, type StateCode } from "./rules/states.js";
import { analysePresence } from "./analysis/presence.js";
import { explain } from "./explain.js";
import * as paypal from "./paypal.js";
import { cachedAnalysis, demoChildren, demoVideos, referencePath, videoPath } from "./fixtures.js";
import { appendLedger, log, newId, store, type Deal, type PayoutItem, type Workspace } from "./store.js";

const COLORS: Record<string, string> = { mia: "#E07A5F", leo: "#3D7EA6", noah: "#5E9C76" };
const LARGE_PAYOUT_CENTS = 100_000;

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ---------------- workspace ----------------

export function createWorkspace(state: StateCode = "IL"): Workspace {
  const trust: Record<string, string | undefined> = {
    mia: process.env.PAYPAL_TRUST_EMAIL_MIA,
    leo: process.env.PAYPAL_TRUST_EMAIL_LEO,
    noah: process.env.PAYPAL_TRUST_EMAIL_NOAH,
  };
  const ws: Workspace = {
    id: newId("ws"),
    createdAt: new Date().toISOString(),
    family: { name: "The Carter family (demo)", state, creatorEmail: process.env.PAYPAL_CREATOR_EMAIL ?? "" },
    children: demoChildren().map((c) => ({
      id: c.id,
      name: c.name,
      birthDate: c.birthDate,
      color: COLORS[c.id] ?? "#888",
      trustEmail: trust[c.id] ?? "",
      trustLabel: `${c.name}'s trust (PayPal sandbox account)`,
    })),
    deals: [],
    ledger: [],
    invoiceIndex: {},
  };
  appendLedger(ws, "-", "workspace.created", { family: ws.family, children: ws.children.map((c) => ({ id: c.id, name: c.name, birthDate: c.birthDate })) });

  // Demo history: two earlier brand deals inside the 30-day window, set aside as the law requires.
  // Clearly labelled as seeded history; no PayPal money moved for these.
  const history: [string, string, number, number][] = [
    ["blender-review", "Brightblend", 60_000, -21],
    ["sunday-lunch", "Green Crate", 180_000, -9],
  ];
  for (const [videoId, brand, amount, offset] of history) {
    const d = newDeal(ws, { videoId, brand, amountCents: amount, date: day(offset) });
    d.seeded = true;
    loadCachedAnalysis(ws, d);
    evaluateDeal(ws, d);
    // seeded history: treat flags as resolved and the set-aside as already paid into trust
    for (const c of d.evaluation!.children) d.setAsideCents[c.childId] = c.owedCents;
    for (const f of d.evaluation!.flags.filter((f) => f.kind === "catch-up-owed" && f.childId)) applyCatchUp(ws, d, f.childId!, f.dealIds ?? []);
    d.status = "settled";
    d.invoice = { id: "(seeded)", status: "PAID", paidVia: undefined };
    log(d, "seed", "Demo history: pre-seeded deal. No PayPal money moved for this one.");
    appendLedger(ws, d.id, "deal.seeded", { setAsideCents: d.setAsideCents, totalOwedCents: d.evaluation!.totalOwedCents });
  }
  store.put(ws);
  return ws;
}

export function newDeal(ws: Workspace, input: { videoId: string; brand: string; amountCents: number; date?: string; state?: StateCode }): Deal {
  const v = demoVideos().find((x) => x.id === input.videoId);
  if (!v) throw new Error(`Unknown video ${input.videoId}`);
  if (!Number.isInteger(input.amountCents) || input.amountCents < 100 || input.amountCents > 5_000_000) throw new Error("Amount must be between $1 and $50,000");
  const d: Deal = {
    id: newId("deal"),
    createdAt: new Date().toISOString(),
    date: input.date ?? day(0),
    brand: input.brand.slice(0, 60),
    brandEmail: process.env.PAYPAL_BRAND_EMAIL ?? "",
    amountCents: input.amountCents,
    videoId: v.id,
    videoTitle: v.title,
    durationSec: v.durationSec,
    state: input.state ?? ws.family.state,
    status: "draft",
    adjustments: [],
    approvals: [],
    setAsideCents: {},
    log: [],
  };
  ws.deals.push(d);
  appendLedger(ws, d.id, "deal.created", { brand: d.brand, amountCents: d.amountCents, videoId: d.videoId, date: d.date, state: d.state });
  return d;
}

// ---------------- analysis ----------------

function loadCachedAnalysis(ws: Workspace, d: Deal) {
  const a = cachedAnalysis(d.videoId);
  if (!a) throw new Error("No cached analysis for this video");
  d.analysis = { ...a, source: "cached" };
  d.presence = Object.fromEntries(a.children.map((c: any) => [c.childId, c.presence]));
}

export async function analyse(ws: Workspace, d: Deal, opts: { live?: boolean } = {}) {
  d.status = "analysing";
  log(d, "analyse", opts.live ? "Running a fresh AI analysis (Gemini via Vertex AI)…" : "Loading the measured presence for this demo video.");
  store.put(ws);
  if (opts.live) {
    const res = await analysePresence({
      video: readFileSync(videoPath(d.videoId)),
      durationSec: d.durationSec,
      children: ws.children.map((c) => ({
        id: c.id,
        name: c.name,
        description: demoChildren().find((x) => x.id === c.id)?.description,
        images: [readFileSync(referencePath(c.id))],
      })),
    });
    d.analysis = { ...res, source: "live" };
    d.presence = Object.fromEntries(res.children.map((c) => [c.childId, c.presence]));
  } else {
    loadCachedAnalysis(ws, d);
  }
  d.adjustments = [];
  d.status = "analysed";
  const summary = Object.fromEntries(d.analysis!.children.map((c) => [c.childId, +c.presencePct.toFixed(2)]));
  log(d, "analyse", `Presence measured: ${d.analysis!.children.map((c) => `${c.name} ${c.presencePct.toFixed(1)}%`).join(", ")}.`);
  appendLedger(ws, d.id, "presence.measured", { source: d.analysis!.source, model: d.analysis!.model, presencePct: summary });
}

// ---------------- rules ----------------

function engineDeal(d: Deal): EngineDeal {
  return {
    id: d.id,
    date: d.date,
    grossCents: d.amountCents,
    durationSec: d.durationSec,
    presence: Object.entries(d.presence ?? {}).map(([childId, intervals]) => ({ childId, intervals })),
    setAsideCents: d.setAsideCents,
  };
}

/** Deals that count as compensated history: settled, seeded, or paid. */
function history(ws: Workspace, except: Deal) {
  return ws.deals.filter((x) => x.id !== except.id && x.presence && ["settled", "paid", "paying", "nothing-owed"].includes(x.status) && x.date <= except.date);
}

export function evaluateDeal(ws: Workspace, d: Deal) {
  const ev = evaluate({
    state: d.state,
    children: ws.children,
    deal: engineDeal(d),
    history: history(ws, d).map(engineDeal),
  });
  if (ev.totalOwedCents >= LARGE_PAYOUT_CENTS)
    ev.flags.push({ kind: "large-payout" as any, message: `Total to set aside is ${(ev.totalOwedCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}, over the $1,000 review threshold.`, needsApproval: true });
  d.evaluation = ev;
  return ev;
}

export function pendingApprovals(d: Deal) {
  return (d.evaluation?.flags ?? []).filter(
    (f) => f.needsApproval && !d.approvals.some((a) => a.kind === f.kind && (a.childId ?? null) === (f.childId ?? null)),
  );
}

// ---------------- the agent ----------------

const running = new Set<string>();

export async function runAgent(ws: Workspace, d: Deal, opts: { live?: boolean } = {}) {
  if (running.has(d.id)) return;
  running.add(d.id);
  try {
    if (!d.analysis || opts.live) await analyse(ws, d, opts);
    const ev = evaluateDeal(ws, d);
    log(d, "rules", `${ev.rule.name} rule: ${ev.qualifyingChildIds.length} child(ren) qualify; ${fmtUsd(ev.totalOwedCents)} to set aside.`);
    appendLedger(ws, d.id, "rules.applied", {
      state: ev.state,
      law: ev.rule.law,
      window: ev.windowLabel,
      owedCents: Object.fromEntries(ev.children.map((c) => [c.childId, c.owedCents])),
      flags: ev.flags.map((f) => f.kind),
    });
    store.put(ws);
    const ex = await explain(ev);
    d.explanation = { ...ex, at: new Date().toISOString() };
    log(d, "explain", ex.source === "ai" ? "Wrote a plain-English explanation (AI, amounts checked)." : "Wrote the explanation from the template.");
    const p = pendingApprovals(d);
    if (p.length) log(d, "flags", `${p.length} item(s) need your approval before money moves to the trusts: ${p.map((f) => f.kind).join(", ")}.`, "warn");
    store.put(ws);
    if (!d.invoice) await sendInvoice(ws, d);
  } catch (e) {
    d.status = "error";
    d.error = (e as Error).message;
    log(d, "error", d.error, "error");
  } finally {
    running.delete(d.id);
    store.put(ws);
  }
}

async function sendInvoice(ws: Workspace, d: Deal) {
  const inv = await paypal.createInvoice({
    requestId: `tc-${d.id}-inv`,
    invoicerEmail: ws.family.creatorEmail || undefined,
    recipientEmail: d.brandEmail,
    itemName: `Sponsored family video: ${d.videoTitle}`,
    itemDescription: `Their Cut deal ${d.id}. Child shares are set aside by law.`,
    amountCents: d.amountCents,
    reference: d.id,
    note: `Payment for sponsored content. ${STATE_RULES[d.state].name} law requires part of this to be held in trust for the children who appear.`,
  });
  const id: string = inv.id ?? String(inv.href).split("/").pop();
  await paypal.sendInvoice(id, `tc-${d.id}-send`);
  const got: any = await paypal.getInvoice(id);
  d.invoice = { id, status: got.status, payerUrl: got.detail?.metadata?.recipient_view_url };
  d.status = "invoiced";
  store.indexInvoice(id, ws.id);
  log(d, "invoice", `PayPal invoice ${id} sent to the brand (${got.status}).`);
  appendLedger(ws, d.id, "invoice.sent", { invoiceId: id, amountCents: d.amountCents, status: got.status });
}

/** Sandbox-only shortcut, clearly labelled in the UI: records the brand's payment through the Invoicing API. */
export async function simulateBrandPayment(ws: Workspace, d: Deal) {
  if (!d.invoice || d.invoice.status === "PAID") return;
  await paypal.recordInvoicePayment(d.invoice.id, d.amountCents, `tc-${d.id}-pay`);
  log(d, "invoice", "Recorded the brand's payment through the PayPal Invoicing API (sandbox simulation).");
  await refreshInvoice(ws, d, "sandbox-api");
}

export async function refreshInvoice(ws: Workspace, d: Deal, via: "paypal" | "sandbox-api" = "paypal") {
  if (!d.invoice || d.seeded) return;
  const got: any = await paypal.getInvoice(d.invoice.id);
  if (got.status === d.invoice.status) return;
  d.invoice.status = got.status;
  if (got.status === "PAID" || got.status === "MARKED_AS_PAID") await onInvoicePaid(ws, d, via);
  store.put(ws);
}

export async function onInvoicePaid(ws: Workspace, d: Deal, via: "paypal" | "sandbox-api") {
  if (d.invoice!.paidAt) return; // idempotent: webhook and poller may both call this
  d.invoice!.paidAt = new Date().toISOString();
  d.invoice!.paidVia ??= via;
  d.status = "paid";
  log(d, "paid", via === "paypal" ? "PayPal confirmed the brand's payment." : "Brand payment recorded (sandbox simulation).");
  appendLedger(ws, d.id, "invoice.paid", { invoiceId: d.invoice!.id, via });
  await maybePay(ws, d);
}

export async function approve(ws: Workspace, d: Deal, items: { kind: string; childId?: string }[], note?: string) {
  for (const it of items) {
    if (!pendingApprovals(d).some((f) => f.kind === it.kind && (f.childId ?? undefined) === (it.childId ?? undefined))) continue;
    d.approvals.push({ ...it, at: new Date().toISOString(), note });
    appendLedger(ws, d.id, "flag.approved", { ...it, note });
    log(d, "approve", `Parent approved: ${it.kind}${it.childId ? ` (${it.childId})` : ""}.`);
  }
  store.put(ws);
  await maybePay(ws, d);
}

async function maybePay(ws: Workspace, d: Deal) {
  if (d.status !== "paid") return;
  const p = pendingApprovals(d);
  if (p.length) {
    log(d, "flags", "Payment received. Waiting for your approval before paying the trusts.", "warn");
    return;
  }
  await firePayouts(ws, d);
}

async function firePayouts(ws: Workspace, d: Deal) {
  const ev = d.evaluation!;
  const items: PayoutItem[] = [];
  for (const c of ev.children.filter((c) => c.owedCents > 0))
    items.push({ childId: c.childId, amountCents: c.owedCents, kind: "share", forDealIds: [d.id], senderItemId: `${d.id}-${c.childId}` });
  for (const f of ev.flags.filter((f) => f.kind === "catch-up-owed" && f.childId && f.amountCents))
    items.push({ childId: f.childId!, amountCents: f.amountCents!, kind: "catch-up", forDealIds: f.dealIds ?? [], senderItemId: `${d.id}-${f.childId}-catchup` });

  if (!items.length) {
    d.status = "nothing-owed";
    log(d, "payout", "No child's share is owed for this video, so nothing goes to the trusts. Presence is still recorded.");
    appendLedger(ws, d.id, "payout.none", {});
    return;
  }
  const missing = items.filter((i) => !ws.children.find((c) => c.id === i.childId)?.trustEmail);
  if (missing.length) throw new Error(`No trust account set for: ${missing.map((m) => m.childId).join(", ")}`);

  const senderBatchId = `tc-${d.id}`; // deterministic: a retry can never pay twice
  d.payout = { senderBatchId, items };
  d.status = "paying";
  store.put(ws);
  const batch = await paypal.createPayout({
    senderBatchId,
    emailSubject: `Their Cut: trust deposit from ${d.brand}`,
    items: items.map((i) => {
      const child = ws.children.find((c) => c.id === i.childId)!;
      return {
        receiverEmail: child.trustEmail,
        amountCents: i.amountCents,
        senderItemId: i.senderItemId,
        note: `${child.name}'s ${i.kind === "share" ? "legal share" : "catch-up share"} for "${d.videoTitle}" (${STATE_RULES[d.state].name} law).`,
      };
    }),
  });
  d.payout.batchId = batch.batch_header?.payout_batch_id;
  d.payout.status = batch.batch_header?.batch_status;
  store.indexPayout(d.payout.batchId!, ws.id);
  log(d, "payout", `PayPal Payouts batch ${d.payout.batchId} created (${d.payout.status}) for ${items.length} trust deposit(s), ${fmtUsd(items.reduce((s, i) => s + i.amountCents, 0))}.`);
  appendLedger(ws, d.id, "payout.created", { senderBatchId, payoutBatchId: d.payout.batchId, items: items.map(({ childId, amountCents, kind }) => ({ childId, amountCents, kind })) });
}

export async function refreshPayout(ws: Workspace, d: Deal) {
  if (!d.payout?.batchId || d.status === "settled") return;
  const b = await paypal.getPayoutBatch(d.payout.batchId);
  d.payout.status = b.batch_header?.batch_status;
  for (const it of b.items ?? []) {
    const mine = d.payout.items.find((x) => x.senderItemId === it.payout_item?.sender_item_id);
    if (!mine) continue;
    const was = mine.status;
    mine.payoutItemId = it.payout_item_id;
    mine.transactionId = it.transaction_id ?? mine.transactionId;
    mine.status = it.transaction_status;
    if (was !== mine.status) {
      log(d, "payout", `${ws.children.find((c) => c.id === mine.childId)?.name}: ${mine.kind} ${fmtUsd(mine.amountCents)} → ${mine.status}${mine.transactionId ? ` (txn ${mine.transactionId})` : ""}.`);
      if (mine.status === "SUCCESS") {
        if (mine.kind === "share") d.setAsideCents[mine.childId] = (d.setAsideCents[mine.childId] ?? 0) + mine.amountCents;
        else applyCatchUp(ws, d, mine.childId, mine.forDealIds);
        appendLedger(ws, d.id, "payout.item.succeeded", { childId: mine.childId, amountCents: mine.amountCents, kind: mine.kind, payoutItemId: mine.payoutItemId, transactionId: mine.transactionId });
      }
    }
  }
  if (d.payout.items.every((i) => ["SUCCESS", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "UNCLAIMED"].includes(i.status ?? ""))) {
    d.status = "settled";
    log(d, "settled", d.payout.items.every((i) => i.status === "SUCCESS") ? "Every child's share is in their trust. Deal settled." : "Batch finished with some items not successful; see statuses.", d.payout.items.every((i) => i.status === "SUCCESS") ? "info" : "warn");
    appendLedger(ws, d.id, "deal.settled", { setAsideCents: d.setAsideCents });
  }
  store.put(ws);
}

/** A catch-up payment fills the gap on earlier deals in the window. Record it against them. */
function applyCatchUp(ws: Workspace, payer: Deal, childId: string, dealIds: string[]) {
  const ev = payer.evaluation!;
  for (const id of dealIds) {
    const h = ws.deals.find((x) => x.id === id);
    if (!h) continue;
    const { perChild } = amountsFor(STATE_RULES[payer.state], engineDeal(h), ev.qualifyingChildIds);
    const owed = perChild[childId] ?? 0;
    if (owed > (h.setAsideCents[childId] ?? 0)) h.setAsideCents[childId] = owed;
  }
}

// ---------------- parent adjustments ----------------

export function adjustPresence(ws: Workspace, d: Deal, childId: string, intervals: { start: number; end: number }[], reason: string) {
  if (["paying", "settled"].includes(d.status)) throw new Error("Payouts have already been made for this deal.");
  if (!ws.children.some((c) => c.id === childId)) throw new Error("Unknown child");
  const clean = mergeIntervals(intervals.map((i) => ({ start: +i.start, end: +i.end })), d.durationSec).map((i) => ({ start: +i.start.toFixed(2), end: +i.end.toFixed(2) }));
  const before = d.presence?.[childId] ?? [];
  d.presence = { ...(d.presence ?? {}), [childId]: clean };
  const adj = { at: new Date().toISOString(), childId, before, after: clean, reason: reason.slice(0, 200) || "Adjusted on the timeline" };
  d.adjustments.push(adj);
  appendLedger(ws, d.id, "presence.adjusted", adj);
  log(d, "adjust", `Parent adjusted ${ws.children.find((c) => c.id === childId)?.name}'s timeline: ${reason || "edited on the timeline"}.`);
  evaluateDeal(ws, d);
  d.explanation = undefined;
  store.put(ws);
}

export async function reexplain(ws: Workspace, d: Deal) {
  if (!d.evaluation) return;
  const ex = await explain(d.evaluation);
  d.explanation = { ...ex, at: new Date().toISOString() };
  store.put(ws);
}

// ---------------- 30-day tracker ----------------

export function tracker(ws: Workspace, state: StateCode = ws.family.state) {
  const rule = STATE_RULES[state];
  const probe: Deal = { ...ws.deals[0], id: "probe", date: day(0), amountCents: 1, presence: {}, durationSec: 1e-6, setAsideCents: {} } as Deal;
  const hist = history(ws, probe).map(engineDeal);
  const total = hist.reduce((s, d) => s + d.durationSec, 0);
  return ws.children.map((c) => {
    const secs = hist.reduce((s, d) => s + mergeIntervals(d.presence.find((p) => p.childId === c.id)?.intervals ?? [], d.durationSec).reduce((a, i) => a + i.end - i.start, 0), 0);
    const inWin = hist.filter((d) => (rule.window.kind === "rolling-days" ? Date.parse(day(0)) - Date.parse(d.date) < rule.window.days * 86_400_000 : rule.window.kind === "calendar-month" ? d.date.slice(0, 7) === day(0).slice(0, 7) : d.date.slice(0, 4) === day(0).slice(0, 4)));
    const winTotal = inWin.reduce((s, d) => s + d.durationSec, 0);
    const winSecs = inWin.reduce((s, d) => s + mergeIntervals(d.presence.find((p) => p.childId === c.id)?.intervals ?? [], d.durationSec).reduce((a, i) => a + i.end - i.start, 0), 0);
    const setAside = ws.deals.reduce((s, d) => s + (d.setAsideCents[c.id] ?? 0), 0);
    return {
      childId: c.id,
      name: c.name,
      windowPresence: winTotal ? winSecs / winTotal : 0,
      allTimePresence: total ? secs / total : 0,
      threshold: rule.presenceThreshold,
      windowDeals: inWin.length,
      setAsideCents: setAside,
    };
  });
}

// ---------------- background sync (fallback for webhooks) ----------------

export function startPoller(intervalMs = 12_000) {
  setInterval(async () => {
    for (const ws of store.all()) {
      for (const d of ws.deals) {
        try {
          if (d.status === "invoiced") await refreshInvoice(ws, d);
          else if (d.status === "paying") await refreshPayout(ws, d);
        } catch (e) {
          console.warn(`[poller] ${d.id}: ${(e as Error).message}`);
        }
      }
    }
  }, intervalMs).unref();
}

const fmtUsd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
