-- =============================================================================
-- 0008 — The demonstration dealership moves to Brunei.
--
-- Sinclair is the demonstration shown to dealerships in Brunei, and it was set
-- in Toronto: a +1 phone number, a Lakeshore Boulevard address, Canadian
-- dollars, and test drives offered in Eastern time. A showroom owner in
-- Gadong reading "10:00 a.m. EDT" is not looking at a product for them.
--
-- Data only, and only for the demonstration tenant. It changes nothing for
-- any other dealership, and only rows still carrying the Toronto values: a
-- deployment where someone has since edited these by hand is left alone.
-- A fresh database never has the tenant when this runs; the seed writes the
-- Brunei values itself.
-- =============================================================================

-- The tenant context the row-level policies read, so the updates below see
-- the demonstration tenant's rows and no one else's.
SELECT set_config('app.tenant_id', '5171c1a1-0000-4000-8000-000000000001', true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenants
     WHERE id = '5171c1a1-0000-4000-8000-000000000001'
       AND timezone = 'America/Toronto'
  ) THEN
    RETURN;
  END IF;

  UPDATE tenants
     SET timezone = 'Asia/Brunei',
         currency = 'BND',
         locale = 'en-GB',
         legal_name = 'Sinclair Motors (B) Sdn Bhd'
   WHERE id = '5171c1a1-0000-4000-8000-000000000001';

  UPDATE tenant_settings
     SET contact = contact || jsonb_build_object(
           'phone', '+673 222 0142',
           'addressLine1', 'Lot 12, Jalan Gadong',
           'city', 'Bandar Seri Begawan',
           'region', 'Brunei-Muara',
           'postalCode', 'BE3519',
           'country', 'BN'
         ),
         finance = finance || jsonb_build_object(
           'disclaimer',
           'Estimate only. Excludes insurance, road tax and registration. '
             || 'Not an offer of financing or a guarantee of approval.'
         )
   WHERE tenant_id = '5171c1a1-0000-4000-8000-000000000001';

  -- A Brunei showroom's week: open at the weekend, Friday only after prayers.
  DELETE FROM business_hours WHERE tenant_id = '5171c1a1-0000-4000-8000-000000000001';
  INSERT INTO business_hours (tenant_id, department, day_of_week, opens_at, closes_at)
  SELECT '5171c1a1-0000-4000-8000-000000000001', d.dept, d.dow::smallint, d.opens::time, d.closes::time
  FROM (VALUES
    ('sales', 0, '10:00', '16:00'),
    ('sales', 1, '09:00', '18:00'), ('sales', 2, '09:00', '18:00'), ('sales', 3, '09:00', '18:00'),
    ('sales', 4, '09:00', '18:00'), ('sales', 5, '14:00', '18:00'), ('sales', 6, '09:00', '18:00'),
    ('service', 1, '08:00', '17:00'), ('service', 2, '08:00', '17:00'), ('service', 3, '08:00', '17:00'),
    ('service', 4, '08:00', '17:00'), ('service', 6, '08:00', '17:00')
  ) AS d(dept, dow, opens, closes);
END
$$;
