-- =====================================================================
-- Counteroffer · Demo-time queries (presenter runs these live)
-- Run ONE STATEMENT AT A TIME (Cmd/Ctrl+Enter). Section A step A.2 is
-- SUPPOSED to error, so "Run All" would stop there.
-- =====================================================================
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;

-- =====================================================================
-- A. GOVERNANCE MOMENT — "the selling agent never sees the floor"
-- =====================================================================
USE ROLE STOREFRONT_ROLE;         -- the role the buyer-facing MCP session runs as
USE SECONDARY ROLES NONE;         -- REQUIRED: this user also holds BROKER_ADMIN; without
                                  -- this, secondary roles would unmask the data
SELECT CURRENT_ROLE(), IS_ROLE_IN_SESSION('BROKER_ADMIN') AS sees_admin;   -- STOREFRONT_ROLE, FALSE

-- A.2 Direct read of the cost basis → ERROR:
--     "Schema 'COUNTEROFFER.PRIVATE' does not exist or not authorized."
SELECT * FROM PRIVATE.COST_BASIS;

-- A.3 It CAN query lane economics... but cost and floor come back NULL.
SELECT * FROM PUBLIC.LANE_ECONOMICS_V ORDER BY LANE_ID;

-- A.4 Same view as the owner: real numbers (LAX-DAL cost 3,635.33, floor 4,071.57)
USE ROLE BROKER_ADMIN;
USE SECONDARY ROLES ALL;
SELECT * FROM PUBLIC.LANE_ECONOMICS_V ORDER BY LANE_ID;

-- =====================================================================
-- B. FUEL SPIKE — floor moves with diesel, the agent doesn't need to know
-- =====================================================================
USE ROLE BROKER_ADMIN;
SELECT LANE_ID, LIST_RATE_STANDARD, FLOOR_STANDARD_NO_LEVERS
FROM PUBLIC.LANE_ECONOMICS_V WHERE LANE_ID = 'LAX-DAL';           -- 4,725.93 / 4,071.57

CALL PUBLIC.SET_DIESEL_PRICE(4.60);

SELECT LANE_ID, LIST_RATE_STANDARD, FLOOR_STANDARD_NO_LEVERS
FROM PUBLIC.LANE_ECONOMICS_V WHERE LANE_ID = 'LAX-DAL';           -- floor 4,285.87

-- ...run a negotiation turn here, then put diesel back:
CALL PUBLIC.SET_DIESEL_PRICE(3.80);

-- =====================================================================
-- C. LEDGER + HUMAN APPROVAL
-- =====================================================================
USE ROLE BROKER_ADMIN;

-- C.1 Latest negotiation's full ledger
SELECT EVENT_ID, TS, ACTOR, ACTION, RATE_PER_LOAD, TERM_MONTHS, LOADS_PER_WEEK,
       PAYMENT_TERMS, PICKUP_WINDOW_HRS, DECISION, COUNTER_RATE, HINT, FLAGS, NOTE
FROM PUBLIC.NEGOTIATION_LEDGER
WHERE NEGOTIATION_ID = (SELECT NEGOTIATION_ID FROM PUBLIC.NEGOTIATIONS
                        ORDER BY CREATED_AT DESC LIMIT 1)
ORDER BY TS, EVENT_ID;

-- C.2 Orders waiting for a pricing manager
SELECT ORDER_ID, NEGOTIATION_ID, CUSTOMER_ID, LANE_ID, RATE_PER_LOAD, TERM_MONTHS,
       LOADS_PER_WEEK, PAYMENT_TERMS, PICKUP_WINDOW_HRS, TOTAL_CONTRACT_VALUE, CREATED_AT
FROM PUBLIC.ORDERS
WHERE STATUS = 'PENDING_APPROVAL'
ORDER BY CREATED_AT DESC;

-- C.3 Approve it (replace the id with the one from C.2; usually O-5001)
CALL PUBLIC.APPROVE_ORDER('O-5001', 'APPROVE');
-- Alternative without typing the id (approves the newest pending order):
-- SET pending_id = (SELECT ORDER_ID FROM PUBLIC.ORDERS WHERE STATUS = 'PENDING_APPROVAL' ORDER BY CREATED_AT DESC LIMIT 1);
-- CALL PUBLIC.APPROVE_ORDER($pending_id, 'APPROVE');

SELECT ORDER_ID, STATUS, DECIDED_BY, DECIDED_AT FROM PUBLIC.ORDERS
WHERE ORDER_ID LIKE 'O-5%' ORDER BY CREATED_AT DESC;

-- =====================================================================
-- D. CONSISTENCY CHECK — view (inline formulas) vs. the PRIVATE UDF
--    Expect both 4071.57 at diesel 3.80 (4285.87 at 4.60).
-- =====================================================================
USE ROLE BROKER_ADMIN;
SELECT v.FLOOR_STANDARD_NO_LEVERS                                          AS view_floor,
       ROUND(PRIVATE.FLOOR_RATE('LAX-DAL', 'STANDARD', 6, 20, 'NET30', 24), 2) AS udf_floor,
       (SELECT DIESEL_PRICE_USD FROM PUBLIC.FUEL_INDEX ORDER BY EFFECTIVE_TS DESC LIMIT 1) AS diesel
FROM PUBLIC.LANE_ECONOMICS_V v
WHERE v.LANE_ID = 'LAX-DAL';

-- =====================================================================
-- E. DEMO RESET — removes everything created live; keeps the seed history
--    (seed IDs are N-0001.. / O-0001.. / C-001..C-025; live IDs come from
--    the sequences: N-1001.. / O-5001..)
-- =====================================================================
USE ROLE BROKER_ADMIN;
USE SECONDARY ROLES ALL;

DELETE FROM PUBLIC.NEGOTIATION_LEDGER
WHERE TRY_TO_NUMBER(SUBSTR(NEGOTIATION_ID, 3)) >= 1001
   OR NEGOTIATION_ID IS NULL
   OR NEGOTIATION_ID = ''
   OR ACTION = 'FUEL_UPDATE';

DELETE FROM PUBLIC.ORDERS
WHERE TRY_TO_NUMBER(SUBSTR(ORDER_ID, 3)) >= 5001;

DELETE FROM PUBLIC.NEGOTIATIONS
WHERE TRY_TO_NUMBER(SUBSTR(NEGOTIATION_ID, 3)) >= 1001;

-- Customers auto-created by START_NEGOTIATION (anything outside the seeded C-001..C-025)
DELETE FROM PUBLIC.CUSTOMERS
WHERE NOT RLIKE(CUSTOMER_ID, 'C-0(0[1-9]|1[0-9]|2[0-5])');

-- Fuel back to the seeded weekly index (latest seeded row = 3.800)
DELETE FROM PUBLIC.FUEL_INDEX WHERE SOURCE = 'MANUAL';

CREATE OR REPLACE SEQUENCE PUBLIC.NEGOTIATION_SEQ START = 1001;
CREATE OR REPLACE SEQUENCE PUBLIC.ORDER_SEQ       START = 5001;

-- Verify reset: expect 20 negotiations, 18 orders, 25 customers, diesel 3.800, 0 live rows
SELECT (SELECT COUNT(*) FROM PUBLIC.NEGOTIATIONS) AS negotiations,
       (SELECT COUNT(*) FROM PUBLIC.ORDERS)       AS orders,
       (SELECT COUNT(*) FROM PUBLIC.CUSTOMERS)    AS customers,
       (SELECT DIESEL_PRICE_USD FROM PUBLIC.FUEL_INDEX ORDER BY EFFECTIVE_TS DESC LIMIT 1) AS diesel,
       (SELECT COUNT(*) FROM PUBLIC.NEGOTIATION_LEDGER
         WHERE TRY_TO_NUMBER(SUBSTR(NEGOTIATION_ID, 3)) >= 1001) AS live_ledger_rows;
