-- Migration 0023: collapse journal_entry_draft into journal_entries with confidence_status (certain | uncertain | discarded).
--   Every transaction the user has is represented by exactly one row in journal_entries — no hidden draft table.
--   Reports, lists, balances, summaries all read this single table and label confidence_status; no toggle to "include drafts".

-- 1. Add columns to journal_entries.
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS confidence_status TEXT NOT NULL DEFAULT 'certain';
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_confidence_status_check
    CHECK (confidence_status IN ('certain', 'uncertain', 'discarded'));
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3)
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1);
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_origin_check
    CHECK (origin IS NULL OR origin IN ('manual', 'heuristic', 'ai', 'ai_low_conf'));

CREATE INDEX IF NOT EXISTS idx_journal_entries_confidence_status
  ON journal_entries(tenant_id, confidence_status, entry_date DESC);

COMMENT ON COLUMN journal_entries.confidence_status IS
  'certain (user-confirmed or auto-posted) | uncertain (AI suggested, awaiting user) | discarded (user rejected). Reports return all and label this so nothing is hidden.';
COMMENT ON COLUMN journal_entries.confidence IS 'Classifier confidence 0..1 at insertion time. NULL for manual entries.';
COMMENT ON COLUMN journal_entries.origin IS 'manual | heuristic | ai | ai_low_conf. NULL for legacy manual entries.';

-- 2. Backfill origin/confidence on existing journal_entries rows (these are all currently certain by definition).
UPDATE journal_entries
   SET origin = CASE
                  WHEN ai_model IS NULL THEN 'manual'
                  WHEN ai_confidence IS NULL THEN 'manual'
                  WHEN ai_confidence >= 0.5 THEN 'ai'
                  ELSE 'ai_low_conf'
                END,
       confidence = ai_confidence
 WHERE origin IS NULL;

-- 3. Sanity check: every pending draft must have balanced draft_lines (SUM debit = SUM credit) before we move it.
DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM journal_entry_draft jed
   WHERE jed.status = 'pending'
     AND (
       (SELECT COALESCE(SUM((line->>'debit')::numeric), 0)  FROM jsonb_array_elements(jed.draft_lines) AS line)
       <>
       (SELECT COALESCE(SUM((line->>'credit')::numeric), 0) FROM jsonb_array_elements(jed.draft_lines) AS line)
     );
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % pending journal_entry_draft rows have unbalanced draft_lines', bad_count;
  END IF;
END $$;

-- 4. Move pending drafts → journal_entries (status='draft', confidence_status='uncertain').
WITH inserted_entries AS (
  INSERT INTO journal_entries
    (id, tenant_id, entry_date, posting_date, source, source_ref_id, description,
     status, ai_confidence, ai_model, created_at, created_by, sync_run_id,
     confidence_status, confidence, origin)
  SELECT
    gen_random_uuid(),
    jed.tenant_id,
    rt.occurred_at::date,
    now()::date,
    'codef_bank'::journal_source,
    jed.raw_transaction_id,
    rt.counterparty,
    'draft'::journal_status,
    jed.ai_confidence,
    jed.rule_id,
    jed.created_at,
    '00000000-0000-0000-0000-000000000001'::uuid,
    jed.sync_run_id,
    'uncertain',
    COALESCE(jed.ai_confidence, jed.heuristic_confidence),
    jed.origin
  FROM journal_entry_draft jed
  JOIN raw_transactions rt ON rt.id = jed.raw_transaction_id
  WHERE jed.status = 'pending'
  RETURNING id, tenant_id, source_ref_id
)
INSERT INTO journal_lines (id, entry_id, tenant_id, line_no, account_code, debit, credit, memo)
SELECT
  gen_random_uuid(),
  ie.id,
  ie.tenant_id,
  (line->>'lineNo')::smallint,
  line->>'accountCode',
  COALESCE((line->>'debit')::numeric, 0),
  COALESCE((line->>'credit')::numeric, 0),
  line->>'memo'
FROM inserted_entries ie
JOIN journal_entry_draft jed
  ON jed.raw_transaction_id = ie.source_ref_id AND jed.tenant_id = ie.tenant_id
CROSS JOIN LATERAL jsonb_array_elements(jed.draft_lines) AS line
WHERE jed.status = 'pending';

-- 5. Mark previously-accepted journal_entries with origin (they were promoted from drafts).
UPDATE journal_entries je
   SET origin = COALESCE(je.origin, jed.origin),
       confidence = COALESCE(je.confidence, jed.ai_confidence, jed.heuristic_confidence)
  FROM journal_entry_draft jed
 WHERE jed.accepted_entry_id = je.id
   AND jed.status = 'accepted';

-- 6. Move discarded drafts as well (status='draft', confidence_status='discarded') so audit trail survives.
WITH inserted_discarded AS (
  INSERT INTO journal_entries
    (id, tenant_id, entry_date, posting_date, source, source_ref_id, description,
     status, ai_confidence, ai_model, created_at, created_by, sync_run_id,
     confidence_status, confidence, origin)
  SELECT
    gen_random_uuid(),
    jed.tenant_id,
    rt.occurred_at::date,
    now()::date,
    'codef_bank'::journal_source,
    jed.raw_transaction_id,
    rt.counterparty,
    'draft'::journal_status,
    jed.ai_confidence,
    jed.rule_id,
    jed.created_at,
    '00000000-0000-0000-0000-000000000001'::uuid,
    jed.sync_run_id,
    'discarded',
    COALESCE(jed.ai_confidence, jed.heuristic_confidence),
    jed.origin
  FROM journal_entry_draft jed
  JOIN raw_transactions rt ON rt.id = jed.raw_transaction_id
  WHERE jed.status = 'discarded'
  RETURNING id, tenant_id, source_ref_id
)
INSERT INTO journal_lines (id, entry_id, tenant_id, line_no, account_code, debit, credit, memo)
SELECT
  gen_random_uuid(),
  ide.id,
  ide.tenant_id,
  (line->>'lineNo')::smallint,
  line->>'accountCode',
  COALESCE((line->>'debit')::numeric, 0),
  COALESCE((line->>'credit')::numeric, 0),
  line->>'memo'
FROM inserted_discarded ide
JOIN journal_entry_draft jed
  ON jed.raw_transaction_id = ide.source_ref_id AND jed.tenant_id = ide.tenant_id
CROSS JOIN LATERAL jsonb_array_elements(jed.draft_lines) AS line
WHERE jed.status = 'discarded';

-- 7. Drop journal_entry_draft.
DROP TABLE IF EXISTS journal_entry_draft;
