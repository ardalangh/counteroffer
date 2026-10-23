-- =====================================================================
-- Golden Valley Reefer · 13_mcp.sql · MCP server
--   COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_MCP
-- Run after 12_agent.sql.
-- One tool only: the seller agent. Deliberately NO SQL execution tool,
-- which would let a client bypass the agent's rules.
-- =====================================================================
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;
USE SCHEMA PUBLIC;

CREATE OR REPLACE MCP SERVER COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_MCP
  FROM SPECIFICATION $$
  tools:
    - title: "Golden Valley Reefer sales desk"
      name: "golden_valley_reefer_sales"
      type: "CORTEX_AGENT_RUN"
      identifier: "COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_SELLER"
      description: "Golden Valley Reefer's sales desk. Request refrigerated (reefer) truckload quotes for fresh produce from Salinas or Fresno, CA to Chicago, Atlanta, Dallas or New York, negotiate contract rates and terms (rate per load, contract length, loads per week, payment terms, pickup window), then book the order. Send one natural-language message per call. Each call may have no memory of earlier calls, so after the first reply ALWAYS include the negotiation_id (e.g. N-1001) and the current terms in your message."
  $$;

GRANT USAGE ON MCP SERVER COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_MCP TO ROLE STOREFRONT_ROLE;
GRANT USAGE ON AGENT COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_SELLER TO ROLE STOREFRONT_ROLE;

-- Checks (run manually):
--   SHOW MCP SERVERS IN SCHEMA COUNTEROFFER.PUBLIC;
--   DESCRIBE MCP SERVER COUNTEROFFER.PUBLIC.GOLDEN_VALLEY_REEFER_MCP;

-- MCP URL for Claude Desktop / buyer agents:
--   https://<org>-<account>.snowflakecomputing.com/api/v2/databases/COUNTEROFFER/schemas/PUBLIC/mcp-servers/GOLDEN_VALLEY_REEFER_MCP
