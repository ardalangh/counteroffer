-- =====================================================================
-- Counteroffer · Step 3c · Governance
-- Run after 02_seed.sql and BEFORE 04_procs.sql.
--   * PUBLIC.LANE_ECONOMICS_V : secure view; cost/floor columns are NULL
--     unless BROKER_ADMIN is an active role in the session.
--   * STOREFRONT_ROLE grants for the objects that exist at this point.
-- Pricing UDFs don't exist yet, so the view computes the contract formulas
-- inline (STANDARD tier, no levers, current diesel):
--   fsc_per_mile  = GREATEST(diesel - 1.20, 0) / 6.0
--   cost_per_load = miles × (carrier_cost_per_mile + fsc_per_mile)
--   list_rate     = cost_per_load × (1 + target_margin)
--   floor (no levers) = cost_per_load × (1 + GREATEST(min_margin, absolute_min_margin))
-- =====================================================================
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;

-- ---------------------------------------------------------------------
-- 1. Secure view (works on every Snowflake edition)
--    SECURE hides the view definition from non-owners (so the formula and
--    the PRIVATE table names can't be read via GET_DDL / SHOW VIEWS) and
--    prevents optimizer tricks from leaking hidden values.
--    IS_ROLE_IN_SESSION('BROKER_ADMIN') is TRUE when the active primary role
--    or an active SECONDARY role is BROKER_ADMIN or inherits it.
--    => Demo as STOREFRONT_ROLE must run `USE SECONDARY ROLES NONE;`, because
--       the demo user also holds BROKER_ADMIN (see 00_setup.sql).
-- ---------------------------------------------------------------------
CREATE OR REPLACE SECURE VIEW PUBLIC.LANE_ECONOMICS_V
  COMMENT = 'Lane economics. Cost and floor columns are NULL unless BROKER_ADMIN is in session.'
AS
WITH diesel AS (
  SELECT DIESEL_PRICE_USD
  FROM PUBLIC.FUEL_INDEX
  ORDER BY EFFECTIVE_TS DESC
  LIMIT 1
),
pol AS (
  SELECT TARGET_MARGIN, MIN_MARGIN, ABSOLUTE_MIN_MARGIN
  FROM PRIVATE.PRICING_POLICY
  WHERE TIER = 'STANDARD'
),
econ AS (
  SELECT l.LANE_ID,
         l.ORIGIN_CITY || ', ' || l.ORIGIN_STATE AS ORIGIN,
         l.DEST_CITY   || ', ' || l.DEST_STATE   AS DESTINATION,
         l.MILES,
         c.CARRIER_COST_PER_MILE,
         l.MILES * (c.CARRIER_COST_PER_MILE + GREATEST(d.DIESEL_PRICE_USD - 1.20, 0) / 6.0) AS COST_PER_LOAD_RAW,
         p.TARGET_MARGIN,
         GREATEST(p.MIN_MARGIN, p.ABSOLUTE_MIN_MARGIN) AS FLOOR_MARGIN
  FROM PUBLIC.LANES l
  JOIN PRIVATE.COST_BASIS c ON c.LANE_ID = l.LANE_ID
  CROSS JOIN diesel d
  CROSS JOIN pol p
)
SELECT
  LANE_ID,
  ORIGIN,
  DESTINATION,
  MILES,
  CASE WHEN IS_ROLE_IN_SESSION('BROKER_ADMIN')
       THEN CARRIER_COST_PER_MILE END                               AS CARRIER_COST_PER_MILE,
  CASE WHEN IS_ROLE_IN_SESSION('BROKER_ADMIN')
       THEN ROUND(COST_PER_LOAD_RAW, 2) END                         AS COST_PER_LOAD,
  ROUND(COST_PER_LOAD_RAW * (1 + TARGET_MARGIN), 2)                 AS LIST_RATE_STANDARD,   -- public: it's what buyers are quoted
  CASE WHEN IS_ROLE_IN_SESSION('BROKER_ADMIN')
       THEN ROUND(COST_PER_LOAD_RAW * (1 + FLOOR_MARGIN), 2) END    AS FLOOR_STANDARD_NO_LEVERS
FROM econ;

-- ---------------------------------------------------------------------
-- 1b. OPTIONAL — Enterprise Edition only: masking policy instead of / in
--     addition to the CASE expressions. Only use this if you replace the
--     CASE expressions above with the bare columns, otherwise it's redundant.
--     (Masking policy input/output type must match the column type.)
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE MASKING POLICY PRIVATE.ADMIN_ONLY_NUMBER AS (val NUMBER(38,6))
--   RETURNS NUMBER(38,6) ->
--   CASE WHEN IS_ROLE_IN_SESSION('BROKER_ADMIN') THEN val ELSE NULL END;
-- ALTER VIEW PUBLIC.LANE_ECONOMICS_V MODIFY
--   COLUMN CARRIER_COST_PER_MILE    SET MASKING POLICY PRIVATE.ADMIN_ONLY_NUMBER,
--   COLUMN COST_PER_LOAD            SET MASKING POLICY PRIVATE.ADMIN_ONLY_NUMBER,
--   COLUMN FLOOR_STANDARD_NO_LEVERS SET MASKING POLICY PRIVATE.ADMIN_ONLY_NUMBER;
-- (If a type mismatch error appears, cast the view columns to NUMBER(38,6)
--  or create one policy per column type: DESCRIBE VIEW PUBLIC.LANE_ECONOMICS_V.)

-- ---------------------------------------------------------------------
-- 2. STOREFRONT_ROLE grants (contract "complete list", objects existing now)
--    Warehouse USAGE and SNOWFLAKE.CORTEX_AGENT_USER were granted in
--    00_setup.sql by ACCOUNTADMIN (BROKER_ADMIN can't re-grant the warehouse).
--    Proc / agent / MCP grants come in 04/05/06.
-- ---------------------------------------------------------------------
GRANT USAGE  ON DATABASE COUNTEROFFER               TO ROLE STOREFRONT_ROLE;
GRANT USAGE  ON SCHEMA   COUNTEROFFER.PUBLIC        TO ROLE STOREFRONT_ROLE;
GRANT SELECT ON TABLE    PUBLIC.LANES               TO ROLE STOREFRONT_ROLE;
GRANT SELECT ON TABLE    PUBLIC.FUEL_INDEX          TO ROLE STOREFRONT_ROLE;
GRANT SELECT ON VIEW     PUBLIC.LANE_ECONOMICS_V    TO ROLE STOREFRONT_ROLE;

-- Belt and braces: make sure nothing else leaked in (no-ops if never granted).
REVOKE ALL PRIVILEGES ON SCHEMA COUNTEROFFER.PRIVATE          FROM ROLE STOREFRONT_ROLE;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA COUNTEROFFER.PRIVATE FROM ROLE STOREFRONT_ROLE;
REVOKE ALL PRIVILEGES ON TABLE PUBLIC.NEGOTIATIONS            FROM ROLE STOREFRONT_ROLE;
REVOKE ALL PRIVILEGES ON TABLE PUBLIC.NEGOTIATION_LEDGER      FROM ROLE STOREFRONT_ROLE;
REVOKE ALL PRIVILEGES ON TABLE PUBLIC.ORDERS                  FROM ROLE STOREFRONT_ROLE;
REVOKE ALL PRIVILEGES ON TABLE PUBLIC.CUSTOMERS               FROM ROLE STOREFRONT_ROLE;

SHOW GRANTS TO ROLE STOREFRONT_ROLE;
-- Expect: USAGE on COUNTEROFFER_WH, COUNTEROFFER, COUNTEROFFER.PUBLIC;
--         SELECT on LANES, FUEL_INDEX, LANE_ECONOMICS_V; nothing in PRIVATE.
--         (CORTEX_AGENT_USER shows under SHOW GRANTS TO ROLE as a database role grant.)

-- ---------------------------------------------------------------------
-- 3. Verification (run statement by statement; #3.1 is SUPPOSED to fail)
-- ---------------------------------------------------------------------
USE ROLE STOREFRONT_ROLE;
USE SECONDARY ROLES NONE;          -- otherwise BROKER_ADMIN may ride along as a secondary role

-- 3.1 Expect ERROR: "Schema 'COUNTEROFFER.PRIVATE' does not exist or not authorized."
SELECT * FROM COUNTEROFFER.PRIVATE.COST_BASIS;

-- 3.2 Expect 12 rows; CARRIER_COST_PER_MILE, COST_PER_LOAD, FLOOR_STANDARD_NO_LEVERS all NULL;
--     LAX-DAL LIST_RATE_STANDARD = 4725.93
SELECT * FROM COUNTEROFFER.PUBLIC.LANE_ECONOMICS_V ORDER BY LANE_ID;

USE ROLE BROKER_ADMIN;
USE SECONDARY ROLES ALL;           -- restore the usual default

-- 3.3 Expect LAX-DAL: 1435 mi, 2.100, COST_PER_LOAD 3635.33, LIST 4725.93, FLOOR 4071.57
SELECT * FROM COUNTEROFFER.PUBLIC.LANE_ECONOMICS_V ORDER BY LANE_ID;
