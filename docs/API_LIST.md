# YourMillionaire — Frontend Integration Guide

> **Audience**: 이 백엔드를 호출할 프론트엔드 개발자.
> **단일 출처**: 이 문서만 보고 클라이언트 통합을 끝낼 수 있도록 작성됨.
> **Last verified**: 2026-05-13 (deployed dev 환경에서 라이브 응답 캡처, migrations 0001–0023 적용).

---

## TL;DR

```
HTTP API (REST)     : https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com
CodefSyncStreamFnUrl: https://vh3nq63kxcjcrjkabaikqrddzm0ymhbf.lambda-url.ap-northeast-2.on.aws/  (SSE)
TaxStrategyFnUrl    : https://la3losebvhzb5yrzliyopfcl6m0qikyd.lambda-url.ap-northeast-2.on.aws/  (SSE)
Cognito Domain      : https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com
Region              : ap-northeast-2
Auth scheme         : Cognito ID Token (Bearer), 발급은 Hosted UI 또는 SDK
CORS allowed        : http://localhost:3000, http://localhost:5173 (env로 추가 가능)
```

세 가지 base URL을 구분해서 호출한다:
- **HTTP API** — 모든 REST endpoint (CRUD, 조회).
- **CodefSyncStreamFnUrl** — `POST /tenants/{id}/fs/sync` 전용. text/event-stream 으로 답함.
- **TaxStrategyFnUrl** — `POST /tenants/{id}/tax/strategy` 전용. text/event-stream.
- **FxStrategyFnUrl** — `POST /tenants/{id}/fx/strategy` 전용. text/event-stream.

CDK output (`Ym-Dev-Api.HttpApiUrl`, `Ym-Dev-Api.CodefSyncStreamFnUrl`, `Ym-Dev-Api.TaxStrategyFnUrl`)이 권위 있는 출처.

---

## 1. 인증 (Cognito ID Token)

### 1.1 Google OAuth via Cognito Hosted UI

```
Step 1 — 로그인 버튼 → Cognito Hosted UI 로 redirect:
  https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com/oauth2/authorize
    ?client_id=6sop98o9dvge94bsipftmkrkeh
    &response_type=code
    &scope=email+openid+profile
    &identity_provider=Google
    &redirect_uri=<프론트엔드 callback URL — 사전 등록 필요>

Step 2 — Cognito가 code 와 함께 callback URL로 redirect

Step 3 — Token 교환 (PKCE 권장):
  POST https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com/oauth2/token
  → { id_token, access_token, refresh_token, expires_in: 3600 }

Step 4 — API 호출: Authorization: Bearer <id_token>
```

ID Token TTL = 1시간, Refresh Token TTL = 30일. **API 호출에는 `id_token` 만 사용** (`access_token` 무시).

### 1.2 추천 헤더

| 헤더 | 언제 |
|------|------|
| `Authorization: Bearer <id_token>` | `/health` 외 모든 endpoint |
| `Content-Type: application/json` | POST / PATCH 본문 있을 때 |
| `Idempotency-Key: <uuid>` | `POST /tenants`, `POST /journal/classify` 권장 |

---

## 2. 공통 규약

### 2.1 에러 응답

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```

API Gateway 가 직접 차단한 401 은 envelope 없이:
```json
{ "message": "Unauthorized" }
```

FE는 두 형식 모두 처리해야 함 — 401이면 토큰 재발급 화면으로.

### 2.2 HTTP status code

| HTTP | 의미 | FE 대응 |
|---|---|---|
| 200 / 201 | 성공 | — |
| 400 | 본문이 JSON 아님 | form 점검 |
| 401 | 토큰 문제 | 재로그인 |
| 403 | tenant 멤버 아님 | 다른 tenant 선택 (`GET /me/tenants`) |
| 404 | 리소스 없음 | URL 확인 |
| 409 | 중복 / Idempotency 충돌 / 상태 전이 불가 | 메시지 안내 |
| 422 | 입력 검증 실패 / 라인 unbalanced 등 | form 재검증 |
| 429 | Bedrock 한도 초과 / throttling | 자동 재시도 X, 시간 두고 재시도 |
| 500 | 미처리 예외 | 로깅 + 재시도 |
| 502 / 503 / 504 | 외부 서비스 장애 | 일시 장애 안내 |

### 2.3 응답 필드 형식

| 항목 | 형식 |
|---|---|
| ID (`id`, `tenantId`, `entryId`) | UUID v4 |
| 날짜 (`entryDate`) | `YYYY-MM-DD` |
| 시각 (`createdAt`) | ISO 8601 UTC (`Z` suffix) |
| 금액 (개별 line `debit`/`credit`) | 정수 KRW |
| 집계 금액 (P&L, BS, summary, balances 등) | **AmountBreakdown** — `{ certain, uncertain, total }` (자세히는 §4) |
| Organization 코드 | 4자리 문자열 (`"0088"` 신한, `"0020"` 우리, `"0081"` 하나) |

### 2.4 Pagination

리스트 endpoint:
- `limit`: 1~100, default 20
- `offset`: 0+, default 0
- 응답 키: `entries` (journal), `runs` (sync_run history) 등

### 2.5 Idempotency

`POST /tenants`, `POST /journal/classify` 는 `Idempotency-Key` 헤더 지원. 동일 키 + 동일 body → 24h 동안 첫 응답 재생. 동일 키 + 다른 body → `409 IDEMPOTENCY_KEY_REUSED`.

---

## 3. SSE — `POST /tenants/{tenantId}/fs/sync` (단일 호출로 모든 결과 받기)

> **이 endpoint 가 가장 중요합니다.** 사용자가 "내 통장 거래 분개해줘" 라고 누르면 이 한 호출로 끝납니다. CODEF 호출 + Bedrock 분류 + DB 저장 + 결과 전달까지 한 connection 에서 진행됩니다.

```
Base URL: CodefSyncStreamFnUrl (Function URL, NOT API Gateway)
Method:   POST
Path:     /tenants/{tenantId}/fs/sync
Headers:  Authorization: Bearer <id_token>
          Content-Type: application/json
```

### 3.1 Request body (전부 optional)

```json
{
  "from": "2026-04-01",
  "to":   "2026-04-30",
  "accountIds": ["uuid", "uuid"]
}
```

- `from` / `to` 둘 다 생략하면 incremental (latestFetchedAt - 2일 ~ 오늘).
- `from` / `to` 둘 중 하나만 보내면 422.
- `to - from > 366` 일이면 422.
- `accountIds` 생략 시 tenant 의 활성 계좌 전부.

### 3.2 Response — `text/event-stream`

```
data: {"type":"run-started","syncRunId":"<uuid>","dateRange":{"from":null,"to":null}}

data: {"type":"account","bankAccountId":"<uuid>","organization":"0088","accountNumberMasked":"********8154",
        "outcome":"success","fetchedCount":12,"balanceUpdated":true,
        "balance":{"previous":1000000,"current":1234567,"delta":234567,"currency":"KRW"},
        "codefErrorCode":null,"codefErrorMessage":null,"userMessage":null}

data: {"type":"classification","rawTransactionId":"<uuid>",
        "sourceAccount":{"bankAccountId":"<uuid>","organization":"0088","accountNumberMasked":"********8154"},
        "occurredAt":"2026-04-15T09:32:00.000Z","entryDate":"2026-04-15",
        "counterparty":"스타벅스 강남점","memo":"스타벅스 강남점",
        "amount":6500,"currency":"KRW",
        "status":"certain",           ← certain | uncertain
        "origin":"ai",                ← heuristic | ai | ai_low_conf
        "confidence":0.92,
        "ruleId":"bedrock:global.anthropic.claude-sonnet-4-6",
        "lines":[
          {"lineNo":1,"accountCode":"5101","debit":6500,"credit":0,"memo":null},
          {"lineNo":2,"accountCode":"1001","debit":0,"credit":6500,"memo":null}
        ],
        "journalEntryId":"<uuid>"}    ← certain 일 때만 채워짐. uncertain 은 entryId 가 따로 있고 PATCH/confirm 으로 접근

data: {"type":"heartbeat","ts":1778635312000}    ← 10초마다, Lambda timeout 방지

data: {"type":"done","syncRunId":"<uuid>",
        "totals":{"accountsScanned":1,"accountsSucceeded":1,"accountsFailed":0,
                  "transactionsFetched":12,"transactionsCertain":8,"transactionsUncertain":4},
        "durationMs":2652}
```

### 3.3 에러 발생 시

```
data: {"type":"error","status":<HTTP code>,"reason":"<userMessage>"}
data: {"type":"done","syncRunId":"<uuid|null>","durationMs":<n>,"failed":true}
```

### 3.4 FE 구현 메모

- 표준 `EventSource` 가 POST 를 지원하지 않으므로 fetch + `ReadableStream` 으로 처리하거나 [`fetch-event-source`](https://github.com/Azure/fetch-event-source) 같은 라이브러리 사용.
- `classification` 이벤트가 들어올 때마다 list 에 prepend. `status: 'certain'` 은 즉시 화면에, `'uncertain'` 은 별도 색 / 검토 배지 + PATCH 버튼.
- `done` 이벤트 후 connection 종료. 별도 GET 으로 결과 재조회할 필요 없음 — 모든 분개는 `GET /entries` 로 동일하게 조회 가능.

---

## 4. AmountBreakdown — 집계 응답의 공통 모양

P&L / BS / CF / TB / monthly summary / accounts balances / receivables 등 **모든 집계 금액 필드**는 다음 형식:

```json
{ "certain": 12000000, "uncertain": 3000000, "total": 15000000 }
```

- `certain` — `confidence_status='certain'` 인 분개의 합. 신뢰 가능한 audit-grade 숫자.
- `uncertain` — `confidence_status='uncertain'` 인 분개의 합. AI 추정. 사용자가 확정하기 전.
- `total` — `certain + uncertain`. 보통 화면에 메인으로 노출되는 숫자.

**FE 권장 렌더링**: total 을 큰 글씨로 보여주고, uncertain 비중을 작은 글씨/배지로 ("그 중 AI 추정 3,000,000원"). 색은 회색/노란색 등 신뢰도 시각화.

별도 토글이나 query param 없이 항상 셋 다 반환된다 — 백엔드가 데이터를 숨기지 않는다.

---

## 5. Endpoint Reference (HTTP API)

라벨: 🟢 일반 사용자 UI / 🟡 회계 전문가·관리자 / 🔴 디버깅 전용

### 5.1 인증 / 사용자

#### `GET /health` 🟢

| 항목 | 내용 |
|---|---|
| **인증** | 불필요 |
| **응답 200** | `{ "status": "ok" }` |

#### `GET /me` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | JWT 의 sub/email 로 user upsert + personal tenant 자동 발급 |
| **인증** | 필수 |
| **응답 200** | `{ id, cognitoSub, email, defaultTenantId, tenantType }` |
| **호출 빈도** | 로그인 직후 1회 + 토큰 갱신 시 1회 (캐시). 페이지마다 호출 X |

#### `GET /me/tenants` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | 사용자가 멤버인 tenant 리스트 |
| **응답 200** | `[ { id, legalName, displayName }, ... ]` |

#### `POST /tenants` 🟡 (법인 사용자만)

| 항목 | 내용 |
|---|---|
| **기능** | 법인 사용자가 BRN 기반 tenant 명시 생성. 개인 사용자는 `/me` 가 자동 발급 |
| **Body** | `{ legalName, displayName, bizRegNo? }` — bizRegNo 는 10자리 숫자 |
| **응답 201** | `{ id, legalName, displayName }` |
| **에러** | 409 `CONFLICT` (BRN 중복), 422 `VALIDATION_ERROR` (BRN 형식) |

### 5.2 은행 연결

#### `POST /tenants/{tenantId}/bank-connections` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | CODEF 에 은행 자격증명 1회 인증 → `connectedId` 발급 + 보유 계좌 디스커버리. **신한 5회 PW 오류 → 인뱅 잠금. 무한 retry 금지** |
| **Body** | `{ organization, loginId, loginPassword, birthDate? }` |
| **응답 200** | `{ connectionId, accounts: [{ accountNumber, accountName, balance }] }` |
| **에러** | 502 `CODEF_ACCOUNT_ERROR` (메시지에 "lock" 포함 시 잠금 임박 → 즉시 경고), 502 `CODEF_API_ERROR` |

#### `POST /tenants/{tenantId}/bank-accounts` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | bank-connections 의 accounts 에서 선택한 계좌를 모니터링 대상으로 등록. 자격증명 재입력 불필요 |
| **Body** | `{ organization, accountNumber }` |
| **응답 201** | `{ id, tenantId, organization, accountNumber, isActive }` |
| **에러** | 422 `NO_BANK_CONNECTION` (먼저 bank-connections 필요), 409 `CONFLICT` (중복 등록) |

### 5.3 분개 (Unified Entries)

> 이전의 `/journal/entries` + `/journal/drafts` + `/uncertain` 은 모두 **단일 `/entries` 로 통합**되었다 (migration 0023). 모든 분개는 한 endpoint 에서 `confidenceStatus` 필드로 구분된다.

#### `GET /tenants/{tenantId}/entries` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | 모든 분개 (certain + uncertain + discarded) 를 confidenceStatus 라벨과 함께 반환. 별도 토글 없음 |
| **쿼리** | `from` (필수), `to` (필수), `limit` (1–500, default 20), `offset` (default 0), `confidenceStatus` (`certain` \| `uncertain` \| `discarded` \| `all`, default `all`) |

응답 200:
```json
{
  "entries": [
    {
      "id": "<uuid>",
      "tenantId": "<uuid>",
      "entryDate": "2026-04-15",
      "postingDate": "2026-05-13",
      "source": "codef_bank",
      "sourceRefId": "<uuid>",
      "description": "스타벅스 강남점",
      "status": "posted",
      "confidenceStatus": "certain",
      "confidence": 0.92,
      "origin": "ai",
      "syncRunId": "<uuid>",
      "aiModel": "global.anthropic.claude-sonnet-4-6",
      "createdAt": "2026-04-15T...",
      "createdBy": "<uuid>",
      "lines": [
        { "lineNo": 1, "accountCode": "5101", "accountName": "복리후생비", "accountType": "expense", "debit": 6500, "credit": 0, "memo": null },
        { "lineNo": 2, "accountCode": "1001", "accountName": "현금",       "accountType": "asset",   "debit": 0,    "credit": 6500, "memo": null }
      ]
    }
  ],
  "accountBalances": [ { id, organization, accountNumber, currentBalance, withdrawable, currency, syncedAt, isStale } ],
  "uncertain": {
    "count": 5,
    "message": "AI가 5건을 확신 없이 분류했습니다. confidenceStatus=\"uncertain\" 인 항목을 검토/수정/확정해 주세요.",
    "confirmEndpoint": "/tenants/{tenantId}/entries/{entryId}/confirm",
    "discardEndpoint": "/tenants/{tenantId}/entries/{entryId}/discard",
    "patchEndpoint":   "/tenants/{tenantId}/entries/{entryId}"
  }
}
```

#### `PATCH /tenants/{tenantId}/entries/{entryId}` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | uncertain 분개의 라인을 in-place 정정. certain 항목에는 사용 불가 (회계 immutability — reverse-by 체인 미구현) |
| **Body** | `{ "lines": [{ lineNo, accountCode, debit, credit, memo? }, ...] }` — 최소 2개, 차변 합 = 대변 합 |
| **응답 200** | 갱신된 EntryRow (위 GET 응답과 동일 shape) |
| **에러** | 409 `CONFLICT` (certain 항목에 PATCH), 422 `VALIDATION_ERROR` (unbalanced) |

#### `POST /tenants/{tenantId}/entries/{entryId}/confirm` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | uncertain → certain 전환. 같은 row 유지, `confidence_status` + `status` 만 갱신 |
| **Body** | `{}` (또는 비워도 됨) |
| **응답 200** | 갱신된 EntryRow |
| **에러** | 409 (discarded 항목), 404 (없음) |

#### `POST /tenants/{tenantId}/entries/{entryId}/discard` 🟢

| 항목 | 내용 |
|---|---|
| **기능** | uncertain → discarded 전환. row 보존, 모든 집계에서 제외 |
| **Body** | `{}` |
| **응답 200** | 갱신된 EntryRow |
| **에러** | 409 (certain 항목), 404 |

#### `POST /tenants/{tenantId}/journal/classify` 🟡 (수동 분류)

| 항목 | 내용 |
|---|---|
| **기능** | 거래 1건을 즉시 동기 분류. 보통은 SSE `/fs/sync` 가 처리하므로 호출할 일 거의 없음 |
| **Body** | `{ date, amount, counterparty, memo }` |
| **응답 201** | 저장된 EntryRow |
| **에러** | 429 `BEDROCK_DAILY_LIMIT_EXCEEDED` (사용자별 100/일), 429 `BEDROCK_THROTTLED`, 503 `BEDROCK_UNAVAILABLE` |
| **권장** | `Idempotency-Key` 헤더 |

#### `POST /tenants/{tenantId}/journal/entries` 🟡 (수동 분개)

| 항목 | 내용 |
|---|---|
| **기능** | 회계 전문가가 수동으로 분개를 입력 |
| **Body** | `{ entryDate, description, lines: [...] }` — 최소 2개 line, balanced |
| **응답 201** | 저장된 EntryRow |
| **에러** | 422 `UNBALANCED_JOURNAL`, 422 `INVALID_JOURNAL_LINE`, 422 `INVALID_ACCOUNT_CODE` |

### 5.4 재무제표 (모두 AmountBreakdown 반환)

#### `GET /tenants/{tenantId}/reports/pnl` 🟢

| 항목 | 내용 |
|---|---|
| **쿼리** | `from`, `to` (필수, `YYYY-MM-DD`) |

응답 200:
```json
{
  "from": "2026-04-01", "to": "2026-04-30", "currency": "KRW",
  "revenue":          { "items": [...], "subtotal": { certain, uncertain, total } },
  "cogs":             { "items": [...], "subtotal": {...} },
  "grossProfit":      { certain, uncertain, total },
  "operatingExpenses":{ "items": [...], "subtotal": {...} },
  "operatingIncome":  { certain, uncertain, total },
  "nonOperating":     { "items": [...], "subtotal": {...} },
  "netIncomeBeforeTax": { certain, uncertain, total },
  "incomeTax":        { certain, uncertain, total },
  "netIncome":        { certain, uncertain, total },
  "metadata": {
    "generatedAt": "...", "accountingStandard": "K-IFRS",
    "uncertainEntryCount": 23,
    "note": "23 entries are AI-suggested and not yet user-confirmed. Their amounts are included in every total as the \"uncertain\" breakdown; \"certain\" is the audit-grade subset."
  }
}
```

`items[].amount` 도 동일하게 `{ certain, uncertain, total }`.

#### `GET /tenants/{tenantId}/reports/balance-sheet` 🟢

| 쿼리 | `asOf` (필수) |

응답:
```json
{
  "asOf": "2026-04-30", "currency": "KRW",
  "assets":      { "current": {...}, "nonCurrent": {...}, "total": { certain, uncertain, total } },
  "liabilities": { "current": {...}, "nonCurrent": {...}, "total": {...} },
  "equity":      { "items": [...], "subtotal": {...} },
  "totalLiabilitiesAndEquity": { certain, uncertain, total },
  "metadata": {...}
}
```

#### `GET /tenants/{tenantId}/reports/cash-flow` 🟢

| 쿼리 | `from`, `to` |

응답 (indirect method):
```json
{
  "from": "...", "to": "...", "currency": "KRW", "method": "indirect",
  "operating": { "items": [...], "subtotal": {...} },
  "investing": {...}, "financing": {...},
  "netChange":   { certain, uncertain, total },
  "openingCash": { certain, uncertain, total },
  "closingCash": { certain, uncertain, total },
  "metadata": {...}
}
```

#### `GET /tenants/{tenantId}/reports/trial-balance` 🟢

| 쿼리 | `asOf` |

응답:
```json
{
  "asOf": "...", "currency": "KRW",
  "rows": [
    { "accountCode": "1002", "accountName": "보통예금",
      "debit":   { certain, uncertain, total },
      "credit":  { certain, uncertain, total },
      "balance": { certain, uncertain, total } }
  ],
  "totalDebit":  { certain, uncertain, total },
  "totalCredit": { certain, uncertain, total },
  "metadata": {...}
}
```

### 5.5 Views

#### `GET /tenants/{tenantId}/summary/monthly` 🟢

| 쿼리 | `ym` (필수, `YYYY-MM`) |

```json
{
  "ym": "2026-04",
  "income":          { certain, uncertain, total },
  "expense":         { certain, uncertain, total },
  "netCashBalance":  { certain, uncertain, total },
  "forecastNextMonth": { certain, uncertain, total },
  "currency": "KRW"
}
```

#### `GET /tenants/{tenantId}/accounts/balances` 🟢

```json
{
  "balances": [
    { "accountCode": "1002", "accountName": "보통예금", "displayName": "통장에 있는 돈",
      "type": "asset", "currency": "KRW",
      "balance": { certain, uncertain, total } }
  ]
}
```

#### `GET /tenants/{tenantId}/receivables` 🟢

매출채권 칸반 (PENDING / DUE_SOON / OVERDUE / COLLECTED). 각 카드에 `confidenceStatus`:
```json
{
  "pending": [
    { "entryId": "...", "entryDate": "...", "counterparty": "...",
      "amount": 1200000, "dueDate": "...", "daysOverdue": 0,
      "confidenceStatus": "uncertain" }
  ],
  "dueSoon": [...], "overdue": [...], "collected": [...]
}
```

#### `PATCH /tenants/{tenantId}/receivables/{entryId}` 🟢

| Body | `{ "status": "PENDING" | "DUE_SOON" | "OVERDUE" | "COLLECTED", "collectedAt"?: "YYYY-MM-DD" }` |

### 5.6 기타

#### `GET /accounts/chart` 🟢

K-IFRS 기본 계정과목 차트 (account_code → name 매핑). FE 가 PATCH 시 accountCode 선택 UI 에 사용.

---

## 6. SSE — `POST /tenants/{tenantId}/tax/strategy` 🟡 (별개 endpoint)

```
Base URL: TaxStrategyFnUrl
Body:     { "tenantId": "<uuid>", "scenario": "..." }
```

Bedrock tool_use agent (시나리오별 세무 전략 검토) 의 결과를 SSE 로 stream. tax-strategy 모듈 전용 — fs-sync 와 별개 endpoint.

---

## 7. 에러 코드 빠른 참조

| code | HTTP | 의미 |
|---|---|---|
| `UNAUTHORIZED` | 401 | JWT 검증 실패 |
| `FORBIDDEN` | 403 | tenant 멤버 아님 |
| `NOT_FOUND` | 404 | 리소스 없음 |
| `CONFLICT` | 409 | 중복 / 상태 전이 불가 (예: certain 에 PATCH) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 같은 키 다른 본문 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 동일 키 처리 중 |
| `VALIDATION_ERROR` | 422 | Zod / 본문 검증 실패 |
| `UNBALANCED_JOURNAL` | 422 | 차변 합 ≠ 대변 합 |
| `INVALID_JOURNAL_LINE` | 422 | 한 line debit + credit 동시 양수 |
| `INVALID_ACCOUNT_CODE` | 422 | 차트에 없는 계정 |
| `NO_BANK_CONNECTION` | 422 | bank-accounts 전에 bank-connections 필요 |
| `DATE_RANGE_TOO_WIDE` | 422 | `to - from > 366` 일 |
| `BEDROCK_DAILY_LIMIT_EXCEEDED` | 429 | 사용자별 100/일 한도 초과 |
| `BEDROCK_THROTTLED` | 429 | AWS Bedrock throttling |
| `INTERNAL_ERROR` | 500 | 미처리 예외 |
| `CODEF_ACCOUNT_ERROR` | 502 | CODEF 인증 실패 (message "lock" 포함 시 잠금 임박) |
| `CODEF_API_ERROR` | 502 | CODEF 일반 API 실패 |
| `CODEF_AUTH_ERROR` | 502 | CODEF OAuth 토큰 발급 실패 |
| `BEDROCK_UNAVAILABLE` | 503 | Bedrock 일시 장애 / 모델 미승인 |

---

## 8. Endpoint 일람

| Method | Path | Base URL | Auth | 라벨 |
|---|---|---|---|---|
| GET | `/health` | HTTP API | — | 🟢 |
| GET | `/me` | HTTP API | JWT | 🟢 |
| GET | `/me/tenants` | HTTP API | JWT | 🟢 |
| POST | `/tenants` | HTTP API | JWT | 🟡 |
| POST | `/tenants/{tenantId}/bank-connections` | HTTP API | JWT | 🟢 |
| POST | `/tenants/{tenantId}/bank-accounts` | HTTP API | JWT | 🟢 |
| **POST** | **`/tenants/{tenantId}/fs/sync`** | **CodefSyncStreamFnUrl (SSE)** | **JWT** | **🟢** |
| GET | `/tenants/{tenantId}/entries` | HTTP API | JWT | 🟢 |
| PATCH | `/tenants/{tenantId}/entries/{entryId}` | HTTP API | JWT | 🟢 |
| POST | `/tenants/{tenantId}/entries/{entryId}/confirm` | HTTP API | JWT | 🟢 |
| POST | `/tenants/{tenantId}/entries/{entryId}/discard` | HTTP API | JWT | 🟢 |
| POST | `/tenants/{tenantId}/journal/classify` | HTTP API | JWT | 🟡 |
| POST | `/tenants/{tenantId}/journal/entries` | HTTP API | JWT | 🟡 |
| GET | `/tenants/{tenantId}/summary/monthly` | HTTP API | JWT | 🟢 |
| GET | `/tenants/{tenantId}/receivables` | HTTP API | JWT | 🟢 |
| PATCH | `/tenants/{tenantId}/receivables/{entryId}` | HTTP API | JWT | 🟢 |
| GET | `/tenants/{tenantId}/accounts/balances` | HTTP API | JWT | 🟢 |
| GET | `/accounts/chart` | HTTP API | — | 🟢 |
| GET | `/tenants/{tenantId}/reports/pnl` | HTTP API | JWT | 🟢 |
| GET | `/tenants/{tenantId}/reports/balance-sheet` | HTTP API | JWT | 🟢 |
| GET | `/tenants/{tenantId}/reports/cash-flow` | HTTP API | JWT | 🟢 |
| GET | `/tenants/{tenantId}/reports/trial-balance` | HTTP API | JWT | 🟢 |
| GET | `/fx/rates/usd-krw` | HTTP API | JWT | 🟢 |
| POST | `/tenants/{tenantId}/fx/revalue` | HTTP API | JWT | 🟡 |
| POST | `/tenants/{tenantId}/fx/accounts` | HTTP API | JWT | 🟢 |
| GET | `/tenants/{tenantId}/fx/accounts` | HTTP API | JWT | 🟢 |
| PATCH | `/tenants/{tenantId}/fx/accounts/{accountId}/balance` | HTTP API | JWT | 🟢 |
| DELETE | `/tenants/{tenantId}/fx/accounts/{accountId}` | HTTP API | JWT | 🟢 |
| POST | `/tenants/{tenantId}/fx/strategy` | FxStrategyFnUrl (SSE) | JWT | 🟢 |
| GET / POST | `/tenants/{tenantId}/corporation-profile` | HTTP API | JWT | 🟡 |
| GET | `/tenants/{tenantId}/filings/upcoming` | HTTP API | JWT | 🟡 |
| GET | `/tenants/{tenantId}/filings/{id}/draft` | HTTP API | JWT | 🟡 |
| GET | `/tenants/{tenantId}/filings/{id}/penalty-simulation` | HTTP API | JWT | 🟡 |
| POST | `/tenants/{tenantId}/filings/{id}/recompute` | HTTP API | JWT | 🟡 |
| GET | `/tenants/{tenantId}/withholding/pending` | HTTP API | JWT | 🟡 |
| POST | `/tenants/{tenantId}/withholding/{id}/file` | HTTP API | JWT | 🟡 |
| GET | `/tenants/{tenantId}/tax-invoices` | HTTP API | JWT | 🟡 |
| POST | `/tenants/{tenantId}/tax/strategy` | TaxStrategyFnUrl (SSE) | JWT | 🟡 |
| GET / POST | `/admin/tax-rules*` `/admin/tax-law-sync*` `/admin/tax-rule-reviews*` | HTTP API | JWT (admin group) | 🔴 |

---

## 9. 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-05-13 | **0024 multi-currency + FX agent**: `tenant_bank_accounts`에 account_kind/currency/is_manual/manual_balance_fcy/bank_label 컬럼. `POST/GET/PATCH/DELETE /tenants/{id}/fx/accounts` 4 라우트 신설 (USD MVP, KRW 환산 표시). `POST /tenants/{id}/fx/strategy` FxStrategyFnUrl SSE 신설 (3 시나리오: exposure_summary / convert_now_check / monthly_outlook). 중복된 `/tenants/{id}/agent/search-tax-law`, `/tenants/{id}/agent/find-benefits` 제거 — `tax/strategy` 가 통합 진입점. |
| 2026-05-13 | **0022 SSE /fs/sync**: API Gateway 폴링 패턴 → Function URL SSE. 한 호출로 fetch → 분류 → 결과 stream. `GET /fs/sync/runs/*` 전부 제거 |
| 2026-05-12 | 0020 draft origin/status, 0019 sync_run audit, tax-strategy SSE |
| 2026-05-11 | bank-connections/accounts 2단계 흐름, journal/entries GET, personal tenant 자동 발급 |
| 2026-05-07 | identity (`/me`, `/tenants`, `/me/tenants`), journal classify + entries POST |
