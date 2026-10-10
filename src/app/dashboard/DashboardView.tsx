import type { Dashboard } from "@/lib/metrics";
import { dash, fmtInr, fmtMin, fmtPct, fmtSec, fmtUsd, fmtWhen } from "@/lib/format";

function Bar({ label, value, max, text }: { label: string; value: number; max: number; text?: string }) {
  const w = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <div className="bar">
      <span>{label}</span>
      <span className="track"><span className="fill" style={{ width: `${w}%`, display: "block" }} /></span>
      <span className="num">{text ?? value}</span>
    </div>
  );
}

function Rows({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <ul className="rows">
      {items.map(([k, v]) => (
        <li key={k}><span>{k}</span><b>{v}</b></li>
      ))}
    </ul>
  );
}

/** One number when USD_TO_INR is set; otherwise the two currencies side by side (no invented exchange rate). */
function money(inr: number | null, parts: { usd: number; inr: number } | null): string {
  if (inr !== null) return fmtInr(inr);
  if (!parts) return dash;
  return `${fmtUsd(parts.usd)} + ${fmtInr(parts.inr)}`;
}

export function DashboardView({ m, demo, tz = 330, redact = false }: { m: Dashboard; demo: boolean; tz?: number; redact?: boolean }) {
  const r = m.responsiveness;
  const l = m.leads;
  const d = m.designerResponse;
  const q = m.quality;
  const e = m.escalations;
  const c = m.cost;
  const fitTotal = d.fit.good + d.fit.poor + d.fit.notRecorded;
  const maxOutcome = Math.max(1, ...m.outcomes.byOutcome.map((o) => o.count));
  const maxDecline = Math.max(1, ...m.outcomes.declineReasons.map((o) => o.count));
  const funnelMax = Math.max(1, m.funnel.steps[0]?.count ?? 1);

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1>Aangan Studio · phone enquiries</h1>
          <div className="sub">Last {m.windowDays} days · all times IST</div>
        </div>
        <nav className="range" aria-label="Date range">
          {[7, 30, 90].map((n) => (
            <a key={n} href={`/dashboard?days=${n}`} className={n === m.windowDays ? "on" : ""}>{n} days</a>
          ))}
          <a href="/simulator">Simulator</a>
        </nav>
      </div>

      {redact && !demo && <div className="banner">Public view: no names, phone numbers, transcripts or call reasons are shown here. They stay in the private call log, Telegram and HubSpot.</div>}
      {demo && <div className="banner"><b>DEMO DATA.</b> These calls, names and amounts are synthetic, generated for layout and testing. Nothing here is real Aangan data.</div>}

      <div className="grid">
        {/* 1 */}
        <section className="panel" aria-labelledby="p1">
          <h2 id="p1">1 · Responsiveness</h2>
          <div className="big">{r.calls} <small>calls</small></div>
          <div className="caption">{r.ai} AI-handled · {r.frontDesk} answered by the front desk</div>
          <Rows items={[
            ["Median time to answer", fmtSec(r.medianAnswerSec)],
            ["90th percentile", fmtSec(r.p90AnswerSec)],
            ["Answered within 5 min", <span key="a" className={r.pctWithin5Min !== null && r.pctWithin5Min >= 90 ? "good" : "warn"}>{fmtPct(r.pctWithin5Min)}</span>],
            ["Unanswered", r.unanswered],
            ["After-hours calls", `${r.afterHoursCalls} (${fmtPct(r.pctAfterHours)})`],
          ]} />
        </section>

        {/* 2 */}
        <section className="panel" aria-labelledby="p2">
          <h2 id="p2">2 · Leads</h2>
          <div className="big">{l.notesSent} <small>notes sent to designers</small></div>
          <div className="caption">{l.updatedNotes} of them updates to an existing lead</div>
          <Rows items={[
            ["Claimed by a designer", `${l.claimed} (${fmtPct(l.claimRatePct)})`],
            ["Consultations", l.consultations],
            ["Failed sends", <span key="f" className={l.failedSends ? "bad" : ""}>{l.failedSends}</span>],
          ]} />
        </section>

        {/* 3 */}
        <section className="panel" aria-labelledby="p3">
          <h2 id="p3">3 · Designer response</h2>
          <div className="big">{fmtMin(d.medianFirstContactMin)} <small>note to first contact (median)</small></div>
          <div className="caption">Based on {d.contacted} leads where a designer replied &ldquo;called&rdquo;</div>
          <Rows items={[
            ["Median time to claim", fmtMin(d.medianClaimMin)],
            ["90th percentile to contact", fmtMin(d.p90FirstContactMin)],
            ["Unclaimed now", <span key="u" className={d.unclaimed ? "warn" : "good"}>{d.unclaimed}</span>],
            ["…past the first-contact target", <span key="o" className={d.overdue ? "bad" : "good"}>{d.overdue}</span>],
          ]} />
          <div className="stack" role="img" aria-label="Fit verdicts">
            <span style={{ width: `${fitTotal ? (d.fit.good / fitTotal) * 100 : 0}%`, background: "var(--good)" }} />
            <span style={{ width: `${fitTotal ? (d.fit.poor / fitTotal) * 100 : 0}%`, background: "var(--bad)" }} />
          </div>
          <div className="legend">
            <span><i style={{ background: "var(--good)" }} />Good fit {d.fit.good}</span>
            <span><i style={{ background: "var(--bad)" }} />Poor fit {d.fit.poor}</span>
            <span>Not recorded {d.fit.notRecorded}</span>
          </div>
        </section>

        {/* 4 */}
        <section className="panel" aria-labelledby="p4">
          <h2 id="p4">4 · Funnel</h2>
          <div className="bars">
            {m.funnel.steps.map((s) => (
              <Bar key={s.label} label={s.label} value={s.count} max={funnelMax} text={`${s.count}${s.pctOfPrev !== null ? ` · ${fmtPct(s.pctOfPrev)}` : ""}`} />
            ))}
          </div>
          <div className="note">Percentages are of the step above. Consultations and projects come from designers&rsquo; Telegram replies (&ldquo;consultation booked&rdquo;, &ldquo;signed&rdquo;).</div>
        </section>

        {/* 5 */}
        <section className="panel" aria-labelledby="p5">
          <h2 id="p5">5 · Outcomes</h2>
          <div className="bars">
            {m.outcomes.byOutcome.map((o) => (
              <Bar key={o.outcome} label={o.outcome.replace(/_/g, " ")} value={o.count} max={maxOutcome} text={`${o.count} · ${fmtPct(o.pct)}`} />
            ))}
            {m.outcomes.unclassified > 0 && <Bar label="not classified" value={m.outcomes.unclassified} max={maxOutcome} />}
          </div>
          <div className="caption" style={{ marginTop: 12 }}>Why calls were declined</div>
          <div className="bars">
            {m.outcomes.declineReasons.length === 0 ? <span className="note">No declined calls in this window.</span> : m.outcomes.declineReasons.map((x) => <Bar key={x.label} label={x.label} value={x.count} max={maxDecline} />)}
          </div>
        </section>

        {/* 6 */}
        <section className="panel" aria-labelledby="p6">
          <h2 id="p6">6 · Quality</h2>
          <div className="big">{fmtPct(q.avgCompletenessPct)} <small>of key fields captured</small></div>
          <div className="caption">On {q.qualifiedCalls} qualified calls</div>
          <div className="bars">
            {q.fieldsCaptured.map((f) => <Bar key={f.field} label={f.field} value={f.pct ?? 0} max={100} text={fmtPct(f.pct)} />)}
          </div>
          <Rows items={[
            ["Hang-ups under 30 s", `${q.hangupsUnder30s} (${fmtPct(q.hangupsPct)})`],
            ["Asked for a human", q.humanRequests],
            ["Could not understand", q.notUnderstood],
          ]} />
        </section>

        {/* 7 */}
        <section className="panel" aria-labelledby="p7">
          <h2 id="p7">7 · Escalations</h2>
          <div className="big">{e.count} <small>complaints</small></div>
          <div className="caption">{e.open} awaiting callback · <span className={e.overdue ? "bad" : ""}>{e.overdue} overdue</span></div>
          <Rows items={[["Median time to callback", fmtMin(e.medianCallbackMin)]]} />
          <table style={{ marginTop: 8 }}>
            <tbody>
              {e.items.slice(0, 5).map((x) => (
                <tr key={x.callId}>
                  <td>{redact ? fmtWhen(x.at, tz) : <a href={`/dashboard/calls/${x.callId}`}>{fmtWhen(x.at, tz)}</a>}</td>
                  <td>{x.callbackMin !== null ? <span className="good">called back in {fmtMin(x.callbackMin)}</span> : x.overdue ? <span className="bad">overdue</span> : <span className="warn">open</span>}</td>
                </tr>
              ))}
              {e.items.length === 0 && <tr><td className="note">None in this window.</td></tr>}
            </tbody>
          </table>
        </section>

        {/* 8 */}
        <section className="panel" aria-labelledby="p8">
          <h2 id="p8">8 · Cost</h2>
          <div className="big">{c.totalInr !== null ? fmtInr(c.totalInr) : <>{fmtUsd(c.totalUsd)} <small>+</small> {fmtInr(c.totalInrPart)}</>} <small>in {m.windowDays} days</small></div>
          <div className="caption">{c.projectedMonthInr !== null ? `≈ ${fmtInr(c.projectedMonthInr)} per month at this rate` : "Monthly projection needs USD_TO_INR"}</div>
          <Rows items={[
            ["Cost per call", money(c.perCallInr, c.perCallParts)],
            ["Cost per qualified lead", money(c.perQualifiedLeadInr, c.perQualifiedLeadParts)],
            [`vs ₹${(c.avgProjectLow / 100000).toFixed(0)}–${(c.avgProjectHigh / 100000).toFixed(0)} lakh avg project`, c.pctOfProjectHigh !== null ? `${c.pctOfProjectHigh}–${c.pctOfProjectLow}%` : dash],
            ["AI model usage", fmtUsd(c.llmUsd)],
            ["Voice minutes", fmtInr(c.voiceInr)],
            ["Telephony", c.telephonyUsd ? `${fmtInr(c.telephonyInr)} + ${fmtUsd(c.telephonyUsd)}` : fmtInr(c.telephonyInr)],
          ]} />
          {c.currencyNote && <div className="note">USD_TO_INR is not set, so model costs (USD) and voice/telephony costs (INR) are shown side by side. Set it to see one rupee total and the share of average project value.</div>}
        </section>

        {/* 9 */}
        <section className="panel wide" aria-labelledby="p9">
          <h2 id="p9">9 · Review: declined calls</h2>
          <div className="caption">Every declined call stays on record. Open one to read the transcript and judge whether the decline was right.</div>
          <table>
            <thead><tr><th>When</th><th>Caller</th><th>Outcome</th><th>Reason</th><th>Flags</th></tr></thead>
            <tbody>
              {m.review.map((x) => (
                <tr key={x.callId}>
                  <td>{redact ? fmtWhen(x.at, tz) : <a href={`/dashboard/calls/${x.callId}`}>{fmtWhen(x.at, tz)}</a>}</td>
                  <td>{redact ? "hidden" : `•••• ${x.phoneLast4}`}</td>
                  <td>{x.outcome.replace(/_/g, " ")}</td>
                  <td>{redact ? "hidden in public view" : (x.reason ?? dash)}</td>
                  <td>{x.flags.map((f) => <span className="tag" key={f}>{f}</span>)}</td>
                </tr>
              ))}
              {m.review.length === 0 && <tr><td colSpan={5} className="note">No declined calls in this window.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
