// /console — the human-in-the-loop negotiation monitor.
//
// Data path: a bridge running next to the seller's Snowflake account publishes
// NEGOTIATIONS / NEGOTIATION_LEDGER / ORDERS into Firestore under
// workspaces/{uid}/..., and this page renders them live. Approve/Reject writes a
// command document that the bridge executes with PUBLIC.APPROVE_ORDER.
// With no bridge connected the page runs on demo-trace.js so it always shows
// what the monitor looks like.
//
// Buyer text is attacker-controlled: every value from Firestore is placed with
// textContent / DOM nodes, never innerHTML.
import { auth, db, go, pageUrl, addCopyButton } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, onSnapshot, query, orderBy, limit,
  addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { demoData } from "./demo-trace.js";

const $ = id => document.getElementById(id);
document.querySelectorAll("[data-page]").forEach(a => a.href = pageUrl(a.dataset.page));

const EVENT_LIMIT = 500;   // newest events kept client-side
const PAGE = 60;           // rows rendered before "Show older moves"
const STALE_MS = 90000;    // no bridge heartbeat for this long → "stale"

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let uid = null, email = "";
let data = { meta: {}, negotiations: [], events: [], orders: [] };
let live = { meta: null, negotiations: null, events: null, orders: null };
let commands = new Map();      // order_id → latest command doc
let demo = null;               // demo dataset, built once
let selected = null;           // negotiation id
let scope = "one";             // "one" | "all"
let shown = PAGE;
let seenEvents = new Set();
let firstPaint = true;
let unsubs = [];

const params = new URLSearchParams(location.search);
if (params.get("n")) selected = params.get("n");

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;            // only ever for our own static markup
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.appendChild(k);
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
function money(v, cents = true) {
  const n = num(v);
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}
function big(v) {
  const n = num(v);
  if (n == null) return "—";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
  return money(n, false);
}
function pct(v, digits = 1) {
  const n = num(v);
  return n == null ? "—" : n.toFixed(digits) + "%";
}
// Firestore Timestamp | ISO string | Date → Date
function asDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function clockTime(v) {
  const d = asDate(v);
  return d ? d.toLocaleTimeString("en-US", { hour12: false }) : "—";
}
function ago(v) {
  const d = asDate(v);
  if (!d) return "—";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
const flagsOf = e => Array.isArray(e.flags) ? e.flags
  : typeof e.flags === "string" ? e.flags.split(",").map(s => s.trim()).filter(Boolean) : [];
function termsStr(e) {
  const bits = [];
  if (num(e.term_months) != null) bits.push(num(e.term_months) + " mo");
  if (num(e.loads_per_week) != null) bits.push(num(e.loads_per_week) + "/wk");
  if (e.payment_terms) bits.push(String(e.payment_terms));
  if (num(e.pickup_window_hrs) != null) bits.push(num(e.pickup_window_hrs) + "h pickup");
  return bits.join(" · ");
}
function announce(msg) { $("announce").textContent = msg; }

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
$("signout").addEventListener("click", () => signOut(auth).then(() => go("login")));

onAuthStateChanged(auth, async user => {
  if (!user) {
    uid = null;
    unsubs.forEach(u => u()); unsubs = [];
    $("main").hidden = true; $("userbar").hidden = true;
    go("login");
    return;
  }
  uid = user.uid;
  email = user.email || user.displayName || "signed in";
  $("who").textContent = email;
  $("loading").textContent = "Loading your negotiations…";

  try {
    const snap = await getDoc(doc(db, "workspaces", uid));
    const company = snap.exists() ? (snap.data().company || "").trim() : "";
    $("who-company").textContent = company || "Your storefront";
  } catch (e) {
    console.warn("workspace read failed", e);
    $("who-company").textContent = "Your storefront";
  }

  $("bridge-cmd").textContent = bridgeCommand();
  addCopyButton($("bridge-cmd").parentNode);

  subscribe();
  $("loading").hidden = true; $("userbar").hidden = false; $("main").hidden = false;
});

function bridgeCommand() {
  return [
    "# in your counteroffer checkout",
    "python3 -m venv bridge/.venv && bridge/.venv/bin/pip install -r bridge/requirements.txt",
    "",
    "COUNTEROFFER_SF_ENV=~/.snowflake/counteroffer.env \\",
    "CO_FB_EMAIL=" + (email || "you@example.com") + " \\",
    "CO_FB_PASSWORD='<your Counteroffer password>' \\",
    "  bridge/.venv/bin/python bridge/counteroffer_bridge.py --watch"
  ].join("\n");
}

// ---------------------------------------------------------------------
// Live subscriptions (with demo fallback)
// ---------------------------------------------------------------------
function subscribe() {
  const ws = ["workspaces", uid];
  const onErr = where => err => {
    console.warn("snapshot error (" + where + ")", err);
    live[where] = live[where] || [];
    applyData();
  };

  unsubs.push(onSnapshot(doc(db, ...ws, "meta", "bridge"), s => {
    live.meta = s.exists() ? s.data() : {};
    applyData();
  }, onErr("meta")));

  unsubs.push(onSnapshot(collection(db, ...ws, "negotiations"), s => {
    live.negotiations = s.docs.map(d => Object.assign({ id: d.id }, d.data()));
    applyData();
  }, onErr("negotiations")));

  unsubs.push(onSnapshot(
    query(collection(db, ...ws, "events"), orderBy("event_id", "desc"), limit(EVENT_LIMIT)),
    s => { live.events = s.docs.map(d => d.data()); applyData(); },
    onErr("events")));

  unsubs.push(onSnapshot(collection(db, ...ws, "orders"), s => {
    live.orders = s.docs.map(d => Object.assign({ order_id: d.id }, d.data()));
    applyData();
  }, onErr("orders")));

  unsubs.push(onSnapshot(
    query(collection(db, ...ws, "commands"), orderBy("created_at", "desc"), limit(40)),
    s => {
      commands = new Map();
      s.docs.forEach(d => {
        const c = d.data();
        if (c.order_id && !commands.has(c.order_id)) commands.set(c.order_id, Object.assign({ _id: d.id }, c));
      });
      renderApprovals();
    },
    onErr("commands")));

  // Keep "last sync" / "x minutes ago" honest without a snapshot.
  setInterval(() => { if (!document.hidden) renderSource(); }, 15000);
}

function hasLiveData() {
  return (live.events && live.events.length > 0) || (live.negotiations && live.negotiations.length > 0);
}

function applyData() {
  // Wait for the first round of snapshots before deciding live vs. demo.
  if (live.events === null || live.negotiations === null) return;

  if (hasLiveData()) {
    data = {
      meta: Object.assign({ source: "snowflake" }, live.meta || {}),
      negotiations: live.negotiations || [],
      events: live.events || [],
      orders: live.orders || []
    };
  } else {
    if (!demo) demo = demoData();
    data = demo;
  }

  data.events = data.events.slice().sort((a, b) => (num(b.event_id) || 0) - (num(a.event_id) || 0));
  data.negotiations = data.negotiations.slice().sort(
    (a, b) => (asDate(b.created_at) || 0) - (asDate(a.created_at) || 0) || String(b.id).localeCompare(String(a.id)));

  if (!selected || !data.negotiations.some(n => n.id === selected)) {
    selected = data.negotiations.length ? data.negotiations[0].id : null;
  }
  render();
}

const isDemo = () => data.meta && data.meta.source === "demo";

// ---------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------
function negById(id) { return data.negotiations.find(n => n.id === id) || null; }

function eventsFor(id) { return data.events.filter(e => e.negotiation_id === id); }

function flagCounts(events) {
  let inj = 0, probe = 0;
  for (const e of events) {
    const f = flagsOf(e);
    if (f.includes("INJECTION_SUSPECTED")) inj++;
    if (f.includes("PROBING_SUSPECTED")) probe++;
  }
  return { inj, probe };
}

function filteredEvents() {
  const q = $("q").value.trim().toLowerCase();
  const actor = $("f-actor").value;
  const action = $("f-action").value;
  const flagged = $("f-flagged").checked;
  const base = scope === "all" ? data.events : eventsFor(selected);
  return base.filter(e => {
    if (actor && e.actor !== actor) return false;
    if (action && e.action !== action) return false;
    if (flagged && flagsOf(e).length === 0) return false;
    if (q) {
      const hay = [e.note, e.hint, e.actor, e.action, e.decision, e.negotiation_id,
        e.rate, e.counter_rate, e.payment_terms].filter(v => v != null).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function render() {
  renderSource();
  renderStats();
  renderApprovals();
  renderRail();
  renderDetail();
  renderTrace();
  firstPaint = false;
}

function renderSource() {
  const chip = $("src-chip"), note = $("src-note");
  const sync = data.meta && data.meta.last_sync;
  const d = asDate(sync);
  const stale = d && Date.now() - d.getTime() > STALE_MS;

  chip.className = "src-chip " + (isDemo() ? "demo" : stale ? "stale" : "live");
  chip.textContent = isDemo() ? "Demo data" : stale ? "Bridge stalled" : "Live";
  note.textContent = isDemo()
    ? "No bridge connected yet — this is a synthetic run so you can see the monitor working."
    : stale
      ? "The bridge hasn't checked in for a while. Restart it to resume live updates."
      : "Streaming from " + (data.meta.account ? String(data.meta.account) : "your Snowflake account") + ".";

  $("src-diesel").textContent = data.meta && data.meta.diesel != null ? "$" + Number(data.meta.diesel).toFixed(2) : "—";
  $("src-sync").textContent = isDemo() ? "—" : ago(sync);
}

function renderStats() {
  const open = data.negotiations.filter(n => n.status === "OPEN" || n.status === "FINAL");
  const pending = data.orders.filter(o => o.status === "PENDING_APPROVAL");
  const pendingValue = pending.reduce((s, o) => s + (num(o.tcv) || 0), 0);
  const booked = data.orders.filter(o => o.status === "CONFIRMED");
  const bookedValue = booked.reduce((s, o) => s + (num(o.tcv) || 0), 0);
  const { inj, probe } = flagCounts(data.events);

  const cards = [
    { k: "Live negotiations", v: String(open.length), s: data.negotiations.length + " total", cls: "" },
    {
      k: "Awaiting your approval", v: String(pending.length),
      s: pending.length ? big(pendingValue) + " in contract value" : "nothing queued",
      cls: pending.length ? "warn" : ""
    },
    {
      k: "Attempts blocked", v: String(inj + probe),
      s: inj + " injection · " + probe + " floor probing",
      cls: inj + probe ? "bad" : ""
    },
    { k: "Booked", v: big(bookedValue), s: booked.length + " order" + (booked.length === 1 ? "" : "s") + " confirmed", cls: booked.length ? "good" : "" }
  ];

  const box = $("stats");
  clear(box);
  for (const c of cards) {
    box.appendChild(el("div", { class: "stat " + c.cls }, [
      el("div", { class: "k", text: c.k }),
      el("div", { class: "v", text: c.v }),
      el("div", { class: "s", text: c.s })
    ]));
  }
}

function renderApprovals() {
  const list = $("approvals-list");
  if (!list) return;
  const pending = data.orders.filter(o => o.status === "PENDING_APPROVAL");
  const recent = data.orders
    .filter(o => o.status !== "PENDING_APPROVAL")
    .sort((a, b) => (asDate(b.decided_at || b.created_at) || 0) - (asDate(a.decided_at || a.created_at) || 0))
    .slice(0, 2);

  $("approvals").classList.toggle("has-pending", pending.length > 0);
  $("approvals-count").textContent = pending.length
    ? pending.length + " order" + (pending.length === 1 ? "" : "s") + " over your auto-approval limit"
    : "all clear";

  clear(list);
  if (!pending.length && !recent.length) {
    list.appendChild(el("p", { class: "empty", text: "No orders yet. Deals under your auto-approval limit book themselves; anything above it lands here." }));
    return;
  }
  if (!pending.length) {
    list.appendChild(el("p", { class: "empty", text: "Nothing needs a decision right now. Recently decided:" }));
  }
  for (const o of pending.concat(recent)) list.appendChild(approvalCard(o));
}

function approvalCard(o) {
  const pending = o.status === "PENDING_APPROVAL";
  const meta = [o.customer, o.lane, money(o.rate) + "/load", termsStr(o)].filter(Boolean).join(" · ");

  const left = el("div", {}, [
    el("div", {}, [
      el("span", { class: "oid", text: String(o.order_id) }),
      el("span", { class: "st st-" + String(o.status || ""), text: String(o.status || "").replace(/_/g, " "), style: "margin-left:10px" })
    ]),
    el("div", { class: "meta" }, [
      document.createTextNode(meta + " · "),
      el("span", { class: "tcv", text: big(o.tcv) + " contract value" })
    ])
  ]);
  if (o.negotiation_id) {
    left.appendChild(el("div", { class: "meta" }, [
      el("a", {
        href: "#", text: "View the full trace for " + o.negotiation_id + " →",
        onclick: ev => { ev.preventDefault(); select(o.negotiation_id); }
      })
    ]));
  }

  const right = el("div", { class: "acts" });
  if (pending) {
    const cmd = commands.get(o.order_id);
    const busy = cmd && (cmd.status === "QUEUED" || cmd.status === "RUNNING");
    if (busy) {
      right.appendChild(el("span", { class: "state busy", text: cmd.decision === "APPROVE" ? "Approving…" : "Rejecting…" }));
    } else if (cmd && cmd.status === "ERROR") {
      right.appendChild(el("span", { class: "state bad", text: "Bridge error: " + String(cmd.result || "failed") }));
    } else {
      right.appendChild(el("button", {
        class: "btn btn-sm btn-green", type: "button", text: "Approve",
        onclick: () => decide(o, "APPROVE")
      }));
      right.appendChild(el("button", {
        class: "btn btn-sm btn-red", type: "button", text: "Reject",
        onclick: () => decide(o, "REJECT")
      }));
    }
  } else {
    right.appendChild(el("span", {
      class: "state " + (o.status === "CONFIRMED" ? "ok" : "bad"),
      text: (o.status === "CONFIRMED" ? "Approved" : "Rejected") +
        (o.decided_by ? " by " + String(o.decided_by) : "") +
        (o.decided_at ? " · " + ago(o.decided_at) : "")
    }));
  }

  return el("div", { class: "appr" + (pending ? " pending" : "") }, [left, right]);
}

async function decide(order, decision) {
  const verb = decision === "APPROVE" ? "Approve" : "Reject";
  if (!confirm(verb + " " + order.order_id + " — " + money(order.rate) + "/load, " +
    big(order.tcv) + " contract value?\n\nThis writes the decision to Snowflake.")) return;

  if (isDemo()) {
    // Demo mode has no bridge: mutate the local dataset so the beat still lands.
    order.status = decision === "APPROVE" ? "CONFIRMED" : "REJECTED";
    order.decided_by = email;
    order.decided_at = new Date().toISOString();
    const nextId = Math.max(0, ...data.events.map(e => num(e.event_id) || 0)) + 1;
    data.events.unshift({
      event_id: nextId, ts: new Date().toISOString(), negotiation_id: order.negotiation_id,
      actor: "HUMAN", action: "APPROVE", decision,
      note: "Order " + order.order_id + " " + (decision === "APPROVE" ? "approved" : "rejected") + " by " + email,
      flags: []
    });
    render();
    announce("Order " + order.order_id + " " + decision.toLowerCase() + "d.");
    return;
  }

  try {
    await addDoc(collection(db, "workspaces", uid, "commands"), {
      type: "APPROVE_ORDER",
      order_id: order.order_id,
      decision,
      status: "QUEUED",
      requested_by: email,
      created_at: serverTimestamp()
    });
    announce("Queued " + decision.toLowerCase() + " for " + order.order_id + ".");
  } catch (e) {
    console.error(e);
    alert("Couldn't queue that decision (" + (e.code || "error") + "). Check that the bridge is running.");
  }
}

function renderRail() {
  const ul = $("neglist");
  clear(ul);
  $("rail-count").textContent = data.negotiations.length + " total";

  if (!data.negotiations.length) {
    ul.appendChild(el("li", {}, [el("p", {
      class: "empty",
      text: "Nothing yet. The first time a buyer's agent calls your storefront, the negotiation shows up here."
    })]));
    return;
  }

  for (const n of data.negotiations) {
    const ev = eventsFor(n.id);
    const { inj, probe } = flagCounts(ev);
    const last = ev[0];

    const warn = el("div", { class: "warnrow" });
    if (inj) warn.appendChild(el("span", { class: "flagchip f-inj", text: "⚠ " + inj + " INJECTION" }));
    if (probe) warn.appendChild(el("span", { class: "flagchip f-probe", text: "⚠ PROBING" }));

    const btn = el("button", {
      type: "button", "aria-current": n.id === selected ? "true" : "false",
      onclick: () => select(n.id)
    }, [
      el("div", { class: "top" }, [
        el("span", { class: "nid", text: String(n.id) }),
        el("span", { class: "st st-" + String(n.status || ""), text: String(n.status || "").replace(/_/g, " ") })
      ]),
      el("div", { class: "cust", text: String(n.customer || "Unknown buyer") }),
      el("div", {
        class: "sub",
        text: [n.lane, (num(n.rounds_used) || 0) + "/" + (num(n.rounds_max) || 8) + " rounds",
        last ? ago(last.ts) : ""].filter(Boolean).join(" · ")
      }),
      (inj || probe) ? warn : null
    ]);
    ul.appendChild(el("li", {}, [btn]));
  }
}

function select(id) {
  selected = id;
  scope = "one";
  shown = PAGE;
  const u = new URL(location.href);
  u.searchParams.set("n", id);
  history.replaceState(null, "", u);
  render();
  $("feed-h").scrollIntoView({ block: "nearest" });
}

function renderDetail() {
  const head = $("detail-head");
  clear(head);
  const n = negById(selected);
  head.appendChild(el("h2", { id: "detail-h", class: "sr-only", text: "Selected negotiation" }));

  if (!n) {
    head.appendChild(el("p", { class: "empty", text: "Select a negotiation to see its trace." }));
    return;
  }

  const ev = eventsFor(n.id);
  const { inj, probe } = flagCounts(ev);

  head.appendChild(el("div", { class: "dh-top" }, [
    el("div", {}, [
      el("div", { class: "nid", text: String(n.id) }),
      el("h2", { class: "name", text: String(n.customer || "Unknown buyer") })
    ]),
    el("span", { class: "st st-" + String(n.status || ""), text: String(n.status || "").replace(/_/g, " ") }),
    n.tier ? el("span", { class: "st", text: String(n.tier) }) : null
  ]));
  head.appendChild(el("div", {
    class: "dh-sub",
    text: [n.origin && n.destination ? n.origin + " → " + n.destination : n.lane,
    num(n.loads_per_week) != null ? n.loads_per_week + " loads/wk" : null,
    num(n.term_months) != null ? n.term_months + "-month term" : null,
      "opened " + ago(n.created_at)].filter(Boolean).join("  ·  ")
  }));

  head.appendChild(gauge(n));

  const stats = el("div", { class: "dh-stats" });
  const st = (k, v, s, cls) => stats.appendChild(el("div", { class: "dh-stat" }, [
    el("div", { class: "k", text: k }),
    el("div", { class: "v" + (cls ? " " + cls : ""), text: v }),
    el("div", { class: "s", text: s || "" })
  ]));

  st("Buyer's last offer", money(n.last_offer_rate), n.last_offer_terms || "");
  const dec = n.last_decision ? String(n.last_decision) : "—";
  st("Agent's answer", dec, n.last_counter_rate && dec !== "ACCEPT" ? "countered " + money(n.last_counter_rate) : "");
  const lst = num(n.list_rate);
  const off = num(n.last_offer_rate);
  st("List rate", money(lst), off && lst ? (((1 - off / lst) * 100).toFixed(1) + "% off list on the table") : "");
  st("Rounds used", (num(n.rounds_used) || 0) + " of " + (num(n.rounds_max) || 8),
    inj + probe ? (inj ? inj + " injection" : "") + (inj && probe ? ", " : "") + (probe ? "probing flagged" : "") : "clean");
  head.appendChild(stats);
}

// Floor gauge. With include_floor the seller sees the real floor; by default the
// bridge publishes only how far above the floor the offer sits, and the number
// itself never leaves Snowflake.
function gauge(n) {
  const list = num(n.list_rate);
  const offer = num(n.last_offer_rate);
  const counter = num(n.last_counter_rate);
  const floor = num(n.floor);
  const cost = num(n.cost);
  const abovePct = num(n.above_floor_pct);

  const wrap = el("div", { class: "gauge" });

  if (!list && !offer) {
    wrap.appendChild(el("div", { class: "gauge-sealed", text: "No offer on the table yet." }));
    return wrap;
  }

  const vals = [list, offer, counter, floor, cost].filter(v => v != null);
  const lo = Math.min(...vals) * 0.97;
  const hi = Math.max(...vals) * 1.02;
  const pos = v => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

  const track = el("div", {
    class: "gauge-track", role: "img",
    "aria-label": gaugeLabel(n)
  });

  if (floor != null) {
    track.appendChild(el("div", { class: "gauge-zone below", style: "left:0;width:" + pos(floor) + "%" }));
    track.appendChild(el("div", { class: "gauge-zone ok", style: "left:" + pos(floor) + "%;right:0" }));
    track.appendChild(el("div", { class: "gauge-mark floor", style: "left:" + pos(floor) + "%" }));
  }
  if (list != null) track.appendChild(el("div", { class: "gauge-mark list", style: "left:" + pos(list) + "%" }));
  if (counter != null) track.appendChild(el("div", { class: "gauge-mark counter", style: "left:" + pos(counter) + "%" }));
  if (offer != null) {
    const above = floor == null ? (abovePct == null || abovePct >= 0) : offer >= floor;
    track.appendChild(el("div", { class: "gauge-offer" + (above ? " above" : ""), style: "left:" + pos(offer) + "%" }));
  }
  wrap.appendChild(track);

  const legend = el("div", { class: "gauge-legend" });
  if (floor != null) legend.appendChild(el("span", { class: "l-floor" }, [el("i", {}), el("b", { text: "Floor " + money(floor) })]));
  if (offer != null) legend.appendChild(el("span", { class: "l-offer" }, [el("i", {}), el("b", { text: "Offer " + money(offer) })]));
  if (counter != null) legend.appendChild(el("span", { class: "l-counter" }, [el("i", {}), el("b", { text: "Counter " + money(counter) })]));
  if (list != null) legend.appendChild(el("span", { class: "l-list" }, [el("i", {}), el("b", { text: "List " + money(list) })]));
  wrap.appendChild(legend);

  if (floor == null) {
    const sealed = el("div", { class: "gauge-sealed" });
    sealed.appendChild(el("b", { text: "Floor sealed in Snowflake. " }));
    sealed.appendChild(document.createTextNode(
      abovePct != null
        ? "The offer on the table is " + pct(Math.abs(abovePct)) +
        (abovePct >= 0 ? " above" : " below") + " your floor for these terms. " +
        "The bridge publishes that distance, not the number."
        : "The bridge is publishing offers and counters only. Run it with --include-floor if you want the floor shown here."
    ));
    wrap.appendChild(sealed);
  } else if (offer != null) {
    const margin = offer - floor;
    wrap.appendChild(el("div", {
      class: "gauge-sealed",
      text: margin >= 0
        ? "The offer clears your floor by " + money(margin) + " (" + pct((margin / floor) * 100) +
          "). Your agent never saw either number."
        : "The offer is " + money(-margin) + " (" + pct((-margin / floor) * 100) +
          ") below your floor for these terms — your agent held the line without ever seeing the number."
    }));
  }
  return wrap;
}

function gaugeLabel(n) {
  const bits = [];
  if (n.last_offer_rate != null) bits.push("buyer's offer " + money(n.last_offer_rate));
  if (n.floor != null) bits.push("floor " + money(n.floor));
  else if (n.above_floor_pct != null) bits.push("offer is " + pct(Math.abs(n.above_floor_pct)) +
    (n.above_floor_pct >= 0 ? " above" : " below") + " the floor");
  if (n.last_counter_rate != null) bits.push("agent's counter " + money(n.last_counter_rate));
  if (n.list_rate != null) bits.push("list rate " + money(n.list_rate));
  return "Price gauge: " + (bits.join(", ") || "no offer yet");
}

// ---------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------
function renderTrace() {
  const body = $("trace-body");
  clear(body);

  const all = filteredEvents();
  const rows = all.slice(0, shown);
  const n = negById(selected);
  const listRate = n ? num(n.list_rate) : null;

  $("f-count").textContent = all.length
    ? "showing " + rows.length + " of " + all.length + " move" + (all.length === 1 ? "" : "s")
    : "no matching moves";
  $("more").hidden = all.length <= rows.length;
  $("trace-note").textContent = scope === "all"
    ? "Every move across every negotiation, newest first."
    : (selected ? "Append-only ledger for " + selected + ", newest first." : "");

  if (!rows.length) {
    body.appendChild(el("tr", {}, [el("td", { colspan: "4" }, [
      el("p", { class: "empty", text: data.events.length ? "Nothing matches those filters." : "No moves recorded yet." })
    ])]));
    return;
  }

  const fresh = [];
  rows.forEach((e, i) => {
    const key = String(e.negotiation_id) + ":" + e.event_id;
    const isNew = !firstPaint && !seenEvents.has(key);
    if (isNew) fresh.push(e);
    seenEvents.add(key);
    body.appendChild(traceRow(e, listRate, i === 0, isNew));
  });

  const flaggedNew = fresh.filter(e => flagsOf(e).length);
  if (flaggedNew.length) {
    announce(flaggedNew.length + " flagged move" + (flaggedNew.length === 1 ? "" : "s") +
      " in " + (flaggedNew[0].negotiation_id || "a negotiation") + ".");
  } else if (fresh.length) {
    announce(fresh.length + " new move" + (fresh.length === 1 ? "" : "s") + " on the trace.");
  }
}

function traceRow(e, listRate, newest, isNew) {
  const flags = flagsOf(e);
  const cls = ["trace-row"];
  if (newest) cls.push("newest");
  if (isNew) cls.push("fresh");
  if (flags.includes("INJECTION_SUSPECTED")) cls.push("flag-inj");
  else if (flags.includes("PROBING_SUSPECTED")) cls.push("flag-probe");

  // When
  const tsCell = el("td", { class: "ts" }, [document.createTextNode(clockTime(e.ts))]);
  if (scope === "all" && e.negotiation_id) {
    tsCell.appendChild(el("a", {
      class: "nidtag", href: "#", text: String(e.negotiation_id),
      onclick: ev => { ev.preventDefault(); select(e.negotiation_id); }
    }));
  }

  // Who
  const actor = String(e.actor || "");
  const whoCell = el("td", { class: "actor a-" + actor, text: actor.replace(/_/g, " ") });

  // What
  const what = el("td", { class: "what" });
  const rate = num(e.rate);
  switch (e.action) {
    case "MESSAGE":
      what.appendChild(el("q", { text: String(e.note || "") }));
      break;
    case "OFFER": {
      const off = rate != null && listRate ? " (" + ((1 - rate / listRate) * 100).toFixed(0) + "% off list)" : "";
      what.appendChild(document.createTextNode("Offer "));
      what.appendChild(el("b", { text: money(rate) }));
      what.appendChild(document.createTextNode(off));
      const t = termsStr(e);
      if (t) { what.appendChild(el("br")); what.appendChild(el("span", { class: "terms", text: t })); }
      break;
    }
    case "QUOTE":
      what.appendChild(document.createTextNode("Quoted list rate "));
      what.appendChild(el("b", { text: money(rate) }));
      break;
    case "START": {
      what.appendChild(document.createTextNode("Negotiation opened" + (e.note ? " · " + e.note : "")));
      const t = termsStr(e);
      if (t) { what.appendChild(el("br")); what.appendChild(el("span", { class: "terms", text: t })); }
      break;
    }
    case "COMMIT":
      what.appendChild(document.createTextNode("Order committed at "));
      what.appendChild(el("b", { text: money(rate) }));
      if (e.note) { what.appendChild(el("br")); what.appendChild(el("span", { class: "terms", text: String(e.note) })); }
      break;
    case "APPROVE":
      what.appendChild(document.createTextNode(String(e.note || "Order decision")));
      break;
    case "FUEL_UPDATE":
      what.appendChild(document.createTextNode("⛽ " + String(e.note || "Diesel index updated")));
      break;
    default:
      what.appendChild(document.createTextNode(String(e.note || e.action || "")));
  }

  // Outcome
  const dec = el("td", { class: "dec" });
  if (flags.includes("INJECTION_SUSPECTED")) dec.appendChild(el("span", { class: "flagchip f-inj", text: "⚠ INJECTION ATTEMPT" }));
  if (flags.includes("PROBING_SUSPECTED")) dec.appendChild(el("span", { class: "flagchip f-probe", text: "⚠ FLOOR PROBING" }));
  if (e.action === "OFFER" && e.decision) {
    const ctr = num(e.counter_rate);
    dec.appendChild(el("span", {
      class: "d d-" + String(e.decision),
      text: "→ " + e.decision + (ctr != null && e.decision !== "ACCEPT" ? " " + money(ctr) : "")
    }));
    if (e.hint) dec.appendChild(el("span", { class: "hint", text: "“" + String(e.hint) + "”" }));
  } else if (e.action === "COMMIT") {
    dec.appendChild(el("span", { class: "d d-ACCEPT", text: "BOOKED" }));
  } else if (e.action === "APPROVE") {
    dec.appendChild(el("span", { class: "d d-INFO", text: String(e.decision || "DECIDED") }));
  } else if (e.action === "FUEL_UPDATE") {
    dec.appendChild(el("span", { class: "d d-FINAL", text: "REPRICE" }));
  }

  return el("tr", { class: cls.join(" ") }, [tsCell, whoCell, what, dec]);
}

// ---------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------
function setScope(next) {
  scope = next;
  shown = PAGE;
  $("scope-one").setAttribute("aria-pressed", String(next === "one"));
  $("scope-all").setAttribute("aria-pressed", String(next === "all"));
  $("feed-h").textContent = next === "all" ? "All traces" : "Trace";
  renderTrace();
}
$("scope-one").addEventListener("click", () => setScope("one"));
$("scope-all").addEventListener("click", () => setScope("all"));

let qTimer = null;
$("q").addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { shown = PAGE; renderTrace(); }, 150);
});
["f-actor", "f-action", "f-flagged"].forEach(id =>
  $(id).addEventListener("change", () => { shown = PAGE; renderTrace(); }));
$("more").addEventListener("click", () => { shown += PAGE; renderTrace(); });

$("bridge-toggle").addEventListener("click", () => {
  const help = $("bridge-help");
  const open = help.hidden;
  help.hidden = !open;
  $("bridge-toggle").setAttribute("aria-expanded", String(open));
  $("bridge-toggle").textContent = open ? "Hide setup" : "Connect live data";
});
