-- Migration 0025: create bedrock_integration schema and bedrock_kb_legal vector table for Bedrock KB RDS storage.

CREATE SCHEMA IF NOT EXISTS bedrock_integration;

CREATE TABLE IF NOT EXISTS bedrock_integration.bedrock_kb_legal (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  embedding       vector(1024) NOT NULL,
  chunks          TEXT         NOT NULL,
  metadata        JSONB        NOT NULL,
  custom_metadata JSONB
);

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_embedding_hnsw_idx
  ON bedrock_integration.bedrock_kb_legal
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_chunks_bigm_idx
  ON bedrock_integration.bedrock_kb_legal
  USING gin (chunks gin_bigm_ops);
