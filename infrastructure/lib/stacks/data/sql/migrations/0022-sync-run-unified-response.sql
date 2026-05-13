-- Migration 0022: enable date-ranged sync requests and audit per-account balance / per-tx classification origin tags for the SSE /fs/sync flow.

ALTER TABLE sync_run ADD COLUMN IF NOT EXISTS date_range_from DATE;
ALTER TABLE sync_run ADD COLUMN IF NOT EXISTS date_range_to   DATE;

COMMENT ON COLUMN sync_run.date_range_from IS 'User-selected lower bound (inclusive). NULL means incremental sync from latest_fetched_at - lookback.';
COMMENT ON COLUMN sync_run.date_range_to   IS 'User-selected upper bound (inclusive). NULL means today.';

ALTER TABLE sync_run_account ADD COLUMN IF NOT EXISTS bank_account_id  UUID REFERENCES tenant_bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE sync_run_account ADD COLUMN IF NOT EXISTS previous_balance NUMERIC(18,2);
ALTER TABLE sync_run_account ADD COLUMN IF NOT EXISTS current_balance  NUMERIC(18,2);

COMMENT ON COLUMN sync_run_account.previous_balance IS 'tenant_bank_accounts.last_balance_krw snapshot BEFORE this run updated it. NULL when not applicable.';
COMMENT ON COLUMN sync_run_account.current_balance  IS 'tenant_bank_accounts.last_balance_krw snapshot AFTER this run updated it. NULL when balance was not updated.';

ALTER TABLE raw_transactions ADD COLUMN IF NOT EXISTS first_sync_run_id UUID REFERENCES sync_run(id) ON DELETE SET NULL;
ALTER TABLE raw_transactions ADD COLUMN IF NOT EXISTS bank_account_id   UUID REFERENCES tenant_bank_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_raw_tx_first_sync_run
  ON raw_transactions(first_sync_run_id)
  WHERE first_sync_run_id IS NOT NULL;

COMMENT ON COLUMN raw_transactions.first_sync_run_id IS 'The sync_run.id that first ingested this raw_transaction.';
COMMENT ON COLUMN raw_transactions.bank_account_id   IS 'tenant_bank_accounts.id this transaction was fetched from. Drives sourceAccount in the SSE response.';

ALTER TABLE journal_entry_draft ADD COLUMN IF NOT EXISTS sync_run_id UUID REFERENCES sync_run(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entry_draft_sync_run
  ON journal_entry_draft(sync_run_id)
  WHERE sync_run_id IS NOT NULL;

COMMENT ON COLUMN journal_entry_draft.sync_run_id IS 'The sync_run.id that produced this uncertain draft. NULL for drafts created outside a sync (manual classify path).';

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS sync_run_id UUID REFERENCES sync_run(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_sync_run
  ON journal_entries(sync_run_id)
  WHERE sync_run_id IS NOT NULL;

COMMENT ON COLUMN journal_entries.sync_run_id IS 'The sync_run.id whose classification produced this certain entry. NULL for manual entries.';
