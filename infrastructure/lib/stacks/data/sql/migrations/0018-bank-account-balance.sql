-- Migration 0018: persist last-known balance snapshot per monitored bank account.

ALTER TABLE tenant_bank_accounts ADD COLUMN IF NOT EXISTS last_balance_krw        NUMERIC(18,2);
ALTER TABLE tenant_bank_accounts ADD COLUMN IF NOT EXISTS last_withdrawable_krw   NUMERIC(18,2);
ALTER TABLE tenant_bank_accounts ADD COLUMN IF NOT EXISTS balance_synced_at       TIMESTAMPTZ;

COMMENT ON COLUMN tenant_bank_accounts.last_balance_krw      IS 'Most recent account balance fetched from CODEF (data.resAccountBalance or trailing resAfterTranBalance). Surface in GET /journal/entries response.';
COMMENT ON COLUMN tenant_bank_accounts.last_withdrawable_krw IS 'Available-to-withdraw amount when bank reports it (data.resWithdrawalAmt). Null when not provided.';
COMMENT ON COLUMN tenant_bank_accounts.balance_synced_at     IS 'Timestamp of the CODEF call that produced last_balance_krw. Drives staleness indicator in UI.';
