// Plain-English explanation of a rule result. The AI only explains: every number it may use
// is passed in, and the text is checked so it never contains an amount we didn't compute.
import { generateJson, BudgetError } from "./analysis/gemini.js";
import { fmt, pct, type Evaluation } from "./rules/engine.js";
import { DISCLAIMER } from "./rules/states.js";

export function templateExplanation(ev: Evaluation): string {
  const r = ev.rule;
  const lines: string[] = [];
  lines.push(`Rule applied: ${r.name}, ${r.law}. ${r.formula.text}`);
  for (const c of ev.children) {
    if (c.eligible)
      lines.push(`${c.name} is in ${pct(c.presenceInDeal)} of this video and ${pct(c.windowPresence)} of paid content over the ${ev.windowLabel}, so ${fmt(c.owedCents)} goes to ${c.name}'s trust.`);
    else lines.push(`${c.name}: nothing owed for this video. ${c.reasons.filter((x) => /not covered|threshold|floor/.test(x)).join(" ")}`);
  }
  if (ev.qualifyingChildIds.length > 1 && ev.rule.multiMinorEqualSplit)
    lines.push(`Because more than one child qualifies, the law splits their combined on-screen share (${pct(ev.combinedPresence)}) equally between them.`);
  lines.push(DISCLAIMER);
  return lines.join(" ");
}

const SCHEMA = { type: "OBJECT", properties: { explanation: { type: "STRING" } }, required: ["explanation"] };

export async function explain(ev: Evaluation): Promise<{ text: string; source: "ai" | "template" }> {
  const facts = {
    state: ev.rule.name,
    law: ev.rule.law,
    rule_text: ev.rule.formula.text,
    window: ev.windowLabel,
    gross: fmt(ev.grossCents),
    combined_presence_of_qualifying_children: pct(ev.combinedPresence),
    children: ev.children.map((c) => ({
      name: c.name,
      age: c.ageAtDeal,
      in_this_video: pct(c.presenceInDeal),
      in_window: pct(c.windowPresence),
      eligible: c.eligible,
      owed: fmt(c.owedCents),
      reasons: c.reasons,
    })),
    total_owed: fmt(ev.totalOwedCents),
    split_rule:
      ev.qualifyingChildIds.length > 1 && ev.rule.multiMinorEqualSplit
        ? `More than one child qualifies, so the law takes the combined share of the video that features any qualifying child (${pct(ev.combinedPresence)}) and splits it equally between them, whatever each child's own percentage. That is why the amounts are equal.`
        : undefined,
    flags: ev.flags.map((f) => f.message),
    citations: ev.rule.citations.map((c) => `${c.label}${c.verified ? "" : " (not verified against statute text)"}`),
  };
  try {
    const r = await generateJson<{ explanation: string }>({
      label: "explain",
      schema: SCHEMA,
      system:
        "You explain child-influencer trust calculations to a parent in plain, warm English. Use ONLY the facts given. Never compute or invent numbers: quote amounts and percentages exactly as given. Quote the rule you applied. 4 to 6 short sentences. No legal advice; end by saying the rules are simplified and to verify with counsel.",
      parts: [{ text: JSON.stringify(facts) }],
    });
    const text = r.data.explanation.trim();
    // Guard: every dollar amount in the text must be one we computed.
    // Allowed = every dollar figure that appears anywhere in the facts we supplied (amounts, flags, thresholds).
    const norm = (a: string) => (a.includes(".") ? a : `${a}.00`);
    const allowed = new Set((JSON.stringify(facts).match(/\$[\d,]+(\.\d{2})?/g) ?? []).map(norm));
    const amounts = text.match(/\$[\d,]+(\.\d{2})?/g) ?? [];
    const bad = amounts.filter((a) => !allowed.has(norm(a)));
    if (bad.length) {
      console.warn(`[explain] AI text used amounts we didn't compute (${bad.join(", ")}); using template.`);
      return { text: templateExplanation(ev), source: "template" };
    }
    return { text, source: "ai" };
  } catch (e) {
    if (!(e instanceof BudgetError)) console.warn("[explain] falling back to template:", (e as Error).message);
    return { text: templateExplanation(ev), source: "template" };
  }
}
