-- Migration 0001: Onboarding RLS policies for Slice 3 identity and tenant management.
-- Replaces single FOR ALL policies with operation-specific policies that work during user onboarding.

-- ============================================================
--  1. users — fix chicken-and-egg on first login
-- ============================================================
-- The original user_self_only policy uses id = app.current_user_id, which means
-- a brand-new user cannot SELECT their own row (they don't know their id yet),
-- causing an infinite INSERT-conflict loop.

DROP POLICY IF EXISTS user_self_only ON users;

-- SELECT: find existing user by cognito_sub before we know their DB id.
CREATE POLICY users_select_by_sub ON users
  FOR SELECT TO app_user
  USING (cognito_sub = current_setting('app.cognito_sub', true));

-- UPDATE/DELETE: only touch own row once user_id is resolved.
CREATE POLICY users_modify_self ON users
  FOR ALL TO app_user
  USING      (id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_user_id', true)::uuid);

-- INSERT: cognito_sub from JWT must match what is being written.
CREATE POLICY users_insert_by_sub ON users
  FOR INSERT TO app_user
  WITH CHECK (cognito_sub = current_setting('app.cognito_sub', true));

-- ============================================================
--  2. tenants — membership-based SELECT + authenticated INSERT
-- ============================================================
-- The original tenant_isolation policy uses id = app.current_tenant_id (single key).
-- This means GET /me/tenants returns at most 1 row and POST /tenants has no tenant_id yet.

DROP POLICY IF EXISTS tenant_isolation ON tenants;

-- SELECT: a user sees all tenants they belong to, regardless of current_tenant_id.
CREATE POLICY tenants_select_by_membership ON tenants
  FOR SELECT TO app_user
  USING (EXISTS (
    SELECT 1 FROM tenant_members tm
    WHERE tm.tenant_id = tenants.id
      AND tm.user_id   = current_setting('app.current_user_id', true)::uuid
  ));

-- UPDATE: only the currently active tenant can be modified.
CREATE POLICY tenants_modify_current ON tenants
  FOR UPDATE TO app_user
  USING      (id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant_id', true)::uuid);

-- INSERT: any authenticated user (user_id resolved) may create a tenant.
CREATE POLICY tenants_insert_authenticated ON tenants
  FOR INSERT TO app_user
  WITH CHECK (current_setting('app.current_user_id', true) <> '');

-- ============================================================
--  3. tenant_members — co-representative visibility
-- ============================================================
-- The original tenant_isolation policy only exposes rows where tenant_id = current_tenant_id.
-- PLAN.md §1.1 requires that an owner sees all co-representatives in the same tenant.

DROP POLICY IF EXISTS tenant_isolation ON tenant_members;

-- SELECT: own rows (any tenant) OR all members of the currently active tenant.
CREATE POLICY tenant_members_visible ON tenant_members
  FOR SELECT TO app_user
  USING (
    user_id   = current_setting('app.current_user_id', true)::uuid
    OR tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- INSERT: can only add yourself (ownership is established by use-case logic).
CREATE POLICY tenant_members_self_insert ON tenant_members
  FOR INSERT TO app_user
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- UPDATE: admin-level operation scoped to current tenant.
CREATE POLICY tenant_members_admin_modify ON tenant_members
  FOR UPDATE TO app_user
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- DELETE: admin-level operation scoped to current tenant.
CREATE POLICY tenant_members_admin_delete ON tenant_members
  FOR DELETE TO app_user
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
