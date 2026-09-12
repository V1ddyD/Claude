-- =============================================================================
-- 0003 — Correct the powertrain battery constraint.
--
-- 0001 asserted `(kind = 'bev') = (battery_kwh IS NOT NULL)`, which is wrong:
-- a plug-in hybrid has a battery and an engine. The original constraint made
-- the S7 3.0 Plug-in Hybrid unrepresentable, which the catalogue seed caught.
--
-- Correct rule:
--   bev, phev  -> must declare a battery
--   ice        -> must not
--   hybrid     -> optional; a conventional hybrid's traction battery is not a
--                 figure customers shop on, so it is not required.
-- =============================================================================

ALTER TABLE powertrains DROP CONSTRAINT IF EXISTS powertrains_check;

ALTER TABLE powertrains ADD CONSTRAINT powertrains_battery_check CHECK (
  CASE kind
    WHEN 'bev'  THEN battery_kwh IS NOT NULL
    WHEN 'phev' THEN battery_kwh IS NOT NULL
    WHEN 'ice'  THEN battery_kwh IS NULL
    ELSE true
  END
);

-- An electric car's usable range is the number customers compare, so a BEV
-- without one is incomplete data rather than a valid row.
ALTER TABLE powertrains ADD CONSTRAINT powertrains_bev_range_check CHECK (
  kind <> 'bev' OR range_km IS NOT NULL
);
