import { describe, expect, it } from "vitest";
import { evaluate, mergeIntervals, measure, ageOn, type Child, type Deal } from "../rules/engine.js";

const mia: Child = { id: "mia", name: "Mia", birthDate: "2017-04-02" };
const leo: Child = { id: "leo", name: "Leo", birthDate: "2019-09-15" };
const teen: Child = { id: "ava", name: "Ava", birthDate: "2009-01-01" }; // 17 in 2026

function deal(id: string, date: string, grossCents: number, presence: Record<string, [number, number][]>, durationSec = 100): Deal {
  return {
    id,
    date,
    grossCents,
    durationSec,
    presence: Object.entries(presence).map(([childId, iv]) => ({
      childId,
      intervals: iv.map(([start, end]) => ({ start, end })),
    })),
  };
}

describe("interval math", () => {
  it("merges overlaps and clamps", () => {
    const m = mergeIntervals([{ start: 5, end: 10 }, { start: 0, end: 6 }, { start: 90, end: 120 }], 100);
    expect(m).toEqual([{ start: 0, end: 10 }, { start: 90, end: 100 }]);
    expect(measure(m)).toBe(20);
  });
  it("computes age", () => {
    expect(ageOn("2017-04-02", "2026-04-01")).toBe(8);
    expect(ageOn("2017-04-02", "2026-04-02")).toBe(9);
  });
});

describe("Illinois", () => {
  it("100% presence → 50% of gross", () => {
    const r = evaluate({ state: "IL", children: [mia], deal: deal("d1", "2026-11-01", 100_000, { mia: [[0, 100]] }), history: [] });
    expect(r.children[0].eligible).toBe(true);
    expect(r.children[0].owedCents).toBe(50_000);
  });
  it("50% presence → 25% of gross", () => {
    const r = evaluate({ state: "IL", children: [mia], deal: deal("d1", "2026-11-01", 100_000, { mia: [[0, 50]] }), history: [] });
    expect(r.children[0].owedCents).toBe(25_000);
  });
  it("below 30% in window → nothing owed, near-threshold flag at 27%", () => {
    const r = evaluate({ state: "IL", children: [mia], deal: deal("d1", "2026-11-01", 100_000, { mia: [[0, 27]] }), history: [] });
    expect(r.children[0].eligible).toBe(false);
    expect(r.totalOwedCents).toBe(0);
    expect(r.flags.some((f) => f.kind === "near-threshold")).toBe(true);
  });
  it("two qualifying minors split the combined percentage equally", () => {
    // Mia 0-60, Leo 40-80 → union 0-80 = 80%; IL rate 0.5 → 40% total, 20% each
    const r = evaluate({
      state: "IL",
      children: [mia, leo],
      deal: deal("d1", "2026-11-01", 100_000, { mia: [[0, 60]], leo: [[40, 80]] }),
      history: [],
    });
    expect(r.combinedPresence).toBeCloseTo(0.8);
    expect(r.children.map((c) => c.owedCents)).toEqual([20_000, 20_000]);
  });
  it("16-year-olds are not covered in Illinois", () => {
    const r = evaluate({ state: "IL", children: [teen], deal: deal("d1", "2026-11-01", 100_000, { ava: [[0, 100]] }), history: [] });
    expect(r.children[0].coveredByAge).toBe(false);
    expect(r.totalOwedCents).toBe(0);
  });
  it("rolling 30-day window and catch-up when the threshold is crossed", () => {
    const h1 = { ...deal("h1", "2026-10-20", 50_000, { mia: [[0, 20]] }), setAsideCents: {} }; // 20%: not eligible alone
    const old = { ...deal("h0", "2026-09-01", 50_000, { mia: [[0, 0.5]] }), setAsideCents: {} }; // outside window
    const r = evaluate({ state: "IL", children: [mia], deal: deal("d1", "2026-11-01", 100_000, { mia: [[0, 50]] }), history: [h1, old] });
    // window = h1 + d1: (20 + 50) / 200 = 35%
    expect(r.children[0].windowPresence).toBeCloseTo(0.35);
    expect(r.children[0].eligible).toBe(true);
    expect(r.children[0].owedCents).toBe(25_000);
    expect(r.flags.find((f) => f.kind === "threshold-crossed")).toBeTruthy();
    const cu = r.flags.find((f) => f.kind === "catch-up-owed");
    expect(cu?.amountCents).toBe(5_000); // 20% * 0.5 * $500
    expect(cu?.dealIds).toEqual(["h1"]);
  });
  it("rounds in the child's favour", () => {
    const r = evaluate({ state: "IL", children: [mia], deal: deal("d1", "2026-11-01", 333, { mia: [[0, 33.3]] }), history: [] });
    // 333 * 0.333 * 0.5 = 55.4445 → 56
    expect(r.children[0].owedCents).toBe(56);
  });
});

describe("California", () => {
  it("0.65 × presence × gross when monthly compensation is at least $1,250", () => {
    const r = evaluate({ state: "CA", children: [mia], deal: deal("d1", "2026-11-05", 200_000, { mia: [[0, 40]] }), history: [] });
    expect(r.meetsEarningsFloor).toBe(true);
    expect(r.children[0].owedCents).toBe(52_000); // 0.4*0.65*2000
  });
  it("nothing owed under the $1,250 monthly floor", () => {
    const r = evaluate({ state: "CA", children: [mia], deal: deal("d1", "2026-11-05", 100_000, { mia: [[0, 40]] }), history: [] });
    expect(r.meetsEarningsFloor).toBe(false);
    expect(r.totalOwedCents).toBe(0);
  });
  it("calendar month window: earlier deals in the same month count toward the floor", () => {
    const h = { ...deal("h1", "2026-11-01", 100_000, { mia: [[0, 40]] }), setAsideCents: {} };
    const r = evaluate({ state: "CA", children: [mia], deal: deal("d1", "2026-11-20", 30_000, { mia: [[0, 40]] }), history: [h] });
    expect(r.meetsEarningsFloor).toBe(true);
    expect(r.flags.some((f) => f.kind === "earnings-floor-crossed")).toBe(true);
    expect(r.flags.find((f) => f.kind === "catch-up-owed")?.amountCents).toBe(26_000);
  });
  it("17-year-olds are covered in California", () => {
    const r = evaluate({ state: "CA", children: [teen], deal: deal("d1", "2026-11-05", 200_000, { ava: [[0, 100]] }), history: [] });
    expect(r.children[0].owedCents).toBe(130_000);
  });
});

describe("Utah (preview)", () => {
  it("is flagged as unverified and needs the $150k annual floor", () => {
    const r = evaluate({ state: "UT", children: [mia], deal: deal("d1", "2026-11-05", 200_000, { mia: [[0, 40]] }), history: [] });
    expect(r.flags.some((f) => f.kind === "unverified-rule")).toBe(true);
    expect(r.totalOwedCents).toBe(0);
  });
  it("15% split equally once the floor is passed", () => {
    const h = { ...deal("h1", "2026-03-01", 15_000_000, { mia: [[0, 40]], leo: [[0, 40]] }), setAsideCents: { mia: 1_125_000, leo: 1_125_000 } };
    const r = evaluate({
      state: "UT",
      children: [mia, leo],
      deal: deal("d1", "2026-11-05", 200_000, { mia: [[0, 40]], leo: [[30, 60]] }),
      history: [h],
    });
    expect(r.children.map((c) => c.owedCents)).toEqual([15_000, 15_000]);
  });
});
