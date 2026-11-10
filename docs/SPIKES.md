# Spikes

These run before any UI is built. Each records what was tried, what happened, and the IDs it produced.

Run with: `npx tsx --env-file=.env scripts/spike-paypal.ts all`

Sandbox app: `proofpay-us` (US). It is shared with other projects, so the webhook handler must ignore invoice IDs it doesn't own.

| # | Spike | Status | Result (2026-11-10) |
|---|---|---|---|
| 0 | OAuth client credentials | ✅ | Token issued. |
| 1 | Invoicing v2: create + send | ✅ | First attempt: `403 NOT_AUTHORIZED`, because Invoicing was off on the app. After enabling it, still 403: **PayPal reuses a cached access token for about 9 h, and that token didn't carry the new `services/invoicing` scope.** Revoking it with `/v1/oauth2/token/terminate` produced a fresh token with the scope. Invoice `INV2-R2PP-F4N2-AL3K-8MAK` → **SENT**. |
| 1b | Brand pays the invoice; `INVOICING.INVOICE.PAID` webhook reaches the app | ⏳ | Needs a public URL for the webhook (deploy to Render first), plus a payment made by signing in as the brand sandbox account on sandbox.paypal.com. That sign-in is done by a person, not by the agent. |
| 2 | Payouts: creator business → two trust accounts | ✅ | Earlier run `PJMSLV4HGXVPN` (brand account as stand-in) → SUCCESS. Real trust accounts: batch `YPPGK5P8ZNU84` → **SUCCESS**. Mia (personal) item `SVZSC5NU5JPJU`, txn `10H025696U992520J`, $1.23. Leo (business account) item `UJ2TLLCSF4KRN`, txn `4VN06038E5187732N`, $0.45. |
| 2b | Payouts idempotency | ✅ | Resending the same `sender_batch_id` / `PayPal-Request-Id` was rejected with `USER_BUSINESS_ERROR`, so retries can't double-pay. |
| 3 | Orders v2 multi-payee (creator + trust as separate `purchase_units` payees) | ✅ created, ⏳ approve/capture | Order `90J802803H0324113` was accepted with status `CREATED`, so a non-partner account can create multi-payee orders. Capture still has to be tested after a buyer approves it. |
| 4a | Gemini reachability | ✅ | `gemini-3.5-flash` answered in 1.8 s. The key is shared with other projects, so the client retries 503 "high demand" errors with backoff. |
| 4b | Video presence accuracy vs hand labels | ✅ feasible, ⏳ full eval | No GPU needed: Gemini takes the video inline at 2 fps, with the parent's reference stills, in two parallel calls (visual, narration). **`gemini-3.5-flash` on `saturday-breakfast` (92 s, 3 children):** mean presence error **1.0 pt**, interval IoU **0.94**, narration subject detection precision **1.00** / recall **1.00** (6/6, including a pronoun-only line). Latency about 30 s. **`gemini-3-flash-preview` on all 3 videos:** error 2.6 pts, IoU 0.83, narration precision 0.67. It put Mia in a clip she's absent from and counted "the kids"/"everyone" as every child. We use 3.5-flash. |
| 4c | Gemini quota | ❌ **blocker** | The shared key is on the **free tier: 20 requests/day per model** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, and `gemini-3.5-flash` resolves to `gemini-3.6-flash`). It's exhausted until about 19 h from 2026-11-10 18:30 IST. One analysis = 2 requests. The 3.5-flash eval of `sunday-lunch` and `blender-review` still has to run, and the hosted "run analysis" button would quickly drain a 20/day quota shared with other projects. |

### Fixes from the spike

- **Ground truth was too coarse.** Multi-sentence narration lines were labelled as a whole. The narration is now one sentence per line.
- **Gemini timestamps are about 1 s resolution,** which left small gaps and caused a systematic undercount. Gaps of 1 s or less for the same child are now closed (`GAP_SEC`, set from the timestamp resolution, not tuned on the eval). On Saturday this took the error from 3.8 to 1.0 pt.
- **Group references.** The narration prompt now says explicitly that "the kids" or "everyone" makes no specific child the subject. This is a documented interpretation of the statute's "subject of an oral narrative" wording.

## Decisions so far

- **The split runs on Payouts.** It works end to end in the sandbox and is idempotent by `sender_batch_id`.
- **The brand pays through Invoicing v2** once the feature is enabled. If it can't be enabled in time, the fallback is a Checkout order that the brand pays, with the order capture webhook triggering the same split. Any fallback is labelled honestly in the UI.

## Notes

- Webhook signatures: events from the dashboard *simulator* fail `verify-webhook-signature` by design. Only real sandbox events verify. The real-event path needs a public URL, so we deploy to Render early.
