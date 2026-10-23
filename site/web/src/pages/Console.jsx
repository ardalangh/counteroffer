// The negotiation monitor: live from Snowflake.
//
// /console polls the monitor_feed Cloud Function, which reads NEGOTIATIONS,
// NEGOTIATION_LEDGER and ORDERS straight from the seller's Snowflake account.
// A negotiation a buyer runs from Claude Desktop shows up here within seconds.
// Approve and Decline call monitor_decide, which runs PUBLIC.APPROVE_ORDER.
//
// There is no sample data in production. Until Setup step 1 names the
// Snowflake account Counteroffer is connected to, the page says so.
//
// Buyer text is attacker-controlled. React escapes every string it renders and
// nothing here uses dangerouslySetInnerHTML, so it can only ever be text.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase.js";
import { useSession } from "../lib/session.jsx";
import { ago, asDate, big, clockTime, money, num, pct, termsStr } from "../lib/format.js";
import { actorOf, answerOf, flagCounts, flagsOf, matches, sortData, statusOf } from "../lib/monitor.js";
import "../styles/console.css";

const POLL_MS = 3000;
const RETRY_MS = 6000;
const PAGE = 60;
const MAX_EVENTS = 1000;

const feed = httpsCallable(functions, "monitor_feed", { timeout: 60000 });
const decideFn = httpsCallable(functions, "monitor_decide", { timeout: 60000 });

function Status({ value }) {
  const [label, tone] = statusOf(value);
  return <span className={"status " + tone}>{label}</span>;
}

// Error from the callable -> what the page should say.
function classify(err) {
  const code = String((err && err.code) || "");
  const msg = String((err && err.message) || "");
  if (code === "functions/failed-precondition" && msg.startsWith("not_connected")) return "not_connected";
  if (code === "functions/permission-denied") return "not_reachable";
  if (code === "functions/unauthenticated") return "signed_out";
  return "error";
}

function mergeEvents(prev, incoming) {
  if (!incoming.length) return prev;
  const seenIds = new Set(prev.map(e => e.event_id));
  const fresh = incoming.filter(e => !seenIds.has(e.event_id));
  if (!fresh.length) return prev;
  return [...fresh, ...prev].sort((a, b) => (num(b.event_id) || 0) - (num(a.event_id) || 0)).slice(0, MAX_EVENTS);
}

export default function Console() {
  const { user, preview } = useSession();
  const uid = user && user.uid;
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");     // loading | live | not_connected | not_reachable | signed_out | error
  const [lastOk, setLastOk] = useState(null);
  const [scope, setScope] = useState("one");
  const [filters, setFilters] = useState({ q: "", actor: "", action: "", flagged: false });
  const [shown, setShown] = useState(PAGE);
  const [pendingDecision, setPendingDecision] = useState({});  // order_id -> "APPROVE" | "REJECT"
  const [decisionError, setDecisionError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [, setTick] = useState(0);
  const seen = useRef(new Set());
  const painted = useRef(false);
  const sinceRef = useRef(0);
  const timer = useRef(null);
  const alive = useRef(true);

  useEffect(() => { document.title = "Monitor · Counteroffer"; }, []);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setTick(x => x + 1); }, 5000);
    return () => clearInterval(t);
  }, []);

  // ---------- polling ----------
  const poll = useCallback(async () => {
    clearTimeout(timer.current);
    if (!alive.current) return;
    if (document.hidden) return;                 // resumes on visibilitychange
    try {
      const res = await feed({ since: sinceRef.current });
      if (!alive.current) return;
      const d = res.data || {};
      const incoming = Array.isArray(d.events) ? d.events : [];
      setData(prev => {
        const events = mergeEvents(prev ? prev.events : [], incoming);
        sinceRef.current = events.length ? Math.max(...events.map(e => num(e.event_id) || 0)) : sinceRef.current;
        return sortData({ meta: d.meta || {}, negotiations: d.negotiations || [], orders: d.orders || [], events });
      });
      setState("live");
      setLastOk(new Date());
      timer.current = setTimeout(poll, POLL_MS);
    } catch (err) {
      if (!alive.current) return;
      const kind = classify(err);
      console.warn("monitor_feed:", err.code || err);
      setState(s => (kind === "error" && s === "live") ? "live" : kind);   // keep showing data through a blip
      if (kind === "error" || kind === "loading") timer.current = setTimeout(poll, RETRY_MS);
      else timer.current = setTimeout(poll, 15000);   // e.g. finished Setup step 1 in another tab
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!uid) return undefined;
    if (preview) {
      import("../data/demoTrace.js").then(m => {
        if (!alive.current) return;
        const d = m.demoData();
        setData(sortData({ ...d, meta: { ...d.meta, source: "preview" } }));
        setState("live"); setLastOk(new Date());
      });
      return () => { alive.current = false; };
    }
    poll();
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive.current = false; clearTimeout(timer.current); document.removeEventListener("visibilitychange", onVis); };
  }, [uid, preview, poll]);

  // ---------- selection: follow the newest negotiation unless one was picked ----------
  const pinned = params.get("n");
  const selectedId = data && (data.negotiations.some(n => n.id === pinned)
    ? pinned : (data.negotiations[0] && data.negotiations[0].id)) || null;
  const selected = data && data.negotiations.find(n => n.id === selectedId);
  const eventsFor = id => (data ? data.events.filter(e => e.negotiation_id === id) : []);

  const visible = useMemo(() => {
    if (!data) return [];
    const base = scope === "all" ? data.events : data.events.filter(e => e.negotiation_id === selectedId);
    return base.filter(e => matches(e, filters));
  }, [data, scope, selectedId, filters]);

  // New moves: mark them (visual) and announce them (screen readers).
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
  function followNewest() {
    const p = new URLSearchParams(params);
    p.delete("n");
    setParams(p, { replace: true });
  }

  async function decide(order, decision) {
    const verb = decision === "APPROVE" ? "Approve" : "Decline";
    if (!window.confirm(verb + " " + order.order_id + "?\n\n" + money(order.rate) + " per load, " + big(order.tcv) +
      " contract value. This writes your decision to Snowflake.")) return;
    setDecisionError("");
    if (preview) {
      setData(d => ({ ...d, orders: d.orders.map(o => o.order_id !== order.order_id ? o : { ...o, status: decision === "APPROVE" ? "CONFIRMED" : "REJECTED", decided_at: new Date().toISOString() }) }));
      return;
    }
    setPendingDecision(m => ({ ...m, [order.order_id]: decision }));
    try {
      await decideFn({ order_id: order.order_id, decision });
      setAnnounce("Order " + order.order_id + (decision === "APPROVE" ? " approved." : " declined."));
      await poll();
    } catch (err) {
      console.error(err);
      setDecisionError("Couldn't " + verb.toLowerCase() + " " + order.order_id + ": " + (err.message || "try again") + ".");
    } finally {
      setPendingDecision(m => { const n = { ...m }; delete n[order.order_id]; return n; });
    }
  }

  // ---------- not-live states ----------
  if (state === "loading" && !data) {
    return <div className="wrap page monitor"><PageHead /><div className="sheet"><p className="empty">Connecting to Snowflake…</p></div></div>;
  }
  if (state === "not_connected" || state === "not_reachable" || state === "signed_out") {
    return (
      <div className="wrap page monitor">
        <PageHead />
        <section className="sheet notlive">
          <div className="sheet-body">
            {state === "not_connected" && (
              <>
                <h2>Connect your Snowflake account</h2>
                <p>This page shows your storefront's negotiations live from Snowflake. Add your Snowflake account in Setup step 1 to connect it.</p>
                <Link className="btn btn-primary" to="/app#step-1">Go to Setup</Link>
              </>
            )}
            {state === "not_reachable" && (
              <>
                <h2>Counteroffer isn't connected to that Snowflake account</h2>
                <p>The account in Setup step 1 isn't one Counteroffer can reach yet. Check that it's the account your storefront runs in.</p>
                <Link className="btn" to="/app#step-1">Check Setup step 1</Link>
              </>
            )}
            {state === "signed_out" && (
              <>
                <h2>Sign in again</h2>
                <p>Your session ended. Sign in to see your negotiations.</p>
                <Link className="btn btn-primary" to="/login">Sign in</Link>
              </>
            )}
          </div>
        </section>
      </div>
    );
  }
  if (!data) {
    return <div className="wrap page monitor"><PageHead /><div className="sheet"><p className="empty">Can't reach Snowflake right now. Retrying…</p></div></div>;
  }

  const pending = data.orders.filter(o => o.status === "PENDING_APPROVAL");
  const decided = data.orders.filter(o => o.status !== "PENDING_APPROVAL")
    .sort((a, b) => (asDate(b.decided_at || b.created_at) || 0) - (asDate(a.decided_at || a.created_at) || 0)).slice(0, 2);

  return (
    <div className="wrap page monitor">
      <PageHead />
      <StatusLine data={data} state={state} lastOk={lastOk} preview={preview} />

      <section className="sheet decide" aria-labelledby="decide-h">
        <div className="sheet-head">
          <h2 id="decide-h">Needs your decision</h2>
          <span className="aside">{pending.length ? "over your auto-approval limit" : "nothing waiting"}</span>
        </div>
        {decisionError && <p className="notice bad" style={{ margin: "12px 20px" }} role="alert">{decisionError}</p>}
        {!pending.length && !decided.length && (
          <p className="empty">Deals under your auto-approval limit book themselves. Anything above it waits here for you.</p>
        )}
        {pending.concat(decided).map(o => (
          <OrderRow key={o.order_id} order={o} busy={pendingDecision[o.order_id]} onDecide={decide} onTrace={select} />
        ))}
      </section>

      <div className="split">
        <nav className="sheet rail" aria-labelledby="rail-h">
          <div className="sheet-head">
            <h2 id="rail-h">All negotiations</h2>
            <span className="aside">{data.negotiations.length || ""}</span>
          </div>
          {pinned && data.negotiations[0] && pinned !== data.negotiations[0].id && (
            <button type="button" className="follow" onClick={followNewest}>Follow the newest negotiation</button>
          )}
          {data.negotiations.length === 0
            ? <p className="empty">Waiting for the first negotiation. When a buyer's agent asks your storefront for a quote, it shows up here.</p>
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
                          {(ev[0] || n.updated_at) && <span>{ago(ev[0] ? ev[0].ts : n.updated_at)}</span>}
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
            <section className="sheet"><p className="empty">No negotiations yet. Start one from Claude Desktop and it appears here.</p></section>
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
        Read live from your Snowflake account. Buyer messages are shown as plain text, never as markup. The ledger is
        append-only; the one thing this page writes back is your approval.
      </p>
      <div className="sr-only" aria-live="polite">{announce}</div>
    </div>
  );
}

function PageHead() {
  return (
    <div className="pagehead">
      <h1>Negotiations</h1>
      <p>What your selling agent and your buyers' agents are doing, and what needs you.</p>
    </div>
  );
}

function StatusLine({ data, state, lastOk, preview }) {
  const stale = state !== "live";
  const open = data.negotiations.filter(n => n.status === "OPEN" || n.status === "FINAL").length;
  const pending = data.orders.filter(o => o.status === "PENDING_APPROVAL");
  const pendingValue = pending.reduce((s, o) => s + (num(o.tcv) || 0), 0);
  const booked = data.orders.filter(o => o.status === "CONFIRMED");
  const bookedValue = booked.reduce((s, o) => s + (num(o.tcv) || 0), 0);
  const { inj, probe } = flagCounts(data.events);
  const source = preview ? ["Preview data", "amber"] : stale ? ["Reconnecting", "red"] : ["Live from Snowflake", "green"];

  return (
    <div className="statusline">
      <span className={"status " + source[1] + (!preview && !stale ? " pulse" : "")}><b>{source[0]}</b></span>
      <span className="figures">
        <span><b>{open}</b> open</span>
        {pending.length > 0 && <span className="due"><b>{pending.length}</b> waiting on you, {big(pendingValue)}</span>}
        {inj + probe > 0 && <span className="alert"><b>{inj + probe}</b> attempt{inj + probe === 1 ? "" : "s"} blocked</span>}
        {booked.length > 0 && <span><b>{big(bookedValue)}</b> booked</span>}
      </span>
      <span className="grow" />
      <span className="readout">Diesel <span className="mono">{data.meta.diesel != null ? "$" + Number(data.meta.diesel).toFixed(2) : "—"}</span></span>
      {lastOk && <span className="readout">Updated {ago(lastOk)}</span>}
    </div>
  );
}

function OrderRow({ order: o, busy, onDecide, onTrace }) {
  const pending = o.status === "PENDING_APPROVAL";
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
          busy ? <span className="muted small">{busy === "APPROVE" ? "Approving…" : "Declining…"}</span>
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
