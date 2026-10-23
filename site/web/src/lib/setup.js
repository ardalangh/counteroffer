// Seller setup: state shape, validation and the SQL each step generates.
// Ported from site/public/wizard.js; behaviour is unchanged.
import { sqlStr, yamlStr } from "./sql.js";

export const RAW = "https://raw.githubusercontent.com/ardalangh/counteroffer/main/sql/";
export const FILES = [
  ["00_setup.sql", "Roles (BROKER_ADMIN, STOREFRONT_ROLE), warehouse and the COUNTEROFFER database."],
  ["01_schema.sql", "The PUBLIC schema the agent uses and the sealed PRIVATE schema for costs and policy."],
  ["02_seed.sql", "Demo lanes, cost basis, customers and pricing policy. Skip or replace it for your own data."],
  ["03_governance.sql", "Grants that keep PRIVATE invisible to the agent and to buyers."],
  ["04_procs.sql", "Owner's-rights procedures that evaluate offers and return only a decision."],
  ["05_agent.sql", "The Claude sales agent, as a Snowflake Cortex Agent."],
  ["06_mcp.sql", "The Snowflake-managed MCP server that exposes the agent to buyers."]
];

export const STEPS = [
  { key: 1, name: "Workspace", blurb: "Your company and Snowflake account" },
  { key: 2, name: "Prerequisites", blurb: "Turn on Claude in Cortex" },
  { key: 3, name: "Install", blurb: "Run seven SQL files" },
  { key: 4, name: "Pricing rules", blurb: "Margins and concessions" },
  { key: 5, name: "Publish", blurb: "Your storefront's MCP server" },
  { key: 6, name: "Invite buyers", blurb: "Send one link" }
];

export const TIERS = {
  STANDARD: { target: 30, min: 12, absmin: 6, threshold: 5000000, buffer: 4, rounds: 8 },
  PREFERRED: { target: 28, min: 10, absmin: 5, threshold: 7500000, buffer: 4, rounds: 8 },
  STRATEGIC: { target: 25, min: 8, absmin: 4, threshold: 10000000, buffer: 3, rounds: 10 }
};
export const TIER_NAMES = { STANDARD: "Standard", PREFERRED: "Preferred", STRATEGIC: "Strategic" };
export const LEVERS = { TERM_12M: 4, VOLUME_30: 3, PICKUP_48H: 2, NET15: 1, NET60: -2 };
export const LEVER_LABELS = {
  TERM_12M: "12-month term", VOLUME_30: "30+ loads a week", PICKUP_48H: "48-hour pickup",
  NET15: "NET15 payment", NET60: "NET60 payment"
};
export const INDUSTRIES = [
  ["freight", "Freight and logistics"], ["distribution", "Distribution"], ["saas", "B2B software"], ["other", "Other"]
];
export const EXAMPLE_COST = 3635.33;

export function defaults() {
  const tiers = {};
  for (const [t, v] of Object.entries(TIERS)) tiers[t] = { target: v.target, min: v.min, absmin: v.absmin, threshold: v.threshold };
  return { company: "", industry: "freight", account: "", clientId: "", tiers, levers: { ...LEVERS }, done: {} };
}

export function mergeLoaded(d) {
  const s = defaults();
  if (!d) return s;
  if (typeof d.company === "string") s.company = d.company;
  if (INDUSTRIES.some(([k]) => k === d.industry)) s.industry = d.industry;
  if (typeof d.account === "string") s.account = d.account;
  if (typeof d.clientId === "string") s.clientId = d.clientId;
  if (d.tiers) for (const t of Object.keys(TIERS)) if (d.tiers[t]) for (const k of Object.keys(s.tiers[t])) if (d.tiers[t][k] !== undefined) s.tiers[t][k] = d.tiers[t][k];
  if (d.levers) for (const k of Object.keys(LEVERS)) if (d.levers[k] !== undefined) s.levers[k] = d.levers[k];
  if (d.done) for (let i = 1; i <= 6; i++) s.done[i] = !!d.done[i];
  return s;
}

// What gets written to Firestore: setup values only, never credentials.
export function persistable(s) {
  return { company: s.company, industry: s.industry, account: s.account, clientId: s.clientId, tiers: s.tiers, levers: s.levers, done: s.done };
}

const n = v => (v === "" || v == null || isNaN(Number(v))) ? NaN : Number(v);
const dec = pct => (pct / 100).toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1");
const money = x => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const oneLine = s => String(s).replace(/[\r\n]+/g, " ");

export const ACCOUNT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
export const accountValid = s => ACCOUNT_RE.test(s.account.trim());
export const host = s => accountValid(s)
  ? s.account.trim().toLowerCase().replace(/_/g, "-") + ".snowflakecomputing.com"
  : "<orgname-accountname>.snowflakecomputing.com";
export const storefrontUrl = s => "https://" + host(s) + "/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/STOREFRONT_MCP";
export const companyName = s => s.company.trim() || "Your company";
export const deskName = s => companyName(s) + " sales desk";
export function slug(s) {
  const x = s.company.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return x ? (/^[0-9]/.test(x) ? "s_" + x : x) : "counteroffer";
}
export function shareLink(s) {
  const q = new URLSearchParams({ n: deskName(s), u: storefrontUrl(s) });
  if (s.clientId.trim()) q.set("c", s.clientId.trim());
  q.set("t", slug(s));
  return window.location.origin + "/connect?" + q.toString();
}

// Returns { errors: string[], invalid: Set<"t-TIER-key" | "l-LEVER"> }
export function validatePolicy(s) {
  const errors = [], invalid = new Set();
  for (const t of Object.keys(TIERS)) {
    const p = s.tiers[t];
    const vals = { target: n(p.target), min: n(p.min), absmin: n(p.absmin), threshold: n(p.threshold) };
    for (const [k, v] of Object.entries(vals)) if (isNaN(v) || v < 0) invalid.add(`t-${t}-${k}`);
    const { target, min, absmin, threshold } = vals;
    const label = TIER_NAMES[t];
    if ([target, min, absmin, threshold].some(isNaN)) { errors.push(`${label}: fill in every value.`); continue; }
    if ([target, min, absmin, threshold].some(v => v < 0)) errors.push(`${label}: values can't be negative.`);
    if (target > 100 || min > 100 || absmin > 100) errors.push(`${label}: margins are percentages from 0 to 100.`);
    if (!(absmin <= min && min <= target)) {
      errors.push(`${label}: the absolute minimum has to be at or below the minimum, and the minimum at or below the target (now ${absmin}%, ${min}%, ${target}%).`);
      invalid.add(`t-${t}-absmin`); invalid.add(`t-${t}-min`);
    }
  }
  for (const k of Object.keys(LEVERS)) {
    if (isNaN(n(s.levers[k]))) { invalid.add(`l-${k}`); errors.push(`${LEVER_LABELS[k]}: enter a credit in margin points.`); }
  }
  return { errors, invalid };
}

export function floorPreview(s) {
  const credits = Object.keys(LEVERS).reduce((sum, k) => { const v = n(s.levers[k]); return sum + (v > 0 ? v : 0); }, 0);
  return Object.keys(TIERS).map(t => {
    const p = s.tiers[t], target = n(p.target), min = n(p.min), absmin = n(p.absmin);
    const ok = ![target, min, absmin].some(isNaN);
    return {
      tier: TIER_NAMES[t],
      list: ok ? money(EXAMPLE_COST * (1 + target / 100)) : "—",
      floor: ok ? money(EXAMPLE_COST * (1 + Math.max(min, absmin) / 100)) : "—",
      levered: ok ? money(EXAMPLE_COST * (1 + Math.max(min - credits, absmin) / 100)) : "—"
    };
  });
}

export function prereqSql(s) {
  const who = oneLine(sqlStr(companyName(s))) + (accountValid(s) ? " (" + s.account.trim().toUpperCase() + ")" : "");
  return [
    `-- Counteroffer prerequisites for ${who}`,
    "USE ROLE ACCOUNTADMIN;",
    "ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';",
    "SELECT AI_COMPLETE('claude-sonnet-5', 'Reply with exactly one word: pong');"
  ].join("\n");
}

export function policySql(s) {
  if (validatePolicy(s).errors.length) return "-- Fix the highlighted values above to generate your policy SQL.";
  const lines = ["USE ROLE BROKER_ADMIN;", ""];
  for (const t of Object.keys(TIERS)) {
    const p = s.tiers[t];
    lines.push(`UPDATE COUNTEROFFER.PRIVATE.PRICING_POLICY SET TARGET_MARGIN = ${dec(n(p.target))}, MIN_MARGIN = ${dec(n(p.min))}, ABSOLUTE_MIN_MARGIN = ${dec(n(p.absmin))}, APPROVAL_THRESHOLD_USD = ${Math.round(n(p.threshold))} WHERE TIER = '${sqlStr(t)}';`);
  }
  lines.push("");
  for (const k of Object.keys(LEVERS)) lines.push(`UPDATE COUNTEROFFER.PRIVATE.CONCESSION_LEVERS SET MARGIN_CREDIT = ${dec(n(s.levers[k]))} WHERE LEVER = '${sqlStr(k)}';`);
  return lines.join("\n");
}

export const OAUTH_SQL = [
  "USE ROLE ACCOUNTADMIN;",
  "CREATE SECURITY INTEGRATION IF NOT EXISTS STOREFRONT_MCP_OAUTH",
  "  TYPE = OAUTH OAUTH_CLIENT = CUSTOM ENABLED = TRUE",
  "  OAUTH_CLIENT_TYPE = 'PUBLIC'",
  "  OAUTH_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'",
  "  OAUTH_USE_SECONDARY_ROLES = NONE",
  "  ALLOWED_ROLES_LIST = ('STOREFRONT_ROLE');",
  "SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('STOREFRONT_MCP_OAUTH');"
].join("\n");

export function mcpSql(s) {
  const co = yamlStr(companyName(s));
  return [
    "USE ROLE BROKER_ADMIN;",
    "CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP",
    "  FROM SPECIFICATION $$",
    "  tools:",
    `    - title: "${co} sales desk"`,
    `      name: "${slug(s)}_sales"`,
    '      type: "CORTEX_AGENT_RUN"',
    '      identifier: "COUNTEROFFER.PUBLIC.ACME_SELLER"',
    `      description: "Request quotes and negotiate contracts with ${co}."`,
    "  $$;",
    "GRANT USAGE ON MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP TO ROLE STOREFRONT_ROLE;"
  ].join("\n");
}

export function inviteText(s) {
  const cid = s.clientId.trim();
  return [
    `Hi — ${companyName(s)} now takes quotes and negotiates contracts with your AI agent.`,
    "",
    `Open this page and click "Add to Claude":`,
    shareLink(s),
    "",
    cid ? "" : "We'll send your OAuth client ID separately.",
    "Sign in with the Snowflake login we gave you, approve access, then set the",
    `"${deskName(s)}" tool to Always allow.`,
    "",
    "Then give Claude a buying mandate, e.g. \"Get a 12-month contract for 30 loads/week",
    "on our lanes at the best price you can, max $X per load.\"",
    "",
    "Your agent negotiates directly with ours; anything above our approval threshold goes to a human on our side.",
    `— ${companyName(s)}`
  ].filter(l => l !== "").join("\n");
}

// ---------- AI onboarding spec → setup state ----------
const pctOf = f => (typeof f === "number" && isFinite(f)) ? Math.round(f * 1000) / 10 : undefined;
const usable = v => !(v === undefined || v === null || v === "" || Number.isNaN(v));

function industryOf(spec) {
  if (spec.is_freight) return "freight";
  const t = String(spec.industry || "").toLowerCase();
  if (/saas|software/.test(t)) return "saas";
  if (/distribut|wholesale/.test(t)) return "distribution";
  return "other";
}

export function applySpec(state, spec) {
  const s = JSON.parse(JSON.stringify(state));
  const company = String(spec.company_name || "").slice(0, 80);
  if (company) s.company = company;
  s.industry = industryOf(spec);
  for (const t of Array.isArray(spec.tiers) ? spec.tiers : []) {
    const T = String(t.tier || "").toUpperCase();
    if (!TIERS[T]) continue;
    const vals = { target: pctOf(t.target_margin), min: pctOf(t.min_margin), absmin: pctOf(t.absolute_min_margin) };
    for (const [k, v] of Object.entries(vals)) if (usable(v)) s.tiers[T][k] = v;
    const thr = Number(t.approval_threshold_usd ?? spec.auto_approval_threshold_usd);
    if (isFinite(thr) && thr >= 0) s.tiers[T].threshold = Math.round(thr);
  }
  for (const lv of Array.isArray(spec.levers) ? spec.levers : []) {
    if (lv && lv.status === "supported" && typeof lv.margin_credit === "number" && lv.lever in LEVERS) {
      const v = pctOf(lv.margin_credit);
      if (usable(v)) s.levers[lv.lever] = v;
    }
  }
  return s;
}
