// PayPal sandbox spikes. Run: npx tsx --env-file=.env scripts/spike-paypal.ts [invoice|payout|order|all]
// Prints IDs and statuses only, never credentials.
import { createInvoice, sendInvoice, getInvoice, createPayout, getPayoutBatch, createMultiPayeeOrder, PayPalError, accessToken } from "../server/paypal.js";

const which = process.argv[2] ?? "all";
const run = `spike-${Date.now()}`;

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing in .env`);
  return v;
}

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    console.log(`✔ ${name}`, JSON.stringify(out, null, 2));
  } catch (e) {
    if (e instanceof PayPalError) console.log(`✘ ${name}: ${e.message} (debug_id ${e.debugId})`, JSON.stringify(e.body, null, 2));
    else console.log(`✘ ${name}: ${(e as Error).message}`);
  }
}

await step("oauth", async () => ((await accessToken()) ? "token ok" : "no token"));

if (which === "invoice" || which === "all") {
  await step("invoice create+send", async () => {
    const inv = await createInvoice({
      requestId: `${run}-inv`,
      invoicerEmail: process.env.PAYPAL_CREATOR_EMAIL,
      recipientEmail: need("PAYPAL_BRAND_EMAIL"),
      itemName: "Sponsored family video (spike)",
      amountCents: 1000,
      reference: run,
    });
    const id = inv.id ?? String(inv.href).split("/").pop();
    await sendInvoice(id, `${run}-send`);
    const got: any = await getInvoice(id);
    return { id, status: got.status, payer_view: got.detail?.metadata?.recipient_view_url };
  });
}

if (which === "payout" || which === "all") {
  await step("payout to trust account", async () => {
    const batch = await createPayout({
      senderBatchId: `${run}-payout`,
      emailSubject: "Their Cut spike payout",
      items: [
        { receiverEmail: need("PAYPAL_TRUST_EMAIL_MIA"), amountCents: 123, senderItemId: `${run}-mia`, note: "spike: Mia trust" },
        ...(process.env.PAYPAL_TRUST_EMAIL_LEO
          ? [{ receiverEmail: process.env.PAYPAL_TRUST_EMAIL_LEO, amountCents: 45, senderItemId: `${run}-leo`, note: "spike: Leo trust" }]
          : []),
      ],
    });
    const id = batch.batch_header?.payout_batch_id;
    await new Promise((r) => setTimeout(r, 5000));
    const s = await getPayoutBatch(id);
    return {
      payout_batch_id: id,
      batch_status: s.batch_header?.batch_status,
      items: s.items?.map((i: any) => ({ payout_item_id: i.payout_item_id, status: i.transaction_status, txn: i.transaction_id })),
    };
  });
  await step("payout idempotency (same sender_batch_id)", async () => {
    try {
      await createPayout({
        senderBatchId: `${run}-payout`,
        emailSubject: "dup",
        items: [{ receiverEmail: need("PAYPAL_TRUST_EMAIL_MIA"), amountCents: 123, senderItemId: `${run}-mia`, note: "dup" }],
      });
      return "accepted (PayPal-Request-Id replay returned the original)";
    } catch (e) {
      if (e instanceof PayPalError) return `rejected as expected: ${(e.body as any)?.name}`;
      throw e;
    }
  });
}

if (which === "order" || which === "all") {
  await step("orders v2 multi-payee", async () => {
    const o = await createMultiPayeeOrder({
      requestId: `${run}-order`,
      units: [
        { referenceId: "creator", payeeEmail: need("PAYPAL_CREATOR_EMAIL"), amountCents: 700, description: "creator share" },
        { referenceId: "mia", payeeEmail: need("PAYPAL_TRUST_EMAIL_MIA"), amountCents: 300, description: "Mia trust share" },
      ],
    });
    return { id: o.id, status: o.status, approve: o.links?.find((l: any) => l.rel === "approve")?.href };
  });
}
