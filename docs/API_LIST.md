# YourMillionaire — HTTP API 목록

> **환경 참고**: 개발 계정 기준 HTTP API 베이스 URL은 `docs/STATUS.md`에 기록된 값을 사용한다. (예: `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com/`)

---

## 1. 개발 현황 요약

| 구분 | 내용 |
|------|------|
| **인프라** | Foundation, Network, Data(Aurora + 마이그레이션 **0006–0008** + DynamoDB), Identity(Cognito), Api(HTTP API + JWT + Identity/Journal Lambda), **Ingestion(CDK 스켈레톤, HTTP 없음)** — `docs/STATUS.md` |
| **백엔드 앱** | `apps/identity`, `apps/journal`, **`packages/journal-core`**, `packages/shared-errors` |
| **진행 단계** | Slice 5: journal-core 추출, 캐시 projector, `ai_decisions`·system SELECT RLS·`dispatched_at`, 멱등 예외 매핑·분개 검증 강화 |
| **공통 인증** | Cognito **ID Token**만 통과 (`aud` = User Pool Client ID). Access Token은 사용하지 않는다. |

라우트는 `infrastructure/lib/stacks/api.stack.ts`에 정의되며, Identity Lambda와 Journal Lambda가 `routeKey`로 분기한다.

---

## 2. 공통 사항

### 2.1 성공/에러 응답 포맷

**성공**: 엔드포인트별로 본문 JSON (아래 각 절 참고).

**에러** (애플리케이션이 `toHttpErrorResponse`로 변환하는 경우):

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required."
  }
}
```

`message`는 클라이언트용 **고정 문구**이며, Zod 실패 시에도 상세 필드 오류는 노출하지 않고 동일한 형태로 `code`만 구분한다.

### 2.2 API Gateway (JWT Authorizer) 단계

| 상황 | HTTP | 비고 |
|------|------|------|
| `Authorization` 없음 / 토큰 무효 / 만료 / Audience 불일치 등 | **401** | Lambda까지 도달하지 않을 수 있음. 응답 본문 형식은 API Gateway 기본 형태일 수 있음 |
| Authorizer 통과 | — | Lambda `event.requestContext.authorizer.jwt.claims`에 JWT 클레임 전달 |

`GET /health`만 **의도적으로 인증 없음**.

### 2.3 Lambda 내부 공통

| 상황 | HTTP | `error.code` |
|------|------|----------------|
| 등록되지 않은 `routeKey` | **404** | `NOT_FOUND` |
| 그 외 처리되지 않은 예외 (`Error`, 미매핑 AWS SDK 오류 등) | **500** | `INTERNAL_ERROR` |
| Powertools 멱등 검증 실패(`IdempotencyValidationError` 등) | **409** | `IDEMPOTENCY_KEY_REUSED` 또는 `IDEMPOTENCY_IN_PROGRESS` |

Powertools 예외는 Identity/Journal `main.ts`의 라우트 래퍼에서 위 `AppError` 코드로 치환된다.

`toHttpErrorResponse` 구현: `packages/shared-errors/src/http-error.ts` — `ZodError` → 422 `VALIDATION_ERROR`, `AppError` 서브클래스 → 해당 `statusCode`/`code`, 그 외 → 500.

### 2.4 Cognito 클레임 검증 (Lambda 내부)

모든 인증 라우트는 컨트롤러에서 `sub`(UUID), `email`, `token_use === 'id'`, `aud` 존재를 검사한다. 실패 시 **401** `UNAUTHORIZED` (로그에는 상세 메시지).

---

## 3. API 상세

### 3.1 `GET /health`

| 항목 | 내용 |
|------|------|
| **기능** | **Liveness probe**. DB나 외부 연동 없이 프로세스 생존만 확인한다. |
| **인증** | 없음 |
| **요청** | 쿼리/본문 없음 |
| **응답 200** | `Content-Type: application/json` |

```json
{ "status": "ok" }
```

| 에러 케이스 | HTTP | 코드 | 비고 |
|-------------|------|------|------|
| (앱 로직상 거의 없음) | — | — | 상세 검증 없음 |
| 등록 외 경로 등 | 404 | `NOT_FOUND` | 동일 Lambda에 없는 라우트 — 이론상 |

---

### 3.2 `GET /me`

| 항목 | 내용 |
|------|------|
| **기능** | JWT의 `sub`·`email`로 **사용자를 조회하고, 없으면 생성**(idempotent upsert)한 뒤 프로필을 반환한다. |
| **인증** | 필수 (ID Token) |
| **요청** | 본문 없음 |
| **응답 200** | |

```json
{
  "id": "uuid",
  "cognitoSub": "uuid",
  "email": "user@example.com"
}
```

| 에러 케이스 | HTTP | 코드 |
|-------------|------|------|
| API Gateway JWT 실패 | 401 | (Gateway) |
| JWT 클레임 형식 불일치 (`sub`/email/`token_use`/`aud`) | 401 | `UNAUTHORIZED` |
| DB upsert 등 비정상 (`Upsert returned no row` 등) | 500 | `INTERNAL_ERROR` |
| Lambda 통합 **타임아웃**(VPC→RDS 첫 연결 지연 등) | Gateway **500** 등 | (Gateway 기본 형태 가능; Identity timeout **30s**) |

---

### 3.3 `POST /tenants`

| 항목 | 내용 |
|------|------|
| **기능** | 로그인 사용자를 주체로 **새 테넌트(사업체)와 owner 멤버십**을 생성한다. 사업자등록번호는 KMS로 암호화·HMAC 해시되어 저장되며, **동일 번호 해시 중복** 시 충돌로 처리된다. |
| **인증** | 필수 (ID Token) |
| **멱등성** | 선택 헤더 `Idempotency-Key`. 설정상 키가 없어도 요청은 처리된다 (`throwOnNoIdempotencyKey: false`). 동일 키·동일 본문 재요청 시 **캐시된 응답 재생**(최대 24h TTL, DynamoDB). |
| **요청 헤더** | `Content-Type: application/json` 권장. `Idempotency-Key` 선택. |
| **요청 본문** | |

```json
{
  "legalName": "string, 1–100자",
  "displayName": "string, 1–100자",
  "bizRegNo": "string, 1–12자 — 하이픈 유무와 무관하게 내부에서 10자리 숫자 형식으로 정규화·검증"
}
```

**참고**: 스키마는 길이만 제한하고, **유효한 한국 사업자등록번호 형식**은 유스케이스의 `parseBizRegNo`에서 검사한다 (정규화 후 `NNN-NN-NNNNN`).

| **응답 201** | |

```json
{
  "id": "uuid",
  "legalName": "…",
  "displayName": "…"
}
```

| 에러 케이스 | HTTP | 코드 | 비고 |
|-------------|------|------|------|
| API Gateway JWT 실패 | 401 | (Gateway) | |
| JWT 클레임 불일치 | 401 | `UNAUTHORIZED` | |
| 본문이 올바른 JSON이 아님 | 422 | `VALIDATION_ERROR` | `ValidationError` |
| Zod 스키마 불일치 (필드 누락, 길이 초과 등) | 422 | `VALIDATION_ERROR` | |
| 사업자등록번호 형식 오류 | 422 | `VALIDATION_ERROR` | `InvalidBizRegNoError` (부모가 `ValidationError`) |
| 동일 `biz_reg_no_hash` 이미 존재 (DB unique) | 409 | `CONFLICT` | PG 어댑터에서 `23505` → `ConflictError` (사용자 메시지는 공통 문구) |
| 멱등 키는 같으나 **본문이 이전과 다름** | **409** | `IDEMPOTENCY_KEY_REUSED` | `IdempotencyValidationError` → `apps/identity/src/main.ts` |
| 멱등 처리·DynamoDB·KMS·DB 기타 오류 | 500 | `INTERNAL_ERROR` | |

---

### 3.4 `GET /me/tenants`

| 항목 | 내용 |
|------|------|
| **기능** | 현재 사용자가 소속된 테넌트 목록을 **생성순**으로 반환한다 (RLS 적용 DB 조회). |
| **인증** | 필수 |
| **요청** | 본문 없음 |
| **응답 200** | JSON 배열 |

```json
[
  {
    "id": "uuid",
    "legalName": "…",
    "displayName": "…"
  }
]
```

| 에러 케이스 | HTTP | 코드 |
|-------------|------|------|
| API Gateway JWT 실패 | 401 | (Gateway) |
| JWT 클레임 불일치 | 401 | `UNAUTHORIZED` |
| DB 오류 | 500 | `INTERNAL_ERROR` |
| Lambda **타임아웃**(VPC/RDS 콜드 스타트 등) | **504/502 계열 또는 Gateway 500** | (통합 계층) | Identity Lambda 타임아웃은 CDK에서 **30초**로 설정 |

---

### 3.5 `POST /tenants/{tenantId}/journal/classify`

| 항목 | 내용 |
|------|------|
| **기능** | (1) 멤버십 확인 (2) 차트 비어 있으면 **K-IFRS 시드** (3) **일일 분류 한도**(DynamoDB) (4) **분류기**로 복식 라인 생성 (5) `journal_entries` 저장. **`CDK_ENV=dev`** 배포 시 Lambda 환경변수 **`JOURNAL_STUB_CLASSIFIER=1`** 이면 **`DeterministicStubClassifier`** 가 호출되어 Bedrock 없이 고정 패턴(예: 소모품비/보통예금)으로 균형 분개를 만든다. **`prod`** 는 **`JOURNAL_STUB_CLASSIFIER=0`** + **`BedrockConverseClassifier`**. **`ai_decisions`** 테이블은 마이그레이션만 적용된 상태로, HTTP 경로에서 필수 기록은 아님. |
| **인증** | 필수 |
| **멱등성** | 선택 헤더 `Idempotency-Key`. 키가 없으면 멱등 레이어 없이 매번 실행. 키는 **헤더가 있으면 헤더**, 없으면 본문 `date`·`amount`·`counterparty`·`memo`를 결합해 유도된다 (`main.ts`의 JMESPath). TTL 24h. |
| **경로 변수** | `tenantId`: UUID 문자열 |

**요청 본문**:

```json
{
  "date": "YYYY-MM-DD",
  "amount": "양의 number",
  "counterparty": "string, 1–200자",
  "memo": "string, 1–500자"
}
```

**응답 201**:

```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "entryDate": "YYYY-MM-DD",
  "aiConfidence": 0.85,
  "aiModel": "stub.k-ifrs-expense",
  "lines": [
    {
      "lineNo": 1,
      "accountCode": "1002",
      "debit": 0,
      "credit": 0,
      "memo": "optional — classifier가 넣지 않으면 생략 가능"
    }
  ]
}
```

**참고**: `prod`·스텁 해제 시 `aiModel` 은 `BEDROCK_MODEL_ID`(예: inference profile ID)를 반영한다.

**참고**: 유스케이스는 엔티티 `source`를 코드상 `'manual'`로 넣는다 (DB 의미 정렬은 별도 이슈).

| 에러 케이스 | HTTP | 코드 | 비고 |
|-------------|------|------|------|
| API Gateway JWT 실패 | 401 | (Gateway) | |
| JWT 클레임 불일치 | 401 | `UNAUTHORIZED` | |
| 테넌트 비멤버 또는 존재하지 않는 테넌트(조회상 멤버 아님) | **403** | `FORBIDDEN` | `VerifyTenantMembershipUseCase` — **404가 아님** |
| 본문 JSON 파싱 실패 | 422 | `VALIDATION_ERROR` | |
| Zod 입력 불일치 (날짜 형식, amount ≤ 0, 문자열 길이 등) | 422 | `VALIDATION_ERROR` | |
| AI 출력 구조/Zod 검증 실패 (`ClassifyOutputSchema`) | 422 | `VALIDATION_ERROR` | `ZodError` |
| **차변·대변 불균형** (`createJournalEntry` → `assertBalanced`) | **422** | `UNBALANCED_JOURNAL` | `UnbalancedJournalError` |
| 일일 분류 호출 한도 초과 (DynamoDB 카운터) | **429** | `BEDROCK_DAILY_LIMIT_EXCEEDED` | |
| Bedrock **스로틀** | **429** | `BEDROCK_THROTTLED` | `ThrottlingException` → `RateLimitError` |
| Bedrock **미가용**(모델 미승인·리전·use-case 미제출 등) | **503** | `BEDROCK_UNAVAILABLE` | `ResourceNotFoundException`, `AccessDeniedException`, `ServiceUnavailableException` 매핑(`journal-core` classifier) |
| Bedrock 응답 구조 오류(툴 결과 없음 등)·기타 미처리 `Error` | 500 | `INTERNAL_ERROR` | |
| `createJournalLine` 규칙 위반 (한 라인에 차·대 동시 양수 등) | **422** | `INVALID_JOURNAL_LINE` | |
| PG 저장 실패 | 500 | `INTERNAL_ERROR` | |
| 멱등 충돌(동일 키·다른 본문) | **409** | `IDEMPOTENCY_KEY_REUSED` | `apps/journal/src/main.ts` 에서 Powertools 검증 오류 매핑 |

---

### 3.6 `POST /tenants/{tenantId}/journal/entries`

| 항목 | 내용 |
|------|------|
| **기능** | 호출자가 지정한 **수동 복식분개**를 검증·저장한다. 멤버십 확인 후 **`findMissingCodes`** 로 계정코드 일괄 검증; 누락 시 저장하지 않는다. 차트가 비어 있으면 유스케이스가 **시드 계정 삽입**을 선행한다 (`ensure-accounts-seeded`). |
| **인증** | 필수 |
| **멱등성** | **없음** (`makeIdempotent` 미적용). 동일 요청은 중복 삽입될 수 있음. |
| **경로 변수** | `tenantId` |

**요청 본문**:

```json
{
  "entryDate": "YYYY-MM-DD",
  "description": "optional string, max 500",
  "lines": [
    {
      "lineNo": "정수, ≥1",
      "accountCode": "string, 1–10자",
      "debit": "number ≥ 0",
      "credit": "number ≥ 0",
      "memo": "optional, max 500"
    }
  ]
}
```

스키마상 `lines`는 **최소 2줄**. 각 줄은 스키마만으로는 "차변 XOR 대변"을 강제하지 않음 — **도메인** `createJournalLine`에서 정확히 한쪽만 양수여야 하며, 위반 시 **422** `INVALID_JOURNAL_LINE`.

**응답 201**:

```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "entryDate": "YYYY-MM-DD",
  "lines": [
    {
      "lineNo": 1,
      "accountCode": "1002",
      "debit": 0,
      "credit": 0,
      "memo": null
    }
  ]
}
```

| 에러 케이스 | HTTP | 코드 | 비고 |
|-------------|------|------|------|
| API Gateway JWT 실패 | 401 | (Gateway) | |
| JWT 클레임 불일치 | 401 | `UNAUTHORIZED` | |
| 비멤버 | 403 | `FORBIDDEN` | |
| JSON 파싱 실패 | 422 | `VALIDATION_ERROR` | |
| Zod 불일치 (날짜, lines 개수, 필드 범위 등) | 422 | `VALIDATION_ERROR` | |
| 차대 불균형 | 422 | `UNBALANCED_JOURNAL` | |
| 존재하지 않는 **계정코드** (`findMissingCodes`) | **422** | **`INVALID_ACCOUNT_CODE`** | |
| 라인 규칙 위반 (`createJournalLine`) | **422** | **`INVALID_JOURNAL_LINE`** | |
| DB 오류 | 500 | `INTERNAL_ERROR` | |

**참고**: 도메인 **`InvalidAccountCodeError`(422)**는 수동 분개 경로에서 **`findMissingCodes`** 로 선행 검증된다.

---

## 4. 애플리케이션 `AppError` 코드 빠른 참조

| code | HTTP | 용도 |
|------|------|------|
| `UNAUTHORIZED` | 401 | 인증·클레임 실패 |
| `FORBIDDEN` | 403 | 테넌트 비멤버 |
| `NOT_FOUND` | 404 | 공용 (Lambda unknown route); 도메인 `TenantNotFoundError` 등은 identity 앱 현재 라우트에서 직접 던지지 않음 |
| `CONFLICT` | 409 | 테넌트 사업자번호 중복 등 |
| `VALIDATION_ERROR` | 422 | JSON/Zod/형식 |
| `INVALID_ACCOUNT_CODE` | 422 | 차트에 없는 계정코드 |
| `INVALID_JOURNAL_LINE` | 422 | 한 줄 차·대 규칙 위반 |
| `UNBALANCED_JOURNAL` | 422 | 분개 불일치 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 동일 `Idempotency-Key`에 다른 본문 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 동일 키 처리 중 |
| `BEDROCK_UNAVAILABLE` | 503 | Bedrock 호출 불가(설정·권한·모델 상태) |
| `BEDROCK_THROTTLED` | 429 | Bedrock API 스로틀 |
| `BEDROCK_DAILY_LIMIT_EXCEEDED` | 429 | 일일 앱 한도 |
| `INTERNAL_ERROR` | 500 | 미처리 예외 |

---

## 5. 엔드포인트 일람

| Method | Path | Lambda | 인증 |
|--------|------|--------|------|
| GET | `/health` | Identity | 없음 |
| GET | `/me` | Identity | JWT |
| POST | `/tenants` | Identity | JWT |
| GET | `/me/tenants` | Identity | JWT |
| POST | `/tenants/{tenantId}/journal/classify` | Journal | JWT |
| POST | `/tenants/{tenantId}/journal/entries` | Journal | JWT |

이 문서는 저장소의 **현재 코드**(`api.stack.ts`, 각 controller/schema/use-case)를 기준으로 작성되었다. 인프라 출력 URL·스테이지 prefix가 붙는 경우가 있으면 실제 호출 시 Base URL을 배포 출력으로 맞춘다.
