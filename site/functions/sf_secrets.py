"""Snowflake credentials, as Firebase secret params.

Declared once here: firebase-functions rejects a param declared twice, and both
main.py (onboard_chat) and monitor.py (monitor_feed / monitor_decide) need them.
"""
from firebase_functions.params import SecretParam

SF_ACCOUNT = SecretParam("SF_ACCOUNT")
SF_USER = SecretParam("SF_USER")
SF_PASSWORD = SecretParam("SF_PASSWORD")
