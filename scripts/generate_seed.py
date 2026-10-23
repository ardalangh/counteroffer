#!/usr/bin/env python3
"""Generate sql/02_seed.sql for Counteroffer.

Deterministic (fixed random seed), stdlib only. Run from anywhere:
    python3 scripts/generate_seed.py
Writes ../sql/02_seed.sql relative to this script.

Pricing formulas mirror docs/CONTRACT.md exactly. Historical accepted rates are
checked against the floor at the HIGHEST diesel price in the seeded fuel series
(3.80, the current price), so they are >= the floor under any seeded diesel.
"""
import math
import os
import random

random.seed(20261023)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sql", "02_seed.sql")

# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------
# (lane_id, origin_city, origin_state, dest_city, dest_state, miles, equipment, cost_per_mile)
LANES = [
    ("LAX-DAL", "Los Angeles", "CA", "Dallas",   "TX", 1435, "DRY_VAN", 2.100),
    ("CHI-NYC", "Chicago",     "IL", "New York", "NY",  790, "DRY_VAN", 2.450),
    ("ATL-MIA", "Atlanta",     "GA", "Miami",    "FL",  662, "REEFER",  2.380),
    ("SEA-PHX", "Seattle",     "WA", "Phoenix",  "AZ", 1420, "DRY_VAN", 2.050),
    ("DEN-CHI", "Denver",      "CO", "Chicago",  "IL", 1003, "DRY_VAN", 1.920),
    ("HOU-ATL", "Houston",     "TX", "Atlanta",  "GA",  790, "DRY_VAN", 2.150),
    ("MEM-CHI", "Memphis",     "TN", "Chicago",  "IL",  530, "DRY_VAN", 2.300),
    ("BOS-ATL", "Boston",      "MA", "Atlanta",  "GA", 1095, "REEFER",  2.420),
    ("PHX-LAX", "Phoenix",     "AZ", "Los Angeles", "CA", 372, "REEFER", 2.600),
    ("DAL-HOU", "Dallas",      "TX", "Houston",  "TX",  239, "FLATBED", 2.550),
    ("NYC-MIA", "New York",    "NY", "Miami",    "FL", 1280, "REEFER",  2.280),
    ("LAX-SEA", "Los Angeles", "CA", "Seattle",  "WA", 1135, "DRY_VAN", 1.880),
]

# All names are invented. Northwind Goods must be STANDARD (contract).
CUSTOMERS = [
    ("Northwind Goods", "STANDARD"),
    ("Bramblecrest Home Supply", "STANDARD"),
    ("Copperleaf Provisions", "PREFERRED"),
    ("Driftwood Pantry Co.", "STANDARD"),
    ("Elmhollow Outfitters", "STANDARD"),
    ("Foxglove Paper Works", "PREFERRED"),
    ("Granite Gully Beverages", "STRATEGIC"),
    ("Harborlight Housewares", "STANDARD"),
    ("Ironpine Garden Supply", "STANDARD"),
    ("Juniper Ridge Pet Foods", "PREFERRED"),
    ("Kestrel Lane Apparel", "STANDARD"),
    ("Lanternfish Seafood Traders", "STRATEGIC"),
    ("Marigold Mill Bakeries", "PREFERRED"),
    ("Nettlefield Hardware", "STANDARD"),
    ("Oakmoss Candle Co.", "STANDARD"),
    ("Pebblebrook Toys", "PREFERRED"),
    ("Quillstone Office Goods", "STANDARD"),
    ("Rustvale Auto Parts", "STRATEGIC"),
    ("Saltmarsh Frozen Foods", "PREFERRED"),
    ("Thistledown Textiles", "STANDARD"),
    ("Umberwood Furniture", "STANDARD"),
    ("Velvet Hollow Cosmetics", "PREFERRED"),
    ("Willowmere Electronics", "STRATEGIC"),
    ("Yarrow Creek Produce", "STANDARD"),
    ("Zephyr Point Sporting Goods", "STANDARD"),
]

# 12 weekly diesel prices, oldest -> newest. Latest MUST be 3.800 and the max.
FUEL = [3.620, 3.650, 3.610, 3.670, 3.700, 3.680, 3.720, 3.750, 3.710, 3.740, 3.770, 3.800]
assert FUEL[-1] == 3.800 and max(FUEL) == 3.800

# tier: target, min, abs_min, buffer, max_rounds, approval_threshold
POLICY = {
    "STANDARD":  (0.30, 0.12, 0.06, 0.04, 8, 5_000_000),
    "PREFERRED": (0.28, 0.10, 0.05, 0.04, 8, 7_500_000),
    "STRATEGIC": (0.25, 0.08, 0.04, 0.03, 10, 10_000_000),
}

LEVERS = [
    ("TERM_12M",   0.04, "A 12-month commitment improves pricing."),
    ("VOLUME_30",  0.03, "Committing to 30 or more loads per week improves pricing."),
    ("PICKUP_48H", 0.02, "A 48-hour pickup window lets us price more aggressively."),
    ("NET15",      0.01, "Paying within 15 days improves pricing."),
    ("NET60",     -0.02, "Net-60 payment terms increase the price."),
]
LEVER_HINT = {k: h for k, _, h in LEVERS}
LEVER_CREDIT = {k: c for k, c, _ in LEVERS}

LANE_BY_ID = {l[0]: l for l in LANES}

# ---------------------------------------------------------------------------
# Pricing formulas (CONTRACT.md)
# ---------------------------------------------------------------------------
def fsc_per_mile(diesel):
    return max(diesel - 1.20, 0) / 6.0

def cost_per_load(lane_id, diesel):
    l = LANE_BY_ID[lane_id]
    return l[5] * (l[7] + fsc_per_mile(diesel))

def list_rate(lane_id, tier, diesel):
    return cost_per_load(lane_id, diesel) * (1 + POLICY[tier][0])

def applicable_levers(term, lpw, pay, pickup):
    out = []
    if term >= 12: out.append("TERM_12M")
    if lpw >= 30: out.append("VOLUME_30")
    if pickup >= 48: out.append("PICKUP_48H")
    if pay == "NET15": out.append("NET15")
    if pay == "NET60": out.append("NET60")
    return out

def floor_rate(lane_id, tier, term, lpw, pay, pickup, diesel):
    _, mn, absmin, *_ = POLICY[tier]
    credit = sum(LEVER_CREDIT[k] for k in applicable_levers(term, lpw, pay, pickup))
    req = max(mn - credit, absmin)
    return cost_per_load(lane_id, diesel) * (1 + req)

def contract_value(rate, lpw, term):
    return rate * lpw * 52 / 12 * term

def ceil5(x):
    return math.ceil(round(x, 6) / 5.0) * 5.0

def hint_for(term, lpw, pay, pickup):
    if pay == "NET60":
        return LEVER_HINT["NET60"]
    used = set(applicable_levers(term, lpw, pay, pickup))
    for k, c, h in sorted(LEVERS, key=lambda x: -x[1]):
        if c > 0 and k not in used:
            return h
    return None

# Worked-example self-check (must match the contract).
assert round(cost_per_load("LAX-DAL", 3.80), 2) == 3635.33
assert round(list_rate("LAX-DAL", "STANDARD", 3.80), 2) == 4725.93
assert round(floor_rate("LAX-DAL", "STANDARD", 6, 20, "NET30", 24, 3.80), 2) == 4071.57
assert round(floor_rate("LAX-DAL", "STANDARD", 12, 40, "NET30", 48, 3.80), 2) == 3853.45
assert round(floor_rate("LAX-DAL", "STANDARD", 6, 20, "NET30", 24, 4.60), 2) == 4285.87

# ---------------------------------------------------------------------------
# SQL helpers
# ---------------------------------------------------------------------------
def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)

def ts(minutes_ago):
    return f"DATEADD(minute, -{int(minutes_ago)}, CURRENT_TIMESTAMP())::TIMESTAMP_NTZ"

def insert(table, cols, rows):
    lines = [f"INSERT INTO {table} ({', '.join(cols)}) VALUES"]
    lines.append(",\n".join("  (" + ", ".join(r) + ")" for r in rows) + ";")
    return "\n".join(lines)

def diesel_at(minutes_ago):
    """Weekly row n weeks ago is at now - n weeks. Pick latest row at or before the moment."""
    week = 7 * 24 * 60
    n = math.ceil(minutes_ago / week)  # weeks ago of the row in effect
    n = min(max(n, 0), len(FUEL) - 1)
    return FUEL[len(FUEL) - 1 - n]

# ---------------------------------------------------------------------------
# History simulation
# ---------------------------------------------------------------------------
customers = [(f"C-{i+1:03d}", n, t) for i, (n, t) in enumerate(CUSTOMERS)]
N_HIST = 20
LOST = {6, 14}
BIG = {4, 11, 17}  # 12-month, 40+ loads/week deals -> above approval threshold  # 1-based negotiation numbers that end CLOSED_LOST

starts = sorted(random.sample(range(2 * 24 * 60, 60 * 24 * 60), N_HIST), reverse=True)  # minutes ago

negotiations, ledger, orders = [], [], []
checks = []
order_no = 0
for i in range(N_HIST):
    nid = f"N-{i+1:04d}"
    cid, cname, tier = random.choice(customers[1:])  # Northwind has no history: its first deal is the live demo
    lane_id = random.choice(LANES)[0]
    term = random.choice([3, 6, 6, 12, 12, 24])
    lpw = random.choice([5, 8, 10, 15, 20, 25, 30, 35, 40, 45])
    if (i + 1) in BIG:
        term, lpw = 12, random.choice([40, 45])
    pay = random.choice(["NET30", "NET30", "NET30", "NET15", "NET60"])
    pickup = random.choice([24, 24, 48])
    t0 = starts[i]
    diesel = diesel_at(t0)
    lst = round(list_rate(lane_id, tier, diesel), 2)
    # Use the stricter of the floor at the historical diesel and at the max seeded
    # diesel (3.80), so every accepted rate is >= the floor under any seeded price.
    flr = max(floor_rate(lane_id, tier, term, lpw, pay, pickup, diesel),
              floor_rate(lane_id, tier, term, lpw, pay, pickup, max(FUEL)))
    buf = POLICY[tier][3]
    cmin = flr * (1 + buf)
    hint = hint_for(term, lpw, pay, pickup)

    t = t0
    def ev(actor, action, rate=None, decision=None, counter=None, hint_=None, note=None, terms=True):
        ledger.append([ts(t), q(nid), q(actor), q(action), q(rate),
                       q(term if terms else None), q(lpw if terms else None),
                       q(pay if terms else None), q(pickup if terms else None),
                       q(decision), q(counter), q(hint_), "NULL", q(note)])

    ev("BUYER", "START", note=f"{cname} requests {lpw} loads/week for {term} months", terms=False)
    t -= 1
    ev("SELLER_AGENT", "QUOTE", rate=lst, note=f"List rate quoted at diesel ${diesel:.2f}", terms=False)

    prev = lst
    rate = round(max(lst * random.uniform(0.82, 0.90), flr * 0.82), 2)
    rounds = 0
    n_counters = random.randint(1, 2)
    offers = []
    accepted = None
    lost = (i + 1) in LOST
    while True:
        t -= random.randint(2, 9)
        rounds += 1
        offers.append(rate)
        if rate >= flr and not lost:
            accepted = rate
            ev("BUYER", "OFFER", rate=rate, decision="ACCEPT", note="Offer accepted")
            break
        counter = ceil5(max(cmin, (rate + prev) / 2))
        ev("BUYER", "OFFER", rate=rate, decision="COUNTER", counter=counter, hint_=hint)
        prev = counter
        if rounds >= n_counters:
            if lost:
                t -= random.randint(5, 30)
                ev("BUYER", "MESSAGE", note="We'll pass on this lane for now.", terms=False)
                break
            rate = counter  # buyer takes the counter
        else:
            rate = round(rate + (counter - rate) * random.uniform(0.4, 0.7), 2)

    status = "CLOSED_LOST" if lost else "CLOSED_WON"
    # No probing pattern (3 rising offers, each step < 1.5%) in history.
    for a, b, c in zip(offers, offers[1:], offers[2:]):
        assert not (a < b < c and b / a - 1 < 0.015 and c / b - 1 < 0.015), nid
    if accepted is not None:
        # Guard: must be >= floor at the highest seeded diesel (= current 3.80).
        f_now = floor_rate(lane_id, tier, term, lpw, pay, pickup, max(FUEL))
        assert accepted >= flr - 1e-9
        if accepted < f_now:
            raise SystemExit(f"{nid}: accepted {accepted} < floor@3.80 {f_now:.2f}; adjust seed")
        checks.append((nid, lane_id, tier, accepted, round(f_now, 2)))
        order_no += 1
        oid = f"O-{order_no:04d}"
        tcv = round(contract_value(accepted, lpw, term), 2)
        thresh = POLICY[tier][5]
        t -= 1
        commit_t = t
        pending = tcv > thresh
        ev("SELLER_AGENT", "COMMIT", rate=accepted,
           note=f"Order {oid} booked ({'PENDING_APPROVAL' if pending else 'CONFIRMED'})")
        decided_by, decided_at = None, None
        if pending:
            t -= random.randint(60, 360)
            decided_by, decided_at = "PRICING_MANAGER", ts(t)
            ev("HUMAN", "APPROVE", rate=accepted, decision=None, note=f"Order {oid} approved", terms=False)
        orders.append([q(oid), q(nid), q(cid), q(lane_id), q(accepted), q(term), q(lpw), q(pay), q(pickup),
                       q(tcv), q("CONFIRMED"), ts(commit_t), q(decided_by), decided_at or "NULL"])
    negotiations.append([q(nid), q(cid), q(lane_id), q(lpw), q(term), q(status), q(rounds), q(lst),
                         ts(t0), ts(t)])

# ---------------------------------------------------------------------------
# Emit SQL
# ---------------------------------------------------------------------------
parts = []
parts.append("""-- =====================================================================
-- Counteroffer · Step 3b · Seed data
-- GENERATED by scripts/generate_seed.py — do not hand-edit; re-run the script.
-- Idempotent: truncates every table, then inserts. Run after 01_schema.sql.
-- Historical IDs N-0001.. / O-0001.. never collide with the live sequences
-- (NEGOTIATION_SEQ starts 1001, ORDER_SEQ starts 5001).
-- =====================================================================
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;

TRUNCATE TABLE PUBLIC.LANES;
TRUNCATE TABLE PUBLIC.CUSTOMERS;
TRUNCATE TABLE PUBLIC.FUEL_INDEX;
TRUNCATE TABLE PUBLIC.NEGOTIATIONS;
TRUNCATE TABLE PUBLIC.NEGOTIATION_LEDGER;
TRUNCATE TABLE PUBLIC.ORDERS;
TRUNCATE TABLE PRIVATE.COST_BASIS;
TRUNCATE TABLE PRIVATE.PRICING_POLICY;
TRUNCATE TABLE PRIVATE.CONCESSION_LEVERS;
""")

parts.append("-- Lanes")
parts.append(insert("PUBLIC.LANES",
    ["LANE_ID", "ORIGIN_CITY", "ORIGIN_STATE", "DEST_CITY", "DEST_STATE", "MILES", "EQUIPMENT"],
    [[q(l[0]), q(l[1]), q(l[2]), q(l[3]), q(l[4]), str(l[5]), q(l[6])] for l in LANES]))

parts.append("\n-- Cost basis (PRIVATE)")
parts.append(insert("PRIVATE.COST_BASIS", ["LANE_ID", "CARRIER_COST_PER_MILE"],
    [[q(l[0]), f"{l[7]:.3f}"] for l in LANES]))

parts.append("\n-- Customers (all fictional)")
crow = []
for cid, n, tier in customers:
    loads = {"STANDARD": random.randint(0, 400), "PREFERRED": random.randint(400, 2500),
             "STRATEGIC": random.randint(2500, 9000)}[tier]
    if n == "Northwind Goods":
        loads = 0
    crow.append([q(cid), q(n), q(tier), str(loads), f"{random.uniform(18, 52):.1f}"])
parts.append(insert("PUBLIC.CUSTOMERS", ["CUSTOMER_ID", "NAME", "TIER", "LIFETIME_LOADS", "AVG_DAYS_TO_PAY"], crow))

parts.append("\n-- Fuel index: 12 weekly rows, latest = now = 3.800")
frows = []
for idx, price in enumerate(FUEL):
    weeks_ago = len(FUEL) - 1 - idx
    frows.append([f"DATEADD(week, -{weeks_ago}, CURRENT_TIMESTAMP())::TIMESTAMP_NTZ", f"{price:.3f}", q("WEEKLY_INDEX")])
parts.append(insert("PUBLIC.FUEL_INDEX", ["EFFECTIVE_TS", "DIESEL_PRICE_USD", "SOURCE"], frows))

parts.append("\n-- Pricing policy (PRIVATE) — exact contract values")
parts.append(insert("PRIVATE.PRICING_POLICY",
    ["TIER", "TARGET_MARGIN", "MIN_MARGIN", "ABSOLUTE_MIN_MARGIN", "COUNTER_BUFFER", "MAX_ROUNDS", "APPROVAL_THRESHOLD_USD"],
    [[q(t), f"{p[0]:.4f}", f"{p[1]:.4f}", f"{p[2]:.4f}", f"{p[3]:.4f}", str(p[4]), f"{p[5]:.2f}"] for t, p in POLICY.items()]))

parts.append("\n-- Concession levers (PRIVATE) — exact contract values")
parts.append(insert("PRIVATE.CONCESSION_LEVERS", ["LEVER", "MARGIN_CREDIT", "HINT_TEXT"],
    [[q(k), f"{c:.4f}", q(h)] for k, c, h in LEVERS]))

parts.append(f"\n-- History: {N_HIST} closed negotiations over the past ~60 days")
parts.append(insert("PUBLIC.NEGOTIATIONS",
    ["NEGOTIATION_ID", "CUSTOMER_ID", "LANE_ID", "LOADS_PER_WEEK", "TERM_MONTHS", "STATUS", "ROUNDS_USED",
     "LIST_RATE_AT_START", "CREATED_AT", "UPDATED_AT"], negotiations))

parts.append("\n-- Ledger (EVENT_ID is AUTOINCREMENT; omitted)")
parts.append(insert("PUBLIC.NEGOTIATION_LEDGER",
    ["TS", "NEGOTIATION_ID", "ACTOR", "ACTION", "RATE_PER_LOAD", "TERM_MONTHS", "LOADS_PER_WEEK", "PAYMENT_TERMS",
     "PICKUP_WINDOW_HRS", "DECISION", "COUNTER_RATE", "HINT", "FLAGS", "NOTE"], ledger))

parts.append("\n-- Orders")
parts.append(insert("PUBLIC.ORDERS",
    ["ORDER_ID", "NEGOTIATION_ID", "CUSTOMER_ID", "LANE_ID", "RATE_PER_LOAD", "TERM_MONTHS", "LOADS_PER_WEEK",
     "PAYMENT_TERMS", "PICKUP_WINDOW_HRS", "TOTAL_CONTRACT_VALUE", "STATUS", "CREATED_AT", "DECIDED_BY", "DECIDED_AT"],
    orders))

parts.append("""
-- Sanity check (expect: 12 lanes, 25 customers, 12 fuel rows, latest diesel 3.800)
SELECT (SELECT COUNT(*) FROM PUBLIC.LANES)                  AS lanes,
       (SELECT COUNT(*) FROM PUBLIC.CUSTOMERS)              AS customers,
       (SELECT COUNT(*) FROM PUBLIC.FUEL_INDEX)             AS fuel_rows,
       (SELECT DIESEL_PRICE_USD FROM PUBLIC.FUEL_INDEX ORDER BY EFFECTIVE_TS DESC LIMIT 1) AS current_diesel,
       (SELECT COUNT(*) FROM PUBLIC.NEGOTIATIONS)           AS negotiations,
       (SELECT COUNT(*) FROM PUBLIC.NEGOTIATION_LEDGER)     AS ledger_rows,
       (SELECT COUNT(*) FROM PUBLIC.ORDERS)                 AS orders;
""")

with open(OUT, "w") as f:
    f.write("\n".join(parts))

print(f"wrote {os.path.normpath(OUT)}")
print(f"lanes={len(LANES)} customers={len(customers)} fuel={len(FUEL)} negotiations={len(negotiations)} "
      f"ledger={len(ledger)} orders={len(orders)}")
for c in checks:
    print("  %s %-8s %-9s accepted=%9.2f floor@3.80=%9.2f margin_over_floor=%5.2f%%" % (*c, (c[3] / c[4] - 1) * 100))
