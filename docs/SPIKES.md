# Spikes

These run before any UI is built. Each records what was tried, what happened, and the IDs it produced.

Run with: `npx tsx --env-file=.env scripts/spike-paypal.ts all`

| # | Spike | Status | Result |
|---|---|---|---|
| 1 | Invoicing v2: create, send, pay as sandbox brand, `INVOICING.INVOICE.PAID` webhook reaches app | ⏳ waiting for sandbox credentials | |
| 2 | Payouts: creator business → child trust sandbox account, status and `PAYMENT.PAYOUTS*` webhooks | ⏳ waiting for sandbox credentials | |
| 3 | Orders v2 multi-payee (`purchase_units` with different payees) | ⏳ waiting for sandbox credentials | |
| 4 | Video presence: Gemini on a 2–3 min clip, 2–3 tagged people, accuracy vs hand labels | ⏳ waiting for Gemini key and demo footage | |

## Notes

- Webhook signatures: events from the dashboard *simulator* fail `verify-webhook-signature` by design. Only real sandbox events verify. The real-event path needs a public URL, so we deploy to Render early.
