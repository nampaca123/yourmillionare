# Slice 7 — 전체 갭 보완 통합 (3계층 동적 세법 + Aurora pgvector + Hybrid Search + AgentCore tools)

> **목적**: PLAN.md §1.4 여정 A "5분 안에 1차 결과" 약속 + §F2 핵심 뷰 4개 + §F4 세금 + §F5 FX + 재무제표 산출을 단일 슬라이스에 일괄 보완. Slice 6까지의 9개 endpoint와 직접 sync 트리거 부재라는 프론트엔드 차단 갭을 해소한다.

---

## 1. 무엇을 메우는가 — 12개 갭 (G1~G12)

| ID | 갭 | 해결 |
|---|---|---|
| G1 | 수동 sync 트리거 endpoint 부재 | `POST /tenants/{id}/sync` + ManualSyncStateMachine |
| G2 | 분석 진행 상태 조회 부재 | `GET /tenants/{id}/sync/status` (undispatched/dispatched/classified) |
| G3 | 월간 요약 카드 API 부재 (뷰 ②) | `GET /tenants/{id}/summary/monthly?ym=YYYY-MM` |
| G4 | 휴리스틱 1차 분류 부재 (5초 약속 위반) | `packages/journal-core/heuristics` + `journal_entry_draft` 테이블 + `GET /journal/drafts` |
| G5 | 재무제표 산출 부재 | `GET /reports/{pnl,balance-sheet,cash-flow,trial-balance}` + `packages/reports-core` |
| G6 | 받을 돈 칸반 부재 (뷰 ③) | `GET /receivables` + `PATCH /receivables/{entryId}` + `journal_entries.receivable_*` 컬럼 |
| G7 | 계정별 잔액 갤러리 부재 (뷰 ④) | `GET /accounts/balances` |
| G8 | FX (USD/KRW) 모듈 부재 | ECOS 어댑터 + `GET /fx/rates/usd-krw` + `POST /fx/revalue` + `packages/fx-core` |
| G9 | 세법 동적 관리 부재 | 3계층 동적 세법 (§3) |
| G10 | account code → 한국어 매핑 부재 | `GET /accounts/chart` (글로벌, 캐시 가능) |
| G11 | totalCount 없는 페이지네이션 | (후속) |
| G12 | 알림톡 미구현 | `notification_event` 테이블 슬롯 + worker는 후속 |

---

## 2. 어떻게 설계했는가

### 2.1 핵심 원칙

1. **헥사고날 의존 방향**: domain → application → infrastructure 강제. 4 신규 패키지 (`@ym/tax-core`, `@ym/fx-core`, `@ym/reports-core`, `@ym/law-corpus-core`) 모두 순수 함수·값 객체만. AWS SDK 의존 없음.
2. **LLM에 산수 안 시킴**: 모든 세금·환산은 결정적 calculator (rate를 인자로 받음). RAG는 해석·인용 전용.
3. **세율은 코드가 아닌 데이터**: `tax_rule` 테이블의 effective-dated row. 코드 deploy 없이 SQL INSERT 한 줄로 2027 세율 개정 대응.
4. **인용 강제**: 모든 KB 응답에 `citations[]` 필수. 빈 결과 시 "관련 법령 찾지 못함" 명시.
5. **dual approval**: 세무사 1명이 잘못 승인해도 production 적용 불가. DB trigger가 2번째 distinct admin 도착 시에만 `tax_rule.approved_at` 갱신.

### 2.2 코드 구조

```
apps/
  identity/          (기존)
  journal/           (기존 + sync/views/reports 12개 endpoint 추가)
  codef/             (기존)
  fx/                (신설 — HTTP entry + ECOS adapter + revaluation use case)
  tax/               (신설 — corporation-profile / filings / withholding / tax-invoices)
  tax-knowledge/     (신설 — Bedrock KB + agent tools + admin governance)
packages/
  journal-core/      (heuristics + 49개 K-IFRS 계정 코드)
  fx-core/           (ExchangeRate VO + IAS 21 revaluation policy)
  tax-core/          (VAT/withholding/corp-tax/penalty pure calculators + holiday roller)
  reports-core/      (P&L/BS/CF/TB builders + 회계 항등식 검증)
  law-corpus-core/   (LawChunk + TARGET_LAW_REGISTRY + chunk builder)
  shared-errors/     (기존)
infrastructure/
  lib/stacks/
    foundation.stack.ts    (기존)
    network.stack.ts       (기존)
    data.stack.ts          (기존, 마이그레이션 0011~0015 등록)
    identity.stack.ts      (기존)
    api.stack.ts           (3 신규 Lambda + 19개 신규 routes)
    ingestion.stack.ts     (ManualSyncStateMachine + LegalSyncStateMachine + LegalSyncScheduleRule)
```

### 2.3 데이터 모델 확장 (마이그레이션 0011~0015)

| 마이그레이션 | 추가 |
|---|---|
| `0011-corporation-and-journal-extensions.sql` | tenants 컬럼 7개 (industry_code, is_youth_founder, ...) + raw_transactions 컬럼 3개 (doc_type/biz_no/fx_rate) + journal_entries 컬럼 3개 (receivable kanban) + `journal_entry_draft` 테이블 |
| `0012-tax-rule-engine.sql` | `tax_rule` (effective-dated) + `tax_rule_approval` (dual approval) + `tax_rule_change_log` (audit) + `tax_rule_review_request` (신구법 큐) + 2 trigger functions |
| `0013-tax-law-corpus-and-holidays.sql` | `tax_law_sync_state` (consecutive_failures + kb_chunk_active 게이트) + `tax_law_chunk_meta` (KB 인덱스) + `holiday_cache` (KASI SoT) |
| `0014-filings-and-withholding.sql` | `filing_obligation` + `filing_applied_rule`/`filing_cited_chunk` (정규화 매핑) + `withholding_payment` + `tax_invoice` (영세율 evidence CHECK) + `penalty_calculation` |
| `0015-notification-events.sql` | `notification_event` 큐 슬롯 |

총 15 신규 테이블 + 20 신규 RLS 정책. `verifier-schema.lambda.ts` 의 `EXPECTED_TABLE_COUNT=28` + `EXPECTED_POLICIES`에 모두 등록.

---

## 3. 3계층 동적 세법 — 핵심 차별화

```
┌──── 계층 3: AgentCore-style Tools (apps/tax-knowledge) ────┐
│  search_tax_law(query, asOfDate)    → KB hybrid + Cohere Rerank
│  find_applicable_benefits(profile)  → KB + 룰엔진 + DDB 캐시
│  recompute_filing_draft(filingId)   → 계층 1만 (KB 미사용)
└──────────────────┬──────────────────────────────────────┘
                   │ 사용자 컨텍스트
┌──── 계층 2: Bedrock Knowledge Base + Aurora pgvector ────┐
│  법제처 OPEN_LAW (12 target) → S3 → Bedrock KB (월 1회 sync)
│  SEMANTIC_HYBRID + Cohere Rerank 3.5 (도쿄 cross-region)
│  metadata 6 filterable + 5 non-filterable (10개 한도 준수)
│  citations 강제, kb_chunk_active 게이트로 신구법 검토 통과 전 노출 차단
└──────────────────┬──────────────────────────────────────┘
                   │ "법인세법 §55 ①"
┌──── 계층 1: Aurora effective-dated tax_rule ────────────┐
│  WHERE effective_from <= :date
│    AND (effective_to IS NULL OR effective_to >= :date)
│  pure function calculators (packages/tax-core)
│  dual approval + audit log + atomic 갱신
└─────────────────────────────────────────────────────────┘
```

**Vector store 결정**: ~~OpenSearch Serverless~~ → **Aurora pgvector** (기존 Aurora cluster의 `kb` DB + `CREATE EXTENSION vector`). 이유:
- OpenSearch Serverless 최소 ~$691/월 (4 OCU) 고정비 — PLAN.md §4.6 비용 모델 ($2.30/user) 깨뜨림
- Aurora는 idle 시 scale-to-zero 가능 → 추가 인프라 비용 ~$0
- Bedrock KB 정식 지원 (2024 GA, hybrid search 포함)
- 한국어 BM25 처리: `pg_bigm` extension 활성화 (multi-byte bigram 인덱스) → Wave-5 PoC로 SEMANTIC_HYBRID 자동 활용 검증

**Reranker**: Cohere Rerank 3.5 (`cohere.rerank-v3-5:0`). 서울 ap-northeast-2 미지원이라 도쿄 ap-northeast-1 cross-region 호출. latency p95 +60~100ms. fallback: Amazon Rerank 1.0 (Wave-5 PoC 후 결정).

---

## 4. 신규 API 19개 (slice 6 9개 + 신규 19개 = 총 28개)

자세한 명세는 [`docs/API_LIST.md`](API_LIST.md) 참조.

| 모듈 | endpoint | Lambda |
|---|---|---|
| Accounts | `GET /accounts/chart` | Journal |
| Sync | `POST /tenants/{id}/sync` (idem-key 필수), `GET /sync/status` | Journal |
| Core Views | `GET /summary/monthly?ym`, `GET /receivables`, `PATCH /receivables/{entryId}`, `GET /accounts/balances` | Journal |
| Drafts | `GET /journal/drafts` (휴리스틱 1차 결과) | Journal |
| Reports | `GET /reports/{pnl,balance-sheet,cash-flow,trial-balance}` | Journal |
| FX | `GET /fx/rates/usd-krw?date|from&to`, `POST /fx/revalue?asOf` | Fx |
| Tax | `GET/POST /corporation-profile`, `GET /filings/upcoming`, `GET /filings/{id}/draft`, `GET /filings/{id}/penalty-simulation`, `POST /filings/{id}/recompute`, `GET /withholding/pending`, `POST /withholding/{id}/file`, `GET /tax-invoices` | Tax |
| Agent | `POST /agent/search-tax-law`, `POST /agent/find-benefits` | TaxKnowledge |
| Admin | `GET /admin/tax-rules`, `POST /admin/tax-rules/{id}/approve` (dual approval), `GET /admin/tax-rules/{id}/change-log`, `GET /admin/tax-law-sync/state`, `POST /admin/tax-law-sync/run`, `GET /admin/tax-rule-reviews`, `POST /admin/tax-rule-reviews/{id}/resolve` | TaxKnowledge |

모든 admin endpoint는 Cognito `ym-tax-admin` group claim 필수.

---

## 5. 외부 API 통합

| API | Adapter | 용도 | 인증 |
|---|---|---|---|
| ECOS Open API (BOK) | `apps/fx/.../ecos-exchange-rate.client.ts` | 731Y001 / 0000001 매매기준율 (IAS 21) | `ECOS_API_KEY` (path) |
| 법제처 OPEN_LAW DRF | `apps/tax-knowledge/.../open-law-go-kr.client.ts` | 12 target — law/lsHstInf/eflaw/oldAndNew/admrul/ordin/licbyl/lstrm/ntsCgmExpc/delHst/lsClsfd/lnkLs | `OPEN_LAW_OC` (query) |
| KASI 특일정보 (천문연) | `apps/tax/.../kasi-holiday.client.ts` | 공휴일 + 대체공휴일 (영업일 롤) | `HOLIDAY_API_SERVICE_KEY` (query) |
| CODEF | (기존) | 은행/카드/외화/세금계산서 | (기존) |
| Bedrock KB + Rerank | `apps/tax-knowledge/.../bedrock-kb.client.ts` | hybrid search + Cohere Rerank | IAM |

---

## 6. 위험 및 완화

| 위험 | 완화 |
|---|---|
| RAG 환각 | system prompt 인용 강제 + Bedrock Guardrails (수치 패턴 차단) + AgentCore Evaluations 5% sampling |
| 미검증 율 사용 | `tax_rule.approved_at=NULL` 응답 시 `verification.allRulesApproved=false` 강제 |
| KB stale | `verification.kbStale` + `lastSyncedAt` 응답에 포함. 30일 미동기화 시 true |
| Rerank cross-region | 도쿄 endpoint 직접 호출 (latency +60~100ms 감수). 실패 시 SEMANTIC_HYBRID retrieve top-5로 fallback |
| 한국어 BM25 dictionary | `pg_bigm` extension 활성화 — multi-byte bigram. Wave-5 PoC로 KB SEMANTIC_HYBRID 통합 검증 |
| Aurora cold start | dev: scale-to-zero / prod: minCapacity=2.0 강제 |
| admin 권한 탈취 | Cognito group + IP allowlist + audit log 3중 방어 |
| dual approval bypass | DB trigger 기반 (애플리케이션 로직 우회 불가) |
| Rerank 비용 폭주 | `RERANK_DAILY_LIMIT_PER_USER=20` env 한도 |

---

## 7. 다음 단계 (Slice 8 후속)

- **Wave-5 PoC**: pg_bigm + Bedrock KB SEMANTIC_HYBRID 통합 검증 + Cohere Rerank cross-region latency 실측
- **find_applicable_benefits 실 구현**: 조특법 KB 검색 + 룰엔진 자격 필터 + AgentCore Code Interpreter 금액 산출
- **`filings/{id}/draft` 실 구현**: tax_rule + 거래 aggregation → 신고서 별지 JSON + PDF S3 업로드
- **알림톡 발송 worker**: `notification_event` 큐 컨슈머 + SNS → Kakao Biz Message
- **AgentCore Phase 2**: PLAN.md §F3의 Coordinator + 4 Specialists 멀티-에이전트
- **영세율 외화증빙 S3 업로드 UI**: `tax_invoice.zero_rate_evidence_s3` CHECK 잠금 해제용

---

## 8. 검증

`scripts/run-persona-e2e.sh` 페르소나 김민지 여정 시나리오 T1~T55+:
- T11 `POST /sync` → 202 + executionArn (ManualSyncStateMachine)
- T13 `GET /sync/status` → status 전이 (fetching → classifying → done)
- T16 `GET /summary/monthly` → income/expense/netCashBalance/forecastNextMonth 4 필드
- T20~T23 reports 4종 회계 항등식 통과
- T29 부가세 draft → `appliedRules` + `citedChunks` 포함
- T34 `agent/search-tax-law` → 인용 ≥1개
- T49 admin 권한 검증 (일반 user → 403)

---

## 9. 비용 모델 영향 (PLAN.md §4.6 갱신 필요)

| 라인 | 변경 |
|---|---|
| ~~OpenSearch Serverless~~ | **제거** ($691/월 회피) |
| **Aurora pgvector** | +$0 (기존 Aurora 분담에 흡수, dev scale-to-zero 유지) |
| **Bedrock embedding (cohere.embed-multilingual-v3)** | ~$0.10/user/월 (초기 ingest + 월 변경분) |
| **Bedrock RetrieveAndGenerate** | ~$0.05/user/월 |
| **Cohere Rerank 3.5 cross-region** | ~$0.02/user/월 (도쿄 + transfer) |
| **Aurora prod minCapacity=2.0** | +~$60/월/cluster (cold-start 회피) |

Net effect: PLAN.md §4.6 $2.30/user 모델 유지 가능.
