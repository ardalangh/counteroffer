import { auth, db, go, pageUrl, sqlStr, yamlStr, addCopyButton } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = id => document.getElementById(id);
document.querySelectorAll("[data-page]").forEach(a => a.href = pageUrl(a.dataset.page));

const RAW = "https://raw.githubusercontent.com/ardalangh/counteroffer/main/sql/";
const FILES = [
  ["00_setup.sql", "Roles (BROKER_ADMIN, STOREFRONT_ROLE), warehouse and the COUNTEROFFER database."],
  ["01_schema.sql", "PUBLIC schema for the agent and the sealed PRIVATE schema for costs and policy."],
  ["02_seed.sql", "Demo lanes, cost basis, customers and pricing policy (skip/replace for your own data)."],
  ["03_governance.sql", "Grants that keep PRIVATE invisible to the agent and buyers."],
  ["04_procs.sql", "Owner's-rights procedures that evaluate offers and return only ACCEPT/COUNTER/REJECT/FINAL."],
  ["05_agent.sql", "The Claude sales agent as a Snowflake Cortex Agent."],
  ["06_mcp.sql", "The Snowflake-managed MCP server that exposes the agent to buyers."]
];
const STEP_NAMES = ["Workspace", "Prerequisites", "Install", "Pricing rules", "Publish", "Invite buyers"];
const TIERS = {
  STANDARD:  { target: 30, min: 12, absmin: 6, threshold: 5000000,  buffer: 4, rounds: 8 },
  PREFERRED: { target: 28, min: 10, absmin: 5, threshold: 7500000,  buffer: 4, rounds: 8 },
  STRATEGIC: { target: 25, min: 8,  absmin: 4, threshold: 10000000, buffer: 3, rounds: 10 }
};
const LEVERS = { TERM_12M: 4, VOLUME_30: 3, PICKUP_48H: 2, NET15: 1, NET60: -2 };
const LEVER_LABELS = { TERM_12M: "12-month term", VOLUME_30: "≥30 loads/week", PICKUP_48H: "48h pickup", NET15: "NET15 payment", NET60: "NET60 payment" };
const EXAMPLE_COST = 3635.33;

function defaults() {
  const tiers = {};
  for (const [t, v] of Object.entries(TIERS)) tiers[t] = { target: v.target, min: v.min, absmin: v.absmin, threshold: v.threshold };
  return { company: "", industry: "freight", account: "", clientId: "", tiers, levers: { ...LEVERS }, done: {} };
}
let state = defaults();
let uid = null;

// ---------- helpers ----------
const ACCOUNT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const accountValid = () => ACCOUNT_RE.test(state.account.trim());
const host = () => accountValid() ? state.account.trim().toLowerCase().replace(/_/g, "-") + ".snowflakecomputing.com" : "<orgname-accountname>.snowflakecomputing.com";
const storefrontUrl = () => "https://" + host() + "/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/STOREFRONT_MCP";
const companyName = () => state.company.trim() || "Your company";
function slug() {
  const s = state.company.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return s ? (/^[0-9]/.test(s) ? "s_" + s : s) : "counteroffer";
}
const num = v => (v === "" || v == null || isNaN(Number(v))) ? NaN : Number(v);
function dec(pct) { return (pct / 100).toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1"); }
const money = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const oneLine = s => String(s).replace(/[\r\n]+/g, " ");

function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v; else if (k === "class") e.className = v; else e.setAttribute(k, v);
  }
  kids.forEach(k => e.appendChild(k));
  return e;
}

// ---------- build dynamic DOM ----------
FILES.forEach(([f, purpose], i) => {
  $("files").appendChild(el("li", {}, [
    el("span", { class: "n", text: String(i + 1).padStart(2, "0") }),
    el("a", { href: RAW + f, target: "_blank", rel: "noopener", text: "sql/" + f }),
    el("small", { text: purpose })
  ]));
});
STEP_NAMES.forEach((n, i) => {
  $("chips").appendChild(el("li", {}, [el("a", { href: "#step-" + (i + 1), id: "chip-" + (i + 1), text: (i + 1) + " · " + n })]));
});

const policyInputs = [];
function numField(label, id, attrs, onInput) {
  const input = el("input", Object.assign({ id, type: "number", inputmode: "decimal" }, attrs));
  input.addEventListener("input", () => onInput(input.value));
  policyInputs.push(input);
  return { wrap: el("div", { class: "field" }, [el("label", { for: id, text: label }), input]), input };
}
const tierInputs = {};
for (const [t, cfg] of Object.entries(TIERS)) {
  tierInputs[t] = {};
  const box = el("div", { class: "tier" }, [el("h3", { text: t })]);
  [["target", "Target margin %"], ["min", "Minimum margin %"], ["absmin", "Absolute minimum %"], ["threshold", "Approval threshold $"]].forEach(([k, lbl]) => {
    const f = numField(lbl, `t-${t}-${k}`, k === "threshold" ? { min: "0", step: "1000" } : { min: "0", max: "100", step: "0.5" }, v => { state.tiers[t][k] = v === "" ? "" : Number(v); changed(); });
    tierInputs[t][k] = f.input;
    box.appendChild(f.wrap);
  });
  box.appendChild(el("p", { class: "ro", text: `Counter buffer ${cfg.buffer}% · Max rounds ${cfg.rounds}` }));
  $("tiers").appendChild(box);
}
const leverInputs = {};
for (const k of Object.keys(LEVERS)) {
  const f = numField(LEVER_LABELS[k] + " (" + k + ")", "l-" + k, { step: "0.5", min: "-50", max: "50" }, v => { state.levers[k] = v === "" ? "" : Number(v); changed(); });
  leverInputs[k] = f.input;
  $("levers").appendChild(f.wrap);
}

// ---------- render ----------
function validatePolicy() {
  const errs = [];
  for (const t of Object.keys(TIERS)) {
    const p = state.tiers[t], target = num(p.target), min = num(p.min), absmin = num(p.absmin), thr = num(p.threshold);
    [["target", target], ["min", min], ["absmin", absmin], ["threshold", thr]].forEach(([k, v]) => tierInputs[t][k].setAttribute("aria-invalid", (isNaN(v) || v < 0) ? "true" : "false"));
    if ([target, min, absmin, thr].some(v => isNaN(v))) { errs.push(`${t}: fill in every value.`); continue; }
    if ([target, min, absmin, thr].some(v => v < 0)) errs.push(`${t}: values can't be negative.`);
    if (target > 100 || min > 100 || absmin > 100) errs.push(`${t}: margins are percentages (0–100).`);
    if (!(absmin <= min && min <= target)) {
      errs.push(`${t}: needs absolute minimum ≤ minimum ≤ target (got ${absmin}% / ${min}% / ${target}%).`);
      tierInputs[t].absmin.setAttribute("aria-invalid", "true"); tierInputs[t].min.setAttribute("aria-invalid", "true");
    }
  }
  for (const k of Object.keys(LEVERS)) {
    const v = num(state.levers[k]);
    leverInputs[k].setAttribute("aria-invalid", isNaN(v) ? "true" : "false");
    if (isNaN(v)) errs.push(`${k}: enter a credit (points).`);
  }
  return errs;
}

function renderPolicy() {
  const errs = validatePolicy();
  $("policy-err").hidden = !errs.length;
  $("policy-err").textContent = errs.join(" ");
  const pre = $("preview"); pre.replaceChildren();
  pre.appendChild(el("thead", {}, [el("tr", {}, ["Tier", "List price", "Floor (no levers)", "Floor (all positive levers)"].map(h => el("th", { text: h })))]));
  const tb = el("tbody");
  const credits = Object.keys(LEVERS).reduce((s, k) => { const v = num(state.levers[k]); return s + (v > 0 ? v : 0); }, 0);
  for (const t of Object.keys(TIERS)) {
    const p = state.tiers[t], target = num(p.target), min = num(p.min), absmin = num(p.absmin);
    const ok = ![target, min, absmin].some(isNaN);
    const cells = ok ? [
      money(EXAMPLE_COST * (1 + target / 100)),
      money(EXAMPLE_COST * (1 + Math.max(min, absmin) / 100)),
      money(EXAMPLE_COST * (1 + Math.max(min - credits, absmin) / 100))
    ] : ["—", "—", "—"];
    tb.appendChild(el("tr", {}, [el("td", { text: t }), ...cells.map(c => el("td", { text: c }))]));
  }
  pre.appendChild(tb);
  if (errs.length) { $("sql-policy").textContent = "-- Fix the highlighted values above to generate your policy SQL."; return; }
  const lines = ["USE ROLE BROKER_ADMIN;", ""];
  for (const t of Object.keys(TIERS)) {
    const p = state.tiers[t];
    lines.push(`UPDATE COUNTEROFFER.PRIVATE.PRICING_POLICY SET TARGET_MARGIN = ${dec(num(p.target))}, MIN_MARGIN = ${dec(num(p.min))}, ABSOLUTE_MIN_MARGIN = ${dec(num(p.absmin))}, APPROVAL_THRESHOLD_USD = ${Math.round(num(p.threshold))} WHERE TIER = '${sqlStr(t)}';`);
  }
  lines.push("");
  for (const k of Object.keys(LEVERS)) lines.push(`UPDATE COUNTEROFFER.PRIVATE.CONCESSION_LEVERS SET MARGIN_CREDIT = ${dec(num(state.levers[k]))} WHERE LEVER = '${sqlStr(k)}';`);
  $("sql-policy").textContent = lines.join("\n");
}

function render() {
  // Step 1
  const acct = state.account.trim();
  const bad = acct !== "" && !accountValid();
  $("account").setAttribute("aria-invalid", bad ? "true" : "false");
  $("account-err").hidden = !bad;
  $("account-err").textContent = bad ? "Use ORGNAME-ACCOUNTNAME: letters, digits and _ only, with exactly one hyphen (e.g. ACMEORG-FREIGHT_PROD)." : "";
  $("host-out").textContent = host();

  // Step 2
  const who = oneLine(sqlStr(companyName())) + (accountValid() ? " (" + acct.toUpperCase() + ")" : "");
  $("sql-prereq").textContent = [
    `-- Counteroffer prerequisites for ${who}`,
    "USE ROLE ACCOUNTADMIN;",
    "ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';",
    "SELECT AI_COMPLETE('claude-sonnet-5', 'Reply with exactly one word: pong');"
  ].join("\n");

  // Step 4
  renderPolicy();

  // Step 5
  $("sql-oauth").textContent = [
    "USE ROLE ACCOUNTADMIN;",
    "CREATE SECURITY INTEGRATION IF NOT EXISTS STOREFRONT_MCP_OAUTH",
    "  TYPE = OAUTH OAUTH_CLIENT = CUSTOM ENABLED = TRUE",
    "  OAUTH_CLIENT_TYPE = 'PUBLIC'",
    "  OAUTH_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'",
    "  OAUTH_USE_SECONDARY_ROLES = NONE",
    "  ALLOWED_ROLES_LIST = ('STOREFRONT_ROLE');",
    "SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('STOREFRONT_MCP_OAUTH');"
  ].join("\n");
  const co = yamlStr(companyName());
  $("sql-mcp").textContent = [
    "USE ROLE BROKER_ADMIN;",
    "CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP",
    "  FROM SPECIFICATION $$",
    "  tools:",
    `    - title: "${co} sales desk"`,
    `      name: "${slug()}_sales"`,
    '      type: "CORTEX_AGENT_RUN"',
    '      identifier: "COUNTEROFFER.PUBLIC.ACME_SELLER"',
    `      description: "Request quotes and negotiate contracts with ${co}."`,
    "  $$;",
    "GRANT USAGE ON MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP TO ROLE STOREFRONT_ROLE;"
  ].join("\n");
  $("url-out").textContent = storefrontUrl();

  // Step 6
  const cid = state.clientId.trim();
  $("cc-name").textContent = companyName() + " sales desk";
  $("cc-logo").textContent = (state.company.trim()[0] || "C").toUpperCase();
  $("cc-url").textContent = storefrontUrl();
  $("cc-client").textContent = cid || "(ask the seller — set in step 5)";
  $("invite").textContent = [
    `Hi — ${companyName()} now takes quotes and negotiates contracts with your AI agent.`,
    "",
    "Connect Claude to our storefront:",
    "1. In Claude: Settings → Connectors → Add custom connector.",
    `2. Paste this URL: ${storefrontUrl()}`,
    "3. Click Sign in now → choose \"Use your own OAuth client\".",
    `4. Client ID: ${cid || "<client ID we'll send you>"}`,
    "5. Click Connect, sign in with the Snowflake login we gave you, and approve access.",
    `6. Set the "${companyName()} sales desk" tool to Always allow.`,
    "7. Give Claude a buying mandate, e.g. \"Get a 12-month contract for 30 loads/week on our lanes at the best price you can, max $X per load.\"",
    "",
    "Your agent negotiates directly with ours; anything above our approval threshold goes to a human on our side.",
    `— ${companyName()}`
  ].join("\n");

  // Progress / done
  let n = 0;
  for (let i = 1; i <= 6; i++) {
    const d = !!state.done[i]; if (d) n++;
    $("step-" + i).classList.toggle("done", d);
    $("chip-" + i).classList.toggle("done", d);
    $("chip-" + i).textContent = (d ? "✓ " : (i + " · ")) + STEP_NAMES[i - 1];
    const cb = document.querySelector(`[data-done="${i}"]`); if (cb.checked !== d) cb.checked = d;
  }
  $("progress-text").textContent = `${n} of 6 steps done`;
  $("bar-fill").style.width = (n / 6 * 100) + "%";
  $("bar").setAttribute("aria-valuenow", String(n));
  $("live").hidden = n !== 6;
  $("live-company").textContent = companyName();
  $("live-url").textContent = storefrontUrl();
}

function fillInputs() {
  $("company").value = state.company; $("industry").value = state.industry; $("account").value = state.account; $("clientid").value = state.clientId;
  for (const t of Object.keys(TIERS)) for (const k of Object.keys(tierInputs[t])) tierInputs[t][k].value = state.tiers[t][k];
  for (const k of Object.keys(LEVERS)) leverInputs[k].value = state.levers[k];
}

// ---------- persistence ----------
let saveTimer = null, dirty = false;
function setSave(text, cls) { const s = $("save-state"); s.textContent = text; s.className = "save-state " + (cls || ""); }
function changed() { render(); dirty = true; setSave("Unsaved changes…"); clearTimeout(saveTimer); saveTimer = setTimeout(save, 800); }
async function save() {
  if (!uid || !dirty) return;
  dirty = false; clearTimeout(saveTimer);
  setSave("Saving…");
  try {
    // Only non-secret, setup values. Never credentials.
    await setDoc(doc(db, "workspaces", uid), {
      company: state.company, industry: state.industry, account: state.account, clientId: state.clientId,
      tiers: state.tiers, levers: state.levers, done: state.done, updatedAt: serverTimestamp()
    }, { merge: true });
    setSave("All changes saved", "ok");
  } catch (e) {
    dirty = true;
    console.error(e);
    setSave("Couldn't save (" + (e.code || "error") + "). Retrying…", "bad");
    saveTimer = setTimeout(save, 4000);
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

function mergeLoaded(d) {
  const s = defaults();
  if (typeof d.company === "string") s.company = d.company;
  if (["freight", "distribution", "saas", "other"].includes(d.industry)) s.industry = d.industry;
  if (typeof d.account === "string") s.account = d.account;
  if (typeof d.clientId === "string") s.clientId = d.clientId;
  if (d.tiers) for (const t of Object.keys(TIERS)) if (d.tiers[t]) for (const k of Object.keys(s.tiers[t])) if (d.tiers[t][k] !== undefined) s.tiers[t][k] = d.tiers[t][k];
  if (d.levers) for (const k of Object.keys(LEVERS)) if (d.levers[k] !== undefined) s.levers[k] = d.levers[k];
  if (d.done) for (let i = 1; i <= 6; i++) s.done[i] = !!d.done[i];
  return s;
}

// ---------- events ----------
$("company").addEventListener("input", e => { state.company = e.target.value; changed(); });
$("industry").addEventListener("change", e => { state.industry = e.target.value; changed(); });
$("account").addEventListener("input", e => { state.account = e.target.value; changed(); });
$("clientid").addEventListener("input", e => { state.clientId = e.target.value; changed(); });
document.querySelectorAll("[data-done]").forEach(cb => cb.addEventListener("change", () => {
  state.done[cb.dataset.done] = cb.checked; changed();
  if (cb.checked) { const next = $("step-" + (Number(cb.dataset.done) + 1)); if (next && !state.done[Number(cb.dataset.done) + 1]) next.scrollIntoView({ behavior: "smooth", block: "start" }); }
}));
document.querySelectorAll("pre.code").forEach(addCopyButton);
$("signout").addEventListener("click", async () => { await save(); await signOut(auth); go("login"); });

// ---------- auth gate ----------
onAuthStateChanged(auth, async user => {
  if (!user) { uid = null; $("main").hidden = true; $("userbar").hidden = true; go("login"); return; }
  uid = user.uid;
  $("who").textContent = user.email || user.displayName || "Signed in";
  $("loading").textContent = "Loading your workspace…";
  try {
    const snap = await getDoc(doc(db, "workspaces", uid));
    state = snap.exists() ? mergeLoaded(snap.data()) : defaults();
    setSave(snap.exists() ? "Restored your saved progress" : "New workspace", "ok");
  } catch (e) {
    console.error(e);
    state = defaults();
    setSave("Couldn't load saved progress (" + (e.code || "error") + ")", "bad");
  }
  fillInputs(); render();
  $("loading").hidden = true; $("userbar").hidden = false; $("main").hidden = false;
});
