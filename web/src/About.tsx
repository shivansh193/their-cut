import { useEffect, useState } from "react";
import { api } from "./api";

export default function About({ config }: { config: any }) {
  const [ev, setEv] = useState<any>(null);
  useEffect(() => {
    api("GET", "/api/eval").then(setEv).catch(() => {});
  }, []);
  return (
    <div style={{ maxWidth: 860 }}>
      <h1>How Their Cut works</h1>
      <p className="sub" style={{ fontSize: 17 }}>
        Laws now say part of a family vlog's earnings belongs to the children in it, and they define that part in seconds: how long the child is on screen or is the subject of the narration.
        Nobody watches hours of footage with a stopwatch, and brand money lands in one account with nothing set aside. Their Cut does both jobs.
      </p>

      <div className="card">
        <h2>1 · Measure (AI)</h2>
        <p>
          The parent tags each child once with a reference still. Gemini watches the video at 2 frames a second and marks when each child is visible, matching only against those stills.
          A second pass transcribes the narration and marks every sentence that is about a child, including "she" or "he" when it refers to them, because the statutes count being the
          "subject of an oral narrative". The parent can correct any segment on the timeline, and each correction is logged.
        </p>
        {ev && (
          <div className="kpis" style={{ marginTop: 8 }}>
            <div className="kpi"><b>{ev.maePts.toFixed(2)} pts</b><span>mean error in a child's % (vs hand labels)</span></div>
            <div className="kpi"><b>{(ev.narration.precision * 100).toFixed(0)}% / {(ev.narration.recall * 100).toFixed(0)}%</b><span>narration precision / recall</span></div>
            <div className="kpi"><b>{ev.meanIou.toFixed(2)}</b><span>timeline overlap (IoU)</span></div>
          </div>
        )}
        {ev && <p className="muted">Measured on {ev.videos} demo videos ({ev.pairs} child × video pairs) with {ev.model}. Gemini's timestamps run about a second early, which lowers the overlap on very short shots but barely moves the percentages that set the money.</p>}
      </div>

      <div className="card">
        <h2>2 · Apply the law (deterministic code)</h2>
        <p>The amounts come from plain code, in whole cents, with tests. The AI only explains the result in words, and the explanation is rejected if it mentions any amount the code didn't produce.</p>
        <table className="table">
          <thead><tr><th>State</th><th>Covers</th><th>Threshold</th><th>Into trust</th><th>Checked against statute?</th></tr></thead>
          <tbody>
            {Object.values(config.rules).map((r: any) => (
              <tr key={r.state}>
                <td><b>{r.name}</b><div className="muted">{r.law}</div></td>
                <td>under {r.minorUnderAge}</td>
                <td>{Math.round(r.presenceThreshold * 100)}% of paid content{r.creatorEarningsFloorCents ? `, creator earns ≥ $${(r.creatorEarningsFloorCents / 100).toLocaleString()}` : ""} ({r.window.kind === "rolling-days" ? `${r.window.days}-day window` : r.window.kind.replace("calendar-", "per ")})</td>
                <td>{r.formula.text}</td>
                <td>{r.citations.some((c: any) => c.verified) ? <span className="pill ok">yes</span> : <span className="pill warn">not yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="disclaimer">{config.disclaimer}</div>
      </div>

      <div className="card">
        <h2>3 · Move the money (PayPal)</h2>
        <ul>
          <li><b>Invoicing v2</b>: the agent drafts and sends the brand an invoice for the deal.</li>
          <li><b>Webhooks</b>: <code>INVOICING.INVOICE.PAID</code>, signature checked with <code>verify-webhook-signature</code>, starts the split. A poller is the fallback.</li>
          <li><b>Payouts</b>: one deposit per child into their trust account. The batch ID is derived from the deal, so a retry can never pay twice. <code>PAYMENT.PAYOUTS-ITEM.*</code> webhooks and polling track each deposit.</li>
          <li><b>Ledger</b>: every step is appended to a hash-chained record holding the evidence, the rule applied, the amounts and the PayPal IDs. That's the record the statutes require, and the child can read it at 18.</li>
        </ul>
        <p className="muted">Everything here runs in the PayPal sandbox. "Simulate brand payment" records a payment through the Invoicing API so you can see the split without logging in as the brand; it's labelled as a simulation wherever it appears.</p>
      </div>

      <div className="card">
        <h2>Privacy</h2>
        <p>
          No face recognition against any outside database. Matching happens only inside one video, against the parent's own reference stills, and no face templates are stored.
          This was designed with Illinois's biometric privacy law (BIPA) in mind. The demo uses licensed stock footage; no real family's video is used.
        </p>
      </div>

      <div className="card">
        <h2>Beyond kids</h2>
        <p>Today it protects kids. The same engine splits earnings for any collab video, whether co-hosts, guests or brand creators, by who's actually on screen.</p>
      </div>
    </div>
  );
}
