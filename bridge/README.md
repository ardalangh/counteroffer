# Counteroffer bridge — Snowflake ⇄ the web console

The seller console at **`/console`** on the Counteroffer site is a static page. This bridge is what
puts real data behind it: it runs next to your Snowflake account, publishes the ledger as it changes,
and executes the approvals you click.

```
PUBLIC.NEGOTIATIONS ─┐                                    ┌─▶ /console  (live trace, gauge, alerts)
NEGOTIATION_LEDGER ──┼─▶ bridge ─▶ Firestore              │
PUBLIC.ORDERS ───────┤            workspaces/<your uid>/ ─┤
FUEL_INDEX ──────────┘                                    │
                                                          ▼
PUBLIC.APPROVE_ORDER ◀── bridge ◀── workspaces/<uid>/commands  (Approve / Reject clicks)
```

Without the bridge, `/console` still opens — on a synthetic run, clearly labelled **Demo data** — so you
can see the monitor before wiring anything up.

## The floor does not leave Snowflake

List rates, buyer offers and the agent's counters are already public in `NEGOTIATION_LEDGER`, so the
bridge publishes them as-is. Your **cost basis and price floor are not published**. What goes up instead
is `above_floor_pct`: how far the current offer sits above (or below) the floor for the terms on the
table. The console draws its gauge from that and says so in as many words.

`--include-floor` publishes the floor, the no-lever floor and the cost per load to your own private
workspace. Only you can read it (see the rules below), but it is still one more place the number lives
— the default is off for a reason.

## Setup

1. **A Counteroffer login.** The bridge signs in as you, with the email and password you use at
   `/login`. That is deliberate: `site/firestore.rules` lets a workspace be read and written only by
   its owner, so your own login is the whole access control story. No service-account key to mint,
   store or leak.

2. **Snowflake credentials**, as a `KEY=VALUE` file kept outside the repo — the same one the Streamlit
   console uses:

   ```
   SF_ACCOUNT=ORGNAME-ACCOUNTNAME
   SF_USER=your_user
   SF_PASSWORD=your_password
   ```

   `SF_ROLE` (default `BROKER_ADMIN`) and `SF_WAREHOUSE` (default `COUNTEROFFER_WH`) are optional.
   The role needs `SELECT` on the `PUBLIC` tables and `USAGE` on `PUBLIC.APPROVE_ORDER`; reading
   `PRIVATE.LIVE_FLOOR_V` is what produces `above_floor_pct`, and the bridge keeps working without it
   (it says so and publishes the public fields only).

3. **Install and run.**

   ```bash
   python3 -m venv bridge/.venv && bridge/.venv/bin/pip install -r bridge/requirements.txt

   COUNTEROFFER_SF_ENV=~/.snowflake/counteroffer.env \
   CO_FB_EMAIL=you@example.com CO_FB_PASSWORD='…' \
       bridge/.venv/bin/python bridge/counteroffer_bridge.py --watch
   ```

   Then open `/console`. The chip at the top flips from **Demo data** to **Live**.

   Keeping the password out of your shell history: put `CO_FB_EMAIL` and `CO_FB_PASSWORD` in the same
   `KEY=VALUE` file as the Snowflake settings. Environment variables override the file.

## Flags

| Flag | What it does |
|---|---|
| `--watch` | Keep syncing. The default. |
| `--once` | One pass, then exit — good for a cron job or a smoke test. |
| `--interval N` | Seconds between polls (default 3). |
| `--include-floor` | Also publish floor and cost figures. Off by default. |
| `--backfill N` | Events published on the first pass (default 300). Later passes send only new ones. |
| `--dry-run` | Read Snowflake, publish nothing, print what would go up. |
| `--reset` | Delete everything the bridge has published, then exit. The console falls back to demo data. |

## What lands in Firestore

Everything under `workspaces/<your uid>/`:

| Path | Contents |
|---|---|
| `negotiations/<N-id>` | One doc per negotiation: customer, tier, lane, status, rounds, list rate, last offer and the agent's answer, plus `above_floor_pct` (or the floor itself with `--include-floor`). |
| `events/<event_id>` | `NEGOTIATION_LEDGER` rows, verbatim, including buyer messages and `INJECTION_SUSPECTED` / `PROBING_SUSPECTED` flags. |
| `orders/<O-id>` | Orders with status, contract value and who decided. |
| `commands/<auto-id>` | Written by the console when you click Approve or Reject; the bridge sets `status` to `RUNNING`, then `DONE` or `ERROR` with the procedure's reply. |
| `meta/bridge` | Heartbeat: last sync, diesel index, account, whether the floor is being published. The console marks the bridge stalled after 90 seconds of silence. |

Buyer messages are attacker-controlled text. They travel as data the whole way — bind parameters into
Snowflake, string fields out of it, and `textContent` in the browser. The console never renders them
as markup.

## Operational notes

- **A sync is all-or-nothing.** The watermark only advances after the write commits, so a dropped
  connection replays that pass instead of losing those rows.
- **Idempotent.** Documents are keyed by `EVENT_ID` / `ORDER_ID` / `NEGOTIATION_ID`, so re-running or
  restarting never duplicates anything. Unchanged negotiations and orders are not rewritten.
- **One-way for history.** The bridge only ever reads the ledger. The sole thing it writes back to
  Snowflake is `APPROVE_ORDER`, from a command you created by clicking.
- **Where it can run.** Anywhere with network access to Snowflake and Google APIs — a laptop for a
  demo, a small VM or a container for real use. It keeps no local state, so restarting is free.
