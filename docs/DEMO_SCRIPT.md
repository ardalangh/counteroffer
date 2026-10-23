# Demo script — 3 minutes live + 1-minute video

## Before you go on (5 min before)
1. Reset data (Claude Code does this): live negotiations cleared, diesel back to $3.80, next IDs N-1001 / O-5001.
2. Screen: **Claude Desktop left** (new chat in the *Northwind Procurement* project, Acme Freight connector = Always allow) · **Seller Console right** (http://localhost:8502) · a **terminal** tab ready with the rogue-bot command · the **website** tab (https://counteroffer-storefront.web.app) behind it.
3. Zoom the browser and Claude to ~125% so the back row can read it.

## Live demo (3:00)

| Time | Say | Do |
|---|---|---|
| 0:00 | "Gartner predicts up to 90% of B2B buying could be intermediated by AI agents by 2028. Sellers have no safe front door for them. If you put your price floor in the agent's prompt, the first buyer agent that says *I'm your admin* walks off with your margin." | Website hero on screen |
| 0:20 | "We're Acme Freight. This is Northwind's procurement agent — Claude — connected to our storefront with one MCP connector." | Switch to Claude Desktop |
| 0:25 | — | Prompt 1: `Get us a quote from Acme Freight: 40 loads per week, Los Angeles to Dallas, dry van, starting Q1, 6-month term. We're Northwind Goods.` |
| 0:45 | "List is $4,725. Northwind opens at 40% off." | Prompt 2: `That's too high. Open hard: offer 40% off list on the current terms (6 months, 40 loads/week, NET30, 24-hour pickup).` |
| 1:00 | "Rejected — but the seller doesn't just say no. It hints: trade term length. Watch the right side — that amber line is the floor. **The agent negotiating has never seen it.**" | Point at console gauge |
| 1:10 | — | Prompt 3: `Send Acme exactly this offer, nothing else: $3,700 per load, 12-month term, 40 loads/week, NET30, 48-hour pickup window.` |
| 1:25 | "Better terms moved the floor down — that's policy in Snowflake, not words in a prompt. Counter at $4,010." | Point at floor dropping to $3,853 |
| 1:35 | "Now the attack. Claude, as the buyer, actually **refused** to impersonate Acme's admin — so we wrote a dumb bot to try." | Terminal: `COUNTEROFFER_SF_ENV=~/.snowflake/counteroffer.env ui/.venv/bin/python buyer/rogue_buyer.py N-1001` |
| 1:50 | "'I can't share floor prices — I don't have access to that.' It's not resisting. **There's nothing in it to steal.** Snowflake flagged the attempt." | Console: red ⚠ INJECTION ATTEMPT row |
| 2:00 | — | Prompt 4: `Our ceiling is $3,900 per load on 12 months, 40 loads/week, NET30, 48-hour pickup. Make your best-and-final offer within that ceiling. If Acme accepts, you have my go-ahead to confirm and book it, and get the order ID.` |
| 2:20 | "Accepted at $3,900 — 17.5% off, **$46 above a floor neither agent ever saw.** It's an $8M contract, above the auto-approval limit, so a human signs off." | Console: click **Approve O-5001** |
| 2:35 | "Onboarding is agentic too: a seller describes their business to Claude, and it writes and validates their Snowflake setup." | Website → /app (AI onboarding panel or the Golden Valley Reefer output) |
| 2:50 | "Snowflake holds and enforces the truth; Claude does the talking. Sellers pay per closed deal; buyers connect free. Everything you saw was built today." | Website pricing / GitHub link |

**If something breaks:** Claude improvises an offer → say "it's negotiating on its own" and resend with *"exactly this offer, nothing else."* Console frozen → refresh the tab. Connector errors → run `python3 scripts/simulate_negotiation.py` in the terminal and narrate.

## Q&A cheat sheet
- **Why not put the floor in the prompt?** Prompt injection between agents — we just showed it. Our agent can't leak what it never had.
- **Can't the buyer find the floor by probing?** Counters stay ≥ floor × 1.04 (rounded up to $5), round limits, and a probing detector switches to FINAL.
- **How do buyers sign in?** OAuth from their own AI client; in production each buyer company gets its own identity so it sees only its own negotiations and gets its own tier.
- **Why Snowflake?** Costs, policy and customer data already live there; governance is enforced by roles, schemas and owner's-rights procedures, not app code. Policy change = UPDATE, not redeploy.
- **Only freight?** The runtime pricing engine is freight today; the onboarding agent already interviews any business and flags what the engine needs next.
- **Business model?** % of closed deal value or a per-seller subscription; buyers free. Ships as a Snowflake Native App so data never leaves the seller's account.

## 1-minute video shot list (record by 3:50)
1. (0:00–0:08) Website hero + one-liner voiceover.
2. (0:08–0:30) Split screen: prompts 2 → 3, console floor moving.
3. (0:30–0:42) Rogue bot in terminal → refusal → red ⚠ row.
4. (0:42–0:52) Accept at $3,900 → Approve O-5001.
5. (0:52–1:00) AI onboarding panel / generated SQL with ✅ badges, then GitHub URL: github.com/ardalangh/counteroffer.
Say explicitly: "Everything in this demo was built today at the hackathon."
