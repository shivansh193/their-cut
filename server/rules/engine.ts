// Deterministic rule engine: from measured presence, gross pay and a creator's
// history, work out which children qualify and how many cents each is owed.
// The LLM only explains these results. It never produces a number.

import { STATE_RULES, type StateCode, type StateRule } from "./states.js";

export interface Interval {
  start: number; // seconds
  end: number; // seconds, end > start
}

export interface Child {
  id: string;
  name: string;
  birthDate: string; // YYYY-MM-DD
}

export interface DealPresence {
  childId: string;
  /** Time on screen and narration time, merged before or inside the engine. Seconds. */
  intervals: Interval[];
}

export interface Deal {
  id: string;
  date: string; // YYYY-MM-DD, the date the content was published / compensated
  grossCents: number;
  durationSec: number;
  presence: DealPresence[];
  /** Already set aside per child (cents). Present on history deals. */
  setAsideCents?: Record<string, number>;
}

export interface ChildResult {
  childId: string;
  name: string;
  ageAtDeal: number;
  coveredByAge: boolean;
  presenceInDeal: number; // fraction 0..1
  windowPresence: number; // fraction 0..1, includes this deal
  windowPresenceBefore: number; // fraction 0..1, history only
  meetsPresenceThreshold: boolean;
  eligible: boolean;
  owedCents: number;
  reasons: string[];
}

export type FlagKind =
  | "threshold-crossed"
  | "near-threshold"
  | "earnings-floor-crossed"
  | "below-earnings-floor"
  | "unverified-rule"
  | "catch-up-owed";

export interface Flag {
  kind: FlagKind;
  childId?: string;
  message: string;
  /** For catch-up: extra cents owed on earlier deals in the window. */
  amountCents?: number;
  dealIds?: string[];
  needsApproval: boolean;
}

export interface Evaluation {
  state: StateCode;
  rule: StateRule;
  dealId: string;
  grossCents: number;
  windowLabel: string;
  creatorEarningsInWindowCents: number;
  meetsEarningsFloor: boolean;
  qualifyingChildIds: string[];
  combinedPresence: number; // union presence of qualifying children in this deal
  children: ChildResult[];
  totalOwedCents: number;
  flags: Flag[];
  formulaApplied: string;
}

// ---------- interval math ----------

export function mergeIntervals(intervals: Interval[], clampTo?: number): Interval[] {
  const xs = intervals
    .map((i) => ({
      start: Math.max(0, i.start),
      end: clampTo === undefined ? i.end : Math.min(clampTo, i.end),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of xs) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function measure(intervals: Interval[]): number {
  return intervals.reduce((s, i) => s + (i.end - i.start), 0);
}

function childSeconds(deal: Deal, childId: string): number {
  const p = deal.presence.find((x) => x.childId === childId);
  return p ? measure(mergeIntervals(p.intervals, deal.durationSec)) : 0;
}

// ---------- dates ----------

function parseDay(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}

export function ageOn(birthDate: string, on: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

function inWindow(rule: StateRule, dealDate: string, otherDate: string): boolean {
  const t = parseDay(dealDate);
  const o = parseDay(otherDate);
  if (o > t) return false;
  switch (rule.window.kind) {
    case "rolling-days":
      return t - o < rule.window.days * 86_400_000;
    case "calendar-month":
      return dealDate.slice(0, 7) === otherDate.slice(0, 7);
    case "calendar-year":
      return dealDate.slice(0, 4) === otherDate.slice(0, 4);
  }
}

function windowLabel(rule: StateRule, dealDate: string): string {
  switch (rule.window.kind) {
    case "rolling-days":
      return `${rule.window.days} days ending ${dealDate}`;
    case "calendar-month":
      return `calendar month ${dealDate.slice(0, 7)}`;
    case "calendar-year":
      return `calendar year ${dealDate.slice(0, 4)}`;
  }
}

// ---------- money ----------

const BP = 10_000n; // basis points

function rateBp(rate: number): bigint {
  return BigInt(Math.round(rate * 10_000));
}

/** ceil(gross * num / den * rate / k), in exact integer math. Rounds in the child's favour. */
function shareCents(grossCents: number, num: number, den: number, rate: number, k: number): number {
  if (den <= 0 || k <= 0 || num <= 0) return 0;
  // Work in milliseconds so fractional-second intervals stay exact enough.
  const n = BigInt(Math.round(num * 1000));
  const d = BigInt(Math.round(den * 1000));
  const top = BigInt(grossCents) * n * rateBp(rate);
  const bottom = d * BP * BigInt(k);
  return Number((top + bottom - 1n) / bottom);
}

export function amountsFor(
  rule: StateRule,
  deal: Deal,
  qualifying: string[],
): { perChild: Record<string, number>; combined: number } {
  const present = qualifying.filter((id) => childSeconds(deal, id) > 0);
  const k = present.length;
  const perChild: Record<string, number> = {};
  if (k === 0) return { perChild, combined: 0 };
  const union = mergeIntervals(
    present.flatMap((id) => deal.presence.find((p) => p.childId === id)!.intervals),
    deal.durationSec,
  );
  const unionSec = measure(union);
  const combined = unionSec / deal.durationSec;
  for (const id of present) {
    if (rule.formula.kind === "presence-times-rate") {
      if (rule.multiMinorEqualSplit) {
        perChild[id] = shareCents(deal.grossCents, unionSec, deal.durationSec, rule.formula.rate, k);
      } else {
        perChild[id] = shareCents(deal.grossCents, childSeconds(deal, id), deal.durationSec, rule.formula.rate, 1);
      }
    } else {
      perChild[id] = shareCents(deal.grossCents, 1, 1, rule.formula.rate, k);
    }
  }
  return { perChild, combined };
}

// ---------- main ----------

export function evaluate(args: {
  state: StateCode;
  children: Child[];
  deal: Deal;
  history: Deal[];
}): Evaluation {
  const rule = STATE_RULES[args.state];
  const { deal } = args;
  const windowHistory = args.history.filter((h) => h.id !== deal.id && inWindow(rule, deal.date, h.date));
  const windowDeals = [...windowHistory, deal];
  const flags: Flag[] = [];

  const earningsBefore = windowHistory.reduce((s, d) => s + d.grossCents, 0);
  const earnings = earningsBefore + deal.grossCents;
  const meetsFloor =
    rule.creatorEarningsFloorCents === 0 ||
    (rule.state === "UT" ? earnings > rule.creatorEarningsFloorCents : earnings >= rule.creatorEarningsFloorCents);
  const metFloorBefore =
    rule.creatorEarningsFloorCents === 0 ||
    (rule.state === "UT"
      ? earningsBefore > rule.creatorEarningsFloorCents
      : earningsBefore >= rule.creatorEarningsFloorCents);

  if (rule.creatorEarningsFloorCents > 0) {
    if (meetsFloor && !metFloorBefore) {
      flags.push({
        kind: "earnings-floor-crossed",
        message: `This deal takes compensation in the ${windowLabel(rule, deal.date)} to ${fmt(earnings)}, past ${rule.name}'s ${fmt(rule.creatorEarningsFloorCents)} floor.`,
        needsApproval: true,
      });
    } else if (!meetsFloor) {
      flags.push({
        kind: "below-earnings-floor",
        message: `Compensation in the ${windowLabel(rule, deal.date)} is ${fmt(earnings)}, below ${rule.name}'s ${fmt(rule.creatorEarningsFloorCents)} floor. No set-aside is required yet; we still log the presence.`,
        needsApproval: false,
      });
    }
  }
  if (!rule.citations.some((c) => c.verified)) {
    flags.push({
      kind: "unverified-rule",
      message: `${rule.name}'s numbers come from secondary sources and have not been checked against the statute text. Confirm them before relying on them.`,
      needsApproval: true,
    });
  }

  const totalDur = windowDeals.reduce((s, d) => s + d.durationSec, 0);
  const histDur = windowHistory.reduce((s, d) => s + d.durationSec, 0);

  const children: ChildResult[] = args.children.map((c) => {
    const age = ageOn(c.birthDate, deal.date);
    const covered = age < rule.minorUnderAge;
    const inDeal = childSeconds(deal, c.id) / deal.durationSec;
    const winSec = windowDeals.reduce((s, d) => s + childSeconds(d, c.id), 0);
    const histSec = windowHistory.reduce((s, d) => s + childSeconds(d, c.id), 0);
    const windowPresence = totalDur ? winSec / totalDur : 0;
    const windowPresenceBefore = histDur ? histSec / histDur : 0;
    const meets = windowPresence >= rule.presenceThreshold;
    const reasons: string[] = [];
    reasons.push(covered ? `Age ${age}, under ${rule.minorUnderAge}: covered.` : `Age ${age}: not covered (${rule.name} covers under ${rule.minorUnderAge}).`);
    reasons.push(
      `In ${pct(windowPresence)} of compensated content over the ${windowLabel(rule, deal.date)} (threshold ${pct(rule.presenceThreshold)}).`,
    );
    if (rule.creatorEarningsFloorCents > 0)
      reasons.push(`Creator compensation in window ${fmt(earnings)} vs floor ${fmt(rule.creatorEarningsFloorCents)}.`);
    const eligible = covered && meets && meetsFloor;
    return {
      childId: c.id,
      name: c.name,
      ageAtDeal: age,
      coveredByAge: covered,
      presenceInDeal: inDeal,
      windowPresence,
      windowPresenceBefore,
      meetsPresenceThreshold: meets,
      eligible,
      owedCents: 0,
      reasons,
    };
  });

  const qualifying = children.filter((c) => c.eligible).map((c) => c.childId);
  const { perChild, combined } = amountsFor(rule, deal, qualifying);
  for (const c of children) c.owedCents = perChild[c.childId] ?? 0;

  for (const c of children) {
    if (!c.coveredByAge) continue;
    const crossed = c.eligible && c.windowPresenceBefore < rule.presenceThreshold && windowHistory.length > 0;
    if (crossed) {
      flags.push({
        kind: "threshold-crossed",
        childId: c.childId,
        message: `${c.name} crosses ${pct(rule.presenceThreshold)} with this video (${pct(c.windowPresenceBefore)} → ${pct(c.windowPresence)} over the ${windowLabel(rule, deal.date)}).`,
        needsApproval: true,
      });
    }
    if (!c.eligible && c.meetsPresenceThreshold === false && rule.presenceThreshold - c.windowPresence <= 0.05 && c.windowPresence > 0) {
      flags.push({
        kind: "near-threshold",
        childId: c.childId,
        message: `${c.name} is at ${pct(c.windowPresence)}, within 5 points of the ${pct(rule.presenceThreshold)} threshold. One more video like this could trigger a set-aside.`,
        needsApproval: false,
      });
    }
  }

  // Catch-up: once a child qualifies for the window, earlier deals in the same window
  // that featured them and set nothing aside may now be owed.
  if (qualifying.length) {
    const owedByChild: Record<string, { cents: number; deals: string[] }> = {};
    for (const h of windowHistory) {
      const { perChild: hp } = amountsFor(rule, h, qualifying);
      for (const [id, cents] of Object.entries(hp)) {
        const already = h.setAsideCents?.[id] ?? 0;
        const gap = cents - already;
        if (gap > 0) {
          owedByChild[id] ??= { cents: 0, deals: [] };
          owedByChild[id].cents += gap;
          owedByChild[id].deals.push(h.id);
        }
      }
    }
    for (const [id, v] of Object.entries(owedByChild)) {
      const name = children.find((c) => c.childId === id)?.name ?? id;
      flags.push({
        kind: "catch-up-owed",
        childId: id,
        amountCents: v.cents,
        dealIds: v.deals,
        message: `${name} now qualifies for the whole window, so ${v.deals.length} earlier deal(s) may owe ${fmt(v.cents)} more.`,
        needsApproval: true,
      });
    }
  }

  const totalOwed = Object.values(perChild).reduce((s, x) => s + x, 0);
  return {
    state: args.state,
    rule,
    dealId: deal.id,
    grossCents: deal.grossCents,
    windowLabel: windowLabel(rule, deal.date),
    creatorEarningsInWindowCents: earnings,
    meetsEarningsFloor: meetsFloor,
    qualifyingChildIds: qualifying,
    combinedPresence: combined,
    children,
    totalOwedCents: totalOwed,
    flags,
    formulaApplied: rule.formula.text,
  };
}

export function fmt(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
