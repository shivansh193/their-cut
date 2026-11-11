// End-to-end smoke test against a running server (sandbox PayPal).
// Run: npx tsx scripts/smoke.ts [baseUrl] [--pay]
// Creates a workspace and a deal, then shows analysis, rules, invoice, approvals, simulated payment and payouts.
const base = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:8799";
const pay = process.argv.includes("--pay");

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error}`);
  return j;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const ws = await api("POST", "/api/ws", {});
console.log("workspace", ws.id, "ledger", ws.ledger);
for (const d of ws.deals) console.log(" history:", d.date, d.videoId, d.status, JSON.stringify(d.setAsideCents));
console.log(" tracker:", ws.tracker.map((t: any) => `${t.name} ${(t.windowPresence * 100).toFixed(1)}% set aside ${usd(t.setAsideCents)}`).join(" | "));

let d = await api("POST", `/api/ws/${ws.id}/deals`, { videoId: process.env.SMOKE_VIDEO ?? "saturday-breakfast", brand: "Sunny Oats", amountCents: Number(process.env.SMOKE_CENTS ?? 250000) });
for (let i = 0; i < 30 && !["invoiced", "error"].includes(d.status); i++) {
  await wait(1000);
  d = await api("GET", `/api/ws/${ws.id}/deals/${d.id}`);
}
console.log("\ndeal", d.id, d.status, d.error ?? "");
console.log(" owed:", d.evaluation?.children.map((c: any) => `${c.name} ${(c.presenceInDeal * 100).toFixed(1)}% → ${usd(c.owedCents)}`).join(", "));
console.log(" flags:", d.evaluation?.flags.map((f: any) => f.kind).join(", "));
console.log(" explanation:", d.explanation?.source, "-", d.explanation?.text);
console.log(" invoice:", JSON.stringify(d.invoice));
const cmp = await api("GET", `/api/ws/${ws.id}/deals/${d.id}/compare`);
console.log(" compare:", Object.entries(cmp).map(([s, v]: any) => `${s} ${usd(v.totalOwedCents)}`).join(" | "));

if (pay) {
  d = await api("POST", `/api/ws/${ws.id}/deals/${d.id}/simulate-payment`);
  console.log("\nafter payment:", d.status, d.invoice.status);
  d = await api("POST", `/api/ws/${ws.id}/deals/${d.id}/approve`, { note: "smoke test" });
  console.log("after approval:", d.status, JSON.stringify(d.payout));
  for (let i = 0; i < 20 && d.status === "paying"; i++) {
    await wait(4000);
    d = await api("POST", `/api/ws/${ws.id}/deals/${d.id}/refresh`);
  }
  console.log("final:", d.status, d.payout?.items.map((i: any) => `${i.childId} ${usd(i.amountCents)} ${i.status} ${i.transactionId ?? ""}`).join(" | "));
  const led = await api("GET", `/api/ws/${ws.id}/children/mia/ledger`);
  console.log("Mia ledger:", led.rows.map((r: any) => `${r.date} ${r.video.slice(0, 18)} ${r.presencePct.toFixed(1)}% set aside ${usd(r.setAsideCents)} ${r.transactionIds.join(",")}`).join("\n  "));
  const l = await api("GET", `/api/ws/${ws.id}/ledger`);
  console.log("ledger verify:", JSON.stringify(l.verify), l.entries.length, "entries");
}
console.log("\nlog:\n " + d.log.map((l: any) => `[${l.step}] ${l.message}`).join("\n "));
