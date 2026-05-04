-- Bootstrap: create app_user role, grant rds_iam, set default privileges.
-- Runs before schema.sql on every deploy; all statements are idempotent.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64)  PRIMARY KEY,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sha256_hex  CHAR(64)     NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN;
  END IF;
END $$;

GRANT rds_iam TO app_user;
GRANT CONNECT ON DATABASE yourmillionare TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
