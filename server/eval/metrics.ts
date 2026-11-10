import { mergeIntervals, measure, type Interval } from "../rules/engine.js";

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const A = mergeIntervals(a), B = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i].start, B[j].start), e = Math.min(A[i].end, B[j].end);
    if (e > s) out.push({ start: s, end: e });
    if (A[i].end < B[j].end) i++; else j++;
  }
  return out;
}

/** Time IoU between two interval sets. Both empty = 1. */
export function iou(pred: Interval[], truth: Interval[]): number {
  const inter = measure(intersect(pred, truth));
  const uni = measure(mergeIntervals([...pred, ...truth]));
  return uni === 0 ? 1 : inter / uni;
}

/** Time-weighted precision/recall. */
export function precisionRecall(pred: Interval[], truth: Interval[]) {
  const inter = measure(intersect(pred, truth));
  const p = measure(mergeIntervals(pred)), t = measure(mergeIntervals(truth));
  return { precision: p === 0 ? (t === 0 ? 1 : 0) : inter / p, recall: t === 0 ? 1 : inter / t };
}

/** Line-level narration detection: a truth line counts as found if a predicted line overlapping it names the same child. */
export function lineLevel(
  pred: { start: number; end: number; subjects: string[] }[],
  truth: { start: number; end: number; subjects: string[] }[],
) {
  let tp = 0, fp = 0, fn = 0;
  const overlaps = (a: Interval, b: Interval) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.2;
  for (const t of truth) for (const c of t.subjects) {
    if (pred.some((p) => overlaps(p, t) && p.subjects.includes(c))) tp++; else fn++;
  }
  for (const p of pred) for (const c of p.subjects) {
    if (!truth.some((t) => overlaps(p, t) && t.subjects.includes(c))) fp++;
  }
  return { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 };
}
