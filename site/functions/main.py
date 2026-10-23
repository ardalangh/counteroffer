"""Firebase Cloud Function (2nd gen, Python): onboard_chat.

HTTPS callable. Requires Firebase Auth. Per-user rate limit (40 calls / rolling hour) kept in
Firestore at onboard_ratelimit/{uid} - a collection clients can't touch (rules deny it; the Admin
SDK bypasses rules). The real work is in core.py.
"""
from __future__ import annotations

import logging
import time

from firebase_admin import firestore, initialize_app
from firebase_functions import https_fn, options

import core
from monitor import monitor_decide, monitor_feed  # noqa: F401  (exported: /console live feed)

initialize_app()
log = logging.getLogger("onboard")

from sf_secrets import SF_ACCOUNT, SF_PASSWORD, SF_USER  # noqa: E402

RATE_LIMIT = 40
RATE_WINDOW_S = 3600


def _rate_limit(uid: str) -> None:
    db = firestore.client()
    ref = db.collection("onboard_ratelimit").document(uid)

    @firestore.transactional
    def bump(txn):
        snap = ref.get(transaction=txn)
        now = time.time()
        d = snap.to_dict() if snap.exists else {}
        start, count = d.get("window_start", 0), d.get("count", 0)
        if now - start > RATE_WINDOW_S:
            start, count = now, 0
        if count >= RATE_LIMIT:
            return False
        txn.set(ref, {"window_start": start, "count": count + 1, "updated": now})
        return True

    if not bump(db.transaction()):
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.RESOURCE_EXHAUSTED,
                                  "You've hit the hourly limit for AI onboarding. Try again later or use the steps below.")


@https_fn.on_call(
    secrets=[SF_ACCOUNT, SF_USER, SF_PASSWORD],
    timeout_sec=540,
    memory=options.MemoryOption.GB_1,
    max_instances=5,
    region="us-central1",
)
def onboard_chat(req: https_fn.CallableRequest) -> dict:
    if req.auth is None or not req.auth.uid:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in to use AI onboarding.")
    data = req.data if isinstance(req.data, dict) else {}
    try:
        core.clean_messages(data.get("messages"))  # validate input before spending a rate-limit slot
    except core.UserFacingError as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, str(e))
    _rate_limit(req.auth.uid)
    conn = None
    try:
        conn = core.connect(SF_ACCOUNT.value, SF_USER.value, SF_PASSWORD.value)
        return core.handle_turn(conn, data.get("messages"))
    except core.UserFacingError as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAVAILABLE, str(e))
    except https_fn.HttpsError:
        raise
    except Exception:  # noqa: BLE001 - never leak stack traces or credentials to the client
        log.exception("onboard_chat failed for uid=%s", req.auth.uid)
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL,
                                  "AI onboarding hit an internal error. Please try again.")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
