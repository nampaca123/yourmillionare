-- Migration 0024: multi-currency on tenant_bank_accounts (manual + CODEF foreign accounts).
--   Both flavors live in the same table so /fx/accounts can union them in one query.
--   account_kind='krw_demand' (existing CODEF) | 'foreign' (manual or CODEF FX).
--   currency: ISO 4217 (KRW for demand accounts, USD for manual MVP).
--   is_manual=true → user-entered FX balance with manual_balance_fcy snapshot.

ALTER TABLE tenant_bank_accounts
  ADD COLUMN IF NOT EXISTS account_kind            TEXT          NOT NULL DEFAULT 'krw_demand';
ALTER TABLE tenant_bank_accounts
  ADD CONSTRAINT tenant_bank_accounts_account_kind_check
    CHECK (account_kind IN ('krw_demand', 'foreign'));

ALTER TABLE tenant_bank_accounts
  ADD COLUMN IF NOT EXISTS currency                CHAR(3)       NOT NULL DEFAULT 'KRW';

ALTER TABLE tenant_bank_accounts
  ADD COLUMN IF NOT EXISTS is_manual               BOOLEAN       NOT NULL DEFAULT FALSE;

ALTER TABLE tenant_bank_accounts
  ADD COLUMN IF NOT EXISTS manual_balance_fcy      NUMERIC(20,4);

ALTER TABLE tenant_bank_accounts
  ADD COLUMN IF NOT EXISTS manual_balance_synced_at TIMESTAMPTZ;

ALTER TABLE tenant_bank_accounts
  ADD COLUMN IF NOT EXISTS bank_label              TEXT;

CREATE INDEX IF NOT EXISTS idx_tenant_bank_accounts_foreign
  ON tenant_bank_accounts (tenant_id, currency)
  WHERE account_kind = 'foreign' AND is_active;

COMMENT ON COLUMN tenant_bank_accounts.account_kind             IS 'krw_demand: existing KRW CODEF account. foreign: user FX exposure (manual or CODEF FX).';
COMMENT ON COLUMN tenant_bank_accounts.currency                 IS 'ISO 4217. KRW for demand accounts; USD whitelist for foreign MVP.';
COMMENT ON COLUMN tenant_bank_accounts.is_manual                IS 'true when the user entered the balance manually rather than CODEF syncing it.';
COMMENT ON COLUMN tenant_bank_accounts.manual_balance_fcy       IS 'User-entered foreign-currency balance. Only set when is_manual=true.';
COMMENT ON COLUMN tenant_bank_accounts.manual_balance_synced_at IS 'Timestamp of the last manual_balance_fcy edit by the user.';
COMMENT ON COLUMN tenant_bank_accounts.bank_label               IS 'Optional user nickname (e.g. "Citi USD"). Free-form, displayed in /fx/accounts.';
