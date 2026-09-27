-- =============================================================================
-- 0010 — Signing in with Google, Facebook or Apple.
--
-- A provider vouches for an email address; the portal then has to find which
-- business, if any, has that person on its team. That lookup happens before a
-- business is known, like password sign-in, and is scoped the same way: this
-- policy lets the transaction see the staff rows for the one email being
-- signed in with, and nobody else's.
-- =============================================================================

DROP POLICY IF EXISTS staff_sign_in ON staff_users;
CREATE POLICY staff_sign_in ON staff_users
  FOR SELECT USING (email = app.login_email());
