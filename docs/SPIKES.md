# Spikes

These run before any UI is built. Each records what was tried, what happened, and the IDs it produced.

Run with: `npx tsx --env-file=.env scripts/spike-paypal.ts all`

Sandbox app: `proofpay-us` (US). It is shared with other projects, so the webhook handler must ignore invoice IDs it doesn't own.

| # | Spike | Status | Result (2026-11-10) |
|---|---|---|---|
| 0 | OAuth client credentials | ✅ | Token issued. |
| 1 | Invoicing v2: create, send, pay, `INVOICING.INVOICE.PAID` | ❌ **blocked** | `403 NOT_AUTHORIZED` on create, list and generate-next-invoice-number, with or without an `invoicer` email (debug_ids `f683792abbcd1`, `f1446139623c8`). The app doesn't have the **Invoicing** feature enabled. Fix: turn on Invoicing for the app (Apps & Credentials → app → Features), or create a dedicated app with it on. |
| 2 | Payouts: creator business → personal account | ✅ | Batch `PJMSLV4HGXVPN` went PENDING → **SUCCESS**; item `9X57KYMWZHE6A`, transaction `56M33672TK995902B`. Receiver was the brand sandbox account as a stand-in, because the trust accounts don't exist yet. |
| 2b | Payouts idempotency | ✅ | Resending the same `sender_batch_id` / `PayPal-Request-Id` was rejected with `USER_BUSINESS_ERROR`, so retries can't double-pay. |
| 3 | Orders v2 multi-payee (creator + trust as separate `purchase_units` payees) | ✅ created, ⏳ approve/capture | Order `90J802803H0324113` was accepted with status `CREATED`, so a non-partner account can create multi-payee orders. Capture still has to be tested after a buyer approves it. |
| 4a | Gemini reachability | ✅ | `gemini-3.5-flash` answered in 1.8 s. The key is shared with other projects, so the client retries 503 "high demand" errors with backoff. |
| 4b | Video presence accuracy vs hand labels | ⏳ | Waiting for demo footage (Pexels). |

## Decisions so far

- **The split runs on Payouts.** It works end to end in the sandbox and is idempotent by `sender_batch_id`.
- **The brand pays through Invoicing v2** once the feature is enabled. If it can't be enabled in time, the fallback is a Checkout order that the brand pays, with the order capture webhook triggering the same split. Any fallback is labelled honestly in the UI.

## Notes

- Webhook signatures: events from the dashboard *simulator* fail `verify-webhook-signature` by design. Only real sandbox events verify. The real-event path needs a public URL, so we deploy to Render early.
