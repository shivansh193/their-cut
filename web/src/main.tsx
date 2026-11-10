import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/scheduler-enterprise/scheduler.css";
import "@bryntum/scheduler-enterprise/svalbard-light.css";
import "./styles.css";
import { api, ensureWorkspace, setWsId } from "./api";
import Home from "./Home";
import DealPage from "./DealPage";
import ChildLedger from "./ChildLedger";
import About from "./About";

function useHash() {
  const [h, setH] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setH(window.location.hash || "#/");
      if (!window.location.hash.startsWith("#new")) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

function App() {
  const hash = useHash();
  const [config, setConfig] = useState<any>(null);
  const [ws, setWs] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setWs(await ensureWorkspace());
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    api("GET", "/api/config")
      .then((c) => {
        (globalThis as any).bryntum = { ...((globalThis as any).bryntum ?? {}), licenseKey: c.bryntumLicenseKey };
        setConfig(c);
      })
      .catch((e) => setErr(e.message));
    void reload();
  }, [reload]);

  if (err) return <div className="shell"><div className="card notice err" style={{ marginTop: 40 }}>{err}</div></div>;
  if (!config || !ws) return <div className="shell"><p style={{ marginTop: 60 }} className="muted">Setting up a private demo family…</p></div>;

  const route = hash.replace(/^#/, "");
  const deal = route.match(/^\/deal\/([\w-]+)/);
  const child = route.match(/^\/child\/([\w-]+)/);

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">
            <svg width="16" height="16" viewBox="0 0 32 32"><path d="M7 25 L16 7 L25 25 Z" fill="none" stroke="white" strokeWidth="4" strokeLinejoin="round" /></svg>
          </span>
          Their Cut
        </a>
        <nav className="nav">
          <a href="#/" className={route === "/" || route === "" || route === "new" ? "active" : ""}>Family</a>
          {ws.children.map((c: any) => (
            <a key={c.id} href={`#/child/${c.id}`} className={child?.[1] === c.id ? "active" : ""}>{c.name}'s ledger</a>
          ))}
          <a href="#/about" className={route === "/about" ? "active" : ""}>How it works</a>
        </nav>
        <div className="right">
          <span className="pill sandbox">PayPal sandbox</span>
          <button
            className="btn small ghost"
            title="Start over with a fresh demo family"
            onClick={async () => {
              setWsId(null);
              setWs(null);
              window.location.hash = "#/";
              await reload();
            }}
          >
            Reset demo
          </button>
        </div>
      </header>

      {deal ? (
        <DealPage key={deal[1]} wsId={ws.id} dealId={deal[1]} ws={ws} config={config} onChanged={reload} />
      ) : child ? (
        <ChildLedger key={child[1]} wsId={ws.id} childId={child[1]} ws={ws} />
      ) : route === "/about" ? (
        <About config={config} />
      ) : (
        <Home ws={ws} config={config} reload={reload} />
      )}

      <footer className="footer">
        Their Cut · built for the PayPal AI Hackathon · PayPal Invoicing, Payouts and Webhooks (sandbox) · Gemini on Vertex AI · Bryntum Scheduler · AG Grid.{" "}
        {config.disclaimer} Demo footage: Pexels License (see ASSETS.md). <a href="https://github.com/shivansh193/their-cut">Source</a>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
