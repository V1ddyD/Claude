-- Let the connecting role assume the request role.
--
-- DATABASE_REQUEST_ROLE makes every request transaction `SET LOCAL ROLE` to
-- app_user, which is how a platform that hands you a single table-owning
-- credential still runs the request path unprivileged: RLS evaluates against
-- app_user and the table grants apply to it, exactly as they would with two
-- separate connection strings.
--
-- SET ROLE requires membership, and a role is not necessarily a member of one
-- it created. Where two connection strings are configured this is already
-- true and the whole thing is skipped.
--
-- The grant runs one way only. The migrating role gains the ability to become
-- app_user; app_user gains nothing, and PUBLIC is not involved.
DO $$
BEGIN
  IF pg_has_role(current_user, 'app_user', 'MEMBER') THEN
    RAISE NOTICE 'app_user membership already held by %', current_user;
  ELSE
    EXECUTE format('GRANT app_user TO %I', current_user);
    RAISE NOTICE 'granted app_user to %', current_user;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    -- Diagnosable rather than fatal: the schema is correct without this, and
    -- a deployment that cannot hold the membership simply must not set
    -- DATABASE_REQUEST_ROLE. Failing the migration would leave no database
    -- at all, which is worse than leaving one that needs a setting changed.
    RAISE WARNING
      'could not grant app_user to % — leave DATABASE_REQUEST_ROLE unset on this host',
      current_user;
END $$;
