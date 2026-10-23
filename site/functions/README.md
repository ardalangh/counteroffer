# `onboard_chat` — AI onboarding Cloud Function

Python 2nd-gen HTTPS **callable** used by the "Onboard with AI" panel on `/app`. Claude runs
through **Snowflake Cortex** (`SNOWFLAKE.CORTEX.COMPLETE`, model `claude-sonnet-5`, automatic
fallback to `claude-sonnet-4-5`). It is the web port of `onboarding/agent.py`.

Flow per call: the client sends `{messages: [{role, content}, ...]}` (≤ 40 messages, ≤ 4,000 chars
each). Claude interviews the seller one or two questions at a time. Once the seller confirms the
summary, Claude replies with only `{"done": true, "spec": {...}}`. The function then checks the
spec, writes each SQL file with a separate Cortex call (in parallel), runs `validate_sql` on every
file, and sends errors back to Claude for up to 2 self-repairs per file. It returns
`{reply, done, spec, files, validation: {file: "OK" | error}, repairs}`. Freight sellers get
`10_policy / 11_data / 12_agent / 13_mcp`. Other industries get `10_policy / 11_data` plus a spec
with `deployable: false`.

Files: `main.py` (callable, auth, rate limit), `core.py` (prompts, Cortex, `validate_sql` port —
no Firebase imports, so it can be unit-tested locally), `templates/` (copies of `sql/05_agent.sql`
and `sql/06_mcp.sql` PART B. Re-copy them if those files change).

## Deploy (needs the Blaze plan)

```bash
cd site
firebase functions:secrets:set SF_ACCOUNT     # e.g. ORGNAME-ACCOUNTNAME
firebase functions:secrets:set SF_USER
firebase functions:secrets:set SF_PASSWORD
# The Python deploy needs a local venv in functions/ (it is git-ignored and not uploaded):
python3.11 -m venv functions/venv && functions/venv/bin/pip install -r functions/requirements.txt
firebase deploy --only functions,hosting
```

The function runs in `us-central1` with a 540 s timeout, 1 GiB memory and at most 5 instances. The
Snowflake user needs role `BROKER_ADMIN` (warehouse `COUNTEROFFER_WH`) and access to Cortex Claude
models (`CORTEX_ENABLED_CROSS_REGION` if your region needs it). Until it's deployed, the panel shows
"AI onboarding isn't deployed yet — use the steps below."

Local test without deploying: `functions/venv/bin/python` → `import core;
conn = core.connect(acct, user, pw); core.handle_turn(conn, [{"role": "user", "content": "..."}])`.
Drop the sandbox afterwards with `DROP SCHEMA IF EXISTS COUNTEROFFER.ONBOARDING_SANDBOX`.

## Security notes
- **Auth required.** Calls without Firebase Auth are rejected (`unauthenticated`).
- **Rate limit.** Each user gets 40 calls per rolling hour. The counter lives in
  `onboard_ratelimit/{uid}`, which the Firestore rules deny to clients (default deny), so users can't
  reset it. Input size is capped at 40 messages × 4,000 chars.
- **Sandbox only.** Generated SQL never runs against `COUNTEROFFER.PUBLIC` or `COUNTEROFFER.PRIVATE`:
  - Every `PUBLIC.`/`PRIVATE.` table reference is rewritten to `COUNTEROFFER.ONBOARDING_SANDBOX`, which is cloned with `LIKE`.
  - Any other 3-part name is refused.
  - Only INSERT/UPDATE/DELETE/MERGE/SELECT execute, and they run inside `BEGIN … ROLLBACK`.
  - DDL, CALL, `SYSTEM$`, CORTEX, `EXECUTE IMMEDIATE`, `IDENTIFIER()` and `TABLE()` are refused.
  - USE and GRANT are skipped.
  - `CREATE AGENT` / `CREATE MCP SERVER` are **only text-checked** (YAML, the 5 tools, the identifiers, no Acme, a single `CORTEX_AGENT_RUN` tool) and never created.
- **Secrets.** Snowflake credentials are Firebase secrets (`SecretParam`). They are never logged or
  returned. Clients see only friendly error messages. Stack traces go to Cloud Logging only, and
  Snowflake error text has URLs stripped.
- **No deploy from the web.** The generated SQL is returned for the seller to review and run themselves.
- **Rendering.** The panel renders all model and user text with `textContent`, never `innerHTML`.
- **Known limitation.** The sandbox tables are shared by all users. Validations from two users at the
  same time are serialized by Snowflake locks, and everything is rolled back either way.
