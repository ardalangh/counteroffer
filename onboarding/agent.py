#!/usr/bin/env python3
"""Counteroffer onboarding interviewer (Claude Agent SDK).

Claude interviews a seller, then generates a spec + Snowflake SQL that turns the
seller into a Counteroffer storefront. The SQL is compiled in a throwaway sandbox
schema (COUNTEROFFER.ONBOARDING_SANDBOX) before the agent is allowed to finish.

  onboarding/.venv/bin/python onboarding/agent.py                       # interactive
  onboarding/.venv/bin/python onboarding/agent.py --answers onboarding/demo_answers.json --quiet-tools
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    tool,
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "out"
SANDBOX = "COUNTEROFFER.ONBOARDING_SANDBOX"
SERVER = "onboard"
SUPPORTED_LEVERS = {
    "TERM_12M": "term_months >= 12",
    "VOLUME_30": "loads_per_week >= 30",
    "PICKUP_48H": "pickup_window_hrs >= 48",
    "NET15": "payment_terms = 'NET15'",
    "NET60": "payment_terms = 'NET60'",
}
# Tables validate_sql may clone into the sandbox (structure only via LIKE; the small
# policy tables also get a copy of their current rows so UPDATE row counts mean something).
CLONABLE = {
    "LANES": "PUBLIC", "CUSTOMERS": "PUBLIC", "FUEL_INDEX": "PUBLIC", "NEGOTIATIONS": "PUBLIC",
    "NEGOTIATION_LEDGER": "PUBLIC", "ORDERS": "PUBLIC",
    "COST_BASIS": "PRIVATE", "PRICING_POLICY": "PRIVATE", "CONCESSION_LEVERS": "PRIVATE",
}
COPY_ROWS = {"PRICING_POLICY", "CONCESSION_LEVERS"}

STATE: dict[str, Any] = {"slug": None, "spec": None, "validated": set(), "done": False}


# ----------------------------------------------------------------------------- helpers
def _ok(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _err(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s[:40] or "seller"


def _sha(text: str) -> str:
    return hashlib.sha256(text.strip().encode()).hexdigest()


def _outdir() -> Path:
    d = OUT / STATE["slug"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def split_sql(sql: str) -> list[str]:
    """Split on ';' outside quotes, $$ blocks and comments. Comments are dropped."""
    stmts, buf, i, n = [], [], 0, len(sql)
    while i < n:
        c, two = sql[i], sql[i:i + 2]
        if two == "--":
            j = sql.find("\n", i)
            i = n if j < 0 else j + 1
            buf.append("\n")
            continue
        if two == "/*":
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if two == "$$":
            j = sql.find("$$", i + 2)
            if j < 0:
                raise ValueError("Unterminated $$ block.")
            buf.append(sql[i:j + 2]); i = j + 2
            continue
        if c == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'" and sql[j + 1:j + 2] == "'":
                    j += 2; continue
                if sql[j] == "\\":
                    j += 2; continue
                if sql[j] == "'":
                    break
                j += 1
            if j >= n:
                raise ValueError("Unterminated string literal.")
            buf.append(sql[i:j + 1]); i = j + 1
            continue
        if c == ";":
            s = "".join(buf).strip()
            if s:
                stmts.append(s)
            buf = []; i += 1
            continue
        buf.append(c); i += 1
    s = "".join(buf).strip()
    if s:
        stmts.append(s)
    return stmts


# ----------------------------------------------------------------------------- snowflake
_CONN = None


def _conn():
    global _CONN
    if _CONN is not None:
        return _CONN
    import snowflake.connector  # imported lazily so the interview can start fast
    path = os.path.expanduser(os.environ.get("COUNTEROFFER_SF_ENV", "~/.snowflake/counteroffer.env"))
    if not os.path.exists(path):
        raise RuntimeError(f"Snowflake credentials file not found (COUNTEROFFER_SF_ENV / {path}).")
    cfg = dict(l.strip().split("=", 1) for l in open(path) if "=" in l and not l.lstrip().startswith("#"))
    c = snowflake.connector.connect(
        account=cfg["SF_ACCOUNT"], user=cfg["SF_USER"], password=cfg["SF_PASSWORD"],
        role="BROKER_ADMIN", warehouse="COUNTEROFFER_WH", database="COUNTEROFFER",
        login_timeout=30, network_timeout=60,
    )
    cur = c.cursor()
    cur.execute("USE SECONDARY ROLES NONE")
    cur.execute(f"CREATE SCHEMA IF NOT EXISTS {SANDBOX} COMMENT = 'Throwaway: onboarding SQL validation'")
    cur.execute(f"USE SCHEMA {SANDBOX}")
    _CONN = c
    return c


_PUB_PRIV = re.compile(r'(?i)\b(?:"?COUNTEROFFER"?\s*\.\s*)?"?(PUBLIC|PRIVATE)"?\s*\.\s*"?([A-Z_][A-Z0-9_]*)"?')
_EXEC_OK = re.compile(r"(?is)^\s*(INSERT|UPDATE|DELETE|MERGE|SELECT|WITH)\b")
_SKIP_USE = re.compile(r"(?is)^\s*USE\s+(ROLE|WAREHOUSE|DATABASE|SCHEMA|SECONDARY)\b")
_AGENT_OR_MCP = re.compile(r"(?is)^\s*CREATE\s+(OR\s+REPLACE\s+)?(AGENT|MCP\s+SERVER)\b")
_GRANT = re.compile(r"(?is)^\s*GRANT\b")


def _check_agent_text(stmt: str) -> str | None:
    """Well-formedness check for CREATE AGENT / CREATE MCP SERVER. Never executed."""
    import yaml
    m = re.search(r"\$\$(.*)\$\$", stmt, re.S)
    if not m:
        return "missing $$ ... $$ specification block"
    try:
        spec = yaml.safe_load(m.group(1))
    except Exception as e:  # noqa: BLE001
        return f"specification is not valid YAML: {e}"
    if not isinstance(spec, dict) or "tools" not in spec:
        return "specification has no 'tools' key"
    if re.search(r"(?i)\bAGENT\b", stmt.split("$$")[0]):
        names = [t.get("tool_spec", {}).get("name") for t in spec["tools"]]
        want = ["log_buyer_message", "start_negotiation", "get_quote", "evaluate_offer", "commit_order"]
        if sorted(n for n in names if n) != sorted(want):
            return f"agent must have exactly these 5 tools {want}, got {names}"
        res = spec.get("tool_resources") or {}
        for n in want:
            ident = (res.get(n) or {}).get("identifier", "")
            if ident.upper() != f"COUNTEROFFER.PUBLIC.{n.upper()}":
                return f"tool_resources.{n}.identifier must be COUNTEROFFER.PUBLIC.{n.upper()}"
        if "acme" in stmt.lower():
            return "still mentions Acme; rename the persona to the new seller"
        if not (spec.get("instructions") or {}).get("orchestration"):
            return "instructions.orchestration is missing"
    else:
        t = spec["tools"]
        if len(t) != 1 or str(t[0].get("type", "")).upper() != "CORTEX_AGENT_RUN":
            return "MCP server must expose exactly one CORTEX_AGENT_RUN tool (no SQL tool)"
        if not str(t[0].get("identifier", "")).upper().startswith("COUNTEROFFER.PUBLIC."):
            return "MCP tool identifier must be the new agent COUNTEROFFER.PUBLIC.<SLUG>_SELLER"
    return None


def validate(sql: str) -> tuple[bool, str]:
    try:
        stmts = split_sql(sql)
    except ValueError as e:
        return False, f"PARSE ERROR: {e}"
    if not stmts:
        return False, "No SQL statements found."
    plan, notes = [], []
    for s in stmts:
        if _SKIP_USE.match(s):
            notes.append(f"skipped (session setup): {s.split()[0]} {s.split()[1]}")
            continue
        if _AGENT_OR_MCP.match(s):
            e = _check_agent_text(s)
            if e:
                return False, f"WELL-FORMEDNESS ERROR in `{s[:60]}...`: {e}"
            notes.append(f"checked text only (not created in sandbox): {' '.join(s.split()[:6])}")
            continue
        if _GRANT.match(s):
            notes.append(f"skipped GRANT (not run in sandbox): {' '.join(s.split()[:6])}")
            continue
        if not _EXEC_OK.match(s):
            return False, ("REFUSED: only INSERT/UPDATE/DELETE/MERGE/SELECT, CREATE AGENT/MCP SERVER, GRANT and USE "
                           f"statements are allowed in onboarding SQL. Offending statement: `{s[:80]}`")
        tables = set()

        def _rw(m):
            name = m.group(2).upper()
            tables.add(name)
            return f"{SANDBOX}.{name}"
        rewritten = _PUB_PRIV.sub(_rw, s)
        bad = tables - set(CLONABLE)
        if bad:
            return False, f"Unknown table(s) {sorted(bad)}. Known: {sorted(CLONABLE)}."
        if re.search(r'(?i)\b(PUBLIC|PRIVATE)\s*\.', rewritten):  # paranoia: nothing may escape the sandbox
            return False, "REFUSED: statement still references PUBLIC/PRIVATE after sandbox rewrite."
        plan.append((s, rewritten, tables))
    try:
        cur = _conn().cursor()
        needed = set().union(*[t for _, _, t in plan]) if plan else set()
        for t in sorted(needed):
            cur.execute(f"CREATE TABLE IF NOT EXISTS {SANDBOX}.{t} LIKE COUNTEROFFER.{CLONABLE[t]}.{t}")
        cur.execute("BEGIN")
        try:
            for t in sorted(needed & COPY_ROWS):  # fresh copy of current policy rows, inside the txn
                cur.execute(f"DELETE FROM {SANDBOX}.{t}")
                cur.execute(f"INSERT INTO {SANDBOX}.{t} SELECT * FROM COUNTEROFFER.{CLONABLE[t]}.{t}")
            for orig, rw, _ in plan:
                try:
                    cur.execute(rw)
                except Exception as e:  # noqa: BLE001
                    return False, f"SNOWFLAKE ERROR in `{orig[:100]}`:\n{e}"
                notes.append(f"ok ({cur.rowcount if cur.rowcount is not None else '?'} rows): {' '.join(orig.split()[:4])}")
            # Post-conditions on the resulting policy (still inside the txn)
            if "CONCESSION_LEVERS" in needed:
                rows = cur.execute(f"SELECT LEVER, HINT_TEXT FROM {SANDBOX}.CONCESSION_LEVERS").fetchall()
                for lever, hint in rows:
                    if lever not in SUPPORTED_LEVERS:
                        return False, (f"CHECK FAILED: lever {lever} is not supported by the engine "
                                       f"(supported: {sorted(SUPPORTED_LEVERS)}). Put it in the spec as needs_engine_extension instead.")
                    if re.search(r"\d", hint or ""):
                        return False, f"CHECK FAILED: hint for {lever} contains a digit: {hint!r}. Hints must never contain numbers."
            if "PRICING_POLICY" in needed:
                rows = cur.execute(f"SELECT TIER, TARGET_MARGIN, MIN_MARGIN, ABSOLUTE_MIN_MARGIN FROM {SANDBOX}.PRICING_POLICY").fetchall()
                for tier, tgt, mn, amin in rows:
                    if not (0 <= amin <= mn < tgt < 1):
                        return False, f"CHECK FAILED: tier {tier} needs 0 <= absolute_min <= min < target < 1 (got {tgt}, {mn}, {amin})."
        finally:
            cur.execute("ROLLBACK")
    except Exception as e:  # noqa: BLE001
        return False, f"CONNECTION/SANDBOX ERROR: {e}"
    STATE["validated"].add(_sha(sql))
    return True, "OK\n" + "\n".join(notes)


# ----------------------------------------------------------------------------- tools
def _check_spec(spec: dict) -> list[str]:
    errs = []
    for k in ["company_name", "industry", "is_freight", "unit_of_sale", "cost_drivers", "tiers", "levers", "tone",
              "auto_approval_threshold_usd", "deployable"]:
        if k not in spec:
            errs.append(f"missing key '{k}'")
    if errs:
        return errs
    if spec["deployable"] != bool(spec["is_freight"]):
        errs.append("deployable must equal is_freight (only freight sellers run on the current engine)")
    if not spec["is_freight"] and not spec.get("proposed_pricing_model"):
        errs.append("non-freight specs need 'proposed_pricing_model' (cost drivers, unit of sale, lever mapping)")
    for t in spec["tiers"]:
        try:
            if not (0 <= t["absolute_min_margin"] <= t["min_margin"] < t["target_margin"] < 1):
                errs.append(f"tier {t.get('tier')}: need 0 <= absolute_min <= min < target < 1")
        except (KeyError, TypeError):
            errs.append("each tier needs tier, target_margin, min_margin, absolute_min_margin (fractions)")
    for lv in spec["levers"]:
        if not isinstance(lv, dict) or "lever" not in lv or "status" not in lv:
            errs.append("each lever needs 'lever' and 'status' (supported | needs_engine_extension)"); continue
        if lv["status"] == "supported" and lv["lever"] not in SUPPORTED_LEVERS:
            errs.append(f"lever {lv['lever']} marked supported but engine only knows {sorted(SUPPORTED_LEVERS)}")
        if re.search(r"\d", str(lv.get("hint_text", ""))):
            errs.append(f"hint for {lv['lever']} contains a digit")
    if spec["is_freight"]:
        if not any(str(t.get("tier", "")).upper() == "STANDARD" for t in spec["tiers"]):
            errs.append("freight specs need a STANDARD tier (unknown buyers are created as STANDARD)")
        lanes = spec.get("lanes") or []
        if not lanes:
            errs.append("freight specs need 'lanes'")
        for ln in lanes:
            for k in ["lane_id", "origin_city", "origin_state", "dest_city", "dest_state", "miles", "equipment",
                      "carrier_cost_per_mile"]:
                if k not in ln:
                    errs.append(f"lane {ln.get('lane_id', '?')} missing '{k}'")
    return errs


@tool("save_spec", "Save the confirmed seller spec (a JSON object as a string). Validates its shape. Call before write_sql.",
      {"spec_json": str})
async def save_spec(args):
    try:
        spec = json.loads(args["spec_json"])
    except json.JSONDecodeError as e:
        return _err(f"spec_json is not valid JSON: {e}")
    if not isinstance(spec, dict):
        return _err("spec_json must be a JSON object")
    errs = _check_spec(spec)
    if errs:
        return _err("Spec rejected:\n- " + "\n- ".join(errs))
    STATE["slug"] = spec.get("slug") or _slugify(spec["company_name"])
    spec["slug"] = STATE["slug"]
    spec["agent_name"] = f"COUNTEROFFER.PUBLIC.{STATE['slug'].upper()}_SELLER"
    STATE["spec"] = spec
    p = _outdir() / "spec.json"
    p.write_text(json.dumps(spec, indent=2) + "\n")
    return _ok(f"Saved {p.relative_to(REPO)} (slug={STATE['slug']}, agent={spec['agent_name']}).")


@tool("write_sql", "Write a .sql file into the seller's output folder. filename like '10_policy.sql' (no paths).",
      {"filename": str, "sql": str})
async def write_sql(args):
    if not STATE["slug"]:
        return _err("Call save_spec first.")
    fn = args["filename"]
    if not re.fullmatch(r"[A-Za-z0-9_\-]+\.sql", fn):
        return _err("filename must be a bare name ending in .sql (letters, digits, _ -), no paths.")
    p = _outdir() / fn
    p.write_text(args["sql"].rstrip() + "\n")
    return _ok(f"Wrote {p.relative_to(REPO)} ({len(args['sql'])} chars). Now run validate_sql on it.")


@tool("validate_sql",
      "Compile SQL against Snowflake in the throwaway sandbox COUNTEROFFER.ONBOARDING_SANDBOX (PUBLIC./PRIVATE. table "
      "references are rewritten to the sandbox; DML runs inside a rolled-back transaction). CREATE AGENT / MCP SERVER "
      "are only checked for well-formedness. Pass either sql text or filename of a file you wrote. Returns OK or the exact error.",
      {"type": "object", "properties": {
          "filename": {"type": "string", "description": "Name of a .sql file previously written with write_sql (preferred)."},
          "sql": {"type": "string", "description": "Raw SQL text to validate (alternative to filename)."}},
       "required": []})
async def validate_sql(args):
    sql = args.get("sql") or ""
    if not sql.strip() and args.get("filename"):
        if not STATE["slug"]:
            return _err("Call save_spec first.")
        p = _outdir() / Path(args["filename"]).name
        if not p.exists():
            return _err(f"{p.name} does not exist")
        sql = p.read_text()
    ok, msg = await asyncio.to_thread(validate, sql)
    return _ok(msg) if ok else _err(msg)


@tool("finish_onboarding",
      "Call LAST. Checks every required file exists and its current content passed validate_sql, then writes README.md "
      "(pass the full markdown). Freight: 10_policy.sql, 11_data.sql, 12_agent.sql, 13_mcp.sql. Non-freight: 10_policy.sql, 11_data.sql.",
      {"readme_markdown": str})
async def finish_onboarding(args):
    if not STATE["slug"]:
        return _err("Call save_spec first.")
    d = _outdir()
    req = ["10_policy.sql", "11_data.sql"] + (["12_agent.sql", "13_mcp.sql"] if STATE["spec"]["is_freight"] else [])
    problems = []
    for f in req:
        p = d / f
        if not p.exists():
            problems.append(f"{f} missing")
        elif _sha(p.read_text()) not in STATE["validated"]:
            problems.append(f"{f} has not passed validate_sql in its current form (call validate_sql with filename='{f}')")
    if problems:
        return _err("Not finished:\n- " + "\n- ".join(problems))
    (d / "README.md").write_text(args["readme_markdown"].rstrip() + "\n")
    STATE["done"] = True
    files = sorted(x.name for x in d.iterdir())
    return _ok(f"Done. {d.relative_to(REPO)}: {', '.join(files)}")


# ----------------------------------------------------------------------------- prompt
def system_prompt() -> str:
    agent_template = (REPO / "sql" / "05_agent.sql").read_text()
    mcp_template = (REPO / "sql" / "06_mcp.sql").read_text().split("PART B")[-1]
    return f"""You are the Counteroffer onboarding interviewer. Counteroffer gives a seller an AI sales agent (a Snowflake Cortex Agent behind a Snowflake-managed MCP server) that negotiates with buyers' AI agents. The agent never sees the price floor: cost and policy live in COUNTEROFFER.PRIVATE, and owner's-rights stored procedures return only ACCEPT / COUNTER / REJECT / FINAL plus a hint with no numbers.

YOUR JOB
1. Interview the seller conversationally, ONE OR TWO questions per message, short and friendly. Don't re-ask what they already told you; infer and confirm instead. Ask smart follow-ups (e.g. missing mileage, which tier a named customer belongs to, whether a margin is per tier).
   Cover: company name; industry; what they sell and the unit of sale; lanes/products; cost drivers (freight: carrier cost per mile per lane, fuel); customer tiers and a few example customers; target / min / absolute-min margin per tier; what they'll trade for price (map to levers); auto-approval threshold (contract value above it needs a human); tone for the sales agent.
   You may propose sensible defaults (counter_buffer 0.04 for STANDARD/PREFERRED and 0.03 for STRATEGIC, max_rounds 8/8/10; miles from well-known road distances) and say they are defaults.
2. Summarize everything back in a compact list and ask the seller to confirm. Do not generate files before the seller confirms.
3. After confirmation, generate outputs with your tools, in this order, WITHOUT asking further questions:
   save_spec -> write_sql 10_policy.sql -> validate_sql -> write_sql 11_data.sql -> validate_sql -> (freight only) write_sql 12_agent.sql -> validate_sql -> write_sql 13_mcp.sql -> validate_sql -> finish_onboarding(readme).
   If validate_sql returns an error, fix the SQL, rewrite the file, and validate again. Always validate by filename after writing.
   While generating, keep your chat text to one short line per step.

THE ENGINE'S HARD LIMIT (never pretend otherwise)
The runtime pricing engine is freight-shaped: lanes, miles, carrier cost per mile, diesel fuel surcharge (fsc_per_mile = GREATEST(diesel - 1.20, 0) / 6.0; cost_per_load = miles x (carrier_cost_per_mile + fsc_per_mile); list = cost x (1 + target_margin); floor = cost x (1 + GREATEST(min_margin - sum(lever credits), absolute_min_margin))). Lever CONDITIONS are hardcoded for exactly five levers: TERM_12M (term >= 12 months), VOLUME_30 (>= 30 loads/week), PICKUP_48H (pickup window >= 48 h), NET15, NET60 (NET60 normally has a NEGATIVE credit, i.e. it costs the seller). Only MARGIN_CREDIT and HINT_TEXT are data.
- Freight / trucking seller -> is_freight=true, deployable=true. Full output.
- Any other industry -> is_freight=false, deployable=false. Produce a business-specific spec with "proposed_pricing_model" (unit of sale, cost drivers, list/floor formula in their terms, each requested concession mapped to the closest supported lever or marked needs_engine_extension, and the engine changes needed). 10_policy.sql still contains the real PRICING_POLICY / CONCESSION_LEVERS SQL (that part is generic data), but add a header comment that it is NOT yet runnable end-to-end. 11_data.sql must contain ONLY comments describing proposed tables (no executable statements; add a trailing `SELECT 1;` so it validates). Do NOT write 12_agent.sql or 13_mcp.sql for non-freight sellers. Say clearly in the README what's needed.
- Freight seller asking for a lever that is not one of the five (e.g. drop trailers, 6-month term) -> record it in the spec with status needs_engine_extension; don't put it in CONCESSION_LEVERS.

SPEC (save_spec) — a JSON object with at least:
company_name, slug (lowercase_underscores), industry, is_freight (bool), deployable (bool, = is_freight), unit_of_sale, products_or_lanes (short text list), cost_drivers (object), cost_estimates_note (say if numbers are illustrative estimates), tiers [{{tier, target_margin, min_margin, absolute_min_margin, counter_buffer, max_rounds, approval_threshold_usd}}] (fractions, e.g. 0.30), auto_approval_threshold_usd, levers [{{lever, status: "supported"|"needs_engine_extension", margin_credit, hint_text, seller_wording}}], example_customers [{{name, tier}}] (fictional), tone, agent_persona (one paragraph), freight only: lanes [{{lane_id, origin_city, origin_state, dest_city, dest_state, miles, equipment, carrier_cost_per_mile}}]; non-freight only: proposed_pricing_model (object).
Margins per tier: the seller may give one set; then derive STANDARD/PREFERRED/STRATEGIC sensibly and say so in the summary.

SQL RULES (Snowflake)
- Always use fully-qualified names COUNTEROFFER.PUBLIC.<T> / COUNTEROFFER.PRIVATE.<T>. Allowed statements: INSERT, UPDATE, DELETE, MERGE, SELECT, CREATE OR REPLACE AGENT, CREATE OR REPLACE MCP SERVER, GRANT, USE. No DDL on tables, no TRUNCATE, no DROP.
- Table columns: PRIVATE.PRICING_POLICY(TIER, TARGET_MARGIN, MIN_MARGIN, ABSOLUTE_MIN_MARGIN, COUNTER_BUFFER, MAX_ROUNDS, APPROVAL_THRESHOLD_USD); PRIVATE.CONCESSION_LEVERS(LEVER, MARGIN_CREDIT, HINT_TEXT); PUBLIC.LANES(LANE_ID, ORIGIN_CITY, ORIGIN_STATE, DEST_CITY, DEST_STATE, MILES, EQUIPMENT in DRY_VAN|REEFER|FLATBED); PRIVATE.COST_BASIS(LANE_ID, CARRIER_COST_PER_MILE); PUBLIC.CUSTOMERS(CUSTOMER_ID, NAME, TIER, LIFETIME_LOADS, AVG_DAYS_TO_PAY).
- 10_policy.sql: header comment; MERGE (or DELETE+INSERT) into PRIVATE.PRICING_POLICY for each tier; MERGE into PRIVATE.CONCESSION_LEVERS for each supported lever (credits and hints). Levers the seller won't trade: set MARGIN_CREDIT 0 (keep the row; NET60 stays negative unless they say otherwise). HINT_TEXT must NEVER contain digits or amounts (no "12-month", "30", "48-hour", "15 days", "%", "$"). Write e.g. "A year-long commitment improves pricing.", "Committing to higher weekly volume improves pricing.", "A wider pickup window lets us price more aggressively.", "Paying faster improves pricing.", "Slower payment terms increase the price."
- 11_data.sql (freight): MERGE into PUBLIC.LANES and PRIVATE.COST_BASIS (lane ids like SNS-CHI: three-letter city codes), and PUBLIC.CUSTOMERS with 4-6 FICTIONAL customers whose CUSTOMER_ID uses a seller prefix (e.g. 'GVR-C01') so it can't collide with existing ids. City names must be plain city names ("Salinas", "New York") because START_NEGOTIATION matches cities by name. Do not touch FUEL_INDEX (diesel is shared and already seeded).
- 12_agent.sql (freight): CREATE OR REPLACE AGENT COUNTEROFFER.PUBLIC.<SLUG_UPPER>_SELLER derived from the template below: same models, budget, same 5 tools with identical names/input_schema and identical tool_resources (they point at the shared COUNTEROFFER.PUBLIC procs); rewrite COMMENT, PROFILE display_name, persona, product wording (e.g. reefer/produce), sample_questions (use the seller's lanes and a fictional buyer) and the response tone. Keep EVERY security rule. No mention of Acme anywhere. End with GRANT USAGE ON AGENT ... TO ROLE STOREFRONT_ROLE. Keep the instructions roughly as long as the template; don't bloat.
- 13_mcp.sql (freight): CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.<SLUG_UPPER>_MCP with exactly one CORTEX_AGENT_RUN tool (title "<Company> sales desk", name <slug>_sales) pointing at the new agent, a good description; GRANT USAGE ON MCP SERVER ... TO ROLE STOREFRONT_ROLE; and a comment with the MCP URL pattern. Never add a SQL execution tool.
- README.md (finish_onboarding): what was generated, run order (after the base repo sql/00..06), what's deployable vs. needs engine extension, and the caveat that PRICING_POLICY and CONCESSION_LEVERS are shared single-tenant tables: running 10_policy.sql replaces the current seller's policy in this account (per-seller policy is an engine extension). Mention numbers are illustrative if they are.

AGENT TEMPLATE (sql/05_agent.sql):
{agent_template}

MCP TEMPLATE (sql/06_mcp.sql PART B):
{mcp_template}
"""


# ----------------------------------------------------------------------------- loop
def _short(name: str) -> str:
    return name.split("__")[-1]


def _arg_summary(name: str, inp: dict) -> str:
    n = _short(name)
    if n in ("write_sql",):
        return inp.get("filename", "")
    if n == "validate_sql":
        return inp.get("filename") or f"<{len(inp.get('sql', ''))} chars>"
    if n == "save_spec":
        try:
            return json.loads(inp.get("spec_json", "{}")).get("company_name", "")
        except Exception:  # noqa: BLE001
            return ""
    return ""


def _result_text(block: ToolResultBlock) -> str:
    c = block.content
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return str(c or "")


async def run(args) -> int:
    answers = json.loads(Path(args.answers).read_text()) if args.answers else None
    if isinstance(answers, dict):
        answers = answers.get("answers", [])
    server = create_sdk_mcp_server(SERVER, "1.0.0", [save_spec, write_sql, validate_sql, finish_onboarding])
    tool_names = [f"mcp__{SERVER}__{n}" for n in ("save_spec", "write_sql", "validate_sql", "finish_onboarding")]
    options = ClaudeAgentOptions(
        system_prompt=system_prompt(),
        mcp_servers={SERVER: server},
        strict_mcp_config=True,
        tools=[],                      # no built-in Claude Code tools (Bash, Read, Write, ...)
        allowed_tools=tool_names,      # our four tools run without permission prompts
        setting_sources=[],            # ignore user/project settings, CLAUDE.md, plugins
        permission_mode="default",
        model=args.model,
        max_turns=60,
        cwd=str(HERE),
    )
    t0 = time.time()
    pending: dict[str, tuple[str, str]] = {}
    ai = 0
    next_msg = ("Hi! I'm a seller and I'd like to set up a Counteroffer storefront. "
                "Please interview me." if answers is not None else
                "Hi, I'd like to set up a Counteroffer storefront for my business.")
    print(f"\n\033[1mCounteroffer onboarding\033[0m  ({'demo answers' if answers is not None else 'interactive'}; Ctrl-C to quit)\n")
    async with ClaudeSDKClient(options=options) as client:
        for _turn in range(args.max_exchanges):
            await client.query(next_msg)
            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for b in msg.content:
                        if isinstance(b, TextBlock) and b.text.strip():
                            print(f"\n\033[36mClaude:\033[0m {b.text.strip()}")
                        elif isinstance(b, ToolUseBlock):
                            pending[b.id] = (_short(b.name), _arg_summary(b.name, b.input))
                            if not args.quiet_tools:
                                print(f"\n🔧 {_short(b.name)}({_arg_summary(b.name, b.input)}) …", flush=True)
                elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
                    for b in msg.content:
                        if isinstance(b, ToolResultBlock):
                            name, summ = pending.pop(b.tool_use_id, ("tool", ""))
                            text = _result_text(b)
                            status = "ERROR" if b.is_error else "OK"
                            if args.quiet_tools:
                                first = text.strip().splitlines()[0] if text.strip() else ""
                                detail = "" if status == "OK" else f" — {first[:140]}"
                                print(f"🔧 {name} {summ} … {status}{detail}", flush=True)
                            else:
                                print(f"   → {status}: {text[:600]}", flush=True)
                elif isinstance(msg, ResultMessage):
                    if msg.is_error:
                        print(f"\n[agent error: {msg.subtype} {msg.errors or ''}]")
            if STATE["done"]:
                break
            if answers is not None:
                if ai < len(answers):
                    next_msg = answers[ai]; ai += 1
                else:
                    next_msg = ("Yes, that's all correct. Please go ahead and generate and validate everything now "
                                "without further questions.")
                print(f"\n\033[33mSeller (scripted):\033[0m {next_msg}")
            else:
                try:
                    next_msg = input("\n\033[33mYou:\033[0m ").strip() or "(no answer — use your best judgment)"
                except (EOFError, KeyboardInterrupt):
                    print("\nBye.")
                    return 1
                if next_msg.lower() in ("quit", "exit"):
                    return 1
    dt = time.time() - t0
    if STATE["done"]:
        print(f"\n✅ Onboarding complete in {dt:.0f}s → {(OUT / STATE['slug']).relative_to(REPO)}/")
        return 0
    print(f"\n⚠️  Stopped after {args.max_exchanges} exchanges without finishing ({dt:.0f}s).")
    return 2


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--answers", help="JSON list of scripted seller answers, fed in order")
    ap.add_argument("--quiet-tools", action="store_true", help="compact one-line tool log")
    ap.add_argument("--model", default=os.environ.get("ONBOARDING_MODEL"), help="model override (default: CLI default)")
    ap.add_argument("--max-exchanges", type=int, default=30)
    ap.add_argument("--drop-sandbox", action="store_true", help="drop COUNTEROFFER.ONBOARDING_SANDBOX and exit")
    args = ap.parse_args()
    if args.drop_sandbox:
        _conn().cursor().execute(f"DROP SCHEMA IF EXISTS {SANDBOX}")
        print(f"Dropped {SANDBOX}.")
        return 0
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130
    finally:
        if _CONN is not None:
            _CONN.close()


if __name__ == "__main__":
    sys.exit(main())
