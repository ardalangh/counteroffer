-- =====================================================================
-- Counteroffer · Lumen Ledger · 10_policy.sql
-- Pricing policy (per tier) and concession levers.
--
-- !! NOT YET RUNNABLE END-TO-END !!
-- Lumen Ledger is a B2B SaaS seller (per seat per month). The current
-- pricing engine is freight-shaped (lanes, miles, diesel, loads/week) and
-- uses markup pricing. This file is valid policy DATA, but the procs will
-- not price SaaS seats correctly until the engine extension in README.md
-- is built. Margins are intended as GROSS margins (price = cost/(1-m)).
--
-- CAVEAT: PRICING_POLICY and CONCESSION_LEVERS are shared, single-tenant
-- tables. Running this replaces the current seller's policy in this account.
-- Levers needing engine extension (SEATS_200, CASE_STUDY, ANNUAL_UPFRONT)
-- are intentionally NOT inserted here; see spec.json.
-- =====================================================================
USE DATABASE COUNTEROFFER;

MERGE INTO COUNTEROFFER.PRIVATE.PRICING_POLICY t
USING (
  SELECT 'STANDARD'  AS TIER, 0.80 AS TARGET_MARGIN, 0.65 AS MIN_MARGIN, 0.55 AS ABSOLUTE_MIN_MARGIN, 0.04 AS COUNTER_BUFFER, 8  AS MAX_ROUNDS, 500000 AS APPROVAL_THRESHOLD_USD
  UNION ALL SELECT 'PREFERRED', 0.78, 0.62, 0.52, 0.04, 8,  500000
  UNION ALL SELECT 'STRATEGIC', 0.72, 0.55, 0.45, 0.03, 10, 500000
) s
ON t.TIER = s.TIER
WHEN MATCHED THEN UPDATE SET
  TARGET_MARGIN = s.TARGET_MARGIN,
  MIN_MARGIN = s.MIN_MARGIN,
  ABSOLUTE_MIN_MARGIN = s.ABSOLUTE_MIN_MARGIN,
  COUNTER_BUFFER = s.COUNTER_BUFFER,
  MAX_ROUNDS = s.MAX_ROUNDS,
  APPROVAL_THRESHOLD_USD = s.APPROVAL_THRESHOLD_USD
WHEN NOT MATCHED THEN INSERT
  (TIER, TARGET_MARGIN, MIN_MARGIN, ABSOLUTE_MIN_MARGIN, COUNTER_BUFFER, MAX_ROUNDS, APPROVAL_THRESHOLD_USD)
  VALUES (s.TIER, s.TARGET_MARGIN, s.MIN_MARGIN, s.ABSOLUTE_MIN_MARGIN, s.COUNTER_BUFFER, s.MAX_ROUNDS, s.APPROVAL_THRESHOLD_USD);

-- TERM_12M  : 12+ month commitment            (+4 pts)
-- NET15     : proxy for annual upfront payment (+3 pts)
-- NET60     : slower payment costs the seller  (-2 pts)
-- VOLUME_30 : not used (condition is loads/week, not seats) -> 0
-- PICKUP_48H: not applicable to SaaS -> 0
MERGE INTO COUNTEROFFER.PRIVATE.CONCESSION_LEVERS t
USING (
  SELECT 'TERM_12M' AS LEVER, 0.04 AS MARGIN_CREDIT, 'A year-long or longer commitment improves pricing.' AS HINT_TEXT
  UNION ALL SELECT 'NET15',      0.03,  'Paying faster, such as annually upfront, improves pricing.'
  UNION ALL SELECT 'NET60',     -0.02,  'Slower payment terms increase the price.'
  UNION ALL SELECT 'VOLUME_30',  0.00,  'Committing to more seats improves pricing.'
  UNION ALL SELECT 'PICKUP_48H', 0.00,  'Scheduling flexibility does not change pricing.'
) s
ON t.LEVER = s.LEVER
WHEN MATCHED THEN UPDATE SET MARGIN_CREDIT = s.MARGIN_CREDIT, HINT_TEXT = s.HINT_TEXT
WHEN NOT MATCHED THEN INSERT (LEVER, MARGIN_CREDIT, HINT_TEXT) VALUES (s.LEVER, s.MARGIN_CREDIT, s.HINT_TEXT);
