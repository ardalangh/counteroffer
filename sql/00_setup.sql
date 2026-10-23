-- =====================================================================
-- Counteroffer · Step 1 · Account setup
-- Run in a Snowsight SQL worksheet, top to bottom.
-- Safe to re-run: everything is IF NOT EXISTS or idempotent.
-- =====================================================================

USE ROLE ACCOUNTADMIN;

-- 1.1  Where am I?  → send this row back
SELECT CURRENT_ORGANIZATION_NAME() AS org,
       CURRENT_ACCOUNT_NAME()      AS account,
       CURRENT_REGION()            AS region,
       CURRENT_USER()              AS me;

-- 1.2  Every Claude model on Cortex is cross-region only. Turn it on.
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';
SHOW PARAMETERS LIKE 'CORTEX_ENABLED_CROSS_REGION' IN ACCOUNT;

-- 1.3  Compute: smallest warehouse, suspends after 60s idle
CREATE WAREHOUSE IF NOT EXISTS COUNTEROFFER_WH
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- 1.4  Two roles
--   BROKER_ADMIN    = Acme Freight's pricing team. Owns data, procedures, agent.
--   STOREFRONT_ROLE = the role the buyer-facing MCP session runs as.
--                     It will NEVER get access to the PRIVATE schema.
CREATE ROLE IF NOT EXISTS BROKER_ADMIN    COMMENT = 'Owns all Counteroffer objects and the pricing procedures';
CREATE ROLE IF NOT EXISTS STOREFRONT_ROLE COMMENT = 'Buyer-facing MCP session role. No access to PRIVATE.';
GRANT ROLE BROKER_ADMIN    TO ROLE SYSADMIN;
GRANT ROLE STOREFRONT_ROLE TO ROLE SYSADMIN;

SET me = CURRENT_USER();
GRANT ROLE BROKER_ADMIN    TO USER IDENTIFIER($me);
GRANT ROLE STOREFRONT_ROLE TO USER IDENTIFIER($me);

-- 1.5  Account-level privileges
GRANT CREATE DATABASE ON ACCOUNT                  TO ROLE BROKER_ADMIN;
GRANT USAGE, OPERATE ON WAREHOUSE COUNTEROFFER_WH TO ROLE BROKER_ADMIN;
GRANT USAGE ON WAREHOUSE COUNTEROFFER_WH          TO ROLE STOREFRONT_ROLE;

GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER       TO ROLE BROKER_ADMIN;     -- AI_COMPLETE etc.
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_AGENT_USER TO ROLE BROKER_ADMIN;     -- build/run agents
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_AGENT_USER TO ROLE STOREFRONT_ROLE;  -- run the seller agent via MCP

-- MCP sessions fail without a default warehouse
ALTER USER IDENTIFIER($me) SET DEFAULT_WAREHOUSE = COUNTEROFFER_WH;

-- 1.6  Database + schemas, owned by BROKER_ADMIN
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;

CREATE DATABASE IF NOT EXISTS COUNTEROFFER;   -- PUBLIC schema is created automatically
CREATE SCHEMA   IF NOT EXISTS COUNTEROFFER.PRIVATE
  COMMENT = 'Cost basis and pricing policy. Owner only. STOREFRONT_ROLE gets nothing here.';

GRANT USAGE ON DATABASE COUNTEROFFER        TO ROLE STOREFRONT_ROLE;
GRANT USAGE ON SCHEMA   COUNTEROFFER.PUBLIC TO ROLE STOREFRONT_ROLE;
-- Deliberately NO grant on COUNTEROFFER.PRIVATE.

-- 1.7  Claude smoke test. If this model errors, uncomment the next one.
SELECT AI_COMPLETE('claude-sonnet-5', 'Reply with exactly one word: pong') AS claude_says;
-- SELECT AI_COMPLETE('claude-sonnet-4-5', 'Reply with exactly one word: pong') AS claude_says;

-- 1.8  Governance sanity check: STOREFRONT_ROLE must not see PRIVATE
USE ROLE STOREFRONT_ROLE;
SHOW SCHEMAS IN DATABASE COUNTEROFFER;   -- expect INFORMATION_SCHEMA and PUBLIC only. NOT PRIVATE.
USE ROLE BROKER_ADMIN;
