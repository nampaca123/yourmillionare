-- Migration 0028: add GIN index on bedrock_kb_legal.custom_metadata required by Bedrock KB storage configuration validation.

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_custom_metadata_gin_idx
  ON bedrock_integration.bedrock_kb_legal
  USING gin (custom_metadata);
