INSERT INTO users (id, cognito_sub, email)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'system', 'system@ym.internal')
ON CONFLICT (cognito_sub) DO NOTHING;

CREATE POLICY tenants_system_select ON tenants FOR SELECT TO app_user
  USING (current_setting('app.cognito_sub', true) = 'system');
