-- (tenant_id, code) uniqueness is guaranteed by the PRIMARY KEY on accounts.
-- This file ensures ON CONFLICT (tenant_id, code) works for seed inserts without a named constraint.
SELECT 1;
