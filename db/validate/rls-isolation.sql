\echo '### Sinclair context sees its own customers'
BEGIN; SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT full_name FROM customers ORDER BY full_name; COMMIT;

\echo '### Other tenant context sees ZERO Sinclair customers'
BEGIN; SET LOCAL app.tenant_id = '22222222-2222-2222-2222-222222222222';
SELECT count(*) AS visible_rows FROM customers; COMMIT;

\echo '### No tenant context set at all -- zero rows, not everything'
SELECT count(*) AS visible_rows FROM customers;

\echo '### Cannot write a row into another tenant (WITH CHECK) -- MUST FAIL'
BEGIN; SET LOCAL app.tenant_id = '22222222-2222-2222-2222-222222222222';
INSERT INTO customers (tenant_id, full_name) VALUES ('11111111-1111-1111-1111-111111111111','Injected');
COMMIT;

\echo '### audit_logs is append-only for the app role -- MUST FAIL'
BEGIN; SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO audit_logs (tenant_id,actor_type,action,entity_type) VALUES ('11111111-1111-1111-1111-111111111111','ai','lead.created','lead');
DELETE FROM audit_logs; COMMIT;
