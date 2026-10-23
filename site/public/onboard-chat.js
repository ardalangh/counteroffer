// "Onboard with AI" chat panel for /app. Talks to the onboard_chat callable Cloud Function
// (Claude via Snowflake Cortex). All model / user text is rendered with textContent only.
import { app, auth, db, addCopyButton } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

const $ = id => document.getElementById(id);
const STARTER = "Tell me about your business — what do you sell, and how do deals usually get negotiated?";
const MAX_MSGS = 40, MAX_LEN = 4000;
const onboardChat = httpsCallable(getFunctions(app, "us-central1"), "onboard_chat", { timeout: 540000 });

let uid = null, messages = [], result = null, busy = false;

function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v; else if (k === "class") e.className = v; else e.setAttribute(k, v);
  }
  kids.forEach(k => e.appendChild(k));
  return e;
}

// ---------- rendering ----------
function bubble(role, text) {
  return el("div", { class: "ai-msg " + role }, [el("span", { class: "who", text: role === "user" ? "You" : "Claude" }), el("span", { text })]);
}
function renderLog() {
  const log = $("ai-log");
  log.replaceChildren(bubble("assistant", STARTER), ...messages.map(m => bubble(m.role, m.content)));
  if (busy) log.appendChild(el("div", { class: "ai-msg assistant", "aria-label": "Claude is typing" }, [el("span", { class: "ai-typing" }, [el("i"), el("i"), el("i")])]));
  log.scrollTop = log.scrollHeight;
  $("ai-send").disabled = busy;
  $("ai-input").disabled = busy;
  $("ai-send").textContent = busy ? "Thinking…" : "Send";
}
function showError(msg) { $("ai-err").textContent = msg; $("ai-err").hidden = !msg; }

function renderResult() {
  const box = $("ai-result");
  if (!result || !result.spec) { box.hidden = true; box.replaceChildren(); return; }
  const s = result.spec, files = result.files || {}, val = result.validation || {};
  const card = el("div", { class: "ai-result" });
  card.appendChild(el("div", { class: "eyebrow", text: "Onboarding result" }));
  card.appendChild(el("h3", { text: String(s.company_name || "Your company") }));
  const dl = el("dl");
  const row = (k, v) => { dl.appendChild(el("dt", { text: k })); dl.appendChild(el("dd", { text: v })); };
  row("Industry", String(s.industry || "—"));
  row("Deployable", s.deployable ? "Yes — runs on the current freight engine" : "No — needs engine extension (spec only)");
  if (s.agent_name) row("Sales agent", String(s.agent_name));
  if (result.repairs) row("Self-repair", `Claude self-repaired ${result.repairs} time${result.repairs === 1 ? "" : "s"} after sandbox errors`);
  card.appendChild(dl);
  for (const [name, sql] of Object.entries(files)) {
    const ok = val[name] === "OK";
    const f = el("div", { class: "ai-file" });
    f.appendChild(el("div", { class: "ai-file-head" }, [
      el("span", { text: name }),
      el("span", { class: "ai-badge " + (ok ? "ok" : "bad"), text: ok ? "✅ validated in Snowflake sandbox" : "❌ error" })
    ]));
    if (!ok && val[name]) f.appendChild(el("p", { class: "ai-errtext", text: String(val[name]) }));
    const pre = el("pre", { class: "code" }, [el("code", { text: String(sql) })]);
    f.appendChild(pre);
    card.appendChild(f);
    addCopyButton(pre);
  }
  card.appendChild(el("p", { class: "mini", text: "The wizard below has been prefilled from this spec. Validation ran inside a rolled-back sandbox transaction; nothing was deployed to your account." }));
  box.replaceChildren(card); box.hidden = false;
}

// ---------- persistence ----------
async function persist() {
  if (!uid) return;
  try {
    await setDoc(doc(db, "workspaces", uid), {
      onboardingChat: { messages, result: result || null, updatedAt: serverTimestamp() }
    }, { merge: true });
  } catch (e) { console.warn("Couldn't save the onboarding chat", e.code || e); }
}

// ---------- wizard prefill (via the wizard's own input listeners, so it autosaves) ----------
function setField(id, value, evt = "input") {
  const e = $(id);
  if (!e || value === undefined || value === null || value === "" || Number.isNaN(value)) return;
  e.value = String(value);
  e.dispatchEvent(new Event(evt, { bubbles: true }));
}
const pct = f => (typeof f === "number" && isFinite(f)) ? Math.round(f * 1000) / 10 : undefined;
function industryOf(s) {
  if (s.is_freight) return "freight";
  const t = String(s.industry || "").toLowerCase();
  if (/saas|software/.test(t)) return "saas";
  if (/distribut|wholesale/.test(t)) return "distribution";
  return "other";
}
function prefillWizard(s) {
  setField("company", String(s.company_name || "").slice(0, 80));
  setField("industry", industryOf(s), "change");
  for (const t of Array.isArray(s.tiers) ? s.tiers : []) {
    const T = String(t.tier || "").toUpperCase();
    if (!["STANDARD", "PREFERRED", "STRATEGIC"].includes(T)) continue;
    setField(`t-${T}-target`, pct(t.target_margin));
    setField(`t-${T}-min`, pct(t.min_margin));
    setField(`t-${T}-absmin`, pct(t.absolute_min_margin));
    const thr = Number(t.approval_threshold_usd ?? s.auto_approval_threshold_usd);
    if (isFinite(thr) && thr >= 0) setField(`t-${T}-threshold`, Math.round(thr));
  }
  for (const lv of Array.isArray(s.levers) ? s.levers : []) {
    if (lv && lv.status === "supported" && typeof lv.margin_credit === "number") setField(`l-${lv.lever}`, pct(lv.margin_credit));
  }
}

// ---------- sending ----------
function friendly(err) {
  const code = String((err && err.code) || "");
  const msg = String((err && err.message) || "");
  const ours = msg && !/^(internal|not[- ]found|unavailable)$/i.test(msg);  // server-written message
  if (code === "functions/unauthenticated") return "Please sign in again to use AI onboarding.";
  if (code === "functions/deadline-exceeded") return "That took too long. Try again — generating files can take a couple of minutes.";
  if (ours && /functions\/(resource-exhausted|invalid-argument|unavailable|internal)/.test(code)) return msg;
  return "AI onboarding isn't deployed yet — use the steps below.";
}

async function send(text) {
  if (busy) return;
  text = text.trim();
  if (!text) return;
  if (text.length > MAX_LEN) { showError("Keep each message under 4,000 characters."); return; }
  if (messages.length + 1 > MAX_MSGS) { showError("This conversation is at its limit. Click “Start over” or use the steps below."); return; }
  showError("");
  messages.push({ role: "user", content: text });
  $("ai-input").value = "";
  busy = true; renderLog();
  persist();
  try {
    const res = await onboardChat({ messages: messages.slice(-MAX_MSGS) });
    const d = res.data || {};
    messages.push({ role: "assistant", content: String(d.reply || "") });
    if (d.done && d.spec) {
      result = { spec: d.spec, files: d.files || {}, validation: d.validation || {}, repairs: Number(d.repairs) || 0 };
      prefillWizard(d.spec);
    }
  } catch (e) {
    console.warn("onboard_chat failed", e.code || e);
    messages.pop();             // let the seller retry the same message
    $("ai-input").value = text;
    showError(friendly(e));
  } finally {
    busy = false; renderLog(); renderResult(); persist();
  }
}

// ---------- events ----------
$("ai-form").addEventListener("submit", e => { e.preventDefault(); send($("ai-input").value); });
$("ai-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($("ai-input").value); }
});
$("ai-reset").addEventListener("click", () => {
  if (busy) return;
  if (messages.length && !confirm("Clear this AI onboarding conversation?")) return;
  messages = []; result = null; showError(""); renderLog(); renderResult(); persist();
});
$("ai-toggle").addEventListener("click", () => {
  const open = $("ai-body").hidden;
  $("ai-body").hidden = !open;
  $("ai-toggle").setAttribute("aria-expanded", String(open));
  $("ai-toggle").textContent = open ? "Hide" : "Show";
  try { localStorage.setItem("aiPanelCollapsed", open ? "0" : "1"); } catch (e) { /* ignore */ }
});
try { if (localStorage.getItem("aiPanelCollapsed") === "1") $("ai-toggle").click(); } catch (e) { /* ignore */ }

renderLog();
onAuthStateChanged(auth, async user => {
  uid = user ? user.uid : null;
  if (!uid) return;
  try {
    const snap = await getDoc(doc(db, "workspaces", uid));
    const c = snap.exists() && snap.data().onboardingChat;
    if (c && Array.isArray(c.messages)) {
      messages = c.messages.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-MAX_MSGS);
      result = c.result && c.result.spec ? c.result : null;
    }
  } catch (e) { console.warn("Couldn't load the onboarding chat", e.code || e); }
  renderLog(); renderResult();
});
