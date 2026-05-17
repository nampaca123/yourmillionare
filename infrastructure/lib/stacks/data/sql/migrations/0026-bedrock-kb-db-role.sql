-- Migration 0026: Bedrock KB DB role with scoped privileges on bedrock_integration schema only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_kb_user') THEN
    CREATE ROLE bedrock_kb_user LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE yourmillionare TO bedrock_kb_user;
GRANT USAGE ON SCHEMA bedrock_integration TO bedrock_kb_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock_integration.bedrock_kb_legal TO bedrock_kb_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA bedrock_integration
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedrock_kb_user;
