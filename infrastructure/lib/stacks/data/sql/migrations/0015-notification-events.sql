-- Migration 0015: notification event slot for upcoming daily KakaoTalk digest + filing reminders. Delivery worker is out of scope for this slice.

CREATE TYPE notification_channel AS ENUM ('KAKAO_BIZ', 'EMAIL', 'IN_APP');
CREATE TYPE notification_kind    AS ENUM (
  'DAILY_DIGEST',
  'FILING_DUE_D14',
  'FILING_DUE_D7',
  'FILING_DUE_D3',
  'WITHHOLDING_DETECTED',
  'KB_STALE_WARNING',
  'BANK_LOCK_RISK'
);
CREATE TYPE notification_status  AS ENUM ('queued', 'sent', 'failed', 'skipped');

CREATE TABLE IF NOT EXISTS notification_event (
  id            UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID                 NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID                 REFERENCES users(id),
  channel       notification_channel NOT NULL DEFAULT 'KAKAO_BIZ',
  kind          notification_kind    NOT NULL,
  payload       JSONB                NOT NULL,
  status        notification_status  NOT NULL DEFAULT 'queued',
  scheduled_at  TIMESTAMPTZ          NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  failure_reason TEXT,
  created_at    TIMESTAMPTZ          NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_queued
  ON notification_event(scheduled_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_notification_tenant_recent
  ON notification_event(tenant_id, created_at DESC);

COMMENT ON TABLE notification_event IS 'Outbound notification queue. Worker (out of scope for this slice) consumes status=queued and dispatches via SNS → Kakao Biz Message';

ALTER TABLE notification_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON notification_event;
CREATE POLICY tenant_isolation ON notification_event
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

DROP POLICY IF EXISTS notification_system_read ON notification_event;
CREATE POLICY notification_system_read ON notification_event
  FOR SELECT TO app_user
  USING (current_setting('app.cognito_sub', true) = 'system');
