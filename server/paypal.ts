// Minimal PayPal REST client (sandbox only). Never logs credentials or tokens.

const SANDBOX = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
    public debugId?: string,
  ) {
    super(message);
  }
}

function base(): string {
  if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox") {
    throw new Error("Their Cut only runs against the PayPal sandbox. Set PAYPAL_ENV=sandbox.");
  }
  return SANDBOX;
}

let cached: { token: string; exp: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new PayPalError(`OAuth failed: ${json.error_description ?? res.status}`, res.status, null);
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 300) * 1000 };
  return cached.token;
}

export async function pp<T = any>(
  method: string,
  path: string,
  body?: unknown,
  opts: { requestId?: string; prefer?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  const res = await fetch(`${base()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new PayPalError(`${method} ${path} → ${res.status} ${json?.name ?? ""} ${json?.message ?? ""}`.trim(), res.status, json, res.headers.get("paypal-debug-id") ?? undefined);
  }
  return json as T;
}

// ---------- Invoicing v2 ----------

export async function createInvoice(args: {
  requestId: string;
  invoicerEmail?: string;
  recipientEmail: string;
  itemName: string;
  itemDescription?: string;
  amountCents: number;
  note?: string;
  reference?: string;
}) {
  const value = (args.amountCents / 100).toFixed(2);
  const created = await pp<{ href?: string; id?: string }>(
    "POST",
    "/v2/invoicing/invoices",
    {
      detail: {
        currency_code: "USD",
        note: args.note,
        reference: args.reference,
        payment_term: { term_type: "DUE_ON_RECEIPT" },
      },
      invoicer: args.invoicerEmail ? { email_address: args.invoicerEmail } : undefined,
      primary_recipients: [{ billing_info: { email_address: args.recipientEmail } }],
      items: [
        {
          name: args.itemName,
          description: args.itemDescription,
          quantity: "1",
          unit_amount: { currency_code: "USD", value },
          unit_of_measure: "AMOUNT",
        },
      ],
    },
    { requestId: args.requestId, prefer: "return=representation" },
  );
  return created as any;
}

export async function sendInvoice(id: string, requestId: string) {
  return pp("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: true }, { requestId });
}

export async function getInvoice(id: string) {
  return pp("GET", `/v2/invoicing/invoices/${id}`);
}

/** Records an external payment. Used only as a labelled fallback when nobody can pay through the PayPal page. */
export async function recordInvoicePayment(id: string, amountCents: number, requestId: string) {
  return pp(
    "POST",
    `/v2/invoicing/invoices/${id}/payments`,
    { method: "OTHER", payment_date: new Date().toISOString().slice(0, 10), amount: { currency_code: "USD", value: (amountCents / 100).toFixed(2) } },
    { requestId },
  );
}

// ---------- Payouts ----------

export async function createPayout(args: {
  senderBatchId: string;
  emailSubject: string;
  items: { receiverEmail: string; amountCents: number; senderItemId: string; note: string }[];
}) {
  return pp<any>(
    "POST",
    "/v1/payments/payouts",
    {
      sender_batch_header: { sender_batch_id: args.senderBatchId, email_subject: args.emailSubject },
      items: args.items.map((i) => ({
        recipient_type: "EMAIL",
        receiver: i.receiverEmail,
        amount: { currency: "USD", value: (i.amountCents / 100).toFixed(2) },
        sender_item_id: i.senderItemId,
        note: i.note,
      })),
    },
    { requestId: args.senderBatchId },
  );
}

export async function getPayoutBatch(batchId: string) {
  return pp<any>("GET", `/v1/payments/payouts/${batchId}`);
}

// ---------- Orders v2 (multi-payee fallback) ----------

export async function createMultiPayeeOrder(args: {
  requestId: string;
  units: { referenceId: string; payeeEmail: string; amountCents: number; description: string }[];
}) {
  return pp<any>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: args.units.map((u) => ({
        reference_id: u.referenceId,
        description: u.description,
        amount: { currency_code: "USD", value: (u.amountCents / 100).toFixed(2) },
        payee: { email_address: u.payeeEmail },
      })),
    },
    { requestId: args.requestId },
  );
}

// ---------- Webhooks ----------

export async function verifyWebhookSignature(headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const h = (k: string) => {
    const v = headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID not set");
  const res = await pp<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: webhookId,
    // Must be the exact JSON PayPal sent; we parse the raw body without re-serialising keys.
    webhook_event: JSON.parse(rawBody),
  });
  return res.verification_status === "SUCCESS";
}

export async function listWebhooks() {
  return pp<any>("GET", "/v1/notifications/webhooks");
}

export async function createWebhook(url: string, eventTypes: string[]) {
  return pp<any>("POST", "/v1/notifications/webhooks", { url, event_types: eventTypes.map((name) => ({ name })) });
}

export const WEBHOOK_EVENTS = [
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.PROCESSING",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
];
