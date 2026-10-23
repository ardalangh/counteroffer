-- =====================================================================
-- Counteroffer · Step 6 · MCP server + OAuth for Claude Desktop
--
-- RUN ORDER
--   PART A (smoke test)  -> run EARLY, right after 00_setup + 01_schema.
--                           Does not need the agent or the pricing procs.
--   PART B (production)  -> run AFTER 05_agent.sql (agent must exist).
--
-- UNVERIFIED: written without a Snowflake connection. The MCP spec
-- shapes follow docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp.
-- =====================================================================


-- #####################################################################
-- PART A · SMOKE TEST  (proves OAuth + MCP + Claude Desktop end to end)
-- #####################################################################

-- A1. PING proc (owner's rights), granted to STOREFRONT_ROLE ------------
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;
USE SCHEMA PUBLIC;

CREATE OR REPLACE PROCEDURE COUNTEROFFER.PUBLIC.PING()
  RETURNS VARCHAR
  LANGUAGE SQL
  EXECUTE AS OWNER
AS
$$
BEGIN
  RETURN 'pong from Acme Freight';
END;
$$;

GRANT USAGE ON PROCEDURE COUNTEROFFER.PUBLIC.PING() TO ROLE STOREFRONT_ROLE;
CALL COUNTEROFFER.PUBLIC.PING();   -- expect: pong from Acme Freight

-- A2. Temporary MCP server exposing PING as a GENERIC procedure tool -----
CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.SMOKE_MCP
  FROM SPECIFICATION $$
  tools:
    - title: "Acme Freight ping"
      name: "ping"
      type: "GENERIC"
      identifier: "COUNTEROFFER.PUBLIC.PING"
      description: "Connectivity test. Returns a short greeting from Acme Freight. Takes no arguments."
      config:
        type: "procedure"
        warehouse: "COUNTEROFFER_WH"
        query_timeout: 30
        input_schema:
          type: "object"
          properties: {}
  $$;

GRANT USAGE ON MCP SERVER COUNTEROFFER.PUBLIC.SMOKE_MCP TO ROLE STOREFRONT_ROLE;
SHOW MCP SERVERS IN SCHEMA COUNTEROFFER.PUBLIC;

-- A3. OAuth security integration (ACCOUNTADMIN) --------------------------
USE ROLE ACCOUNTADMIN;

CREATE OR REPLACE SECURITY INTEGRATION STOREFRONT_MCP_OAUTH
  TYPE = OAUTH
  OAUTH_CLIENT = CUSTOM
  ENABLED = TRUE
  OAUTH_CLIENT_TYPE = 'PUBLIC'
  -- Must EXACTLY match the redirect/callback URI Claude shows when you add
  -- the custom connector. claude.ai and Claude Desktop connectors normally use
  -- the value below; the Snowflake docs say Desktop may show a localhost URI.
  -- If Claude shows something else:
  --   ALTER SECURITY INTEGRATION STOREFRONT_MCP_OAUTH SET OAUTH_REDIRECT_URI = '<exact uri>';
  OAUTH_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 86400
  OAUTH_USE_SECONDARY_ROLES = NONE
  ALLOWED_ROLES_LIST = ('STOREFRONT_ROLE')
  COMMENT = 'Claude Desktop -> Counteroffer MCP. Sessions run as STOREFRONT_ROLE only.';

-- Client ID + secret to paste into Claude Desktop (Advanced settings):
SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('STOREFRONT_MCP_OAUTH');
-- Returns JSON: {"OAUTH_CLIENT_ID": "...", "OAUTH_CLIENT_SECRET": "...", "OAUTH_CLIENT_SECRET_2": "..."}
-- Treat as secrets. Don't paste them into the repo or the demo screen.

-- A4. The default-role problem -------------------------------------------
-- The OAuth session's role = the signing-in user's DEFAULT_ROLE, and that
-- role must be in ALLOWED_ROLES_LIST. (ACCOUNTADMIN/SECURITYADMIN are blocked
-- from OAuth by default anyway.) Also: sessions fail if DEFAULT_WAREHOUSE is null.
--
-- OPTION 1 (simplest): the presenter signs in as themselves.
--   Set your own default role to STOREFRONT_ROLE. In Snowsight, switch roles
--   manually (top-left role picker) to BROKER_ADMIN / ACCOUNTADMIN for admin work;
--   a Snowsight worksheet's role is independent of DEFAULT_ROLE.
SET me = CURRENT_USER();
ALTER USER IDENTIFIER($me) SET DEFAULT_ROLE = STOREFRONT_ROLE  DEFAULT_WAREHOUSE = COUNTEROFFER_WH;
-- To undo after the demo:  ALTER USER IDENTIFIER($me) SET DEFAULT_ROLE = ACCOUNTADMIN;
--
-- OPTION 2 (cleaner): a dedicated buyer user. Uncomment to use.
--   Sign in as NORTHWIND_BUYER in the Claude Desktop OAuth window
--   (use a private browser window if you're already logged into Snowsight).
--   NOTE: new Snowflake accounts may enforce MFA for password users (TYPE=PERSON).
--   If so, enroll MFA (Duo/passkey) at first sign-in, which takes about 2 minutes,
--   or use OPTION 1.
-- CREATE USER IF NOT EXISTS NORTHWIND_BUYER
--   TYPE = PERSON
--   PASSWORD = '<choose-a-strong-password>'      -- never commit the real value
--   MUST_CHANGE_PASSWORD = FALSE
--   DEFAULT_ROLE = STOREFRONT_ROLE
--   DEFAULT_WAREHOUSE = COUNTEROFFER_WH
--   COMMENT = 'Demo buyer identity for Claude Desktop (Northwind Goods procurement)';
-- GRANT ROLE STOREFRONT_ROLE TO USER NORTHWIND_BUYER;

-- A5. The MCP URL ----------------------------------------------------------
-- Format: https://<account_url>/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/<NAME>
-- <account_url> = <org>-<account>.snowflakecomputing.com, lowercase, with
-- HYPHENS not underscores (my_org-my_acct -> my-org-my-acct). Copy it from
-- Snowsight: bottom-left account menu > "Connect a tool to Snowflake" / account URL.
-- Or compute it:
SELECT 'https://'
       || LOWER(REPLACE(CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME(), '_', '-'))
       || '.snowflakecomputing.com/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/'
       || name AS mcp_url
FROM (SELECT 'SMOKE_MCP' AS name UNION ALL SELECT 'STOREFRONT_MCP');

-- SMOKE TEST GATE: in Claude Desktop add a custom connector with the SMOKE_MCP
-- URL plus the client ID/secret, sign in, then ask "Call the Acme Freight ping tool."
-- Expect "pong from Acme Freight". Then edit the connector URL to STOREFRONT_MCP
-- after PART B.


-- #####################################################################
-- PART B · PRODUCTION  (run after 05_agent.sql)
-- #####################################################################
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;
USE SCHEMA PUBLIC;

-- One tool only: the seller agent. Deliberately NO SYSTEM_EXECUTE_SQL tool:
-- that would let a client run SQL directly and bypass the agent's rules.
CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP
  FROM SPECIFICATION $$
  tools:
    - title: "Acme Freight sales desk"
      name: "acme_freight_sales"
      type: "CORTEX_AGENT_RUN"
      identifier: "COUNTEROFFER.PUBLIC.ACME_SELLER"
      description: "Acme Freight Co.'s sales desk. Request truckload freight quotes and negotiate contract rates and terms (rate per load, contract length, loads per week, payment terms, pickup window), then book the order. Send one natural-language message per call. Each call may have no memory of earlier calls, so after the first reply ALWAYS include the negotiation_id (e.g. N-1001) and the current terms in your message."
  $$;

GRANT USAGE ON MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP TO ROLE STOREFRONT_ROLE;
-- The agent and its procs need their own grants (05_agent.sql / 04_procs.sql):
GRANT USAGE ON AGENT COUNTEROFFER.PUBLIC.ACME_SELLER TO ROLE STOREFRONT_ROLE;

-- Retire the smoke-test server.
DROP MCP SERVER IF EXISTS COUNTEROFFER.PUBLIC.SMOKE_MCP;

SHOW MCP SERVERS IN SCHEMA COUNTEROFFER.PUBLIC;
DESCRIBE MCP SERVER COUNTEROFFER.PUBLIC.STOREFRONT_MCP;

-- Final URL for Claude Desktop:
--   https://<org>-<account>.snowflakecomputing.com/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/STOREFRONT_MCP
