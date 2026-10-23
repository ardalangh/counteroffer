// The negotiation monitor.
//
// Data path: a bridge running next to the seller's Snowflake account publishes
// NEGOTIATIONS / NEGOTIATION_LEDGER / ORDERS into Firestore under
// workspaces/{uid}/..., and this page renders them live. Approve and Decline
// write a command document that the bridge executes with PUBLIC.APPROVE_ORDER.
// With no bridge connected it shows the demo dataset, labelled as such.
//
// Buyer text is attacker-controlled. React escapes every string it renders and
// nothing here uses dangerouslySetInnerHTML, so it can only ever be text.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  addDoc, collection, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp
} from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { useSession } from "../lib/session.jsx";
import { ago, asDate, big, clockTime, money, num, pct, termsStr } from "../lib/format.js";
import { actorOf, answerOf, flagCounts, flagsOf, matches, sortData, statusOf } from "../lib/monitor.js";
import { demoData } from "../data/demoTrace.js";
import { CodeBlock } from "../components/Copy.jsx";
import "../styles/console.css";

const EVENT_LIMIT = 500;
const PAGE = 60;
const STALE_MS = 90000;

function Status({ value }) {
  const [label, tone] = statusOf(value);
  return <span className={"status " + tone}>{label}</span>;
}

export default function Console() {
  const { user, preview } = useSession();
  const uid = user && user.uid;
  const email = (user && (user.email || user.displayName)) || "you";
  const [params, setParams] = useSearchParams();

  const [live, setLive] = useState({ meta: null, negotiations: null, events: null, orders: null });
  const [commands, setCommands] = useState(new Map());
  const [demo, setDemo] = useState(null);
  const [company, setCompany] = useState("");
  const [scope, setScope] = useState("one");
  const [filters, setFilters] = useState({ q: "", actor: "", action: "", flagged: false });
  const [shown, setShown] = useState(PAGE);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [, setTick] = useState(0);
  const seen = useRef(new Set());
  const painted = useRef(false);

  useEffect(() => { document.title = "Monitor · Counteroffer"; }, []);

  // Keep "x minutes ago" honest.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setTick(x => x + 1); }, 15000);
    return () => clearInterval(t);
  }, []);

  // ---------- subscriptions ----------
  useEffect(() => {
    if (!uid) return undefined;
    if (preview) { setLive({ meta: {}, negotiations: [], events: [], orders: [] }); return undefined; }

    getDoc(doc(db, "workspaces", uid))
      .then(s => setCompany(s.exists() ? String(s.data().company || "").trim() : ""))
      .catch(() => {});

    const ws = ["workspaces", uid];
    const put = key => value => setLive(l => ({ ...l, [key]: value }));
    const onErr = key => err => { console.warn("snapshot error (" + key + ")", err); setLive(l => ({ ...l, [key]: l[key] || (key === "meta" ? {} : []) })); };

    const unsubs = [
      onSnapshot(doc(db, ...ws, "meta", "bridge"), s => put("meta")(s.exists() ? s.data() : {}), onErr("meta")),
      onSnapshot(collection(db, ...ws, "negotiations"),
        s => put("negotiations")(s.docs.map(d => ({ id: d.id, ...d.data() }))), onErr("negotiations")),
      onSnapshot(query(collection(db, ...ws, "events"), orderBy("event_id", "desc"), limit(EVENT_LIMIT)),
        s => put("events")(s.docs.map(d => d.data())), onErr("events")),
      onSnapshot(collection(db, ...ws, "orders"),
        s => put("orders")(s.docs.map(d => ({ order_id: d.id, ...d.data() }))), onErr("orders")),
      onSnapshot(query(collection(db, ...ws, "commands"), orderBy("created_at", "desc"), limit(40)), s => {
        const m = new Map();
        s.docs.forEach(d => { const c = d.data(); if (c.order_id && !m.has(c.order_id)) m.set(c.order_id, { _id: d.id, ...c }); });
        setCommands(m);
      }, () => {})
    ];
    return () => unsubs.forEach(u => u());
  }, [uid, preview]);

  const ready = live.events !== null && live.negotiations !== null;
  const hasLive = ready && ((live.events && live.events.length) || (live.negotiations && live.negotiations.length));

  useEffect(() => { if (ready && !hasLive && !demo) setDemo(demoData()); }, [ready, hasLive, demo]);

  const data = useMemo(() => {
    if (!ready) return null;
    if (hasLive) {
      return sortData({
        meta: { source: "snowflake", ...(live.meta || {}) },
        negotiations: live.negotiations || [], events: live.events || [], orders: live.orders || []
      });
    }
    return demo ? sortData(demo) : null;
  }, [ready, hasLive, live, demo]);

  const isDemo = !!data && data.meta.source === "demo";
  const selectedId = data && (data.negotiations.some(n => n.id === params.get("n"))
    ? params.get("n") : (data.negotiations[0] && data.negotiations[0].id)) || null;
  const selected = data && data.negotiations.find(n => n.id === selectedId);

  const eventsFor = id => data.events.filter(e => e.negotiation_id === id);

  const visible = useMemo(() => {
    if (!data) return [];
    const base = scope === "all" ? data.events : data.events.filter(e => e.negotiation_id === selectedId);
    return base.filter(e => matches(e, filters));
  }, [data, scope, selectedId, filters]);

  // Announce new moves (screen readers), mark them fresh (visual).
  const freshKeys = useMemo(() => {
    const fresh = new Set();
    if (!data) return fresh;
    for (const e of data.events) {
      const key = e.negotiation_id + ":" + e.event_id;
      if (painted.current && !seen.current.has(key)) fresh.add(key);
    }
    return fresh;
  }, [data]);
  useEffect(() => {
    if (!data) return;
    const flagged = data.events.filter(e => freshKeys.has(e.negotiation_id + ":" + e.event_id) && flagsOf(e).length);
    if (flagged.length) setAnnounce(flagged.length + " flagged move" + (flagged.length === 1 ? "" : "s") + " in " + (flagged[0].negotiation_id || "a negotiation") + ".");
    else if (freshKeys.size) setAnnounce(freshKeys.size + " new move" + (freshKeys.size === 1 ? "" : "s") + ".");
    data.events.forEach(e => seen.current.add(e.negotiation_id + ":" + e.event_id));
    painted.current = true;
  }, [data, freshKeys]);

  function select(id) {
    const p = new URLSearchParams(params);
    p.set("n", id);
    setParams(p, { replace: true });
    setScope("one");
    setShown(PAGE);
    requestAnimationFrame(() => document.getElementById("trace")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  async function decide(order, decision) {
    const verb = decision === "APPROVE" ? "Approve" : "Decline";
    if (!window.confirm(verb + " " + order.order_id + "?\n\n" + money(order.rate) + " per load, " + big(order.tcv) +
      " contract value. This writes your decision to Snowflake.")) return;

    if (isDemo) {
      setDemo(d => {
        const next = { ...d, orders: d.orders.map(o => o.order_id !== order.order_id ? o : {
          ...o, status: decision === "APPROVE" ? "CONFIRMED" : "REJECTED", decided_by: email, decided_at: new Date().toISOString()
        }) };
        const nextId = Math.max(0, ...d.events.map(e => num(e.event_id) || 0)) + 1;
        next.events = [{
          event_id: nextId, ts: new Date().toISOString(), negotiation_id: order.negotiation_id,
          actor: "HUMAN", action: "APPROVE", decision,
          note: "Order " + order.order_id + " " + (decision === "APPROVE" ? "approved" : "declined") + " by " + email, flags: []
        }, ...d.events];
        return next;
      });
      setAnnounce("Order " + order.order_id + (decision === "APPROVE" ? " approved." : " declined."));
      return;
    }
    try {
      await addDoc(collection(db, "workspaces", uid, "commands"), {
        type: "APPROVE_ORDER", order_id: order.order_id, decision, status: "QUEUED",
        requested_by: email, created_at: serverTimestamp()
      });
      setAnnounce("Sent your decision on " + order.order_id + ".");
    } catch (e) {
      console.error(e);
      window.alert("Couldn't send that decision (" + (e.code || "error") + "). Check that the bridge is running.");
    }
  }

  if (!data) return <div className="loading" role="status">Loading your negotiations…</div>;

  const pending = data.orders.filter(o => o.status === "PENDING_APPROVAL");
  const decided = data.orders.filter(o => o.status !== "PENDING_APPROVAL")
    .sort((a, b) => (asDate(b.decided_at || b.created_at) || 0) - (asDate(a.decided_at || a.created_at) || 0)).slice(0, 2);

  return (
    <div className="wrap page monitor">
      <div className="pagehead">
        <h1>Negotiations</h1>
        <p>What your selling agent and your buyers' agents did, and what needs you.{company && <span className="muted"> {company}.</span>}</p>
      </div>

      <StatusLine data={data} isDemo={isDemo} bridgeOpen={bridgeOpen} onBridge={() => setBridgeOpen(o => !o)} />
      {bridgeOpen && <BridgeHelp email={email} />}

      <section className="sheet decide" aria-labelledby="decide-h">
        <div className="sheet-head">
          <h2 id="decide-h">Needs your decision</h2>
          <span className="aside">{pending.length ? "over your auto-approval limit" : "nothing waiting"}</span>
        </div>
        {!pending.length && !decided.length && (
          <p className="empty">Deals under your auto-approval limit book themselves. Anything above it waits here for you.</p>
        )}
        {pending.concat(decided).map(o => (
          <OrderRow key={o.order_id} order={o} command={commands.get(o.order_id)} onDecide={decide} onTrace={select} />
        ))}
      </section>

      <div className="split">
        <nav className="sheet rail" aria-labelledby="rail-h">
          <div className="sheet-head">
            <h2 id="rail-h">All negotiations</h2>
            <span className="aside">{data.negotiations.length || ""}</span>
          </div>
          {data.negotiations.length === 0
            ? <p className="empty">Nothing yet. The first time a buyer's agent calls your storefront it shows up here.</p>
            : (
              <ul className="neglist">
                {data.negotiations.map(n => {
                  const ev = eventsFor(n.id);
                  const { inj, probe } = flagCounts(ev);
                  return (
                    <li key={n.id}>
                      <button type="button" aria-current={n.id === selectedId ? "true" : undefined} onClick={() => select(n.id)}>
                        <span className="cust">{String(n.customer || "Unknown buyer")}</span>
                        <span className="meta">
                          <span className="mono">{n.id}</span>
                          <Status value={n.status} />
                          {ev[0] && <span>{ago(ev[0].ts)}</span>}
                          {inj > 0 && <span className="warn">{inj} injection{inj === 1 ? "" : "s"}</span>}
                          {probe > 0 && <span className="warn probe">probing</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
        </nav>

        <div className="detail">
          {selected ? <Detail n={selected} events={eventsFor(selected.id)} /> : (
            <section className="sheet"><p className="empty">Pick a negotiation to see what happened.</p></section>
          )}

          <section className="sheet tracesheet" id="trace" aria-labelledby="trace-h">
            <div className="sheet-head">
              <h2 id="trace-h">Trace</h2>
              <div className="seg" role="group" aria-label="Which negotiations to show">
                <button type="button" aria-pressed={scope === "one"} onClick={() => { setScope("one"); setShown(PAGE); }}>Selected</button>
                <button type="button" aria-pressed={scope === "all"} onClick={() => { setScope("all"); setShown(PAGE); }}>Everything</button>
              </div>
            </div>

            <div className="filters">
              <div className="search">
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
                <input className="input" type="search" placeholder="Search messages, hints and rates" autoComplete="off" spellCheck="false"
                  aria-label="Search the trace" value={filters.q}
                  onChange={e => { setFilters(f => ({ ...f, q: e.target.value })); setShown(PAGE); }} />
              </div>
              <select className="select" aria-label="Filter by who moved" value={filters.actor}
                onChange={e => { setFilters(f => ({ ...f, actor: e.target.value })); setShown(PAGE); }}>
                <option value="">Anyone</option>
                <option value="BUYER">Buyer agent</option>
                <option value="SELLER_AGENT">Your agent</option>
                <option value="HUMAN">You</option>
                <option value="SYSTEM">System</option>
              </select>
              <select className="select" aria-label="Filter by kind of move" value={filters.action}
                onChange={e => { setFilters(f => ({ ...f, action: e.target.value })); setShown(PAGE); }}>
                <option value="">Every move</option>
                <option value="MESSAGE">Messages</option>
                <option value="OFFER">Offers</option>
                <option value="QUOTE">Quotes</option>
                <option value="START">Opened</option>
                <option value="COMMIT">Bookings</option>
                <option value="APPROVE">Approvals</option>
                <option value="FUEL_UPDATE">Fuel updates</option>
              </select>
              <label className="check">
                <input type="checkbox" checked={filters.flagged}
                  onChange={e => { setFilters(f => ({ ...f, flagged: e.target.checked })); setShown(PAGE); }} />
                Flagged only
              </label>
              <span className="count" aria-live="polite">
                {visible.length ? (Math.min(shown, visible.length) < visible.length ? Math.min(shown, visible.length) + " of " : "") + visible.length + (visible.length === 1 ? " move" : " moves") : ""}
              </span>
            </div>

            <div className="table-scroll">
              <table className="trace">
                <caption className="sr-only">Negotiation trace, newest first</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">Who</th><th scope="col">Move</th><th scope="col" className="r">Result</th></tr></thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr><td colSpan={4} className="none">{data.events.length ? "Nothing matches those filters." : "No moves recorded yet."}</td></tr>
                  )}
                  {visible.slice(0, shown).map(e => (
                    <TraceRow key={e.negotiation_id + ":" + e.event_id} e={e} scope={scope}
                      listRate={selected ? num(selected.list_rate) : null}
                      fresh={freshKeys.has(e.negotiation_id + ":" + e.event_id)} onSelect={select} />
                  ))}
                </tbody>
              </table>
            </div>
            {visible.length > shown && (
              <div className="sheet-foot">
                <button type="button" className="btn btn-sm" onClick={() => setShown(s => s + PAGE)}>Show older moves</button>
              </div>
            )}
          </section>
        </div>
      </div>

      <p className="muted small footnote">
        Buyer messages are shown as plain text, never as markup. The ledger is append-only in Snowflake and this page
        only reads it. The one thing it writes back is your approval.
      </p>
      <div className="sr-only" aria-live="polite">{announce}</div>
    </div>
  );
}

function StatusLine({ data, isDemo, bridgeOpen, onBridge }) {
  const sync = asDate(data.meta.last_sync);
  const stale = !isDemo && sync && Date.now() - sync.getTime() > STALE_MS;
  const open = data.negotiations.filter(n => n.status === "OPEN" || n.status === "FINAL").length;
  const pending = data.orders.filter(o => o.status === "PENDING_APPROVAL");
  const pendingValue = pending.reduce((s, o) => s + (num(o.tcv) || 0), 0);
  const booked = data.orders.filter(o => o.status === "CONFIRMED");
  const bookedValue = booked.reduce((s, o) => s + (num(o.tcv) || 0), 0);
  const { inj, probe } = flagCounts(data.events);
  const source = isDemo ? ["Worked example", "amber"] : stale ? ["Bridge stalled", "red"] : ["Live", "green"];

  return (
    <>
      <div className="statusline">
        <span className={"status " + source[1] + (source[0] === "Live" ? " pulse" : "")}><b>{source[0]}</b></span>
        <span className="figures">
          <span><b>{open}</b> live</span>
          {pending.length > 0 && <span className="due"><b>{pending.length}</b> waiting on you, {big(pendingValue)}</span>}
          {inj + probe > 0 && <span className="alert"><b>{inj + probe}</b> attempt{inj + probe === 1 ? "" : "s"} blocked</span>}
          {booked.length > 0 && <span><b>{big(bookedValue)}</b> booked</span>}
        </span>
        <span className="grow" />
        <span className="readout">Diesel <span className="mono">{data.meta.diesel != null ? "$" + Number(data.meta.diesel).toFixed(2) : "—"}</span></span>
        {!isDemo && <span className="readout">Updated {ago(sync)}</span>}
        <button type="button" className="linkbtn small" aria-expanded={bridgeOpen} onClick={onBridge}>
          {bridgeOpen ? "Hide setup" : isDemo ? "Connect your data" : "Bridge setup"}
        </button>
      </div>
      {isDemo && <p className="srcnote">No bridge is connected, so this is a worked example built from our test run. Connect your data to see your own negotiations.</p>}
      {stale && <p className="srcnote bad">The bridge hasn't checked in for a while. Restart it to resume live updates.</p>}
    </>
  );
}

function BridgeHelp({ email }) {
  const cmd = [
    "# in your counteroffer checkout",
    "python3 -m venv bridge/.venv && bridge/.venv/bin/pip install -r bridge/requirements.txt",
    "",
    "COUNTEROFFER_SF_ENV=~/.snowflake/counteroffer.env \\",
    "CO_FB_EMAIL=" + (email || "you@example.com") + " \\",
    "CO_FB_PASSWORD='<your Counteroffer password>' \\",
    "  bridge/.venv/bin/python bridge/counteroffer_bridge.py --watch"
  ].join("\n");
  return (
    <section className="sheet bridge" aria-labelledby="bridge-h">
      <div className="sheet-body">
        <h2 id="bridge-h">Stream your Snowflake ledger into this page</h2>
        <p>
          The bridge runs next to your Snowflake account and publishes <code>NEGOTIATION_LEDGER</code>,{" "}
          <code>NEGOTIATIONS</code> and <code>ORDERS</code> as they change. Your approvals here go back to{" "}
          <code>PUBLIC.APPROVE_ORDER</code>.
        </p>
        <CodeBlock wrap>{cmd}</CodeBlock>
        <p className="muted small">
          Your cost basis and floor stay in Snowflake. The bridge publishes how far an offer sits from the floor, not
          the number, unless you pass <code>--include-floor</code>.{" "}
          <a href="https://github.com/ardalangh/counteroffer/blob/main/bridge/README.md" target="_blank" rel="noopener noreferrer">Setup guide</a>
        </p>
      </div>
    </section>
  );
}

function OrderRow({ order: o, command: cmd, onDecide, onTrace }) {
  const pending = o.status === "PENDING_APPROVAL";
  const busy = cmd && (cmd.status === "QUEUED" || cmd.status === "RUNNING");
  return (
    <div className={"order" + (pending ? " pending" : "")}>
      <div className="order-main">
        <div className="order-line">
          <span className="mono oid">{String(o.order_id)}</span>
          <span className="mono amount">{big(o.tcv)}</span>
          <Status value={o.status} />
        </div>
        <div className="order-terms">
          {[o.customer, o.lane, money(o.rate) + " per load", termsStr(o)].filter(Boolean).join(" · ")}
          {o.negotiation_id && <> · <button type="button" className="linkbtn" onClick={() => onTrace(o.negotiation_id)}>See the trace</button></>}
        </div>
      </div>
      <div className="order-acts">
        {pending ? (
          busy ? <span className="muted small">{cmd.decision === "APPROVE" ? "Approving…" : "Declining…"}</span>
          : cmd && cmd.status === "ERROR" ? <span className="error">Bridge error: {String(cmd.result || "failed")}</span>
          : (
            <>
              <button type="button" className="btn btn-sm" onClick={() => onDecide(o, "REJECT")}>Decline</button>
              <button type="button" className="btn btn-sm btn-good" onClick={() => onDecide(o, "APPROVE")}>Approve</button>
            </>
          )
        ) : (
          o.decided_at ? <span className="muted small">Decided {ago(o.decided_at)}</span> : null
        )}
      </div>
    </div>
  );
}

function Detail({ n, events }) {
  const { inj, probe } = flagCounts(events);
  const lst = num(n.list_rate), off = num(n.last_offer_rate);
  const [answer] = answerOf(n.last_decision);
  return (
    <section className="sheet dsheet" aria-labelledby="detail-h">
      <div className="sheet-body">
        <div className="d-name">
          <h2 id="detail-h">{String(n.customer || "Unknown buyer")}</h2>
          <span className="mono muted small">{n.id}</span>
          <Status value={n.status} />
        </div>
        <p className="d-route">
          {[n.origin && n.destination ? n.origin + " to " + n.destination : n.lane,
            num(n.loads_per_week) != null ? n.loads_per_week + " loads a week" : null,
            num(n.term_months) != null ? n.term_months + "-month term" : null,
            n.tier ? String(n.tier).charAt(0) + String(n.tier).slice(1).toLowerCase() + " tier" : null,
            "opened " + ago(n.created_at)].filter(Boolean).join(" · ")}
        </p>

        <PriceScale n={n} />

        <dl className="facts">
          <div><dt>Buyer's last offer</dt><dd className="mono">{money(n.last_offer_rate)}</dd><dd className="sub">{n.last_offer_terms || ""}</dd></div>
          <div><dt>Your agent said</dt><dd>{answer}</dd><dd className="sub">{n.last_counter_rate && n.last_decision !== "ACCEPT" ? "countered " + money(n.last_counter_rate) : ""}</dd></div>
          <div><dt>List rate</dt><dd className="mono">{money(lst)}</dd><dd className="sub">{off && lst ? ((1 - off / lst) * 100).toFixed(1) + "% off list on the table" : ""}</dd></div>
          <div><dt>Rounds used</dt><dd>{(num(n.rounds_used) || 0) + " of " + (num(n.rounds_max) || 8)}</dd>
            <dd className={"sub" + (inj + probe ? " warntext" : "")}>{inj || probe ? [inj ? inj + " injection" : null, probe ? "probing" : null].filter(Boolean).join(", ") + " flagged" : "nothing flagged"}</dd></div>
        </dl>
      </div>
    </section>
  );
}

// A price line with up to four stops. With include_floor the seller sees the
// floor; otherwise the bridge sends only the distance, so there's no floor stop.
function PriceScale({ n }) {
  const list = num(n.list_rate), offer = num(n.last_offer_rate);
  const counter = num(n.last_counter_rate), floor = num(n.floor);
  const abovePct = num(n.above_floor_pct);
  if (!list && !offer) return <p className="scale-say muted">No offer on the table yet.</p>;

  const vals = [list, offer, counter, floor].filter(v => v != null);
  const lo = Math.min(...vals) * 0.985, hi = Math.max(...vals) * 1.015;
  const at = v => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) + "%";
  const bits = [];
  if (offer != null) bits.push("buyer's offer " + money(offer));
  if (floor != null) bits.push("your floor " + money(floor));
  if (counter != null) bits.push("your counter " + money(counter));
  if (list != null) bits.push("list rate " + money(list));

  let say = null;
  if (floor == null) {
    say = abovePct != null
      ? <>The offer on the table is <b>{pct(Math.abs(abovePct))} {abovePct >= 0 ? "above" : "below"} your floor</b> for these terms. <span className="muted">The bridge publishes that distance, not the floor itself.</span></>
      : <span className="muted">Run the bridge with --include-floor to show your floor here.</span>;
  } else if (offer != null) {
    const m = offer - floor;
    say = <>{m >= 0 ? "Clears your floor by " : "Sits below your floor by "}<b>{money(Math.abs(m))} ({pct(Math.abs(m / floor) * 100)})</b><span className="muted">. Your agent never saw either number.</span></>;
  }

  return (
    <div className="scale">
      <div className="scale-track" role="img" aria-label={"Price scale: " + bits.join(", ")}>
        {floor != null && offer != null && (
          <div className={"scale-fill" + (offer < floor ? " under" : "")}
            style={{ left: at(Math.min(floor, offer)), width: `calc(${at(Math.max(floor, offer))} - ${at(Math.min(floor, offer))})` }} />
        )}
        {floor != null && <Stop at={at(floor)} cls="floor" value={floor} label="your floor" />}
        {offer != null && <Stop at={at(offer)} cls="offer" value={offer} label="their offer" />}
        {counter != null && <Stop at={at(counter)} cls="counter" value={counter} label="your counter" />}
        {list != null && <Stop at={at(list)} cls="list" value={list} label="list" />}
      </div>
      {say && <p className="scale-say">{say}</p>}
    </div>
  );
}

function Stop({ at, cls, value, label }) {
  return (
    <div className={"stop " + cls} style={{ left: at }}>
      <b className="mono">{money(value, false)}</b><i /><span>{label}</span>
    </div>
  );
}

function TraceRow({ e, scope, listRate, fresh, onSelect }) {
  const flags = flagsOf(e);
  const inj = flags.includes("INJECTION_SUSPECTED"), probe = flags.includes("PROBING_SUSPECTED");
  const rate = num(e.rate);
  const cls = [fresh ? "fresh" : "", inj ? "flag-inj" : probe ? "flag-probe" : ""].filter(Boolean).join(" ");
  const M = ({ v }) => <span className="mono money">{money(v)}</span>;

  let what;
  switch (e.action) {
    case "MESSAGE": what = <q>{String(e.note || "")}</q>; break;
    case "OFFER": what = (
      <>Offered <M v={rate} />{rate != null && listRate ? <span className="muted"> ({((1 - rate / listRate) * 100).toFixed(0)}% off list)</span> : null}
        {termsStr(e) && <span className="terms">{termsStr(e)}</span>}</>
    ); break;
    case "QUOTE": what = <>Quoted the list rate <M v={rate} /></>; break;
    case "START": what = <>Opened the negotiation{e.note ? ": " + e.note : ""}{termsStr(e) && <span className="terms">{termsStr(e)}</span>}</>; break;
    case "COMMIT": what = <>Booked the order at <M v={rate} />{e.note && <span className="terms">{String(e.note)}</span>}</>; break;
    default: what = String(e.note || e.action || "");
  }

  let result = null;
  if (e.action === "OFFER" && e.decision) {
    const [label, tone] = answerOf(e.decision);
    const ctr = num(e.counter_rate);
    result = (
      <>
        <span className={"d " + tone}>{label}{ctr != null && e.decision !== "ACCEPT" ? <> <span className="mono">{money(ctr)}</span></> : null}</span>
        {e.hint && <span className="hint-t">{String(e.hint)}</span>}
      </>
    );
  } else if (e.action === "COMMIT") result = <span className="d green">Booked</span>;
  else if (e.action === "APPROVE") result = <span className="d">{e.decision === "REJECT" ? "Declined" : "Approved"}</span>;
  else if (e.action === "FUEL_UPDATE") result = <span className="d amber">Repriced</span>;

  return (
    <tr className={cls}>
      <td className="ts mono">
        {clockTime(e.ts)}
        {scope === "all" && e.negotiation_id && (
          <button type="button" className="nidlink" onClick={() => onSelect(e.negotiation_id)}>{e.negotiation_id}</button>
        )}
      </td>
      <td className={"who a-" + String(e.actor || "")}>{actorOf(e.actor)}</td>
      <td className="what">{what}</td>
      <td className="res">
        {inj && <span className="flag inj">Injection attempt</span>}
        {probe && <span className="flag probe">Probing the floor</span>}
        {result}
      </td>
    </tr>
  );
}
