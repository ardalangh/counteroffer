export const num = v => (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);

export function money(v, cents = true) {
  const n = num(v);
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0
  });
}

// Contract values: $8.11M, $940k.
export function big(v) {
  const n = num(v);
  if (n == null) return "—";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return money(n, false);
}

export function pct(v, digits = 1) {
  const n = num(v);
  return n == null ? "—" : n.toFixed(digits) + "%";
}

// Firestore Timestamp | ISO string | Date → Date
export function asDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function clockTime(v) {
  const d = asDate(v);
  return d ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
}

export function ago(v) {
  const d = asDate(v);
  if (!d) return "—";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

export function termsStr(e) {
  const bits = [];
  if (num(e.term_months) != null) bits.push(num(e.term_months) + " months");
  if (num(e.loads_per_week) != null) bits.push(num(e.loads_per_week) + " loads/wk");
  if (e.payment_terms) bits.push(String(e.payment_terms));
  if (num(e.pickup_window_hrs) != null) bits.push(num(e.pickup_window_hrs) + "h pickup");
  return bits.join(", ");
}
