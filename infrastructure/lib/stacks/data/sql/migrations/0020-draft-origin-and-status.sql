-- Migration 0020: distinguish AI low-confidence drafts from heuristic drafts + accept lifecycle.

ALTER TABLE journal_entry_draft ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'heuristic';
ALTER TABLE journal_entry_draft ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(4,3);
ALTER TABLE journal_entry_draft ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE journal_entry_draft ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE journal_entry_draft ADD COLUMN IF NOT EXISTS accepted_entry_id UUID;

ALTER TABLE journal_entry_draft DROP CONSTRAINT IF EXISTS journal_entry_draft_origin_check;
ALTER TABLE journal_entry_draft ADD CONSTRAINT journal_entry_draft_origin_check
  CHECK (origin IN ('heuristic', 'ai_low_conf'));

ALTER TABLE journal_entry_draft DROP CONSTRAINT IF EXISTS journal_entry_draft_status_check;
ALTER TABLE journal_entry_draft ADD CONSTRAINT journal_entry_draft_status_check
  CHECK (status IN ('pending', 'accepted', 'discarded'));

COMMENT ON COLUMN journal_entry_draft.origin       IS 'heuristic = counterparty regex/amount band; ai_low_conf = Bedrock classification below DRAFT_CONFIDENCE_THRESHOLD.';
COMMENT ON COLUMN journal_entry_draft.ai_confidence IS 'Bedrock confidence (0..1) when origin=ai_low_conf. NULL for heuristic drafts.';
COMMENT ON COLUMN journal_entry_draft.status       IS 'pending → user can accept; accepted → promoted to journal_entries; discarded → rejected by user.';
COMMENT ON COLUMN journal_entry_draft.accepted_entry_id IS 'journal_entries.id when status=accepted. Drives audit linkage.';

CREATE INDEX IF NOT EXISTS idx_journal_entry_draft_status
  ON journal_entry_draft (tenant_id, status, created_at DESC)
  WHERE status = 'pending';
