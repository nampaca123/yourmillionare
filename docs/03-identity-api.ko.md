# Slice 3 — Identity & API Skeleton 설계 기록

## 1. 결과물 요약

Cognito User Pool → HTTP API (JWT Authorizer) → VPC Lambda → Aurora (IAM auth + RLS) 경로를 처음으로 연결했다. `apps/identity`에 헥사고날 아키텍처 기반의 첫 도메인 패키지가 들어섰다.

### 활성화된 엔드포인트

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| GET | `/health` | 없음 | liveness probe — DB 핑 없음 |
| GET | `/me` | JWT ID Token | 사용자 resolve/생성 (idempotent) |
| POST | `/tenants` | JWT ID Token | 테넌트 생성 + owner 멤버십 등록 |
| GET | `/me/tenants` | JWT ID Token | 내 모든 테넌트 조회 |

> **클라이언트 가이드**: `Authorization: Bearer <id_token>` — Cognito ID Token만 허용. Access Token에는 `aud` 클레임이 없어서 JWT Authorizer가 자동 거부함.

---

## 2. RLS 함정 세 가지와 해결 (0001 마이그레이션)

### 함정 (1) — users chicken-and-egg

**문제**: `users` 테이블의 원래 RLS 정책 `user_self_only`는 `id = app.current_user_id`로만 SELECT를 허용. 처음 로그인하는 사용자는 DB id를 모르기 때문에 SELECT가 막힌다.

**해결**: `users_select_by_sub` 정책 추가 — `cognito_sub = app.cognito_sub`로 SELECT 허용. 첫 연결 시 cognito_sub만 GUC에 set해서 사용자 row를 찾거나, 없으면 `users_insert_by_sub` 정책(cognito_sub 기반 INSERT)으로 생성한다. 그 다음 `app.current_user_id`를 set해 이후 쿼리에서 `users_modify_self`가 적용되도록 한다.

### 함정 (2) — tenants 단일 키 문제

**문제**: 원래 `tenant_isolation` 정책은 `id = app.current_tenant_id` (단일 키). `GET /me/tenants`를 호출할 때 `current_tenant_id`가 하나만 설정되므로 다른 테넌트는 전혀 안 보인다.

**해결**: `tenants_select_by_membership` 정책으로 교체 — `tenant_members` 조인으로 `current_user_id`가 멤버로 있는 모든 테넌트를 SELECT. `POST /tenants` 직후 `current_tenant_id`가 없어도 INSERT가 가능하도록 `tenants_insert_authenticated` 정책도 추가.

### 함정 (3) — tenant_members 공동대표 가시성

**문제**: 원래 `tenant_isolation` 정책이 `tenant_members`에도 있었는데, `tenant_id = current_tenant_id`만 허용해서 owner가 같은 테넌트의 다른 owner를 SELECT할 수 없었다.

**해결**: `tenant_members_visible` 정책 — `user_id = current_user_id OR tenant_id = current_tenant_id`로 확장. 자신의 멤버십은 어떤 테넌트든 볼 수 있고, 현재 활성 테넌트의 멤버 전체도 볼 수 있다.

---

## 3. 마이그레이션 시스템 (multifile)

`schema-migrator.lambda.ts`는 두 단계로 동작한다:

1. **Base migration** (`db-bootstrap.sql` + `schema.sql`): 단일 트랜잭션, SHA256 해시로 schema_migrations row 기록. 이미 적용됐으면 skip.
2. **Incremental migrations** (`migrations/*.sql` 사전순): 파일별 독립 트랜잭션. 한 파일 실패 시 그 파일만 롤백, 이전 파일은 유지.

**부분 실패 동작**: `0001-onboarding-rls.sql`이 실패하면 schema_migrations에 row가 생기지 않는다. 다음 배포 시 동일 파일을 재시도한다. 의도된 동작.

---

## 4. JWT Authorizer — ID Token vs Access Token

Cognito HTTP API Authorizer는 `aud` 클레임이 있어야 토큰을 수락한다. Cognito Access Token에는 `aud`가 없고 `client_id`만 있다. 따라서 `audience: [clientId]`로 설정하면 **ID Token만** 수락된다. 클라이언트는 `Auth.currentSession().getIdToken().getJwtToken()`을 헤더에 넣어야 한다.

---

## 5. IAM 토큰 캐시 + race condition 방지

Lambda 인스턴스 당 `pg.Pool`을 하나 유지한다. IAM auth token TTL은 15분이며, 만료 3분 전부터 갱신을 시도한다.

동시 요청이 토큰 갱신을 동시에 시작하는 race를 막기 위해 `refreshing: Promise<Pool> | undefined`를 사용한다. 갱신 중인 promise가 있으면 새 요청은 그 promise를 재사용한다.

```
이전 pool 종료 → IAM Signer.getAuthToken() → 새 pool 생성
갱신 도중 두 번째 Lambda 요청 → refreshing promise 반환 (중복 갱신 없음)
```

---

## 6. KMS 암호화 설계

### biz_reg_no (10자리)

KMS `Encrypt` 직접 호출 (4KB 한도 안에서 충분). DEK 패턴 불필요.

### 중복 검사 (biz_reg_no_hash)

KMS HMAC 키로 `GenerateMac(HMAC_SHA_256)`. **별도의 non-rotating 키**를 사용한다. 암호화 키를 회전하면 동일한 사업자번호의 해시값이 달라져 중복 검사가 깨지기 때문이다.

---

## 7. POST /tenants Idempotency-Key 결정

슬라이스 3에서는 **deferred**. `biz_reg_no` unique constraint가 데이터 정합을 보호하므로 double-submit 시 `ConflictError(409)` 반환. 사용자가 두 번 클릭해도 데이터 중복은 없다.

Slice 4에서 `IdempotencyKeys` DynamoDB 테이블을 활용한 24h 키-기반 응답 재현 기능 추가 예정.

---

## 8. 비용 추가분 (dev 월 예상)

| 항목 | 비용 |
|------|------|
| Cognito User Pool (50K MAU 무료) | ~$0 |
| HTTP API ($1.00/M req) | ~$0 |
| HTTP API access logs | ~$0.5 |
| Identity Lambda (256MB ARM, 거의 0 호출) | ~$0 |
| KMS HMAC 키 | $1/월 + 호출 단가 |
| KMS 암호화 키 | $1/월 + 호출 단가 |
| CloudWatch Logs (추가분) | ~$0.5 |
| **합계** | **~$3** |
