# 슬라이스 진행 현황

## 스택별 상태 (Slice 5 이후)

| 스택 | 상태 | 비고 |
|------|------|------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK, **CODEF + ECOS** Secrets 슬롯 (CMK는 AWS-managed로 정리됨) |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, SG, VPC Endpoints, NAT Instance, PRIVATE_WITH_EGRESS |
| `Ym-Dev-Data` | ✅ DEPLOYED | Aurora + schema + migrations (**0006–0010**) + DynamoDB + verifier (13 tables) |
| `Ym-Dev-Identity` | ✅ DEPLOYED | Cognito User Pool + Client + **Hosted UI domain + Google IdP** |
| `Ym-Dev-Api` | ✅ DEPLOYED | HTTP API + Identity (PRIVATE_WITH_EGRESS) / Journal Lambda + 신규 routes 2개 |
| `Ym-Dev-Ingestion` | ✅ DEPLOYED | CODEF EDA **실연동 가동** (SFN→fetch→SQS→Bedrock classify→Aurora) |

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

## Slice 6 — CODEF 실연동 (개인 사용자 + ID/PW MVP) ✅ COMPLETE

| 항목 | 상태 |
|------|------|
| Personal tenant 자동 발급 (`/me` 첫 호출) | ✅ Migration 0010, BRN nullable, business_type='personal' |
| `POST /tenants/{id}/bank-connections` (CODEF account/create + account-list) | ✅ ID/PW 기반, RSA 암호화, `tenant_bank_connections` 영속 저장 |
| `POST /tenants/{id}/bank-accounts` (계좌 confirm) | ✅ 사전 connection 필요, connectedId 자동 첨부 |
| `GET /tenants/{id}/journal/entries` | ✅ from/to/limit/offset, 멤버십 검증, lines join |
| Identity Lambda 서브넷 PRIVATE_WITH_EGRESS | ✅ CODEF 인터넷 호출 가능 |
| Cognito Google OAuth + Hosted UI 도메인 | ✅ `IdentityStack` IdP + Domain, redirect chain 302 검증됨 |
| CODEF 응답 URL-decode 버그 수정 | ✅ `decodeURIComponent` 모든 클라이언트 적용 |
| CODEF 성공 코드 비교 버그 수정 | ✅ `00000` → `CF-00000` |
| SFN Map ItemSelector 패턴 정착 | ✅ `iterator` deprecated 제거 + `payload` 명시 매핑 |
| Classify worker accounts 시드 | ✅ `K_IFRS_DEFAULT_ACCOUNTS` bulk-insert (FK 위반 방지) |
| **Bedrock dev/prod 일원화** | ✅ 모든 Lambda에서 실 Sonnet 사용, stub은 unit test 전용 격리 |
| **E2E 검증** | ✅ 16/16 시나리오 PASS, 신한 110xxxxxxxxx + Sonnet 4.6 분개 검증 완료 |

### 보안 트레이드오프 (Phase 0 한정)

`POST /bank-connections`는 신한 인터넷뱅킹 ID/PW를 그대로 받아 CODEF로 전달한다. RSA-PKCS1로 즉시 암호화한 뒤 평문은 스코프를 벗어나며, 어떤 구조화 로그에도 기록되지 않는다. 그러나 평문이 짧은 시간 동안 Identity Lambda 메모리를 경유하는 사실은 변하지 않는다.

- 베타 사용자 1인(본인 신한 계정) 검증 한정으로 허용
- HTTPS + RSA + 로그 제외 + 즉시 스코프 해제로 노출 표면 최소화
- Phase 1에서 CODEF 인증서 팝업(loginType=0) 또는 간편인증(loginType=5)으로 교체 예정

---

## 다음 슬라이스 (Slice 7+)

Slice 6에서 CODEF 실어댑터 + 파이프라인 + SFN itemProcessor + ai_decisions 기록까지 완료. 남은 항목:

| 항목 | 비고 |
|------|------|
| CODEF 인증 방식 마이그레이션 | loginType=1(ID/PW) → loginType=0(인증서 팝업) 또는 loginType=5(간편인증). Phase 1 |
| 운영 모니터링 강화 | Powertools 전 Lambda 적용, X-Ray + Application Signals SLO |
| RDS Proxy (prod) | CODEF 폴링 동시성 증가 시점에 도입 |
| Bedrock 비용 컨트롤 | 일일 한도 + per-tenant token quota + cache 활용 |
| Foundation Secret CMK 정합성 | CDK에서 `encryptionKey: alias/aws/secretsmanager` 명시로 drift 정리 |
| Multi-bank 지원 | Toss/KakaoBank 등 organization 추가 + per-bank loginType 매핑 |
| 프론트엔드 UI | Cognito Hosted UI 콜백 처리 + 분개 시각화 |

---

## Slice 2 배포 실패 이력 (참고)

### 1차 실패 — `Cannot find DBInstance in DBCluster`
- **원인**: SchemaMigration Custom Resource가 writer 인스턴스 기동 전 실행됨
- **조치**: `migrationCR.node.addDependency(aurora.cluster.node.findChild('writer'))` 추가

### 2차 실패 — `Database returned SQL Exception`
- **원인**: `splitStatements()` 달러쿼팅 내부 `;` 오인
- **조치**: `if (ch === ';')` → `if (!inDollarQuote && ... && ch === ';')` 수정
