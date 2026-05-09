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

## 다음 슬라이스 (Slice 6+)

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
