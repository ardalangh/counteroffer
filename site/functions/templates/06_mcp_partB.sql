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
