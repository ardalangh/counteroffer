# Golden Valley Reefer — Counteroffer storefront

Golden Valley Reefer is a refrigerated truckload carrier in California's Central Valley. It hauls fresh produce from Salinas and Fresno to distribution centers in Chicago, Atlanta, Dallas and New York. The unit of sale is one full reefer truckload, priced per load.

**Status: deployable.** This is a freight seller, so it runs on the existing pricing engine.

## Generated files
| File | What it does |
|---|---|
| `spec.json` | Confirmed seller spec (lanes, tiers, levers, customers, tone) |
| `10_policy.sql` | MERGE into `PRIVATE.PRICING_POLICY` for 3 tiers and into `PRIVATE.CONCESSION_LEVERS` for 5 levers |
| `11_data.sql` | MERGE into `PUBLIC.LANES` (8 reefer lanes), `PRIVATE.COST_BASIS` and `PUBLIC.CUSTOMERS` (5 fictional customers, `GVR-C01..C05`) |
| `12_agent.sql` | `CREATE OR REPLACE AGENT COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_SELLER`, with the 5 standard tools pointing at the shared procs, plus a grant to `STOREFRONT_ROLE` |
| `13_mcp.sql` | `CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_MCP`, with one `CORTEX_AGENT_RUN` tool (`golden_valley_reefer_sales`), no SQL tool, plus a grant |

## Run order
1. Run the base repo `sql/00` through `sql/06` first (schemas, tables, fuel index, procs, base agent/MCP).
2. `10_policy.sql`
3. `11_data.sql`
4. `12_agent.sql`. If `claude-sonnet-5` is rejected, use `claude-sonnet-4-5`. If the YAML errors, create the agent in the Snowsight UI and run only the GRANT.
5. `13_mcp.sql`

MCP URL: `https://<org>-<account>.snowflakecomputing.com/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/GOLDEN_VALLEY_REEFER_MCP`

## Pricing setup
| Tier | Target | Min | Abs. min | Counter buffer* | Max rounds* | Approval threshold |
|---|---|---|---|---|---|---|
| STANDARD | 32% | 14% | 7% | 0.04 | 8 | $3,000,000 |
| PREFERRED | 30% | 12% | 6% | 0.04 | 8 | $3,000,000 |
| STRATEGIC | 26% | 9% | 5% | 0.03 | 10 | $3,000,000 |

\*Defaults accepted by the seller. Contracts above $3M total value go to PENDING_APPROVAL, and a person signs off.

Levers (margin credit):
- TERM_12M: +4 pts
- VOLUME_30: +3 pts
- PICKUP_48H: +2 pts
- NET15: +1 pt
- NET60: −2 pts, so it costs the buyer

Fuel uses the shared diesel surcharge (`FUEL_INDEX` is not modified).

Lanes (miles / carrier $ per mile before fuel):
- SNS-CHI 2130 / 2.50
- SNS-ATL 2450 / 2.40
- SNS-DAL 1640 / 2.70
- SNS-NYC 2950 / 2.30
- FRE-CHI 2000 / 2.45
- FRE-ATL 2300 / 2.35
- FRE-DAL 1480 / 2.65
- FRE-NYC 2800 / 2.25

**Illustrative numbers:** carrier cost per mile figures are the seller's rough estimates, not audited. Mileages are approximate road distances. Customers are fictional.

## Needs engine extension
- **Drop trailers at the farm:** the seller wants it, but the engine can't price it. It's recorded in the spec as `needs_engine_extension` and not added to `CONCESSION_LEVERS`. Supporting it needs a new offer term and a condition in `EVALUATE_OFFER`. Until then, the agent tells buyers it can't price drop trailers today.

## Important caveat: shared single-tenant tables
`PRIVATE.PRICING_POLICY` and `PRIVATE.CONCESSION_LEVERS` are keyed only by tier and lever, not by seller. **Running `10_policy.sql` replaces the current seller's policy in this account**, and that includes any other seller's agent. Per-seller policy (adding a seller key and threading it through the procs) is an engine extension. Lanes, cost basis and customers use unique IDs (`SNS-`/`FRE-`, `GVR-`), so they sit alongside existing data. Note that `START_NEGOTIATION` matches lanes by city name, so lanes that overlap with another seller's could be ambiguous.

## Security
- The agent never sees cost, margins or floors.
- The pricing procedures return only ACCEPT / COUNTER / REJECT / FINAL and hints with no numbers.
- Every buyer message is logged and screened for prompt injection.
- The MCP server exposes only the agent.
