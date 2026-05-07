# 슬라이스 진행 현황

## 스택별 상태 (Slice 4 기준)

| 스택 | 상태 | 비고 |
|------|------|------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK, CODEF Secrets 슬롯 |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, SG, VPC Endpoints, NAT Instance, PRIVATE_WITH_EGRESS |
| `Ym-Dev-Data` | ✅ DEPLOYED | Aurora + schema(baseline-v1 + migrations 0001-0002) + HostedRotation + DynamoDB |
| `Ym-Dev-Identity` | ✅ DEPLOYED | Cognito User Pool + Client |
| `Ym-Dev-Api` | ✅ DEPLOYED | HTTP API (`https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com/`) + Identity Lambda + Journal Lambda |

---

## Slice 2 검증 결과 (2026-05-05 17:50 KST — 슬라이스 3 배포 후에는 RLS 정책 15개로 갱신 예정)

### verifier-schema
- `status: OK`
- 테이블 10개 확인 (`actualTableCount: 10`)
- RLS 정책 8개 확인

### verifier-iam
- `status: OK`
- IAM 토큰으로 `app_user` Aurora 직접 연결 성공 (`iamConnectMs: 2127`)

---

## Slice 3 코드 변경 요약

| 파일 | 변경 내용 |
|------|-----------|
| `infrastructure/lib/stacks/data/sql/migrations/0001-onboarding-rls.sql` | users/tenants/tenant_members RLS 정책 재정의 |
| `infrastructure/lib/stacks/data/schema-migrator.lambda.ts` | multifile migrations/ 지원 (파일별 트랜잭션 + sha256) |
| `infrastructure/lib/stacks/data/verifier-schema.lambda.ts` | 정책 이름 화이트리스트 검증으로 전환 |
| `infrastructure/lib/stacks/data/verifier-iam.lambda.ts` | RLS 격리 시나리오 추가 (tenant A/B fixture) |
| `infrastructure/lib/stacks/data.stack.ts` | aurora public 노출, verifier-iam Data API 권한 추가 |
| `infrastructure/lib/stacks/identity.stack.ts` | Cognito User Pool + Client (신규) |
| `infrastructure/lib/stacks/api.stack.ts` | HTTP API + JWT Authorizer + Identity Lambda (신규) |
| `infrastructure/bin/yourmillionare.ts` | Identity/Api 스택 배선 추가 |
| `apps/identity/` | 헥사고날 도메인 패키지 전체 (신규) |
| `docs/03-identity-api.ko.md` | Slice 3 설계 기록 |

---

## 테스트 현황 (Slice 4 완료 시점)

```
infrastructure: Test Files 5 passed (5), Tests 44 passed (44)
apps/identity:  Test Files 4 passed (4), Tests 15 passed (15)
apps/journal:   Test Files 4 passed (4), Tests 13 passed (13)
packages/shared-errors: (타입 전용, 런타임 테스트 없음)
```

cdk-nag 에러 0건. 모든 단위 테스트 통과.

---

## Slice 4 코드 변경 요약

| 파일 | 변경 내용 |
|------|-----------|
| `infrastructure/lib/stacks/network.stack.ts` | t4g.nano NAT Instance (fck-nat), PRIVATE_WITH_EGRESS 서브넷 |
| `infrastructure/lib/stacks/data.stack.ts` | HostedRotation (securityGroups:[lambdaSg]), `public cache` property, migrationsSha256 trigger |
| `infrastructure/lib/stacks/data/schema-migrator.lambda.ts` | baseline-v1 stable key + legacy hash 감지, baseVersion 변수명 버그 fix |
| `infrastructure/lib/stacks/data/sql/migrations/0002-accounts-unique.sql` | SELECT 1 no-op (원래 잘못된 ALTER TABLE 제거) |
| `infrastructure/lib/stacks/api.stack.ts` | JournalFn (PRIVATE_WITH_EGRESS, 30s, 512MB), Idempotency 환경변수, journal 라우트 |
| `infrastructure/bin/yourmillionare.ts` | `cache: data.cache` ApiStack 전달 |
| `packages/shared-errors/` | AppError, RateLimitError, IdempotencyKeyReused/InProgress, toHttpErrorResponse 공유 패키지 |
| `apps/identity/src/main.ts` | `makeIdempotent(POST /tenants)` 적용 |
| `apps/identity/src/infrastructure/inbound/http/idempotency.config.ts` | Powertools persistence/config factory (신규) |
| `apps/journal/` | 헥사고날 패키지 전체 (신규) |
| `docs/04-slice4.ko.md` | Slice 4 설계 기록 |

---

## 슬라이스 5 범위 (예정)

슬라이스 4 완료 → CODEF 어댑터 연동(슬라이스 5)으로 넘어간다.

| 항목 | 비고 |
|------|------|
| CODEF API 어댑터 (`apps/codef`) | 은행 거래내역 수집 |
| EventBridge → Step Functions → SQS 파이프라인 | classify 엔드포인트를 EDA로 교체 |
| RDS Proxy (prod 한정) | CODEF 폴링 동시성 증가 시점에 도입 |
| `ai_decisions` 테이블 | 학습 피드백 루프 |

---

## Slice 2 검증 결과 (참고 — 슬라이스 3 배포 전 기준)

---

## Slice 2 배포 실패 이력 (참고)

### 1차 실패 — `Cannot find DBInstance in DBCluster`
- **원인**: SchemaMigration Custom Resource가 writer 인스턴스 기동 전 실행됨
- **조치**: `migrationCR.node.addDependency(aurora.cluster.node.findChild('writer'))` 추가

### 2차 실패 — `Database returned SQL Exception`
- **원인**: `splitStatements()` 달러쿼팅 내부 `;` 오인
- **조치**: `if (ch === ';')` → `if (!inDollarQuote && ... && ch === ';')` 수정
