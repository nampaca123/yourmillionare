# 슬라이스 진행 현황

## 스택별 상태 (Slice 5 이후)

| 스택 | 상태 | 비고 |
|------|------|------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK, **CODEF + ECOS** Secrets 슬롯 |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, SG, VPC Endpoints, NAT Instance, PRIVATE_WITH_EGRESS |
| `Ym-Dev-Data` | ✅ DEPLOYED | Aurora + schema + migrations (**0006–0008**) + DynamoDB |
| `Ym-Dev-Identity` | ✅ DEPLOYED | Cognito User Pool + Client |
| `Ym-Dev-Api` | ✅ DEPLOYED | HTTP API + Identity/Journal Lambda (**journal-core**, transaction cache env) |
| `Ym-Dev-Ingestion` | 🆕 CDK | CODEF EDA **스켈레톤** (SFN+SQS+스케줄+DLQ 알람), 실 로직은 후속 |

---

## 테스트 현황 (Slice 5)

```
infrastructure: Test Files 5 passed (5), Tests 46 passed (46)
apps/identity:  Test Files 4 passed (4), Tests 15 passed (15)
apps/journal:   Test Files 4 passed (4), Tests 13 passed (13)
packages/journal-core: vitest (stub classifier 등)
packages/shared-errors: vitest
```

`CDK_ENV=dev AWS_ACCOUNT_ID=123456789012 npx cdk synth Ym-Dev-Ingestion` — 성공 (로컬 검증).

---

## Phase 0 종료

Slice 5 범위: **journal-core**, **캐시 projector**, **마이그레이션(ai_decisions·system tenant policy·dispatched_at)**, **Ingestion/Fx 스택 뼈대**, **시크릿 동기화 스크립트**. CODEF 실연동·워커 트랜잭션 분리·Powertools 전 Lambda 계측은 Slice 6에서 심화.

자세한 설계·한계는 `docs/05-slice5.ko.md`.

---

## Slice 6 — CODEF 실연동 (개인 사용자 + ID/PW MVP)

| 항목 | 상태 |
|------|------|
| Personal tenant 자동 발급 (`/me` 첫 호출) | ✅ Migration 0010, BRN nullable, business_type='personal' |
| `POST /tenants/{id}/bank-connections` (CODEF account/create + account-list) | ✅ ID/PW 기반, RSA 암호화, `tenant_bank_connections` 영속 저장 |
| `POST /tenants/{id}/bank-accounts` (계좌 confirm) | ✅ 사전 connection 필요, connectedId 자동 첨부 |
| `GET /tenants/{id}/journal/entries` | ✅ from/to/limit/offset, 멤버십 검증, lines join |
| Identity Lambda 서브넷 PRIVATE_WITH_EGRESS | ✅ CODEF 인터넷 호출 가능 |
| Cognito Google OAuth + Hosted UI 도메인 | ✅ `IdentityStack` IdP + Domain |
| `codef-bank.client` URL-decode 버그 수정 | ✅ `decodeURIComponent` 적용 |

### 보안 트레이드오프 (Phase 0 한정)

`POST /bank-connections`는 신한 인터넷뱅킹 ID/PW를 그대로 받아 CODEF로 전달한다. RSA-PKCS1로 즉시 암호화한 뒤 평문은 스코프를 벗어나며, 어떤 구조화 로그에도 기록되지 않는다. 그러나 평문이 짧은 시간 동안 Identity Lambda 메모리를 경유하는 사실은 변하지 않는다.

- 베타 사용자 1인(본인 신한 계정) 검증 한정으로 허용
- HTTPS + RSA + 로그 제외 + 즉시 스코프 해제로 노출 표면 최소화
- Phase 1에서 CODEF 인증서 팝업(loginType=0) 또는 간편인증(loginType=5)으로 교체 예정

---

## 다음 슬라이스 (Slice 7+)

| 항목 | 비고 |
|------|------|
| CODEF 실어댑터 (`apps/codef`) | mock fixture · Postgres · SQS 본문 연결 |
| 파이프라인 고도화 | 워커 트랜잭션 분리·`ai_decisions`·Powertools 전 구간 |
| RDS Proxy (prod) | CODEF 폴링 동시성 증가 시점에 도입 |
| SFN Map API | `iterator` → `itemProcessor` 마이그레이션 |

---

## Slice 2 배포 실패 이력 (참고)

### 1차 실패 — `Cannot find DBInstance in DBCluster`
- **원인**: SchemaMigration Custom Resource가 writer 인스턴스 기동 전 실행됨
- **조치**: `migrationCR.node.addDependency(aurora.cluster.node.findChild('writer'))` 추가

### 2차 실패 — `Database returned SQL Exception`
- **원인**: `splitStatements()` 달러쿼팅 내부 `;` 오인
- **조치**: `if (ch === ';')` → `if (!inDollarQuote && ... && ch === ';')` 수정
