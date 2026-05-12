-- Migration 0016: enable pgvector + pg_bigm for the Bedrock KB SEMANTIC_HYBRID search. Wave-5 KB stack provisions the chunk table.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_bigm;
