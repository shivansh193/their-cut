import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { api, navigate, usd } from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "Inter, system-ui, sans-serif",
  headerFontWeight: 600,
  backgroundColor: "#ffffff",
  foregroundColor: "#2d2a26",
  headerBackgroundColor: "#f7f1ea",
  borderColor: "#ece4d9",
  accentColor: "#e07a5f",
  rowHoverColor: "#fdf6ef",
  borderRadius: 10,
  wrapperBorderRadius: 12,
});

export default function ChildLedger({ wsId, childId, ws }: { wsId: string; childId: string; ws: any }) {
  const [data, setData] = useState<any>(null);
  const [verify, setVerify] = useState<any>(null);
  useEffect(() => {
    api("GET", `/api/ws/${wsId}/children/${childId}/ledger`).then(setData);
    api("GET", `/api/ws/${wsId}/ledger`).then((l) => setVerify(l.verify));
  }, [wsId, childId]);

  const cols = useMemo<ColDef[]>(
    () => [
      { field: "date", headerName: "Date", width: 115, sort: "asc" },
      { field: "video", headerName: "Video", flex: 2, minWidth: 220, valueFormatter: (p) => String(p.value).replace(/ \(.*\)$/, "") },
      { field: "brand", headerName: "Paid by", width: 130 },
      { field: "presencePct", headerName: "% of video", width: 115, type: "rightAligned", valueFormatter: (p) => `${p.value.toFixed(1)}%`, cellRenderer: (p: any) => `${p.value.toFixed(1)}%${p.data.adjusted ? " ✎" : ""}` },
      { field: "windowPresencePct", headerName: "% over window", width: 135, type: "rightAligned", valueFormatter: (p) => `${p.value.toFixed(1)}%` },
      { field: "grossCents", headerName: "Brand paid", width: 125, type: "rightAligned", valueFormatter: (p) => usd(p.value) },
      { field: "setAsideCents", headerName: "Set aside for you", width: 150, type: "rightAligned", valueFormatter: (p) => usd(p.value), cellStyle: { fontWeight: 600 } },
      { field: "state", headerName: "Law", width: 80 },
      {
        field: "transactionIds",
        headerName: "PayPal transaction",
        flex: 1,
        minWidth: 190,
        valueFormatter: (p) => (p.data.seeded ? "demo history (no money moved)" : p.value?.length ? p.value.join(", ") : p.data.status),
      },
      { field: "invoiceId", headerName: "Invoice", width: 210, hide: false },
      {
        headerName: "Evidence",
        width: 110,
        cellRenderer: () => "View →",
        onCellClicked: (p: any) => navigate(`#/deal/${p.data.dealId}`),
        cellStyle: { color: "#b5543b", cursor: "pointer" },
      },
    ],
    [],
  );

  if (!data) return <div className="card">Loading ledger…</div>;
  const child = ws.children.find((c: any) => c.id === childId);
  return (
    <div>
      <a href="#/">← Family</a>
      <div className="row" style={{ margin: "12px 0 16px", alignItems: "flex-end" }}>
        <img className="avatar" src={`/media/references/${childId}.jpg`} alt="" style={{ ["--c" as any]: child?.color }} />
        <div>
          <div className="muted">What {data.child.name} will see at 18</div>
          <h1>{data.child.name}'s ledger</h1>
        </div>
        <span className="spacer" />
        <div style={{ textAlign: "right" }}>
          <div className="muted">Held in trust</div>
          <div className="big-num">{usd(data.totalSetAsideCents)}</div>
        </div>
      </div>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Every paid video {data.child.name} was in: how much of it they were in, what the brand paid, what was set aside for them under the law, and the PayPal transaction that moved it into {data.child.trustLabel.toLowerCase()}.
        </p>
        <div className="row">
          {verify && <span className={`pill ${verify.ok ? "ok" : "bad"}`}>{verify.ok ? "✓ Record intact: every entry's hash chains to the one before" : `Record altered at entry ${verify.brokenAt}`}</span>}
          <span className="spacer" />
          <a className="btn small" href={`/api/ws/${wsId}/ledger`} target="_blank" rel="noreferrer">Raw audit trail</a>
        </div>
        <div className="ledger-grid">
          <AgGridReact theme={theme} rowData={data.rows} columnDefs={cols} domLayout="normal" animateRows suppressCellFocus />
        </div>
        <p className="muted">✎ means a parent corrected the measurement; the original and the change are both in the audit trail.</p>
      </div>
    </div>
  );
}
