// Pure helpers for the negotiation monitor.
import { asDate, num } from "./format.js";

export const flagsOf = e => Array.isArray(e.flags) ? e.flags
  : typeof e.flags === "string" ? e.flags.split(",").map(s => s.trim()).filter(Boolean) : [];

export function flagCounts(events) {
  let inj = 0, probe = 0;
  for (const e of events) {
    const f = flagsOf(e);
    if (f.includes("INJECTION_SUSPECTED")) inj++;
    if (f.includes("PROBING_SUSPECTED")) probe++;
  }
  return { inj, probe };
}

export const STATUS = {
  OPEN: ["Open", "blue"], FINAL: ["Final offer", "amber"], ACCEPTED: ["Accepted", "green"],
  CLOSED_WON: ["Won", "green"], CLOSED_LOST: ["Lost", "red"],
  PENDING_APPROVAL: ["Needs you", "amber"], CONFIRMED: ["Approved", "green"], REJECTED: ["Declined", "red"]
};
export const statusOf = v => STATUS[v] || [String(v || "—"), ""];

export const ANSWER = { ACCEPT: ["Accepted", "green"], COUNTER: ["Countered", "blue"], REJECT: ["Rejected", "red"], FINAL: ["Final offer", "amber"] };
export const answerOf = d => ANSWER[d] || ["—", ""];

export const ACTOR = { BUYER: "Buyer agent", SELLER_AGENT: "Your agent", HUMAN: "You", SYSTEM: "System" };
export const actorOf = a => ACTOR[a] || String(a || "").replace(/_/g, " ");

export function sortData(d) {
  return {
    ...d,
    events: d.events.slice().sort((a, b) => (num(b.event_id) || 0) - (num(a.event_id) || 0)),
    negotiations: d.negotiations.slice().sort((a, b) =>
      ((asDate(b.created_at) || 0) - (asDate(a.created_at) || 0)) || String(b.id).localeCompare(String(a.id)))
  };
}

export function matches(e, { q, actor, action, flagged }) {
  if (actor && e.actor !== actor) return false;
  if (action && e.action !== action) return false;
  if (flagged && flagsOf(e).length === 0) return false;
  if (q) {
    const hay = [e.note, e.hint, e.actor, e.action, e.decision, e.negotiation_id, e.rate, e.counter_rate, e.payment_terms]
      .filter(v => v != null).join(" ").toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}
