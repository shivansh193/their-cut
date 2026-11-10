import { useState } from "react";
import { api, navigate, usd, type StateCode } from "./api";

export default function Home({ ws, config, reload }: { ws: any; config: any; reload: () => Promise<void> }) {
  const total = ws.tracker.reduce((s: number, t: any) => s + t.setAsideCents, 0);
  const live = ws.deals.filter((d: any) => !d.seeded);
  return (
    <div>
      <section className="hero">
        <div>
          <span className="pill sandbox">PayPal sandbox · AI by Gemini</span>
          <h1 style={{ marginTop: 10 }}>When a brand pays for a family video, the kids in it are owed their cut.</h1>
          <p>
            Illinois, California and Utah now require parents to set aside part of what they earn from videos featuring their children. Their Cut watches the video,
            measures how much of it each child is in, applies the state's formula, and as soon as PayPal confirms the brand's payment, moves each child's share into their trust.
          </p>
          <div className="row">
            <a className="btn primary" href="#new">Start a brand deal</a>
            <a className="btn" href="#/about">How it works</a>
          </div>
        </div>
        <div className="card">
          <div className="row">
            <h3>{ws.family.name}</h3>
            <span className="spacer" />
            <StatePicker ws={ws} config={config} reload={reload} />
          </div>
          <div className="kpis" style={{ marginTop: 12 }}>
            <div className="kpi"><b>{usd(total)}</b><span>held in trust</span></div>
            <div className="kpi"><b>{ws.deals.length}</b><span>brand deals</span></div>
            <div className="kpi"><b title={ws.ledger.ok ? "Every entry's hash checks out" : "Hash chain broken"}>{ws.ledger.ok ? "✓" : "✗"} {ws.ledger.entries}</b><span>ledger entries</span></div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>{config.rules[ws.family.state].law}</p>
        </div>
      </section>

      <h2 style={{ margin: "8px 0 12px" }}>The kids</h2>
      <div className="grid g3">
        {ws.children.map((c: any) => {
          const t = ws.tracker.find((x: any) => x.childId === c.id);
          const age = Math.floor((Date.now() - Date.parse(c.birthDate)) / (365.25 * 86_400_000));
          const over = t.windowPresence >= t.threshold;
          return (
            <div key={c.id} className="card" style={{ ["--c" as any]: c.color }}>
              <div className="child-card">
                <img className="avatar" src={`/media/references/${c.id}.jpg`} alt={`Reference still the parent tagged as ${c.name}`} />
                <div style={{ flex: 1 }}>
                  <div className="row">
                    <h3>{c.name}</h3>
                    <span className="muted">age {age}</span>
                    <span className="spacer" />
                    <a href={`#/child/${c.id}`}>Ledger →</a>
                  </div>
                  <div className="muted">{c.trustLabel}</div>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="row" style={{ fontSize: 13 }}>
                  <span>In <b>{(t.windowPresence * 100).toFixed(1)}%</b> of paid content, last 30 days</span>
                  <span className="spacer" />
                  <span className={`pill ${over ? "warn" : ""}`}>{over ? "over" : "under"} {Math.round(t.threshold * 100)}%</span>
                </div>
                <div className="meter" title={`Legal threshold ${Math.round(t.threshold * 100)}%`}>
                  <i style={{ width: `${Math.min(100, t.windowPresence * 100)}%` }} />
                  <u style={{ left: `${t.threshold * 100}%` }} />
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="sub">Set aside so far</span>
                  <span className="spacer" />
                  <b>{usd(t.setAsideCents)}</b>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <NewDeal ws={ws} config={config} reload={reload} />

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Brand deals</h2>
        <div className="table-wrap">
          <table className="table" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Date</th><th>Video</th><th>Brand</th><th>Paid</th>{ws.children.map((c: any) => <th key={c.id}>{c.name}</th>)}<th>Status</th></tr>
            </thead>
            <tbody>
              {ws.deals.map((d: any) => (
                <tr key={d.id} className="click" onClick={() => navigate(`#/deal/${d.id}`)}>
                  <td className="mono">{d.date}</td>
                  <td>{d.videoTitle.replace(/ \(.*\)$/, "")}{d.seeded && <span className="pill" style={{ marginLeft: 6 }}>demo history</span>}</td>
                  <td>{d.brand}</td>
                  <td>{usd(d.amountCents)}</td>
                  {ws.children.map((c: any) => (
                    <td key={c.id}>
                      <div>{d.presencePct[c.id] != null ? `${d.presencePct[c.id].toFixed(1)}%` : "…"}</div>
                      <div className="muted">{d.setAsideCents[c.id] ? usd(d.setAsideCents[c.id]) : d.owedCents[c.id] ? `${usd(d.owedCents[c.id])} owed` : "—"}</div>
                    </td>
                  ))}
                  <td><span className={`pill ${d.status === "settled" || d.status === "nothing-owed" ? "ok" : d.status === "error" ? "bad" : "warn"}`}>{d.pending ? "needs your OK" : d.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {live.length === 0 && <p className="muted">The two deals above are pre-seeded history (no money moved), so the 30-day window has something in it. Start a deal to see the full PayPal flow.</p>}
      </div>
    </div>
  );
}

function StatePicker({ ws, config, reload }: any) {
  const [busy, setBusy] = useState(false);
  return (
    <select
      className="pill"
      style={{ border: 0, padding: "4px 8px" }}
      value={ws.family.state}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        await api("PATCH", `/api/ws/${ws.id}/family`, { state: e.target.value });
        await reload();
        setBusy(false);
      }}
    >
      {(["IL", "CA", "UT"] as StateCode[]).map((s) => <option key={s} value={s}>Lives in {config.rules[s].name}</option>)}
    </select>
  );
}

function NewDeal({ ws, config, reload }: any) {
  const [videoId, setVideoId] = useState(config.videos[0].id);
  const v = config.videos.find((x: any) => x.id === videoId);
  const [brand, setBrand] = useState(v.suggestedBrand);
  const [amount, setAmount] = useState(String(v.suggestedAmountCents / 100));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card" id="new" style={{ marginTop: 24 }}>
      <h2>New brand deal</h2>
      <p className="sub" style={{ margin: "4px 0 12px" }}>
        Pick the sponsored video, who's paying and how much. The agent measures the video, applies {config.rules[ws.family.state].name} law, invoices the brand through PayPal, and pays the trusts once the brand pays.
      </p>
      <div className="video-pick">
        {config.videos.map((x: any) => (
          <button
            key={x.id}
            className={x.id === videoId ? "on" : ""}
            onClick={() => {
              setVideoId(x.id);
              setBrand(x.suggestedBrand);
              setAmount(String(x.suggestedAmountCents / 100));
            }}
          >
            <video src={`/media/videos/${x.id}.mp4#t=12`} muted preload="metadata" />
            <div style={{ marginTop: 6, fontWeight: 600 }}>{x.title.replace(/ \(.*\)$/, "")}</div>
            <div className="muted">{Math.round(x.durationSec)} s · demo footage (Pexels)</div>
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 14, alignItems: "flex-end" }}>
        <div className="field"><label>Brand</label><input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={60} /></div>
        <div className="field"><label>Brand pays (USD)</label><input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" style={{ width: 140 }} /></div>
        <button
          className="btn primary"
          disabled={busy || !brand || !(Number(amount) >= 1)}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const d = await api("POST", `/api/ws/${ws.id}/deals`, { videoId, brand, amountCents: Math.round(Number(amount) * 100) });
              await reload();
              navigate(`#/deal/${d.id}`);
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Starting…" : "Start the deal"}
        </button>
      </div>
      {err && <div className="notice err" style={{ marginTop: 10 }}>{err}</div>}
      <p className="muted" style={{ marginTop: 10 }}>The brand is a PayPal sandbox account. No real money moves.</p>
    </div>
  );
}
