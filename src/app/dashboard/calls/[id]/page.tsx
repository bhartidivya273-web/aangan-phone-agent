import { getConfig } from "@/lib/config";
import { getDashboardSource } from "@/lib/dashboardSource";
import { dash, fmtUsd, fmtWhen } from "@/lib/format";
import { isPublicView } from "@/lib/publicView";

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = getConfig();
  if (isPublicView()) {
    return (
      <div className="wrap">
        <p><a href="/dashboard">← Dashboard</a></p>
        <h1>Call details are private</h1>
        <p className="note">This is the public dashboard. Transcripts, names and phone numbers are only available in the private call log (and in Telegram and HubSpot).</p>
      </div>
    );
  }
  try {
    const src = getDashboardSource();
    const d = await src.store.getCallDetail(id);
    if (!d) return <div className="wrap"><p><a href="/dashboard">← Dashboard</a></p><h1>Call not found</h1></div>;
    const { call, costs, handoffs, lead } = d;
    const turns = (call.transcript ?? "").split(/ (?=(?:AI Agent|Caller|Front Desk): )/).filter(Boolean);
    return (
      <div className="wrap">
        <p><a href="/dashboard">← Dashboard</a>{src.demo && <span className="tag" style={{ marginLeft: 8 }}>demo data</span>}</p>
        <h1>{call.outcome?.replace(/_/g, " ") ?? "not classified"} · {fmtWhen(call.started_at, cfg.tzOffsetMinutes)}</h1>
        <p>{call.reason ?? dash}</p>
        <dl className="kv">
          <dt>Caller</dt><dd>{call.caller_phone ?? dash} ({call.source === "ai" ? "AI answered" : "front desk answered"})</dd>
          <dt>Duration</dt><dd>{call.duration_sec != null ? `${call.duration_sec} s` : dash}</dd>
          <dt>Flags</dt><dd>{call.flags.length ? call.flags.map((f) => <span className="tag" key={f}>{f}</span>) : dash}</dd>
          <dt>Code guards applied</dt><dd>{call.guards.length ? call.guards.join(", ") : "none"}</dd>
          <dt>Lead status</dt><dd>{lead ? `${lead.status} · ${lead.call_count} call(s)` : dash}</dd>
          {Object.entries(call.extracted).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => (
            <><dt key={`k${k}`}>{k.replace(/_/g, " ")}</dt><dd key={`v${k}`}>{String(v)}</dd></>
          ))}
        </dl>
        <h2>Transcript</h2>
        {turns.length ? turns.map((t, i) => { const [who, ...rest] = t.split(": "); return <div className="turn" key={i}><b>{who}</b> {rest.join(": ")}</div>; }) : <p className="note">No transcript stored for this call.</p>}
        <h2>Handoffs</h2>
        {handoffs.length ? handoffs.map((h) => <pre className="t" key={h.id}>{`${h.kind} · ${h.status}${h.claimed_by ? ` · claimed by ${h.claimed_by}` : ""}\n\n${h.note_text}`}</pre>) : <p className="note">No note was sent for this call.</p>}
        <h2>Cost</h2>
        <ul className="rows">
          {costs.map((c, i) => <li key={i}><span>{c.kind}{c.model ? ` (${c.model})` : ""}</span><b>{c.currency === "USD" ? fmtUsd(c.amount) : `₹${c.amount.toFixed(2)}`}</b></li>)}
          {costs.length === 0 && <li><span>No cost rows</span><b>{dash}</b></li>}
        </ul>
      </div>
    );
  } catch (e) {
    return <div className="wrap"><h1>Unavailable</h1><p className="bad">{(e as Error).message}</p></div>;
  }
}
