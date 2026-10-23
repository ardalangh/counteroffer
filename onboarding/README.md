# Counteroffer onboarding: an agentic interviewer

**Onboarding is itself agentic.** A seller doesn't fill in a 40-field form or hand-write SQL. Claude interviews them like a good solutions engineer: a couple of questions at a time, with follow-ups and sensible defaults it labels as defaults. It reads the summary back for sign-off. Then it writes the policy, lanes, cost basis, sales-agent persona and MCP server. It also **compiles every file against real Snowflake** in a throwaway sandbox and fixes its own errors before it hands over. Ten minutes of conversation produces a storefront that buyers' AI agents can negotiate with, and the price floor never leaves the PRIVATE schema.

Built with the Claude Agent SDK (Python). The agent can only use four in-process tools: `save_spec`, `write_sql`, `validate_sql` and `finish_onboarding`. It has no Bash or file tools.

## Run

```bash
# one-time setup (already done if onboarding/.venv exists)
python3 -m venv onboarding/.venv
onboarding/.venv/bin/pip install claude-agent-sdk snowflake-connector-python pyyaml

# interactive: you are the seller
onboarding/.venv/bin/python onboarding/agent.py

# demo mode: scripted seller answers (Golden Valley Reefer, a fictional produce reefer carrier)
onboarding/.venv/bin/python onboarding/agent.py --answers onboarding/demo_answers.json --quiet-tools

# non-freight example (a fictional B2B SaaS company): produces a "needs engine extension" spec
onboarding/.venv/bin/python onboarding/agent.py --answers onboarding/demo_answers_saas.json --quiet-tools

# clean up the validation sandbox schema
onboarding/.venv/bin/python onboarding/agent.py --drop-sandbox
```

- **Auth:** Claude uses your local Claude Code login (the `claude` CLI). Snowflake reads a `KEY=VALUE` file (`SF_ACCOUNT`, `SF_USER`, `SF_PASSWORD`) from `$COUNTEROFFER_SF_ENV`, default `~/.snowflake/counteroffer.env`. Credentials are never printed.
- **Flags:**
  - `--answers FILE` feeds the next scripted answer each time Claude asks something. Claude still writes its own questions. After the script runs out, the seller "confirms".
  - `--quiet-tools` prints one line per tool call, e.g. `🔧 validate_sql 10_policy.sql … OK`.
  - `--model` overrides the model.
- **Timing:** a demo-mode run takes about 2–3 minutes. Freight took 176 s; SaaS took 125 s.

## What it produces: `onboarding/out/<slug>/`

| File | Freight seller | Any other industry |
|---|---|---|
| `spec.json` | Full spec: tiers, levers, lanes, costs, persona | Business-specific spec plus `proposed_pricing_model`. `deployable: false` |
| `10_policy.sql` | MERGE into `PRIVATE.PRICING_POLICY` and `PRIVATE.CONCESSION_LEVERS` (credits + number-free hints) | Same SQL, headed **NOT YET RUNNABLE END-TO-END** |
| `11_data.sql` | MERGE into `PUBLIC.LANES`, `PRIVATE.COST_BASIS`, and `PUBLIC.CUSTOMERS` (fictional customers, prefixed ids) | Proposed tables as **comments only** |
| `12_agent.sql` | `CREATE OR REPLACE AGENT COUNTEROFFER.PUBLIC.<SLUG>_SELLER`, derived from `sql/05_agent.sql`, with the same 5 tools, all security rules kept, and a GRANT to STOREFRONT_ROLE | not generated |
| `13_mcp.sql` | MCP server `<SLUG>_MCP` with one `CORTEX_AGENT_RUN` tool pointing at the new agent | not generated |
| `README.md` | What was generated, run order, caveats | What engine extension is needed |

Run order for a freight seller: run the base repo `sql/00..06` first, then `10 → 11 → 12 → 13`.

## How `validate_sql` works (and why it's safe)
- It connects as `BROKER_ADMIN` on `COUNTEROFFER_WH` with `USE SECONDARY ROLES NONE`, then creates `COUNTEROFFER.ONBOARDING_SANDBOX` if it's missing.
- It rewrites every `COUNTEROFFER.PUBLIC.` / `COUNTEROFFER.PRIVATE.` (or bare `PUBLIC.` / `PRIVATE.`) table reference to the sandbox. It refuses any statement that would still reach PUBLIC or PRIVATE afterwards.
- It clones only the tables the SQL touches (`CREATE TABLE IF NOT EXISTS … LIKE …`). It also copies in the current policy rows, so UPDATE/MERGE row counts mean something.
- It runs the DML inside `BEGIN … ROLLBACK`. Only INSERT, UPDATE, DELETE, MERGE and SELECT execute. USE and GRANT statements are skipped. Any other DDL is refused.
- It then checks invariants on the result:
  - every lever is one of the five the engine supports;
  - **no hint contains a digit**;
  - `0 ≤ absolute_min ≤ min < target < 1`.
- `CREATE AGENT` / `CREATE MCP SERVER` are **never created in the sandbox**. Their YAML is parsed and checked instead:
  - the agent has exactly the 5 tools, pointing at `COUNTEROFFER.PUBLIC.<PROC>`, with no leftover "Acme";
  - the MCP server has exactly one `CORTEX_AGENT_RUN` tool and no SQL tool.
- Errors go back to Claude verbatim, and Claude fixes them and retries. `finish_onboarding` refuses to complete until every required file has passed `validate_sql` **in its current form** (checked by content hash).

## The freight-vs-other-industry boundary (deliberately honest)
The runtime pricing engine in `sql/04_procs.sql` is freight-shaped: lanes, miles, carrier cost per mile, diesel surcharge, and `cost × (1 + margin)` markup. The **conditions** for the five levers are hardcoded in the procs: `TERM_12M` ≥ 12 months, `VOLUME_30` ≥ 30 loads/week, `PICKUP_48H` ≥ 48 h, `NET15`, `NET60`. Only each lever's credit and hint text are data.
- **Freight / trucking:** the output is fully deployable. Concessions outside the five, such as drop trailers, are recorded in the spec as `needs_engine_extension` and kept out of the lever table.
- **Everything else:** you get a spec, the policy SQL and a proposed pricing model, which covers:
  - unit of sale and cost drivers;
  - each lever mapped to the closest supported one or flagged;
  - the engine changes needed.

  These are clearly labeled not yet runnable. (In the SaaS test, Claude also noticed that the engine reads "margin" as markup, while SaaS teams usually mean gross margin.)
- **Single-tenant caveat:** `PRICING_POLICY` and `CONCESSION_LEVERS` are shared tables. Running a seller's `10_policy.sql` replaces the current policy in that account. Per-seller policy is an engine extension.

Golden Valley Reefer, Lumen Ledger and every customer name are fictional. Costs and mileages are illustrative estimates.
