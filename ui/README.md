# Acme Seller Console (Streamlit in Snowflake)

App: `COUNTEROFFER.PUBLIC.SELLER_CONSOLE`, owner role `BROKER_ADMIN`, warehouse runtime.
Reads `PUBLIC.NEGOTIATIONS / NEGOTIATION_LEDGER / ORDERS / FUEL_INDEX / CUSTOMERS / LANES` and
`PRIVATE.LIVE_FLOOR_V`. Calls `PUBLIC.SET_DIESEL_PRICE` and `PUBLIC.APPROVE_ORDER` via `session.call`.
Auto-refreshes every 3 s with `st.fragment(run_every=3)` (falls back to a Refresh button on old Streamlit).

## Local preview (mock data, no Snowflake)
```bash
cd counteroffer
python3 -m venv ui/.venv && ui/.venv/bin/pip install -r ui/requirements-local.txt
COUNTEROFFER_MOCK=1 ui/.venv/bin/streamlit run ui/streamlit_app.py --server.headless true --server.port 8501
# open http://localhost:8501  (sidebar: "Simulate role without PRIVATE access", "Reset mock data")
```
Mock mode also turns on automatically if `get_active_session()` fails.

## Deploy option A: Snowsight UI
1. Run SQL files `00`–`04` first (the procs and `PRIVATE.LIVE_FLOOR_V` must exist).
2. Snowsight → switch role to **BROKER_ADMIN** → *Projects → Streamlit → + Streamlit App*.
3. Title `SELLER_CONSOLE`, database **COUNTEROFFER**, schema **PUBLIC**, warehouse **COUNTEROFFER_WH**
   (runtime: warehouse). Create.
4. In the editor, replace the code with `ui/streamlit_app.py`.
5. *Packages* dropdown: pick **streamlit 1.50.0** (or newer; needs 1.37+ for `st.fragment`), or upload
   `ui/environment.yml` as `environment.yml` in the app's files. Click **Run**.
   - If Snowsight named the app something else, rename it:
     `ALTER STREAMLIT COUNTEROFFER.PUBLIC.<name> RENAME TO COUNTEROFFER.PUBLIC.SELLER_CONSOLE;`

## Deploy option B: SQL
```sql
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
CREATE STAGE IF NOT EXISTS COUNTEROFFER.PUBLIC.UI_STAGE;
-- from SnowSQL / Snowflake CLI on your laptop:
PUT file://ui/streamlit_app.py @COUNTEROFFER.PUBLIC.UI_STAGE/seller_console AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
PUT file://ui/environment.yml  @COUNTEROFFER.PUBLIC.UI_STAGE/seller_console AUTO_COMPRESS=FALSE OVERWRITE=TRUE;

CREATE OR REPLACE STREAMLIT COUNTEROFFER.PUBLIC.SELLER_CONSOLE
  FROM '@COUNTEROFFER.PUBLIC.UI_STAGE/seller_console'
  MAIN_FILE = 'streamlit_app.py'
  QUERY_WAREHOUSE = COUNTEROFFER_WH
  TITLE = 'Acme Seller Console';
ALTER STREAMLIT COUNTEROFFER.PUBLIC.SELLER_CONSOLE ADD LIVE VERSION FROM LAST;
```
(Snowflake CLI alternative to PUT: `snow stage copy ui/streamlit_app.py @COUNTEROFFER.PUBLIC.UI_STAGE/seller_console`.)

## Governance moment ("🔒 Floor hidden for this role")
The floor panel only renders if `SELECT * FROM PRIVATE.LIVE_FLOOR_V` succeeds. Any error → lock card,
the rest of the console keeps working (it reads offers from the PUBLIC ledger). Because SiS apps run
with owner's rights, the lock appears in Snowflake only if the app's owner role can't read the view,
e.g. a second copy of this app owned by a role with PUBLIC-table SELECT but no PRIVATE access.
Locally: sidebar toggle "Simulate role without PRIVATE access".

## Demo tips
- Picker defaults to "Newest (follows live)", so a new `START_NEGOTIATION` shows up on its own.
- Ledger is newest-first, so the latest move is always at the top.
- Diesel "Spike to $4.60" makes floor/list jump, with an orange ▲ delta shown for 20 s.
