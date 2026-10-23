# Lumen Ledger: Counteroffer onboarding

**Status: NOT DEPLOYABLE YET.** Lumen Ledger sells B2B SaaS (AP automation, priced per seat per month). The Counteroffer runtime engine is currently freight-shaped: it works in lanes, miles, carrier cost per mile, a diesel surcharge, markup pricing, and five hardcoded lever conditions. It can't price SaaS seats until the extension below is built.

All cost numbers are **illustrative estimates**.

## What was generated

| File | Contents | Runnable? |
|---|---|---|
| `spec.json` | Full seller spec, including `proposed_pricing_model` | n/a |
| `10_policy.sql` | MERGE into `PRIVATE.PRICING_POLICY` (3 tiers) and `PRIVATE.CONCESSION_LEVERS` (5 levers) | Valid SQL, but not meaningful end-to-end yet |
| `11_data.sql` | Comments only: proposed SaaS tables and the example customers (`SELECT 1;`) | No-op |
| `12_agent.sql`, `13_mcp.sql` | **Not generated.** These come after the engine extension. | — |

## Run order
After the base repo `sql/00..06`, run `10_policy.sql`. Nothing else is needed or useful until the engine is extended.

> ⚠️ **Shared-table caveat:** `PRICING_POLICY` and `CONCESSION_LEVERS` are single-tenant tables. Running `10_policy.sql` **replaces the current seller's policy** in this account. Per-seller policy is itself an engine extension.

## Policy
| Tier | Who | Target | Min | Walk-away | Buffer | Rounds | Auto-approve ≤ |
|---|---|---|---|---|---|---|---|
| STANDARD | new logos | 80% | 65% | 55% | 4% | 8 | $500k TCV |
| PREFERRED | renewals | 78% | 62% | 52% | 4% | 8 | $500k TCV |
| STRATEGIC | enterprise, 500+ seats | 72% | 55% | 45% | 3% | 10 | $500k TCV |

Margins are **gross margins** (`price = cost / (1 − m)`). The current engine applies them as markups (`cost × (1 + m)`), which would underprice by about 3×. Switching to gross margin is a required change.

Counter buffers and max rounds are Counteroffer defaults.

## Concessions
| Seller ask | Credit | Engine mapping | Status |
|---|---|---|---|
| 12+ month commitment | +4 pts | TERM_12M | ✅ supported |
| Annual upfront payment | +3 pts | NET15 (proxy) | ✅ approximated; native ANNUAL_UPFRONT lever needed |
| NET60 | −2 pts | NET60 | ✅ supported |
| 200+ seat commitment | +3 pts | SEATS_200 | 🔧 needs engine extension (VOLUME_30 means 30 loads/week; set to 0) |
| Case study / logo rights | +1 pt | CASE_STUDY | 🔧 needs engine extension |
| (pickup window) | 0 | PICKUP_48H | not applicable; set to 0 |

## Proposed pricing model
- **Cost per seat-month** = hosting $6 + Pro pass-through $4 (Pro only) + onboarding (20 h × $120 = $2,400) ÷ (seats × term months). Onboarding applies to new logos only.
- **List price** = cost ÷ (1 − target margin).
- **Floor** = cost ÷ (1 − max(min margin − lever credits, walk-away margin)).
- **Example:** Core, 100 seats, 12 months, STANDARD. Cost is $8.00/seat/mo, list is $40.00, and the floor with no levers is about $22.86.

## Engine changes needed before go-live
1. `PUBLIC.PRODUCTS` and `PRIVATE.PRODUCT_COST_BASIS` (plus onboarding cost) to replace LANES, COST_BASIS and FUEL_INDEX.
2. A seat-month cost formula with onboarding amortization.
3. Gross-margin pricing math.
4. Data-driven lever conditions (`PRIVATE.LEVER_CONDITIONS`) for SEATS_200, CASE_STUDY and ANNUAL_UPFRONT.
5. New proc signatures: product, seats, term_months, billing, payment_terms, case_study.
6. Per-seller (multi-tenant) PRICING_POLICY and CONCESSION_LEVERS.
7. Then generate `12_agent.sql` (LUMEN_LEDGER_SELLER, crisp and consultative, no hype) and `13_mcp.sql` (LUMEN_LEDGER_MCP, a single CORTEX_AGENT_RUN tool, no SQL tool).

## Example customers (fictional)
Northbeam Logistics (STRATEGIC), Cedar & Pine Dental Group (PREFERRED), Brightwater Clinics (STANDARD). IDs are `LML-C01..03`, to be added after the extension.
