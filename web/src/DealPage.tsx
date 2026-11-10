import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PresenceTimeline, { type Lane } from "./PresenceTimeline";
import { api, mmss, usd, type StateCode } from "./api";

type Iv = { start: number; end: number };
const merge = (xs: Iv[], gap = 0) => {
  const s = xs.filter((i) => i.end > i.start).map((i) => ({ ...i })).sort((a, b) => a.start - b.start);
  const out: Iv[] = [];
  for (const i of s) {
    const l = out[out.length - 1];
    if (l && i.start - l.end <= gap) l.end = Math.max(l.end, i.end);
    else out.push(i);
  }
  return out;
};
const measure = (xs: Iv[]) => xs.reduce((s, i) => s + i.end - i.start, 0);

const STEP_ORDER = ["draft", "analysing", "analysed", "invoiced", "paid", "paying", "settled"];

export default function DealPage({ wsId, dealId, ws, config, onChanged }: { wsId: string; dealId: string; ws: any; config: any; onChanged: () => void }) {
  const [deal, setDeal] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [reveal, setReveal] = useState<number | undefined>(undefined);
  const [compare, setCompare] = useState<any>(null);
  const [tab, setTab] = useState<StateCode>("IL");
  const video = useRef<HTMLVideoElement>(null);
  const animated = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api("GET", `/api/ws/${wsId}/deals/${dealId}`);
      setDeal(d);
      setErr(null);
      return d;
    } catch (e: any) {
      setErr(e.message);
    }
  }, [wsId, dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  // poll while the agent is working or PayPal is in flight
  useEffect(() => {
    if (!deal) return;
    const active = ["draft", "analysing", "analysed", "invoiced", "paid", "paying"].includes(deal.status);
    if (!active) return;
    const ms = deal.status === "invoiced" ? 4000 : 1500;
    const h = setInterval(async () => {
      const d = deal.status === "invoiced" || deal.status === "paying" ? await api("POST", `/api/ws/${wsId}/deals/${dealId}/refresh`).catch(() => null) : await load();
      if (d) setDeal(d);
      if (d && d.status !== deal.status) onChanged();
    }, ms);
    return () => clearInterval(h);
  }, [deal?.status, wsId, dealId, load, onChanged]);

  useEffect(() => {
    if (deal) setTab(deal.state);
  }, [deal?.state]);

  useEffect(() => {
    if (!deal?.presence) return;
    api("GET", `/api/ws/${wsId}/deals/${dealId}/compare`).then(setCompare).catch(() => {});
  }, [deal?.presence, deal?.adjustments?.length, wsId, dealId]);

  // the "watching the video" effect: paint presence progressively the first time a deal is opened
  const replay = useCallback(() => {
    if (!deal?.analysis) return;
    const dur = deal.durationSec;
    const t0 = performance.now();
    const total = 5000;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / total);
      setReveal(k >= 1 ? undefined : dur * k);
      if (k < 1) setTimeout(step, 66);
    };
    step();
  }, [deal?.analysis, deal?.durationSec]);

  useEffect(() => {
    if (!deal?.analysis || animated.current) return;
    animated.current = true;
    const key = `tc.revealed.${dealId}`;
    let seen = false;
    try {
      seen = sessionStorage.getItem(key) === "1";
      sessionStorage.setItem(key, "1");
    } catch {}
    if (!seen && !deal.seeded) replay();
  }, [deal?.analysis, dealId, replay, deal?.seeded]);

  const lanes: Lane[] = useMemo(() => {
    if (!deal?.analysis) return [];
    return ws.children.map((c: any) => {
      const ac = deal.analysis.children.find((x: any) => x.childId === c.id);
      const adjusted = deal.adjustments.some((a: any) => a.childId === c.id);
      const presence: Iv[] = deal.presence?.[c.id] ?? [];
      const screen = adjusted
        ? presence
        : merge((ac?.visual ?? []).filter((i: any) => i.confidence >= 0.5), 1).map((m) => {
            const src = (ac?.visual ?? []).find((v: any) => v.start >= m.start - 0.01 && v.start <= m.end);
            return { ...m, confidence: src?.confidence, evidence: src?.evidence };
          });
      const voice = adjusted ? [] : (ac?.narration ?? []).filter((i: any) => i.confidence >= 0.5);
      const shown = merge([...screen, ...voice].map((i) => ({ start: i.start, end: Math.min(i.end, reveal ?? i.end) })).filter((i) => i.start < (reveal ?? Infinity)));
      const pct = reveal != null ? (measure(shown) / deal.durationSec) * 100 : (measure(merge(presence)) / deal.durationSec) * 100;
      return { id: c.id, name: c.name, color: c.color, pct, screen, voice, adjusted };
    });
  }, [deal?.analysis, deal?.presence, deal?.adjustments, ws.children, reveal, deal?.durationSec]);

  const act = async (label: string, method: string, path: string, body?: unknown) => {
    setBusy(label);
    setErr(null);
    try {
      const d = await api(method, `/api/ws/${wsId}/deals/${dealId}${path}`, body);
      setDeal(d);
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const onEdit = useCallback(
    (childId: string, intervals: Iv[]) => {
      const name = ws.children.find((c: any) => c.id === childId)?.name;
      void act("adjust", "PATCH", "/presence", { childId, intervals, reason: `Parent corrected ${name}'s timeline` });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.children, wsId, dealId],
  );

  if (err && !deal) return <div className="card notice err">{err}</div>;
  if (!deal) return <div className="card">Loading deal…</div>;

  const ev = deal.evaluation;
  const locked = !!deal.invoice?.paidAt;
  const stepIdx = STEP_ORDER.indexOf(deal.status === "nothing-owed" ? "settled" : deal.status);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <a href="#/">← Family</a>
        <span className="spacer" />
        {deal.seeded && <span className="pill">Demo history</span>}
        <StatusPill status={deal.status} pending={deal.pendingApprovals.length} />
      </div>
      <div className="row" style={{ alignItems: "flex-end", marginBottom: 18 }}>
        <div>
          <div className="muted">{deal.date} · {deal.brand} · {config.rules[deal.state].name} law</div>
          <h1>{deal.videoTitle}</h1>
        </div>
        <span className="spacer" />
        <div style={{ textAlign: "right" }}>
          <div className="muted">Brand pays</div>
          <div className="big-num">{usd(deal.amountCents)}</div>
        </div>
      </div>

      {err && <div className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="deal-layout">
        <div>
          <div className="card">
            <div className="video-wrap">
              <video ref={video} src={`/media/videos/${deal.videoId}.mp4`} controls playsInline preload="metadata" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} />
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <h2>Who's in it, second by second</h2>
              <span className="spacer" />
              {deal.analysis && (
                <span className="pill info" title={deal.analysis.privacy}>
                  {deal.analysis.source === "live" ? "Fresh AI run" : "Measured by AI"} · {deal.analysis.model}
                </span>
              )}
            </div>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Solid bars: the child is on screen. Striped bars: the narration is about them, which the law counts too. Drag, stretch or right-click a bar to correct it. Every change is recorded.
            </p>
            {deal.analysis ? (
              <PresenceTimeline
                duration={deal.durationSec}
                lanes={lanes}
                playhead={t}
                revealT={reveal}
                readOnly={locked || reveal != null || deal.seeded}
                onSeek={(s) => {
                  if (video.current) video.current.currentTime = s;
                  setT(s);
                }}
                onEdit={onEdit}
              />
            ) : (
              <div className="timeline" style={{ display: "grid", placeItems: "center" }}>
                <span className="muted">{deal.status === "error" ? "Analysis failed." : "Watching the video…"}</span>
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" onClick={replay} disabled={!deal.analysis || reveal != null}>Replay analysis</button>
              {!locked && !deal.seeded && (
                <button className="btn small" disabled={!!busy} onClick={() => act("live", "POST", "/analyse")} title="Runs Gemini on the video again. Rate-limited to keep costs down.">
                  {busy === "live" ? "Running Gemini… (about 30 s)" : "Re-run AI analysis"}
                </button>
              )}
              <span className="spacer" />
              {deal.adjustments.length > 0 && <span className="pill warn">{deal.adjustments.length} parent correction(s), all logged</span>}
            </div>
          </div>

          {deal.analysis && <Evidence deal={deal} ws={ws} onSeek={(s) => video.current && (video.current.currentTime = s)} />}
          <ActivityLog deal={deal} wsId={wsId} />
        </div>

        <div>
          <MoneyPanel deal={deal} ws={ws} stepIdx={stepIdx} busy={busy} act={act} />
          {deal.pendingApprovals.length > 0 && (
            <div className="card notice" style={{ marginTop: 16 }}>
              <h3>Needs your OK</h3>
              <p className="sub" style={{ margin: "6px 0" }}>The agent stopped before paying the trusts because:</p>
              <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
                {deal.pendingApprovals.map((f: any) => <li key={f.kind + (f.childId ?? "")}>{f.message}</li>)}
              </ul>
              <button className="btn primary" disabled={!!busy || !deal.invoice} onClick={() => act("approve", "POST", "/approve", { note: "Approved by parent in the deal page" })}>
                {busy === "approve" ? "Approving…" : "I've checked. Approve and continue"}
              </button>
            </div>
          )}
          {ev && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row">
                <h2>What the law says they're owed</h2>
              </div>
              <div className="tabs" style={{ marginTop: 10 }}>
                {(["IL", "CA", "UT"] as StateCode[]).map((s) => (
                  <button key={s} className={tab === s ? "on" : ""} onClick={() => setTab(s)}>
                    {config.rules[s].name}{s === deal.state ? " ✓" : ""}
                  </button>
                ))}
              </div>
              {tab === deal.state ? (
                <>
                  <div className="child-rows">
                    {ev.children.map((c: any) => {
                      const col = ws.children.find((x: any) => x.id === c.childId)?.color;
                      return (
                        <div className="child-row" key={c.childId} style={{ ["--c" as any]: col }}>
                          <span className="swatch" />
                          <div>
                            <b>{c.name}</b> <span className="muted">· {(c.presenceInDeal * 100).toFixed(1)}% of this video · {(c.windowPresence * 100).toFixed(1)}% over the window</span>
                            {!c.eligible && <div className="muted">{c.reasons.filter((r: string) => /not covered|threshold|floor/.test(r)).join(" ")}</div>}
                          </div>
                          <b style={{ fontVariantNumeric: "tabular-nums" }}>{usd(c.owedCents)}</b>
                        </div>
                      );
                    })}
                  </div>
                  <div className="row" style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                    <span className="sub">Into trust</span>
                    <span className="spacer" />
                    <span className="big-num" style={{ fontSize: 24 }}>{usd(ev.totalOwedCents)}</span>
                  </div>
                  <p style={{ marginBottom: 6 }}>{deal.explanation?.text ?? "Writing a plain-English explanation…"}</p>
                  {deal.explanation && <div className="muted">{deal.explanation.source === "ai" ? "Explained by AI. Every amount above was computed by the rules engine; the AI only describes it." : "Explanation from template."}</div>}
                  <Citations rule={config.rules[deal.state]} />
                </>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <p className="sub">If this family lived in {config.rules[tab].name}, the same video would put <b>{compare?.[tab] ? usd(compare[tab].totalOwedCents) : "…"}</b> into trust.</p>
                  <p className="muted">{config.rules[tab].formula.text}</p>
                  {compare?.[tab] && (
                    <div className="child-rows">
                      {compare[tab].children.map((c: any) => (
                        <div className="child-row" key={c.childId} style={{ ["--c" as any]: ws.children.find((x: any) => x.id === c.childId)?.color }}>
                          <span className="swatch" />
                          <span>{ws.children.find((x: any) => x.id === c.childId)?.name}{!c.eligible && <span className="muted"> · not eligible</span>}</span>
                          <b>{usd(c.owedCents)}</b>
                        </div>
                      ))}
                    </div>
                  )}
                  <Citations rule={config.rules[tab]} />
                </div>
              )}
              <div className="disclaimer">{config.disclaimer}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status, pending }: { status: string; pending: number }) {
  const map: Record<string, [string, string]> = {
    draft: ["Starting", "info"],
    analysing: ["Watching the video", "info"],
    analysed: ["Applying the law", "info"],
    invoiced: ["Waiting for the brand to pay", "warn"],
    paid: [pending ? "Paid · needs your OK" : "Paid", "warn"],
    paying: ["Paying the trusts", "info"],
    settled: ["Settled", "ok"],
    "nothing-owed": ["Paid · nothing owed", "ok"],
    error: ["Problem", "bad"],
  };
  const [label, cls] = map[status] ?? [status, ""];
  return <span className={`pill ${cls}`}>{label}</span>;
}

function Citations({ rule }: { rule: any }) {
  return (
    <details style={{ marginTop: 10 }}>
      <summary className="muted" style={{ cursor: "pointer" }}>Sources for {rule.name} ({rule.law})</summary>
      <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 13 }}>
        {rule.citations.map((c: any) => (
          <li key={c.url}>
            <a href={c.url} target="_blank" rel="noreferrer">{c.label}</a>{" "}
            {c.verified ? <span className="pill ok">checked against statute text</span> : <span className="pill warn">not verified against statute text</span>}
            {c.note && <div className="muted">{c.note}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function MoneyPanel({ deal, ws, stepIdx, busy, act }: any) {
  const inv = deal.invoice;
  const steps = [
    { k: "analysed", title: "Measured who's in the video", body: deal.analysis ? `${deal.analysis.children.map((c: any) => `${c.name} ${c.presencePct.toFixed(1)}%`).join(" · ")}` : "Gemini watches the video and listens to the narration." },
    { k: "invoiced", title: "PayPal invoice sent to the brand", body: inv ? <div className="ids"><span className="id">Invoice {inv.id}</span><span className="id">{inv.status}</span></div> : "Drafted by the agent with PayPal Invoicing." },
    {
      k: "paid",
      title: "Brand paid",
      body: inv?.paidAt ? (
        <div className="ids"><span className="id">{inv.paidVia === "sandbox-api" ? "Recorded via Invoicing API (sandbox simulation)" : "Confirmed by PayPal"}</span><span className="id">{new Date(inv.paidAt).toLocaleTimeString()}</span></div>
      ) : (
        "The agent waits for PayPal's INVOICING.INVOICE.PAID webhook."
      ),
    },
    {
      k: "paying",
      title: "Each child's share paid into their trust",
      body: deal.payout ? (
        <div>
          <div className="ids"><span className="id">Batch {deal.payout.batchId ?? "…"}</span><span className="id">{deal.payout.status ?? "…"}</span></div>
          {deal.payout.items.map((i: any) => {
            const c = ws.children.find((x: any) => x.id === i.childId);
            return (
              <div key={i.senderItemId} className="row" style={{ marginTop: 6, gap: 6 }}>
                <span className="swatch" style={{ ["--c" as any]: c?.color }} />
                <b>{c?.name}</b>
                <span>{usd(i.amountCents)}{i.kind === "catch-up" ? " (catch-up)" : ""}</span>
                <span className={`pill ${i.status === "SUCCESS" ? "ok" : i.status ? "warn" : ""}`}>{i.status ?? "sending"}</span>
                {i.transactionId && <span className="id">txn {i.transactionId}</span>}
              </div>
            );
          })}
        </div>
      ) : deal.status === "nothing-owed" ? (
        "No child's share was owed for this video."
      ) : (
        "PayPal Payouts, one deposit per child, with a deterministic batch ID so a retry can never pay twice."
      ),
    },
    { k: "settled", title: "Recorded for the child to read at 18", body: deal.status === "settled" || deal.status === "nothing-owed" ? <a href={`/api/ws/${ws.id}/deals/${deal.id}/record`}>Download the full deal record (JSON)</a> : "Hash-chained ledger entry with the evidence, rule, amounts and PayPal IDs." },
  ];
  return (
    <div className="card">
      <div className="row">
        <h2>Money</h2>
        <span className="spacer" />
        <span className="pill sandbox">PayPal sandbox</span>
      </div>
      <ol className="steps">
        {steps.map((s) => {
          const idx = STEP_ORDER.indexOf(s.k);
          const done = stepIdx > idx || (s.k === "settled" && ["settled", "nothing-owed"].includes(deal.status)) || (s.k === "paying" && deal.status === "settled");
          const now = !done && (stepIdx === idx || stepIdx + 1 === idx) && deal.status !== "error";
          return (
            <li key={s.k}>
              <span className={`dot ${done ? "done" : now ? "now" : ""} ${deal.status === "error" && now ? "err" : ""}`}>{done ? "✓" : ""}</span>
              <div>
                <b>{s.title}</b>
                <div className="sub" style={{ fontSize: 13.5 }}>{s.body}</div>
                {s.k === "paid" && deal.status === "invoiced" && inv && (
                  <div className="row" style={{ marginTop: 8 }}>
                    {inv.payerUrl && <a className="btn paypal small" href={inv.payerUrl} target="_blank" rel="noreferrer">Pay as the brand in PayPal sandbox</a>}
                    <button className="btn small" disabled={!!busy} onClick={() => act("simulate", "POST", "/simulate-payment")}>
                      {busy === "simulate" ? "Recording…" : "Simulate brand payment (sandbox API)"}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {deal.status === "error" && (
        <div className="notice err" style={{ marginTop: 10 }}>
          {deal.error} <button className="btn small" onClick={() => act("retry", "POST", "/refresh")}>Retry</button>
        </div>
      )}
    </div>
  );
}

function Evidence({ deal, ws, onSeek }: { deal: any; ws: any; onSeek: (s: number) => void }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const shots = useMemo(() => {
    const out: { key: string; childId: string; t: number; caption: string }[] = [];
    for (const c of deal.analysis.children) {
      const vis = merge(c.visual.filter((i: any) => i.confidence >= 0.5), 1).slice(0, 2);
      for (const v of vis) out.push({ key: `${c.childId}-${v.start}`, childId: c.childId, t: Math.min(v.end - 0.2, v.start + 1.5), caption: `${c.name} on screen · ${mmss(v.start)}` });
    }
    return out;
  }, [deal.analysis]);

  useEffect(() => {
    let cancelled = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = `/media/videos/${deal.videoId}.mp4`;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const grab = (i: number) => {
      if (cancelled || i >= shots.length) return;
      v.currentTime = shots[i].t;
      v.onseeked = () => {
        canvas.getContext("2d")!.drawImage(v, 0, 0, 320, 180);
        const url = canvas.toDataURL("image/jpeg", 0.7);
        setThumbs((m) => ({ ...m, [shots[i].key]: url }));
        grab(i + 1);
      };
    };
    v.onloadeddata = () => grab(0);
    return () => {
      cancelled = true;
      v.src = "";
    };
  }, [shots, deal.videoId]);

  const quotes = deal.analysis.transcript.filter((l: any) => l.subjects.some((s: any) => s.confidence >= 0.5));
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Evidence</h2>
      <p className="muted" style={{ margin: "4px 0 0" }}>Frames where each child was seen, and every sentence the narration says about them. Click one to jump there.</p>
      <div className="evidence">
        {shots.map((s) => (
          <figure key={s.key} onClick={() => onSeek(s.t)} style={{ ["--c" as any]: ws.children.find((c: any) => c.id === s.childId)?.color }}>
            {thumbs[s.key] ? <img src={thumbs[s.key]} alt={s.caption} /> : <img alt="" />}
            <figcaption>{s.caption}</figcaption>
          </figure>
        ))}
      </div>
      {quotes.length > 0 && (
        <table className="table" style={{ marginTop: 12 }}>
          <tbody>
            {quotes.map((q: any) => (
              <tr key={q.start} className="click" onClick={() => onSeek(q.start)}>
                <td className="mono" style={{ width: 60 }}>{mmss(q.start)}</td>
                <td className="quote">“{q.text}”</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {q.subjects.filter((s: any) => s.confidence >= 0.5).map((s: any) => (
                    <span key={s.childId} className="pill" style={{ marginLeft: 4 }}>{ws.children.find((c: any) => c.id === s.childId)?.name} · {s.how}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 10 }}>{deal.analysis.privacy}</p>
    </div>
  );
}

function ActivityLog({ deal, wsId }: { deal: any; wsId: string }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row">
        <h2>What the agent did</h2>
        <span className="spacer" />
        <a className="btn small" href={`/api/ws/${wsId}/deals/${deal.id}/record`}>Deal record (JSON)</a>
      </div>
      <div className="log" style={{ marginTop: 8 }}>
        {deal.log.slice().reverse().map((l: any, i: number) => (
          <div key={i} className={l.level}>
            <span className="muted mono">{new Date(l.at).toLocaleTimeString()}</span> <b>{l.step}</b> · {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}
