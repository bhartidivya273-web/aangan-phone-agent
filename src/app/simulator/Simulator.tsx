"use client";

import { useEffect, useRef, useState } from "react";

type Line = { who: "agent" | "caller"; text: string };
type EndResult = { outcome: string | null; effectiveOutcome: string | null; reason: string | null; flags: string[]; handoff: string | null; wouldSend: Array<{ to: string; text: string }>; error?: string };

export function Simulator() {
  const [state, setState] = useState<unknown>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<EndResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  async function turn(st: unknown, utterance: string | null) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/simulator/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: st, utterance }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error ?? "request failed");
      setState(j.state);
      setClosed(j.closed);
      if (j.say) setLines((l) => [...l, { who: "agent", text: j.say }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (started.current) return; // React strict mode runs effects twice in dev
    started.current = true;
    turn(null, null); // greeting
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [lines, result]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy || closed) return;
    setText("");
    setLines((l) => [...l, { who: "caller", text: t }]);
    await turn(state, t);
  }

  async function end() {
    setBusy(true);
    try {
      const res = await fetch("/api/simulator/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }) });
      setResult(await res.json());
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setState(null); setLines([]); setClosed(false); setResult(null); setText("");
    turn(null, null);
  }

  return (
    <div className="chat">
      {lines.map((l, i) => <div key={i} className={`msg ${l.who}`}>{l.text}</div>)}
      {err && <p className="bad">{err}</p>}
      {!result && (
        <form onSubmit={send}>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={closed ? "The agent ended the call" : "Say something as the caller…"} disabled={busy || closed} aria-label="Caller message" />
          <button disabled={busy || closed || !text.trim()}>Send</button>
          <button type="button" className="ghost" onClick={end} disabled={busy || lines.length < 2}>End call &amp; classify</button>
        </form>
      )}
      {closed && !result && <p className="note">The agent closed the call. Click &ldquo;End call &amp; classify&rdquo; to see the outcome and the note designers would get.</p>}
      {result && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2>Result</h2>
          {result.error ? <p className="bad">{result.error}</p> : (
            <>
              <div className="big">{(result.outcome ?? "unclassified").replace(/_/g, " ")}</div>
              <div className="caption">{result.reason}</div>
              <p>{result.flags.map((f) => <span className="tag" key={f}>{f}</span>)}</p>
              {result.wouldSend.map((s, i) => <pre className="t" key={i}>{`Would send to ${s.to}:\n\n${s.text}`}</pre>)}
              {result.wouldSend.length === 0 && <p className="note">No handoff would be sent for this outcome.</p>}
            </>
          )}
          <button onClick={reset}>New call</button>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}
