"""Negotiation monitor feed: Snowflake ledger -> the /console page, live.

Two HTTPS callables, both Firebase-Auth only:

  monitor_feed    the current negotiations, orders and diesel index, plus ledger
                  events newer than `since` (or the latest 300 on first load).
                  /console polls it every few seconds while the tab is visible.
  monitor_decide  approve or decline an order waiting on a person, via
                  PUBLIC.APPROVE_ORDER. Written to the ledger as a HUMAN event.

Who may call them: a signed-in seller whose workspace (Setup step 1) names the
Snowflake account these functions are configured for. Anyone else gets a
clear "not connected" answer and no data — a stranger who signs up can't read
the seller's negotiations or approve their orders.

The function connects as BROKER_ADMIN (see core.connect), so it can read
PRIVATE.LIVE_FLOOR_V and show the seller their own floor. That number goes
only to the authorised seller's browser; it is not stored anywhere new, and
the selling agent still never sees it.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
from decimal import Decimal

from firebase_admin import firestore
from firebase_functions import https_fn, options

import core
from sf_secrets import SF_ACCOUNT, SF_PASSWORD, SF_USER

log = logging.getLogger("monitor")

DB = "COUNTEROFFER"
BACKFILL = 300
ORDER_ID_RE = re.compile(r"^O-\d{1,10}$")

# One Snowflake session per warm instance. Logging in takes a second or two,
# and the console polls every few seconds, so reconnecting each call would be
# most of the latency.
_conn = None
_lock = threading.Lock()


def _err(code, msg):
    return https_fn.HttpsError(code, msg)


def _norm_account(a) -> str:
    # Snowflake hostnames turn "_" into "-"; treat the two spellings as the same account.
    return str(a or "").strip().upper().replace("_", "-")


def _authorize(req: https_fn.CallableRequest) -> str:
    if req.auth is None or not req.auth.uid:
        raise _err(https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in to see your negotiations.")
    uid = req.auth.uid
    snap = firestore.client().collection("workspaces").document(uid).get()
    account = (snap.to_dict() or {}).get("account") if snap.exists else None
    if not account or not str(account).strip():
        raise _err(https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
                   "not_connected: Add your Snowflake account in Setup step 1 to connect the monitor.")
    if _norm_account(account) != _norm_account(SF_ACCOUNT.value):
        raise _err(https_fn.FunctionsErrorCode.PERMISSION_DENIED,
                   "not_reachable: Counteroffer isn't connected to that Snowflake account yet.")
    return uid


def _connection():
    global _conn
    if _conn is not None:
        try:
            if not _conn.is_closed():
                return _conn
        except Exception:  # noqa: BLE001
            pass
    _conn = core.connect(SF_ACCOUNT.value, SF_USER.value, SF_PASSWORD.value)
    try:
        _conn.cursor().execute("ALTER SESSION SET QUERY_TAG = 'counteroffer-web-monitor'")
    except Exception:  # noqa: BLE001
        pass
    return _conn


def _reset():
    global _conn
    try:
        if _conn is not None:
            _conn.close()
    except Exception:  # noqa: BLE001
        pass
    _conn = None


def _rows(conn, sql: str, params=None) -> list[dict]:
    cur = conn.cursor()
    cur.execute(sql, params or ())
    cols = [c[0].upper() for c in cur.description]
    return [{k: _plain(v) for k, v in zip(cols, r)} for r in cur.fetchall()]


def _plain(v):
    """Snowflake value -> something JSON can carry."""
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=dt.timezone.utc)
        return v.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    return v


# ---------------------------------------------------------------------------
# Reads (same shape the bridge published, so the page code is source-agnostic)
# ---------------------------------------------------------------------------
def read_diesel(conn):
    r = _rows(conn, f"SELECT MAX_BY(DIESEL_PRICE_USD, EFFECTIVE_TS) AS D FROM {DB}.PUBLIC.FUEL_INDEX")
    return r[0]["D"] if r else None


def read_negotiations(conn) -> list[dict]:
    base = _rows(conn, f"""
        SELECT n.NEGOTIATION_ID, c.NAME AS CUSTOMER, c.TIER, n.LANE_ID,
               l.ORIGIN_CITY || ', ' || l.ORIGIN_STATE AS ORIGIN,
               l.DEST_CITY   || ', ' || l.DEST_STATE   AS DESTINATION,
               n.LOADS_PER_WEEK, n.TERM_MONTHS, n.STATUS, n.ROUNDS_USED, n.LIST_RATE_AT_START,
               CONVERT_TIMEZONE('UTC', n.CREATED_AT::TIMESTAMP_LTZ)::TIMESTAMP_NTZ AS CREATED_AT,
               CONVERT_TIMEZONE('UTC', n.UPDATED_AT::TIMESTAMP_LTZ)::TIMESTAMP_NTZ AS UPDATED_AT
        FROM {DB}.PUBLIC.NEGOTIATIONS n
        JOIN {DB}.PUBLIC.CUSTOMERS c ON c.CUSTOMER_ID = n.CUSTOMER_ID
        JOIN {DB}.PUBLIC.LANES     l ON l.LANE_ID     = n.LANE_ID
        ORDER BY n.CREATED_AT DESC
        LIMIT 200""")
    try:
        max_rounds = {r["TIER"]: r["MAX_ROUNDS"] for r in _rows(conn, f"SELECT TIER, MAX_ROUNDS FROM {DB}.PRIVATE.PRICING_POLICY")}
    except Exception:  # noqa: BLE001
        max_rounds = {}
    try:
        floors = {r["NEGOTIATION_ID"]: r for r in _rows(conn, f"SELECT * FROM {DB}.PRIVATE.LIVE_FLOOR_V")}
    except Exception:  # noqa: BLE001
        log.warning("PRIVATE.LIVE_FLOOR_V not readable; serving public fields only")
        floors = {}

    out = []
    for n in base:
        f = floors.get(n["NEGOTIATION_ID"], {})
        offer = f.get("LAST_OFFER_RATE")
        floor = f.get("FLOOR_FOR_LAST_TERMS") or f.get("FLOOR_NO_LEVERS")
        out.append({
            "id": n["NEGOTIATION_ID"],
            "customer": n["CUSTOMER"],
            "tier": n["TIER"],
            "lane": n["LANE_ID"],
            "origin": n["ORIGIN"],
            "destination": n["DESTINATION"],
            "loads_per_week": n["LOADS_PER_WEEK"],
            "term_months": n["TERM_MONTHS"],
            "status": n["STATUS"],
            "rounds_used": n["ROUNDS_USED"],
            "rounds_max": max_rounds.get(n["TIER"], 8),
            "list_rate": f.get("LIST_RATE") or n["LIST_RATE_AT_START"],
            "last_offer_rate": offer,
            "last_offer_terms": f.get("LAST_OFFER_TERMS"),
            "last_decision": f.get("LAST_DECISION"),
            "last_counter_rate": f.get("LAST_COUNTER_RATE"),
            "floor": floor,
            "floor_no_levers": f.get("FLOOR_NO_LEVERS"),
            "cost": f.get("COST_PER_LOAD"),
            "above_floor_pct": round((offer - floor) / floor * 100, 2) if offer is not None and floor else None,
            "created_at": n["CREATED_AT"],
            "updated_at": n["UPDATED_AT"],
        })
    return out


_EVENT_COLS = f"""
    SELECT EVENT_ID, CONVERT_TIMEZONE('UTC', TS::TIMESTAMP_LTZ)::TIMESTAMP_NTZ AS TS,
           NEGOTIATION_ID, ACTOR, ACTION, RATE_PER_LOAD, TERM_MONTHS, LOADS_PER_WEEK,
           PAYMENT_TERMS, PICKUP_WINDOW_HRS, DECISION, COUNTER_RATE, HINT, FLAGS, NOTE
    FROM {DB}.PUBLIC.NEGOTIATION_LEDGER"""


def read_events(conn, since: int) -> list[dict]:
    if since > 0:
        r = _rows(conn, _EVENT_COLS + " WHERE EVENT_ID > %s ORDER BY EVENT_ID DESC LIMIT 500", (since,))
    else:
        r = _rows(conn, _EVENT_COLS + f" ORDER BY EVENT_ID DESC LIMIT {BACKFILL}")
    return [{
        "event_id": e["EVENT_ID"],
        "ts": e["TS"],
        "negotiation_id": e["NEGOTIATION_ID"],
        "actor": e["ACTOR"],
        "action": e["ACTION"],
        "rate": e["RATE_PER_LOAD"],
        "term_months": e["TERM_MONTHS"],
        "loads_per_week": e["LOADS_PER_WEEK"],
        "payment_terms": e["PAYMENT_TERMS"],
        "pickup_window_hrs": e["PICKUP_WINDOW_HRS"],
        "decision": e["DECISION"],
        "counter_rate": e["COUNTER_RATE"],
        "hint": e["HINT"],
        "flags": [f.strip() for f in (e["FLAGS"] or "").split(",") if f.strip()],
        "note": e["NOTE"],
    } for e in r]


def read_orders(conn) -> list[dict]:
    r = _rows(conn, f"""
        SELECT o.ORDER_ID, o.NEGOTIATION_ID, c.NAME AS CUSTOMER, o.LANE_ID, o.RATE_PER_LOAD,
               o.TERM_MONTHS, o.LOADS_PER_WEEK, o.PAYMENT_TERMS, o.PICKUP_WINDOW_HRS,
               o.TOTAL_CONTRACT_VALUE, o.STATUS,
               CONVERT_TIMEZONE('UTC', o.CREATED_AT::TIMESTAMP_LTZ)::TIMESTAMP_NTZ AS CREATED_AT,
               o.DECIDED_BY,
               CONVERT_TIMEZONE('UTC', o.DECIDED_AT::TIMESTAMP_LTZ)::TIMESTAMP_NTZ AS DECIDED_AT
        FROM {DB}.PUBLIC.ORDERS o
        JOIN {DB}.PUBLIC.CUSTOMERS c ON c.CUSTOMER_ID = o.CUSTOMER_ID
        ORDER BY o.CREATED_AT DESC
        LIMIT 100""")
    return [{
        "order_id": o["ORDER_ID"],
        "negotiation_id": o["NEGOTIATION_ID"],
        "customer": o["CUSTOMER"],
        "lane": o["LANE_ID"],
        "rate": o["RATE_PER_LOAD"],
        "term_months": o["TERM_MONTHS"],
        "loads_per_week": o["LOADS_PER_WEEK"],
        "payment_terms": o["PAYMENT_TERMS"],
        "pickup_window_hrs": o["PICKUP_WINDOW_HRS"],
        "tcv": o["TOTAL_CONTRACT_VALUE"],
        "status": o["STATUS"],
        "created_at": o["CREATED_AT"],
        "decided_by": o["DECIDED_BY"],
        "decided_at": o["DECIDED_AT"],
    } for o in r]


def snapshot(conn, since: int) -> dict:
    return {
        "meta": {
            "source": "snowflake",
            "diesel": read_diesel(conn),
            "include_floor": True,
            "last_sync": _plain(dt.datetime.now(dt.timezone.utc)),
        },
        "negotiations": read_negotiations(conn),
        "events": read_events(conn, since),
        "orders": read_orders(conn),
    }


def _with_conn(fn):
    """Run fn(conn) on the cached session; reconnect once if it went stale."""
    with _lock:
        try:
            return fn(_connection())
        except Exception as first:  # noqa: BLE001
            log.warning("Snowflake call failed (%s); reconnecting once", type(first).__name__)
            _reset()
            return fn(_connection())


# ---------------------------------------------------------------------------
# Callables
# ---------------------------------------------------------------------------
_OPTS = dict(
    secrets=[SF_ACCOUNT, SF_USER, SF_PASSWORD],
    timeout_sec=60,
    memory=options.MemoryOption.MB_512,
    max_instances=3,
    region="us-central1",
)


@https_fn.on_call(**_OPTS)
def monitor_feed(req: https_fn.CallableRequest) -> dict:
    _authorize(req)
    data = req.data if isinstance(req.data, dict) else {}
    try:
        since = max(0, int(data.get("since") or 0))
    except (TypeError, ValueError):
        since = 0
    try:
        return _with_conn(lambda conn: snapshot(conn, since))
    except https_fn.HttpsError:
        raise
    except Exception:  # noqa: BLE001 - never leak stack traces or credentials
        log.exception("monitor_feed failed")
        raise _err(https_fn.FunctionsErrorCode.UNAVAILABLE, "Couldn't reach Snowflake. Retrying.")


@https_fn.on_call(**_OPTS)
def monitor_decide(req: https_fn.CallableRequest) -> dict:
    _authorize(req)
    data = req.data if isinstance(req.data, dict) else {}
    order_id = str(data.get("order_id") or "").strip()
    decision = str(data.get("decision") or "").strip().upper()
    if not ORDER_ID_RE.match(order_id) or decision not in ("APPROVE", "REJECT"):
        raise _err(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Send an order id like O-5001 and APPROVE or REJECT.")

    def call(conn):
        cur = conn.cursor()
        cur.execute(f"CALL {DB}.PUBLIC.APPROVE_ORDER(%s, %s)", (order_id, decision))
        raw = cur.fetchone()[0]
        return json.loads(raw) if isinstance(raw, str) else raw

    try:
        res = _with_conn(call)
    except Exception:  # noqa: BLE001
        log.exception("monitor_decide failed")
        raise _err(https_fn.FunctionsErrorCode.UNAVAILABLE, "Couldn't reach Snowflake. Try again.")
    if isinstance(res, dict) and res.get("error"):
        raise _err(https_fn.FunctionsErrorCode.FAILED_PRECONDITION, str(res["error"]))
    return res if isinstance(res, dict) else {"result": res}
