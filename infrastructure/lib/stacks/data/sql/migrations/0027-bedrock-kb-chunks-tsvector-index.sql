-- Migration 0027: add to_tsvector('simple') GIN index on bedrock_kb_legal.chunks required by Bedrock KB storage configuration validation; pg_bigm GIN index remains the primary Korean keyword path.

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_chunks_tsvector_idx
  ON bedrock_integration.bedrock_kb_legal
  USING gin (to_tsvector('simple', chunks));
