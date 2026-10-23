#!/usr/bin/env python3
"""Counteroffer bridge — Snowflake ledger ⇄ the web console at /console.

Up:   PUBLIC.NEGOTIATIONS, NEGOTIATION_LEDGER, ORDERS and the current diesel
      index are published to Firestore under workspaces/<uid>/..., where
      site/public/console.js renders them live.
Down: approve/reject clicks land in workspaces/<uid>/commands; this process
      executes them with PUBLIC.APPROVE_ORDER and writes the result back.

The floor stays in Snowflake. By default the bridge publishes only how far
above the floor the current offer sits (a percentage), never the number, the
cost basis or the policy. --include-floor opts into publishing the figures to
your own private workspace.

Auth is the seller's own Counteroffer login (Firebase email/password), so the
existing Firestore rules — a workspace is readable and writable only by its
owner — are what protects the data. No service-account key needed.

Usage
-----
  COUNTEROFFER_SF_ENV=~/.snowflake/counteroffer.env \\
  CO_FB_EMAIL=you@example.com CO_FB_PASSWORD='…' \\
      python3 bridge/counteroffer_bridge.py --watch

  --once             sync a single time and exit
  --watch            keep syncing (default interval 3s)
  --interval N       seconds between polls
  --include-floor    also publish floor / cost figures to your workspace
  --backfill N       events to publish on the first pass (default 300)
  --reset            delete everything this bridge has published, then exit
  --dry-run          read Snowflake and print what would be published
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

# Web config from site/public/firebase-init.js. Public by design: it identifies
# the project. Access is enforced by Firebase Auth + the Firestore rules.
FB_API_KEY = "AIzaSyCtlPD0wd7bCeq0HYzqXnCY404Bm2aYzpo"
FB_PROJECT = "counteroffer-storefront"

IDENTITY = "https://identitytoolkit.googleapis.com/v1"
SECURETOKEN = "https://securetoken.googleapis.com/v1/token"
FIRESTORE = "https://firestore.googleapis.com/v1"
DOC_ROOT = f"projects/{FB_PROJECT}/databases/(default)/documents"

DB = "COUNTEROFFER"
COMMIT_CHUNK = 200          # Firestore allows 500 writes per commit
COLLECTIONS = ("negotiations", "events", "orders", "commands", "meta")


def log(*a):
    print(dt.datetime.now().strftime("[%H:%M:%S]"), *a, flush=True)


def die(msg, code=2):
    print("error: " + msg, file=sys.stderr)
    raise SystemExit(code)


# =====================================================================
# Config
# =====================================================================
def load_env_file(path: str) -> dict:
    out = {}
    with open(os.path.expanduser(path)) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def config() -> dict:
    env_path = os.environ.get("COUNTEROFFER_SF_ENV")
    cfg = load_env_file(env_path) if env_path else {}
    # Environment variables win over the file.
    for key in ("SF_ACCOUNT", "SF_USER", "SF_PASSWORD", "SF_ROLE", "SF_WAREHOUSE",
                "CO_FB_EMAIL", "CO_FB_PASSWORD"):
        if os.environ.get(key):
            cfg[key] = os.environ[key]
    missing = [k for k in ("SF_ACCOUNT", "SF_USER", "SF_PASSWORD") if not cfg.get(k)]
    if missing:
        die("missing Snowflake settings: " + ", ".join(missing) +
            ".\nPut them in a KEY=VALUE file and point COUNTEROFFER_SF_ENV at it, "
            "or export them.")
    missing = [k for k in ("CO_FB_EMAIL", "CO_FB_PASSWORD") if not cfg.get(k)]
    if missing:
        die("missing Counteroffer login: " + ", ".join(missing) +
            ".\nThese are the email and password you use at /login on the console site.")
    return cfg


# =====================================================================
# Firestore over REST, signed in as the seller
# =====================================================================
def http_json(url: str, payload=None, method=None, token=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} from {urllib.parse.urlparse(url).path}: {detail}") from None


class Firebase:
    """Signed-in Firestore client for one workspace."""

    def __init__(self, email: str, password: str):
        res = http_json(f"{IDENTITY}/accounts:signInWithPassword?key={FB_API_KEY}",
                        {"email": email, "password": password, "returnSecureToken": True})
        self.uid = res["localId"]
        self.email = res.get("email", email)
        self._token = res["idToken"]
        self._refresh = res["refreshToken"]
        self._expires = time.time() + int(res.get("expiresIn", 3600)) - 120

    @property
    def token(self) -> str:
        if time.time() >= self._expires:
            res = http_json(f"{SECURETOKEN}?key={FB_API_KEY}",
                            {"grant_type": "refresh_token", "refresh_token": self._refresh})
            self._token = res["id_token"]
            self._refresh = res["refresh_token"]
            self._expires = time.time() + int(res.get("expires_in", 3600)) - 120
        return self._token

    def path(self, *parts) -> str:
        return "/".join([DOC_ROOT, "workspaces", self.uid, *[str(p) for p in parts]])

    def commit(self, writes: list):
        for i in range(0, len(writes), COMMIT_CHUNK):
            http_json(f"{FIRESTORE}/{DOC_ROOT}:commit", {"writes": writes[i:i + COMMIT_CHUNK]},
                      token=self.token)

    def list_docs(self, collection: str, page_size=100) -> list:
        url = (f"{FIRESTORE}/{urllib.parse.quote(self.path(collection), safe='/()')}"
               f"?pageSize={page_size}")
        out, page = [], None
        while True:
            res = http_json(url + (f"&pageToken={page}" if page else ""), token=self.token)
            out.extend(res.get("documents", []))
            page = res.get("nextPageToken")
            if not page:
                return out

    def delete_collection(self, collection: str):
        docs = self.list_docs(collection)
        if docs:
            self.commit([{"delete": d["name"]} for d in docs])
        return len(docs)


def fs_value(v):
    """Python value → Firestore REST Value."""
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, Decimal):
        v = float(v)
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, dt.datetime):
        if v.tzinfo is None:
            v = v.astimezone()                     # naive → this machine's zone
        return {"timestampValue": v.astimezone(dt.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [fs_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: fs_value(x) for k, x in v.items()}}}
    return {"stringValue": str(v)}


def fs_fields(d: dict) -> dict:
    return {k: fs_value(v) for k, v in d.items()}


def write_doc(fb: Firebase, collection: str, doc_id, fields: dict) -> dict:
    return {"update": {"name": fb.path(collection, doc_id), "fields": fs_fields(fields)}}


def patch_doc(fb: Firebase, collection: str, doc_id, fields: dict) -> dict:
    return {"update": {"name": fb.path(collection, doc_id), "fields": fs_fields(fields)},
            "updateMask": {"fieldPaths": list(fields)}}


def py_value(v: dict):
    """Firestore REST Value → plain Python (only the types we write)."""
    if "nullValue" in v:
        return None
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "booleanValue" in v:
        return v["booleanValue"]
    if "timestampValue" in v:
        return v["timestampValue"]
    if "arrayValue" in v:
        return [py_value(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: py_value(x) for k, x in (v["mapValue"].get("fields") or {}).items()}
    return v.get("stringValue")


def plain(doc: dict) -> dict:
    """Firestore REST document → plain dict, with the document id as _id."""
    out = {k: py_value(v) for k, v in (doc.get("fields") or {}).items()}
    out["_id"] = doc.get("name", "").rsplit("/", 1)[-1]
    return out


# =====================================================================
# Snowflake
# =====================================================================
def snowflake_session(cfg: dict):
    from snowflake.snowpark import Session

    sess = Session.builder.configs({
        "account": cfg["SF_ACCOUNT"], "user": cfg["SF_USER"], "password": cfg["SF_PASSWORD"],
        "role": cfg.get("SF_ROLE", "BROKER_ADMIN"),
        "warehouse": cfg.get("SF_WAREHOUSE", "COUNTEROFFER_WH"),
        "database": DB, "schema": "PUBLIC",
    }).create()
    sess.sql("USE SECONDARY ROLES NONE").collect()
    return sess


def scalarize(v):
    if isinstance(v, Decimal):
        return float(v)
    return v


def rows(sess, sql: str, params=None) -> list:
    q = sess.sql(sql, params=params) if params else sess.sql(sql)
    return [{k.upper(): scalarize(val) for k, val in r.as_dict().items()} for r in q.collect()]


def read_diesel(sess):
    r = rows(sess, f"SELECT MAX_BY(DIESEL_PRICE_USD, EFFECTIVE_TS) AS D FROM {DB}.PUBLIC.FUEL_INDEX")
    return r[0]["D"] if r else None


def read_negotiations(sess, include_floor: bool) -> list:
    """One row per negotiation. Floor columns come from PRIVATE.LIVE_FLOOR_V."""
    base = rows(sess, f"""
        SELECT n.NEGOTIATION_ID, c.NAME AS CUSTOMER, c.TIER, n.LANE_ID,
               l.ORIGIN_CITY || ', ' || l.ORIGIN_STATE AS ORIGIN,
               l.DEST_CITY   || ', ' || l.DEST_STATE   AS DESTINATION,
               n.LOADS_PER_WEEK, n.TERM_MONTHS, n.STATUS, n.ROUNDS_USED,
               n.LIST_RATE_AT_START,
               n.CREATED_AT::TIMESTAMP_LTZ AS CREATED_AT,
               n.UPDATED_AT::TIMESTAMP_LTZ AS UPDATED_AT
        FROM {DB}.PUBLIC.NEGOTIATIONS n
        JOIN {DB}.PUBLIC.CUSTOMERS c ON c.CUSTOMER_ID = n.CUSTOMER_ID
        JOIN {DB}.PUBLIC.LANES     l ON l.LANE_ID     = n.LANE_ID
        ORDER BY n.CREATED_AT DESC""")

    # Rounds allowed per tier (policy, not a secret in itself).
    try:
        max_rounds = {r["TIER"]: r["MAX_ROUNDS"]
                      for r in rows(sess, f"SELECT TIER, MAX_ROUNDS FROM {DB}.PRIVATE.PRICING_POLICY")}
    except Exception:
        max_rounds = {}

    try:
        floors = {r["NEGOTIATION_ID"]: r for r in rows(sess, f"SELECT * FROM {DB}.PRIVATE.LIVE_FLOOR_V")}
    except Exception as e:
        log("note: PRIVATE.LIVE_FLOOR_V not readable by this role — publishing public fields only "
            f"({type(e).__name__})")
        floors = {}

    out = []
    for n in base:
        f = floors.get(n["NEGOTIATION_ID"], {})
        offer = f.get("LAST_OFFER_RATE")
        floor = f.get("FLOOR_FOR_LAST_TERMS") or f.get("FLOOR_NO_LEVERS")
        doc = {
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
            # List rate, offers and counters are already public in the ledger.
            "list_rate": f.get("LIST_RATE") or n["LIST_RATE_AT_START"],
            "last_offer_rate": offer,
            "last_offer_terms": f.get("LAST_OFFER_TERMS"),
            "last_decision": f.get("LAST_DECISION"),
            "last_counter_rate": f.get("LAST_COUNTER_RATE"),
            "created_at": n["CREATED_AT"],
            "updated_at": n["UPDATED_AT"],
        }
        # Floor-relative distance: a derived signal, not the number.
        if offer is not None and floor:
            doc["above_floor_pct"] = round((offer - floor) / floor * 100, 2)
        if include_floor:
            doc["floor"] = floor
            doc["floor_no_levers"] = f.get("FLOOR_NO_LEVERS")
            doc["cost"] = f.get("COST_PER_LOAD")
        out.append(doc)
    return out


def read_events(sess, since: int, backfill: int) -> list:
    if since:
        r = rows(sess, f"""
            SELECT EVENT_ID, TS::TIMESTAMP_LTZ AS TS, NEGOTIATION_ID, ACTOR, ACTION, RATE_PER_LOAD,
                   TERM_MONTHS, LOADS_PER_WEEK, PAYMENT_TERMS, PICKUP_WINDOW_HRS, DECISION,
                   COUNTER_RATE, HINT, FLAGS, NOTE
            FROM {DB}.PUBLIC.NEGOTIATION_LEDGER
            WHERE EVENT_ID > ?
            ORDER BY EVENT_ID""", [since])
    else:
        r = rows(sess, f"""
            SELECT EVENT_ID, TS::TIMESTAMP_LTZ AS TS, NEGOTIATION_ID, ACTOR, ACTION, RATE_PER_LOAD,
                   TERM_MONTHS, LOADS_PER_WEEK, PAYMENT_TERMS, PICKUP_WINDOW_HRS, DECISION,
                   COUNTER_RATE, HINT, FLAGS, NOTE
            FROM {DB}.PUBLIC.NEGOTIATION_LEDGER
            ORDER BY EVENT_ID DESC
            LIMIT {int(backfill)}""")
        r.reverse()
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


def read_orders(sess) -> list:
    r = rows(sess, f"""
        SELECT o.ORDER_ID, o.NEGOTIATION_ID, c.NAME AS CUSTOMER, o.LANE_ID, o.RATE_PER_LOAD,
               o.TERM_MONTHS, o.LOADS_PER_WEEK, o.PAYMENT_TERMS, o.PICKUP_WINDOW_HRS,
               o.TOTAL_CONTRACT_VALUE, o.STATUS,
               o.CREATED_AT::TIMESTAMP_LTZ AS CREATED_AT, o.DECIDED_BY,
               o.DECIDED_AT::TIMESTAMP_LTZ AS DECIDED_AT
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


def call_proc(sess, proc: str, *args):
    res = sess.call(f"{DB}.PUBLIC.{proc}", *args)
    try:
        return json.loads(res) if isinstance(res, str) else res
    except Exception:
        return {"result": res}


# =====================================================================
# Sync
# =====================================================================
class Bridge:
    def __init__(self, fb: Firebase, sess, cfg: dict, args):
        self.fb, self.sess, self.cfg, self.args = fb, sess, cfg, args
        self.watermark = 0
        self.published = {}      # (collection, id) → last payload, to skip no-op writes

    def unchanged(self, collection: str, doc_id, payload: dict) -> bool:
        """True if this exact payload was already published (skip the write)."""
        key = (collection, str(doc_id))
        return self.published.get(key) == json.dumps(payload, sort_keys=True, default=str)

    def mark_published(self, collection: str, doc_id, payload: dict):
        self.published[(collection, str(doc_id))] = json.dumps(payload, sort_keys=True, default=str)

    def sync(self) -> int:
        writes = []
        # Nothing here mutates the watermark or the published cache: a commit that
        # throws must leave this pass repeatable, or those rows are lost for good.
        pending = []

        negotiations = read_negotiations(self.sess, self.args.include_floor)
        for n in negotiations:
            if not self.unchanged("negotiations", n["id"], n):
                writes.append(write_doc(self.fb, "negotiations", n["id"], n))
                pending.append(("negotiations", n["id"], n))

        events = read_events(self.sess, self.watermark, self.args.backfill)
        for e in events:
            writes.append(write_doc(self.fb, "events", e["event_id"], e))

        orders = read_orders(self.sess)
        for o in orders:
            if not self.unchanged("orders", o["order_id"], o):
                writes.append(write_doc(self.fb, "orders", o["order_id"], o))
                pending.append(("orders", o["order_id"], o))

        diesel = read_diesel(self.sess)
        writes.append(write_doc(self.fb, "meta", "bridge", {
            "source": "snowflake",
            "account": self.cfg["SF_ACCOUNT"],
            "role": self.cfg.get("SF_ROLE", "BROKER_ADMIN"),
            "diesel": diesel,
            "include_floor": bool(self.args.include_floor),
            "last_event_id": self.watermark,
            "last_sync": dt.datetime.now(dt.timezone.utc),
        }))

        if self.args.dry_run:
            log(f"dry run: {len(negotiations)} negotiations, {len(events)} new events, "
                f"{len(orders)} orders, diesel {diesel}, {len(writes)} writes withheld")
            return 0

        self.fb.commit(writes)

        # Committed: only now is it safe to not send these again.
        for args in pending:
            self.mark_published(*args)
        if events:
            self.watermark = max(e["event_id"] for e in events)

        if events or len(writes) > 1:
            log(f"published {len(events)} new event(s), {len(writes)} write(s) "
                f"· watermark {self.watermark} · diesel {diesel}")
        return len(writes)

    def run_commands(self) -> int:
        try:
            docs = [plain(d) for d in self.fb.list_docs("commands")]
        except Exception as e:
            log("could not read commands:", e)
            return 0

        done = 0
        for c in docs:
            if c.get("status") != "QUEUED":
                continue
            cid, ctype = c["_id"], c.get("type")
            if self.args.dry_run:
                log(f"dry run: would execute {ctype} {c.get('order_id')} {c.get('decision')}")
                continue

            self.fb.commit([patch_doc(self.fb, "commands", cid, {"status": "RUNNING"})])
            try:
                if ctype == "APPROVE_ORDER":
                    oid = str(c.get("order_id") or "")
                    decision = str(c.get("decision") or "").upper()
                    if decision not in ("APPROVE", "REJECT"):
                        raise ValueError("decision must be APPROVE or REJECT")
                    res = call_proc(self.sess, "APPROVE_ORDER", oid, decision)
                elif ctype == "SET_DIESEL_PRICE":
                    res = call_proc(self.sess, "SET_DIESEL_PRICE", float(c.get("price")))
                else:
                    raise ValueError(f"unsupported command type {ctype!r}")

                err = res.get("error") if isinstance(res, dict) else None
                self.fb.commit([patch_doc(self.fb, "commands", cid, {
                    "status": "ERROR" if err else "DONE",
                    "result": err or json.dumps(res),
                    "finished_at": dt.datetime.now(dt.timezone.utc),
                })])
                log(f"{ctype} {c.get('order_id') or ''} {c.get('decision') or ''} → "
                    f"{'ERROR: ' + err if err else res}")
            except Exception as e:
                self.fb.commit([patch_doc(self.fb, "commands", cid, {
                    "status": "ERROR",
                    "result": f"{type(e).__name__}: {e}",
                    "finished_at": dt.datetime.now(dt.timezone.utc),
                })])
                log(f"{ctype} failed:", e)
            done += 1
        return done


# =====================================================================
# Entry point
# =====================================================================
def main(argv=None):
    p = argparse.ArgumentParser(description="Publish the Counteroffer ledger to the web console.")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="sync a single time and exit")
    mode.add_argument("--watch", action="store_true", help="keep syncing (default)")
    mode.add_argument("--reset", action="store_true", help="delete everything published, then exit")
    p.add_argument("--interval", type=float, default=3.0, help="seconds between polls (default 3)")
    p.add_argument("--include-floor", action="store_true",
                   help="also publish floor/cost figures to your own workspace")
    p.add_argument("--backfill", type=int, default=300, help="events to publish on the first pass")
    p.add_argument("--dry-run", action="store_true", help="read Snowflake, publish nothing")
    args = p.parse_args(argv)

    cfg = config()

    log("signing in to Counteroffer as", cfg["CO_FB_EMAIL"])
    fb = Firebase(cfg["CO_FB_EMAIL"], cfg["CO_FB_PASSWORD"])
    log("workspace", fb.uid)

    if args.reset:
        total = sum(fb.delete_collection(c) for c in COLLECTIONS)
        log(f"deleted {total} published document(s). The console falls back to demo data.")
        return 0

    log("connecting to Snowflake", cfg["SF_ACCOUNT"], "as", cfg["SF_USER"])
    sess = snowflake_session(cfg)
    try:
        bridge = Bridge(fb, sess, cfg, args)
        if args.include_floor:
            log("--include-floor: floor and cost figures WILL be published to your workspace")
        else:
            log("floor stays in Snowflake; publishing offer-vs-floor distance only")

        bridge.sync()
        bridge.run_commands()
        if args.once:
            log("done (--once)")
            return 0

        log(f"watching every {args.interval:g}s — Ctrl-C to stop")
        while True:
            time.sleep(args.interval)
            try:
                bridge.sync()
                bridge.run_commands()
            except KeyboardInterrupt:
                raise
            except Exception as e:
                log("sync failed, retrying:", f"{type(e).__name__}: {e}")
                time.sleep(min(args.interval * 3, 30))
    except KeyboardInterrupt:
        log("stopped")
        return 0
    finally:
        try:
            sess.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
