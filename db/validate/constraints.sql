\set ON_ERROR_STOP off
-- minimal fixture
INSERT INTO tenants (id, slug, legal_name, brand_name, ticket_prefix)
  VALUES ('11111111-1111-1111-1111-111111111111','sinclair','Sinclair Motors Inc.','Sinclair','SIN');
INSERT INTO tenants (id, slug, legal_name, brand_name, ticket_prefix)
  VALUES ('22222222-2222-2222-2222-222222222222','other','Other Motors','Other','OTH');
INSERT INTO customers (id, tenant_id, full_name, email)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Alex Morgan','alex@example.test'),
         ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Jordan Lee','jordan@example.test');
INSERT INTO resources (id, tenant_id, kind, name)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','bay','Demo Bay 1');

INSERT INTO appointments (id,tenant_id,type,customer_id,starts_at,ends_at,confirmation_code,created_by_type)
 VALUES ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','test_drive',
         'aaaaaaaa-0000-0000-0000-000000000001','2026-09-19 11:30:00-04','2026-09-19 12:15:00-04','ALEX01','ai'),
        ('cccccccc-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','test_drive',
         'aaaaaaaa-0000-0000-0000-000000000002','2026-09-19 11:45:00-04','2026-09-19 12:30:00-04','JORD01','ai');

\echo '### T1: first booking of the 11:30 slot'
INSERT INTO appointment_resources (tenant_id,appointment_id,resource_id,starts_at,ends_at)
 VALUES ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001',
         'bbbbbbbb-0000-0000-0000-000000000001','2026-09-19 11:30:00-04','2026-09-19 12:15:00-04');

\echo '### T2: second customer overlapping the same resource -- MUST FAIL'
INSERT INTO appointment_resources (tenant_id,appointment_id,resource_id,starts_at,ends_at)
 VALUES ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000002',
         'bbbbbbbb-0000-0000-0000-000000000001','2026-09-19 11:45:00-04','2026-09-19 12:30:00-04');

\echo '### T3: back-to-back booking at 12:15 -- MUST SUCCEED (half-open range)'
INSERT INTO appointments (id,tenant_id,type,customer_id,starts_at,ends_at,confirmation_code,created_by_type)
 VALUES ('cccccccc-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','test_drive',
         'aaaaaaaa-0000-0000-0000-000000000002','2026-09-19 12:15:00-04','2026-09-19 13:00:00-04','JORD02','ai');
INSERT INTO appointment_resources (tenant_id,appointment_id,resource_id,starts_at,ends_at)
 VALUES ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
         'bbbbbbbb-0000-0000-0000-000000000001','2026-09-19 12:15:00-04','2026-09-19 13:00:00-04');

\echo '### T4: cross-tenant child pointing at another tenant customer -- MUST FAIL'
INSERT INTO appointments (tenant_id,type,customer_id,starts_at,ends_at,confirmation_code,created_by_type)
 VALUES ('22222222-2222-2222-2222-222222222222','test_drive',
         'aaaaaaaa-0000-0000-0000-000000000001','2026-09-20 10:00:00-04','2026-09-20 10:45:00-04','X1','ai');

\echo '### T5: ends_at before starts_at -- MUST FAIL'
INSERT INTO appointments (tenant_id,type,customer_id,starts_at,ends_at,confirmation_code,created_by_type)
 VALUES ('11111111-1111-1111-1111-111111111111','test_drive',
         'aaaaaaaa-0000-0000-0000-000000000001','2026-09-20 11:00:00-04','2026-09-20 10:00:00-04','X2','ai');

\echo '### T6: reserved unit without reserved_until -- MUST FAIL'
INSERT INTO vehicle_models (id,tenant_id,slug,name,full_name,model_year,body_style,segment,base_msrp_cents)
 VALUES ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','s5','S5','Sinclair S5',2026,'suv','Premium Mid-Size SUV',5290000);
INSERT INTO powertrains (id,tenant_id,model_id,code,name,kind,drivetrain)
 VALUES ('eeeeeeee-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','2.0T-AWD','2.0 Turbo AWD','ice','awd');
INSERT INTO trims (id,tenant_id,model_id,code,name,tier_order)
 VALUES ('ffffffff-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','PREMIUM','Premium',2);
INSERT INTO model_configurations (id,tenant_id,model_id,powertrain_id,trim_id,price_cents)
 VALUES ('99999999-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001','ffffffff-0000-0000-0000-000000000001',5890000);
INSERT INTO inventory_units (tenant_id,model_configuration_id,stock_number,status,asking_price_cents)
 VALUES ('11111111-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','SIN-0001','reserved',5890000);

\echo '### T7: BEV without battery_kwh -- MUST FAIL'
INSERT INTO powertrains (tenant_id,model_id,code,name,kind,drivetrain)
 VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','E-AWD','Dual Motor AWD','bev','awd');

\echo '### T8: public inventory view hides non-available units'
INSERT INTO inventory_units (tenant_id,model_configuration_id,stock_number,status,asking_price_cents)
 VALUES ('11111111-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','SIN-0002','available',5890000),
        ('11111111-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','SIN-0003','sold',5890000);
SELECT stock_number FROM v_public_inventory ORDER BY stock_number;

\echo '### T9: active resource bookings on the demo bay'
SELECT a.confirmation_code, ar.starts_at FROM appointment_resources ar
  JOIN appointments a ON a.id = ar.appointment_id ORDER BY ar.starts_at;
