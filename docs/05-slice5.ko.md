# Slice 5 — journal-core · 운영 안정화 · Ingestion/FX 골격

Slice 5는 **공유 도메인 패키지**와 **운영 중 발견된 장애(타임아웃·Bedrock 미설정·멱등 경고)**를 코드와 IaC로 정리하고, CODEF/환율 파이프라인용 **비HTTP 스택 골격**을 추가하는 단계다.

---

## 1. 목표와 범위

| 영역 | 내용 |
|------|------|
| **도메인 재사용** | `@ym/journal-core` — 분개 엔티티/값 객체/도메인 오류, Bedrock 분류기·스텁 분류기, PG 저장 배치 유틸, DynamoDB 캐시 projector |
| **HTTP API 신뢰성** | Identity Lambda **VPC→RDS 콜드 스타트** 대비 **timeout 30s**; Powertools **`registerLambdaContext`**| Journal **`dev` 스텁 분류기**로 Anthropic/Bedrock 미완료 계정에서도 분류 API 검증 가능 |
| **에러 계약** | Bedrock SDK — `ResourceNotFoundException`·`AccessDeniedException`·`ServiceUnavailableException` → **`503` `BEDROCK_UNAVAILABLE`**; `ThrottlingException` → **`429` `BEDROCK_THROTTLED`** |
| **데이터 모델** | 마이그레이션 **0006** `ai_decisions`, **0007** 시스템 사용자·`tenants_system_select`, **0008** `raw_transactions.dispatched_at` + 부분 인덱스 |
| **인프라 골격** | `IngestionStack` — SQS·DLQ·SFN Map·EventBridge 스케줄·알람; `apps/codef`·`apps/fx` **스텁 Lambda**; Foundation **`EcosCredentialSecret`** 슬롯 |
| **비밀 동기화** | `scripts/sync-secrets-from-env.sh` — 로컬 `.env` 기반 Secrets Manager 반영 (비밀은 저장소에 커밋하지 않음) |

---

## 2. 해결한 운영 이슈 (요약)

### 2.1 `GET /me` Gateway 500 / Lambda timeout

- **원인:** Identity Lambda가 **PRIVATE_ISOLATED** 서브넷에서 Aurora로 **RDS IAM + TCP** 연결을 맺을 때, 콜드 스타트에서 **10초** Lambda 타임아웃 내에 완료되지 않는 경우가 있었다.
- **조치:** `api.stack.ts`에서 Identity **`timeout: 30s`** (Journal과 동일 수준).

### 2.2 Bedrock `ResourceNotFoundException` (Anthropic use-case 미제출)

- **원인:** 계정에서 모델 사용 승인·use-case 폼 미완료 시 Converse 호출이 **404** 계열 예외로 끝나, 기존에는 **`INTERNAL_ERROR`(500)** 로만 노출되었다.
- **조치 (prod 경로):** `BedrockConverseClassifier`에서 위 예외를 **`BedrockUnavailableError`(503)** 로 매핑해 클라이언트가 구분 가능하게 함.
- **조치 (dev 경로):** **`JOURNAL_STUB_CLASSIFIER=1`** (`deploymentEnv === 'dev'`)일 때 **`DeterministicStubClassifier`** 사용 — 고정 차변·대변(시드 계정 코드 기준)·`aiModel: stub.k-ifrs-expense`. **비용·외부 의존 없이** E2E·회귀 테스트에 적합.

### 2.3 Powertools Idempotency “remaining time” 경고

- **원인:** `IdempotencyConfig`에 Lambda **`context`** 미등록.
- **조치:** Identity/Journal 핸들러 초반에 **`registerLambdaContext(context)`** 호출 (`tenantCreateIdempotencyConfig` / `classifyIdempotencyConfig`).

### 2.4 분개·테넌트 API 에러 정합성

- 수동 분개: **`findMissingCodes`** → **`INVALID_ACCOUNT_CODE`(422)**; 라인 규칙 → **`INVALID_JOURNAL_LINE`(422)**.
- 멱등 본문 불일치: **`IDEMPOTENCY_KEY_REUSED`(409)** (Identity·Journal 동일 패턴).

---

## 3. 테스트와 E2E

| 종류 | 명령 / 산출물 |
|------|----------------|
| **유닛·스택** | 루트 `npm test` — Infrastructure **`ApiStack`** 에 `JOURNAL_STUB_CLASSIFIER` dev/prod 검증 추가 |
| **터미널 HTTP E2E** | `./scripts/run-api-e2e.sh` — `docs/api-e2e-raw.ndjson`; 최신 녹색 **`26/26`** (`docs/API_E2E_RESULTS_20260507.md`) |
| **인증** | `API_E2E_PASSWORD`(+ 선택 `API_E2E_USERNAME`) 또는 `ID_TOKEN`; Cognito 사용자 생성 시 **비밀번호 정책(특수문자 등)** 준수 |

---

## 4. 스키마 단일 진실

- **`schema.sql`** 에 **0006–0008** 내용 통합: `ai_decisions`, `tenants_system_select`, `dispatched_at`·인덱스, 시스템 사용자 시드 `INSERT ... ON CONFLICT DO NOTHING`.
- **`verifier-schema`** 화이트리스트와 테이블 개수(11)와 일치.

---

## 5. 스텁·후속 (Slice 6+)

- **CODEF 실연동:** mock/raw INSERT/SQS 본문·워커 트랜잭션·`ai_decisions` 채움.
- **SFN Map:** `iterator` → **`itemProcessor`** 로 교체 (현재 deprecated 경고).
- **운영 Bedrock:** `prod` 에서 **`JOURNAL_STUB_CLASSIFIER=0`** 유지, 콘솔에서 모델 액세스·use-case 완료 후 검증.
- **RDS Proxy:** 동시성 증가 시 검토.

---

## 6. 비용·운영 메모

- **Dev 스텁 분류:** classify 경로에서 Bedrock 호출이 없어 **토큰 비용 0** (일일 한도 카운터 DynamoDB는 여전히 증가 — 스텁도 “분류 시도”로 카운트).
- **Ingestion/FX 스케줄:** 스텁 Lambda 위주면 고정비보다 **실행 횟수·알람·NAT egress**(실연동 시)가 지배적.

---

## 7. 관련 문서

| 문서 | 역할 |
|------|------|
| `docs/API_LIST.md` | HTTP 라우트·에러 코드·dev 스텁 동작 |
| `docs/API_E2E_RESULTS_20260507.md` | E2E 시나리오 표·운영 수정 요약 |
| `docs/STATUS.md` | 스택 배포 상태 요약 |
| `CLAUDE.md` | 레포 공통 구현 규칙 |
