-- =====================================================================
-- Counteroffer · Step 3a · Schema
-- This file IS the shared contract. Don't rename anything without
-- updating docs/CONTRACT.md. Run after 00_setup.sql.
-- =====================================================================
USE ROLE BROKER_ADMIN;
USE WAREHOUSE COUNTEROFFER_WH;
USE DATABASE COUNTEROFFER;

-- ---------------------------------------------------------------------
-- PUBLIC schema
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE PUBLIC.LANES (
  LANE_ID       STRING      NOT NULL PRIMARY KEY,  -- 'LAX-DAL'
  ORIGIN_CITY   STRING      NOT NULL,              -- 'Los Angeles'
  ORIGIN_STATE  STRING      NOT NULL,              -- 'CA'
  DEST_CITY     STRING      NOT NULL,
  DEST_STATE    STRING      NOT NULL,
  MILES         NUMBER(6,0) NOT NULL,
  EQUIPMENT     STRING      NOT NULL               -- DRY_VAN | REEFER | FLATBED
);

CREATE OR REPLACE TABLE PUBLIC.CUSTOMERS (
  CUSTOMER_ID     STRING NOT NULL PRIMARY KEY,     -- 'C-001'
  NAME            STRING NOT NULL,
  TIER            STRING NOT NULL,                 -- STANDARD | PREFERRED | STRATEGIC
  LIFETIME_LOADS  NUMBER(10,0) DEFAULT 0,
  AVG_DAYS_TO_PAY NUMBER(5,1),
  CREATED_AT      TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE PUBLIC.FUEL_INDEX (
  EFFECTIVE_TS     TIMESTAMP_NTZ NOT NULL,
  DIESEL_PRICE_USD NUMBER(6,3)   NOT NULL,
  SOURCE           STRING                          -- WEEKLY_INDEX | MANUAL
);
-- Current diesel price = the row with the latest EFFECTIVE_TS.

CREATE OR REPLACE SEQUENCE PUBLIC.NEGOTIATION_SEQ START = 1001;   -- → 'N-1001'
CREATE OR REPLACE SEQUENCE PUBLIC.ORDER_SEQ       START = 5001;   -- → 'O-5001'

CREATE OR REPLACE TABLE PUBLIC.NEGOTIATIONS (
  NEGOTIATION_ID     STRING NOT NULL PRIMARY KEY,  -- 'N-1001'
  CUSTOMER_ID        STRING NOT NULL,
  LANE_ID            STRING NOT NULL,
  LOADS_PER_WEEK     NUMBER(6,0),
  TERM_MONTHS        NUMBER(4,0),
  STATUS             STRING NOT NULL,              -- OPEN | ACCEPTED | FINAL | CLOSED_WON | CLOSED_LOST
  ROUNDS_USED        NUMBER(4,0) DEFAULT 0,
  LIST_RATE_AT_START NUMBER(10,2),
  CREATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE PUBLIC.NEGOTIATION_LEDGER (
  EVENT_ID          NUMBER AUTOINCREMENT START 1 INCREMENT 1,
  TS                TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  NEGOTIATION_ID    STRING,           -- NULL allowed for SYSTEM events (fuel updates)
  ACTOR             STRING NOT NULL,  -- BUYER | SELLER_AGENT | SYSTEM | HUMAN
  ACTION            STRING NOT NULL,  -- START | MESSAGE | QUOTE | OFFER | COMMIT | APPROVE | FUEL_UPDATE | ALERT
  RATE_PER_LOAD     NUMBER(10,2),
  TERM_MONTHS       NUMBER(4,0),
  LOADS_PER_WEEK    NUMBER(6,0),
  PAYMENT_TERMS     STRING,           -- NET15 | NET30 | NET60
  PICKUP_WINDOW_HRS NUMBER(4,0),
  DECISION          STRING,           -- ACCEPT | COUNTER | REJECT | FINAL
  COUNTER_RATE      NUMBER(10,2),
  HINT              STRING,
  FLAGS             STRING,           -- comma-separated: INJECTION_SUSPECTED, PROBING_SUSPECTED
  NOTE              STRING
);

CREATE OR REPLACE TABLE PUBLIC.ORDERS (
  ORDER_ID             STRING NOT NULL PRIMARY KEY,   -- 'O-5001'
  NEGOTIATION_ID       STRING NOT NULL,
  CUSTOMER_ID          STRING NOT NULL,
  LANE_ID              STRING NOT NULL,
  RATE_PER_LOAD        NUMBER(10,2) NOT NULL,
  TERM_MONTHS          NUMBER(4,0)  NOT NULL,
  LOADS_PER_WEEK       NUMBER(6,0)  NOT NULL,
  PAYMENT_TERMS        STRING       NOT NULL,
  PICKUP_WINDOW_HRS    NUMBER(4,0)  NOT NULL,
  TOTAL_CONTRACT_VALUE NUMBER(14,2) NOT NULL,         -- rate × loads/week × 52/12 × term_months
  STATUS               STRING NOT NULL,               -- CONFIRMED | PENDING_APPROVAL | REJECTED
  CREATED_AT           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  DECIDED_BY           STRING,
  DECIDED_AT           TIMESTAMP_NTZ
);

-- ---------------------------------------------------------------------
-- PRIVATE schema — owner (BROKER_ADMIN) only. STOREFRONT_ROLE: nothing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE PRIVATE.COST_BASIS (
  LANE_ID               STRING      NOT NULL PRIMARY KEY,
  CARRIER_COST_PER_MILE NUMBER(6,3) NOT NULL,
  UPDATED_AT            TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE PRIVATE.PRICING_POLICY (
  TIER                   STRING       NOT NULL PRIMARY KEY,
  TARGET_MARGIN          NUMBER(5,4)  NOT NULL,  -- list price = cost × (1 + target)
  MIN_MARGIN             NUMBER(5,4)  NOT NULL,  -- floor margin before levers
  ABSOLUTE_MIN_MARGIN    NUMBER(5,4)  NOT NULL,  -- floor never goes below this
  COUNTER_BUFFER         NUMBER(5,4)  NOT NULL,  -- counters stay >= floor × (1 + buffer)
  MAX_ROUNDS             NUMBER(4,0)  NOT NULL,
  APPROVAL_THRESHOLD_USD NUMBER(14,2) NOT NULL   -- contract value above this → PENDING_APPROVAL
);

CREATE OR REPLACE TABLE PRIVATE.CONCESSION_LEVERS (
  LEVER         STRING      NOT NULL PRIMARY KEY,  -- TERM_12M | VOLUME_30 | PICKUP_48H | NET15 | NET60
  MARGIN_CREDIT NUMBER(5,4) NOT NULL,              -- subtracted from MIN_MARGIN; negative = costs the seller
  HINT_TEXT     STRING      NOT NULL               -- what the agent may say. Never contains numbers.
);
