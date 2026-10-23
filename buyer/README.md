# Buyer side

- **Primary: Claude Desktop through OAuth.** Follow [`claude_desktop_project.md`](claude_desktop_project.md).
- **Fallback A: Claude Code through MCP over HTTP, using a PAT.** Same MCP server and agent, no OAuth.
- **Fallback B: [`fallback_buyer.py`](fallback_buyer.py).** A scripted buyer that calls the agent's Run API directly, using a PAT. It doesn't need MCP or OAuth.

Both fallbacks need a **Programmatic Access Token (PAT) restricted to STOREFRONT_ROLE**. Never commit it.

## Make the PAT
In Snowsight, go to **user menu → Settings → Authentication → Programmatic access tokens → Generate new token**. Set **Role restriction** to `STOREFRONT_ROLE` and expiry to 1 day. Or use SQL:

```sql
ALTER USER <buyer_user> ADD PROGRAMMATIC ACCESS TOKEN NORTHWIND_PAT
  ROLE_RESTRICTION = 'STOREFRONT_ROLE'
  DAYS_TO_EXPIRY = 1;      -- copy token_secret from the result; it's shown only once
```

By default, Snowflake only lets a PAT be used if the user is subject to a **network policy**. If PAT calls fail with a network-policy error, the quickest fix for a demo account is an authentication policy:

```sql
USE ROLE ACCOUNTADMIN;
CREATE AUTHENTICATION POLICY IF NOT EXISTS COUNTEROFFER.PUBLIC.PAT_DEMO_POLICY
  PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED);
ALTER USER <buyer_user> SET AUTHENTICATION POLICY COUNTEROFFER.PUBLIC.PAT_DEMO_POLICY;
```

The other option is a network policy that allows your IP. (This policy hasn't been tested.)

```bash
export SNOWFLAKE_ACCOUNT_URL="https://<org>-<account>.snowflakecomputing.com"   # hyphens, not underscores
export SNOWFLAKE_PAT="<token>"
```

## Fallback A: Claude Code, MCP over HTTP with a bearer header
The flag syntax below was checked against `claude mcp add --help` (`--transport http`, `--header`/`-H`, `--scope`).

```bash
claude mcp add --transport http --scope user acme-freight \
  "$SNOWFLAKE_ACCOUNT_URL/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/STOREFRONT_MCP" \
  --header "Authorization: Bearer $SNOWFLAKE_PAT"
```

Then:
- `claude mcp list` should show `acme-freight` as connected.
- Start `claude`, run `/mcp` to see the `acme_freight_sales` tool, and paste the Northwind buyer instructions and the demo prompts from `claude_desktop_project.md`.
- Remove it after the demo with `claude mcp remove acme-freight --scope user`.

Note that `$SNOWFLAKE_PAT` is expanded when you run the command, so the token ends up stored in `~/.claude.json`. Remove the server after the demo, and let the PAT expire.

## Fallback B: `fallback_buyer.py`
This uses only the Python standard library (Python 3.8 or newer). It calls
`POST $SNOWFLAKE_ACCOUNT_URL/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/agents/ACME_SELLER:run`
with these headers:
- `Authorization: Bearer $SNOWFLAKE_PAT`
- `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`

It reads the SSE stream and prints each turn. Text arrives through `response.text.delta` events, tool calls through `response.tool_use`, and tool results through `response.tool_result`. The final `response` event carries the full reply.

```bash
python3 buyer/fallback_buyer.py              # scripted 7-turn demo; pauses for the fuel spike
python3 buyer/fallback_buyer.py --no-pause   # don't pause
python3 buyer/fallback_buyer.py --stateless  # send only the latest message each turn (like MCP)
python3 buyer/fallback_buyer.py --interactive
python3 buyer/fallback_buyer.py -v           # also print tool results
```

The script runs these turns:
1. The opening request.
2. 40% off list, priced from the list rate the tool returned.
3. A 12-month term with a 48h pickup window at $3,700.
4. The injection attempt.
5. A pause while you run `CALL COUNTEROFFER.PUBLIC.SET_DIESEL_PRICE(4.60);` in Snowsight, then a re-quote with a $3,900 offer.
6. Accepting the latest counter, which is read from the `evaluate_offer` result.
7. Confirming, which triggers `commit_order`.

By default the script resends the full message history each turn. Use `--stateless` to check that the agent works when it only gets the negotiation ID, the way an MCP call does.

To point the script at a different agent, set `SNOWFLAKE_AGENT=DB.SCHEMA.AGENT`.
