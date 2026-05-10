# YourMillionaire — Frontend Integration Guide

> **Audience**: 이 백엔드를 호출할 프론트엔드 개발자.
> **단일 출처**: 이 문서만 보고 클라이언트 통합을 끝낼 수 있도록 작성됨. 누락된 부분이 있으면 이슈로 알려주세요.
> **Last verified**: 2026-05-11 (deployed dev 환경에서 라이브 응답 캡처).

---

## TL;DR

```
Base URL (dev) : https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com
Cognito Domain : https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com
Region         : ap-northeast-2
Auth scheme    : Cognito ID Token (Bearer), 발급은 Hosted UI 또는 SDK
CORS allowed   : http://localhost:3000, http://localhost:5173 (env로 추가 가능)
```

최소 호출 시퀀스 (3줄):
```bash
TOKEN="<Cognito ID Token>"
TENANT=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/me" | jq -r .defaultTenantId)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/tenants/$TENANT/journal/entries?from=2026-05-01&to=2026-05-31"
```

---

## 1. 환경

| 항목 | dev |
|------|-----|
| HTTP API Gateway | `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com` |
| Cognito User Pool ID | `ap-northeast-2_wSw9ItHbS` |
| Cognito User Pool Client ID | `6sop98o9dvge94bsipftmkrkeh` |
| Cognito Hosted UI domain | `https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com` |
| Cognito Issuer URL | `https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_wSw9ItHbS` |
| Region | `ap-northeast-2` (Seoul) |
| 데이터 시간대 | 모든 timestamp 응답은 ISO 8601 UTC (`Z` suffix), 날짜 응답은 `YYYY-MM-DD` (Asia/Seoul 기준 일자) |

prod URL은 별도 발급 시 추가. CDK 배포 출력 (`Ym-Dev-Api.HttpApiUrl`, `Ym-Dev-Identity.HostedUiDomainBaseUrl`)이 권위 있는 출처.

### 1.1 헬스체크 (CORS-friendly, 인증 불필요)

```http
GET /health
```
응답:
```json
{ "status": "ok" }
```
**용도**: 클라이언트 시작 시 백엔드 연결 확인.

---

## 2. 인증 (Cognito ID Token)

### 2.1 브라우저용 Google OAuth (production-grade)

이 흐름이 일반 사용자가 사용하는 정식 경로. 프론트엔드는 다음 단계를 구현:

**Step 1 — 로그인 버튼 클릭 시 Hosted UI로 redirect**:
```
https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com/oauth2/authorize
  ?client_id=6sop98o9dvge94bsipftmkrkeh
  &response_type=code
  &scope=email+openid+profile
  &identity_provider=Google
  &redirect_uri=<프론트엔드 callback URL — 사전 등록 필요>
```
> `identity_provider=Google`을 빼면 Cognito가 IdP 선택 화면을 보여줍니다. Google로 바로 보내려면 명시.

**Step 2 — Google 인증 후 callback**:
사용자가 Google에서 동의하면 Cognito가 다음 형식으로 redirect:
```
<프론트엔드 callback URL>?code=<authorization_code>&state=<...>
```

**Step 3 — Code → Token 교환** (프론트엔드 SPA에서 직접 가능, PKCE 권장):
```http
POST https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&client_id=6sop98o9dvge94bsipftmkrkeh
&code=<authorization_code>
&redirect_uri=<동일 callback URL>
```
응답:
```json
{
  "id_token": "eyJraWQi...",
  "access_token": "eyJraWQi...",
  "refresh_token": "eyJjdHki...",
  "expires_in": 3600,
  "token_type": "Bearer"
}
```
**API 호출에는 `id_token`만 사용**. `access_token`은 무시.

**Step 4 — API 호출**:
```
Authorization: Bearer <id_token>
```

### 2.2 등록된 callback / logout URL

CDK가 등록한 default callback: `http://localhost:3000/callback`. 프론트엔드 production 도메인이 정해지면 `infrastructure/lib/stacks/identity.stack.ts`의 `COGNITO_CALLBACK_URLS` env로 추가 후 재배포.

GCP OAuth Client에 등록된 redirect URI (Cognito 측):
`https://yourmillionare-dev.auth.ap-northeast-2.amazoncognito.com/oauth2/idpresponse`

### 2.3 토큰 만료와 갱신

- ID Token TTL: **1시간** (Cognito 기본값)
- Refresh Token TTL: **30일** (Cognito 기본값)
- 만료된 ID Token으로 호출 시: `401 Unauthorized` (API Gateway 단에서 차단)
- 갱신: refresh_token으로 동일 token endpoint 재호출 (`grant_type=refresh_token`)

### 2.4 추천 헤더

| 헤더 | 언제 | 비고 |
|------|------|------|
| `Authorization: Bearer <id_token>` | `/health` 외 모든 endpoint | 빠지면 401 |
| `Content-Type: application/json` | POST 요청 시 | 본문 있는 경우 필수 |
| `Idempotency-Key: <uuid>` | `POST /tenants`, `POST /journal/classify`에 권장 | 동일 키 + 동일 본문 → 24h 동안 캐시 응답 재생. 다른 본문 → 409 |

### 2.5 (참고) 개발자 직접 인증 — 브라우저 우회

E2E/디버그용. 일반 사용자에게는 노출 X. AWS 자격증명 + `ADMIN_USER_PASSWORD_AUTH` flow:
```bash
aws cognito-idp admin-initiate-auth \
  --user-pool-id ap-northeast-2_wSw9ItHbS \
  --client-id 6sop98o9dvge94bsipftmkrkeh \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=...,PASSWORD=..." \
  --query 'AuthenticationResult.IdToken' --output text
```

---

## 3. 공통 규약

### 3.1 성공 응답

각 endpoint별로 명세 (Section 5 참고). 공통 봉투(envelope) 없이 도메인 객체를 그대로 반환. 예: `{ "id": "...", "email": "..." }` 또는 배열 `[ {...}, {...} ]`.

### 3.2 에러 응답 — 통일된 형식

API Gateway가 던지는 401 외에는 모두 다음 형식:
```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```

API Gateway가 직접 차단한 401 (토큰 누락/위조)은 다음 형식 (envelope 없음):
```json
{ "message": "Unauthorized" }
```

프론트엔드는 두 형식 모두 처리해야 함 — 401이면 토큰 재발급 화면으로.

### 3.3 HTTP status code 의미 (전 endpoint 공통)

| HTTP | 언제 | 어떻게 대응 |
|------|------|-------------|
| 200 / 201 | 성공 | — |
| **400** | 본문이 JSON이 아님 | 클라이언트 버그. 본문 형식 점검 |
| **401** | 토큰 없음 / 만료 / 위조 | 로그인 화면으로 redirect (refresh 시도 권장) |
| **403** | 토큰은 유효하지만 해당 tenant 멤버 아님 | "권한 없음" 메시지. 다른 tenant 선택지 제공 (`GET /me/tenants`) |
| **404** | 라우트 없음 | URL 오타. 본 문서 Section 5 endpoint 일람 확인 |
| **409** | 중복(unique 위반) / Idempotency key 재사용 | "이미 존재함". 사용자에게 안내 |
| **422** | 입력 형식 / Zod 검증 실패 | form 입력 재검증. 응답의 `code`로 어떤 필드인지 분기 |
| **429** | 분류 일일 한도 초과 / Bedrock throttling | "잠시 후 다시" 안내. 자동 재시도하지 말 것 |
| **500** | 서버 내부 오류 | 사용자에게 일반 메시지 + Sentry/Datadog 등에 보고 |
| **502 / 503 / 504** | 외부 서비스 (CODEF, Bedrock) 장애 | 사용자에게 "은행/AI 서비스 일시 장애" 안내 |

### 3.4 필드 규약

| 항목 | 형식 | 예시 |
|------|------|------|
| ID 필드 (모든 `id`, `tenantId` 등) | UUID v4 | `881efe03-8181-4ae1-b6d3-0c16d87feba1` |
| 날짜 (entry_date 등) | ISO date `YYYY-MM-DD` | `2026-05-10` |
| 시각 (createdAt 등 — 응답에는 거의 미노출) | ISO 8601 UTC | `2026-05-11T00:07:44.687Z` |
| 금액 (debit, credit) | **정수 KRW** (소수점 없음) | `5000` (= 5,000원) |
| 키 (clientName 등) | camelCase | `defaultTenantId`, `accountNumber` |
| Enum (organization 코드) | 4자리 문자열 (CODEF 기관코드) | `"0088"` (신한), `"0020"` (우리), `"0081"` (하나) |
| Bank account number | 하이픈 포함/제외 자유. 서버는 그대로 저장 | `"110443478154"` 또는 `"110-443-478154"` |

### 3.5 CORS

API Gateway에 다음 정책이 설정됨:
- **Allowed origins**: `http://localhost:3000`, `http://localhost:5173` (Vite 기본). 추가는 CDK env `API_CORS_ALLOWED_ORIGINS` (콤마 구분)
- **Allowed methods**: `GET, POST, OPTIONS`
- **Allowed headers**: `Authorization, Content-Type, Idempotency-Key`
- **Allow credentials**: false (Cognito는 `Authorization` 헤더만 사용, 쿠키 X)
- **Max-Age**: 600s

브라우저는 OPTIONS preflight를 자동 처리 — 별도 코드 불필요.

### 3.6 Pagination

`GET` endpoint 중 list 반환:
- `limit`: 1~100, default 20
- `offset`: 0+, default 0
- 응답에 `entries` 키로 배열 반환. **현재 totalCount는 미반환** — 한 번 더 호출해서 길이 확인하거나 limit+1로 호출해 hasMore 판단.

### 3.7 Idempotency

`POST /tenants`, `POST /tenants/{id}/journal/classify`는 `Idempotency-Key` 헤더(권장 UUID) 지원. 동일 key + 동일 body → 24h 동안 첫 응답 그대로 재생. 동일 key + 다른 body → `409 IDEMPOTENCY_KEY_REUSED`. 처리 중인 동일 key 재요청 → `409 IDEMPOTENCY_IN_PROGRESS`.

### 3.8 Rate limits

- **Bedrock 분류 일일 한도**: 사용자별 100건/일 (env `BEDROCK_DAILY_LIMIT_PER_USER`). 초과 시 `429 BEDROCK_DAILY_LIMIT_EXCEEDED`.
- **Bedrock SDK throttling**: AWS 측 throttle 시 `429 BEDROCK_THROTTLED`.
- 그 외 endpoint별 별도 rate limit는 현재 없음 (API Gateway burst 한도만 적용).

---

## 4. 사용자 워크플로우 (검증 완료)

다음 시퀀스는 deployed dev 환경에서 실제 호출이 검증된 흐름입니다 (16/16 PASS, `docs/API_TEST_RESULTS.md` 참조).

### 4.1 신규 사용자가 처음으로 자기 통장 거래 분개를 보기까지

**Step 1 — 로그인** (Section 2.1 참고)
사용자가 Google 계정으로 로그인 → ID Token 확보.

**Step 2 — `GET /me`** (사용자 정보 + personal tenant 자동 발급)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com/me
```
응답 (실제 라이브):
```json
{
  "id": "dab67bfa-d997-47ba-8d23-eccd64ed4868",
  "cognitoSub": "14d8cd8c-3061-701f-9ae6-ccb45ba75c03",
  "email": "api-e2e-6a639eee@ym-e2e.test",
  "defaultTenantId": "881efe03-8181-4ae1-b6d3-0c16d87feba1"
}
```
프론트엔드는 `defaultTenantId`를 저장. 이후 `/tenants/{tenantId}/...` 모든 호출에 사용. **첫 호출 시 personal tenant가 자동 발급되며, 이후 호출은 같은 ID 반환 (idempotent)**. 별도 가입/사업자등록번호 입력 단계 불필요.

**Step 3 — `POST /tenants/{tenantId}/bank-connections`** (은행 인증 + 계좌 디스커버리)
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "organization": "0088",
    "loginId": "shinhan_id",
    "loginPassword": "shinhan_password"
  }' \
  "$BASE/tenants/881efe03-8181-4ae1-b6d3-0c16d87feba1/bank-connections"
```
응답:
```json
{
  "connectionId": "uuid",
  "accounts": [
    { "accountNumber": "110226771592", "accountName": "신한투자증권+증권거래예금", "balance": "120" },
    { "accountNumber": "110443478154", "accountName": "TEENS+PLUS통장",        "balance": "417210" }
  ]
}
```

**프론트엔드 UX 권장**:
- 비밀번호 입력 폼은 즉시 마스킹 (`type="password"`)
- 응답 후 `accounts` 배열을 사용자에게 카드 리스트로 표시
- 신한은행 5회 PW 오류 시 인터넷뱅킹 잠금 위험 → 로그인 시도 횟수를 클라이언트에서도 카운트하고 3회 실패 시 사용자에게 강한 경고
- 응답이 `502 CODEF_ACCOUNT_ERROR` + 메시지에 "lock" 포함 시 잠금 임박 → 즉시 사용자에게 안내

**Step 4 — `POST /tenants/{tenantId}/bank-accounts`** (사용자가 모니터링할 계좌 선택)
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "organization": "0088", "accountNumber": "110443478154" }' \
  "$BASE/tenants/881efe03-8181-4ae1-b6d3-0c16d87feba1/bank-accounts"
```
응답:
```json
{
  "id": "uuid",
  "tenantId": "881efe03-8181-4ae1-b6d3-0c16d87feba1",
  "organization": "0088",
  "accountNumber": "110443478154",
  "isActive": true
}
```
**자격증명 재입력 불필요** — Step 3에서 캐시된 `connectedId`가 자동 결합. 여러 계좌를 모니터링하려면 이 호출을 반복.

**Step 5 — 잠시 대기** (백그라운드 처리)
Step 4 직후에는 거래내역이 없음. 백엔드 Step Functions가 6시간마다 자동 실행해 CODEF에서 거래내역을 가져와 Bedrock으로 분류. 사용자가 즉시 보고 싶다면 백엔드 운영자가 SFN을 수동 트리거 (별도 endpoint 없음, 운영 작업).

**Step 6 — `GET /tenants/{tenantId}/journal/entries`** (분개 결과 조회)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/tenants/881efe03-8181-4ae1-b6d3-0c16d87feba1/journal/entries?from=2026-05-01&to=2026-05-31&limit=20"
```
응답 (실제 라이브):
```json
{
  "entries": [
    {
      "id": "d3d1e1a0-8f30-486d-8b57-e3712a29f52d",
      "entryDate": "2026-05-10",
      "source": "codef_bank",
      "description": "신한체",
      "aiConfidence": 0.6,
      "aiModel": "global.anthropic.claude-sonnet-4-6",
      "sourceRefId": "1dc13113-3871-4995-889e-8569a30430b9",
      "lines": [
        { "lineNo": 1, "accountCode": "5401", "debit": 5000, "credit": 0, "memo": null },
        { "lineNo": 2, "accountCode": "1002", "debit": 0,    "credit": 5000, "memo": null }
      ]
    }
  ]
}
```
**프론트엔드 UX 권장**:
- `aiConfidence < 0.5`인 entry는 사용자에게 "AI 분류 확신도 낮음" 표시 + 수동 정정 옵션 제공
- `lines` 배열은 항상 차변 합 = 대변 합 (복식부기). 화면 표시 시 한 줄로: "5,401 보통예금 5,000원 → 5401 통신비"
- `accountCode → 계정명` 매핑은 별도 endpoint 미제공. 향후 `GET /accounts` 추가 검토 (현재는 클라이언트에서 K-IFRS 표준 매핑 하드코딩)

---

## 5. API Reference

각 endpoint마다 **External / Advanced / Internal** 라벨로 프론트엔드 노출 여부를 구분.

| 라벨 | 의미 |
|------|------|
| 🟢 **External** | 일반 사용자 UI에서 직접 사용 |
| 🟡 **Advanced** | 회계 전문가/관리자 UI에서만 노출. 일반 사용자 화면에는 숨김 |
| 🔴 **Internal** | 백엔드/디버깅 전용. 프론트엔드 UI에 노출하지 말 것 |

---

### 5.1 `GET /health` 🟢 External

| 항목 | 내용 |
|------|------|
| **기능** | 백엔드 liveness probe. 시작 시 한 번 호출해 연결 확인 |
| **인증** | 불필요 |
| **요청** | 본문 없음 |
| **응답 200** | `{ "status": "ok" }` |
| **에러** | 거의 없음 (네트워크 실패 시 응답 없음) |

---

### 5.2 `GET /me` 🟢 External

| 항목 | 내용 |
|------|------|
| **기능** | (1) JWT의 `sub`/`email`로 사용자 upsert (2) 사용자의 personal tenant가 없으면 자동 발급 (3) `defaultTenantId` 포함 응답 |
| **인증** | 필수 (ID Token) |
| **호출 빈도** | 로그인 직후 1회 + 토큰 갱신 시 1회. 페이지마다 호출하지 말 것 (캐시) |
| **요청** | 본문 없음 |

**응답 200**:
```json
{
  "id": "dab67bfa-d997-47ba-8d23-eccd64ed4868",
  "cognitoSub": "14d8cd8c-3061-701f-9ae6-ccb45ba75c03",
  "email": "user@example.com",
  "defaultTenantId": "881efe03-8181-4ae1-b6d3-0c16d87feba1"
}
```

`defaultTenantId`는 personal tenant (BizRegNo 없는 1인 워크스페이스). 첫 호출 시 자동 생성, 이후 동일.

| 에러 | HTTP | code |
|------|------|------|
| 토큰 없음/만료/위조 | 401 | (Gateway: `{"message":"Unauthorized"}`) |
| JWT 클레임 형식 불일치 | 401 | `UNAUTHORIZED` |
| Lambda 콜드스타트 타임아웃 (드물게) | 500 | (Gateway 기본) |

---

### 5.3 `POST /tenants` 🟡 Advanced

| 항목 | 내용 |
|------|------|
| **기능** | 법인 사업자 사용자가 BRN(사업자등록번호) 기반의 추가 tenant를 명시 생성. **개인 사용자는 호출 불필요** — `GET /me`에서 personal tenant가 자동 발급됨 |
| **인증** | 필수 |
| **멱등성** | `Idempotency-Key` 헤더 권장 (선택) |

**요청 본문**:
```json
{
  "legalName":   "주식회사 OOO",
  "displayName": "OOO",
  "bizRegNo":    "1234567890"
}
```
- `bizRegNo`: 선택. 생략하면 personal tenant 생성. 입력 시 10자리 숫자 (하이픈 무관, 내부 정규화)

**응답 201**:
```json
{
  "id": "uuid",
  "legalName": "주식회사 OOO",
  "displayName": "OOO"
}
```

| 에러 | HTTP | code |
|------|------|------|
| 토큰 문제 | 401 | (Gateway/`UNAUTHORIZED`) |
| 본문 JSON 파싱 실패 | 400 | `VALIDATION_ERROR` |
| BRN 형식 오류 (10자리 숫자 아님) | 422 | `VALIDATION_ERROR` |
| 동일 BRN 중복 | 409 | `CONFLICT` |
| Idempotency-Key 같은데 본문 다름 | 409 | `IDEMPOTENCY_KEY_REUSED` |
| Idempotency-Key 처리 중 | 409 | `IDEMPOTENCY_IN_PROGRESS` |

---

### 5.4 `GET /me/tenants` 🟢 External

| 항목 | 내용 |
|------|------|
| **기능** | 사용자가 멤버인 모든 tenant 리스트. UI의 "워크스페이스 전환" 메뉴에 사용 |
| **인증** | 필수 |

**응답 200** (실제 라이브):
```json
[
  { "id": "4180f5a3-0a11-49bb-bd2a-d0a4eb760324", "legalName": "E2E Legal", "displayName": "E2E Disp" },
  { "id": "881efe03-8181-4ae1-b6d3-0c16d87feba1", "legalName": "user@example.com", "displayName": "user@example.com" }
]
```

| 에러 | HTTP |
|------|------|
| 토큰 문제 | 401 |

---

### 5.5 `POST /tenants/{tenantId}/bank-connections` 🟢 External

| 항목 | 내용 |
|------|------|
| **기능** | 사용자의 은행 자격증명(현재 신한 ID/PW, loginType=1)을 CODEF에 1회 인증해 `connectedId`를 발급받고, 같은 호출에서 보유 계좌 리스트를 디스커버리. `connectedId`는 영속 저장되어 이후 `bank-accounts` 호출에서 재사용 |
| **인증** | 필수 |
| **경로 변수** | `tenantId`: UUID (`GET /me`의 `defaultTenantId`) |
| **주의** | **신한은 5회 PW 오류 시 인터넷뱅킹 자체가 잠김.** 사용자가 입력 실수해도 무한 retry 금지. 클라이언트도 시도 횟수 추적 권장 |

**요청 본문**:
```json
{
  "organization":  "0088",
  "loginId":       "shinhan_internet_banking_id",
  "loginPassword": "shinhan_password",
  "birthDate":     "19950101"
}
```
- `organization`: 정확히 4자 (CODEF 기관코드, 신한=`0088`)
- `birthDate`: 선택. 신한이 PW 오류 누적 시 추가 검증 요구하면 다음 시도부터 포함

**응답 200**:
```json
{
  "connectionId": "uuid",
  "accounts": [
    { "accountNumber": "110226771592", "accountName": "신한투자증권+증권거래예금", "balance": "120" },
    { "accountNumber": "110443478154", "accountName": "TEENS+PLUS통장",            "balance": "417210" }
  ]
}
```

| 에러 | HTTP | code | 의미/대응 |
|------|------|------|----------|
| 비멤버 tenant | 403 | `FORBIDDEN` | 다른 사용자의 tenantId. `GET /me/tenants`로 본인 것 확인 |
| `loginId`/`loginPassword` 누락 | 422 | `VALIDATION_ERROR` | form 재검증 |
| `organization` 4자 아님 | 422 | `VALIDATION_ERROR` | |
| CODEF 인증 실패 (잘못된 ID/PW 등) | 502 | `CODEF_ACCOUNT_ERROR` | 응답 message에 "lock" 포함 시 잠금 임박 → 사용자에게 강한 경고 |
| CODEF account-list API 실패 | 502 | `CODEF_API_ERROR` | 일시적 외부 장애. 재시도 가능 |

> **보안 트레이드오프 (Phase 0)**: 사용자의 은행 평문 비밀번호가 백엔드 Lambda 메모리를 잠시 경유합니다. RSA-PKCS1로 즉시 암호화 + 로그 미포함 + 즉시 스코프 해제로 노출 표면 최소화. 사용자에게 "이 정보는 거래내역 조회 목적으로만 사용되며 평문으로 저장되지 않음"을 명시하는 동의 화면 권장. Phase 1에서 인증서 팝업/간편인증으로 교체 예정 (`docs/STATUS.md`).

---

### 5.6 `POST /tenants/{tenantId}/bank-accounts` 🟢 External

| 항목 | 내용 |
|------|------|
| **기능** | `bank-connections` 응답의 `accounts` 배열에서 사용자가 선택한 계좌를 모니터링 대상으로 등록. 자격증명 재입력 없이 캐시된 `connectedId`가 자동 결합 |
| **인증** | 필수 |

**요청 본문**:
```json
{
  "organization":  "0088",
  "accountNumber": "110443478154"
}
```

**응답 201**:
```json
{
  "id":            "uuid",
  "tenantId":      "881efe03-...",
  "organization":  "0088",
  "accountNumber": "110443478154",
  "isActive":      true
}
```

| 에러 | HTTP | code | 의미 |
|------|------|------|------|
| 비멤버 tenant | 403 | `FORBIDDEN` | |
| 해당 `(tenantId, organization)`에 사전 connection 없음 | 422 | `NO_BANK_CONNECTION` | 먼저 `POST /bank-connections` 호출 필요 |
| `organization` 4자 아님 / `accountNumber` 빈 문자열 | 422 | `VALIDATION_ERROR` | |
| 동일 `(tenantId, organization, accountNumber)` 이미 등록 | 409 | `CONFLICT` | UI에서 "이미 등록된 계좌" 표시 |

---

### 5.7 `GET /tenants/{tenantId}/journal/entries` 🟢 External

| 항목 | 내용 |
|------|------|
| **기능** | tenant의 분개 결과를 날짜 범위로 조회. CODEF가 수집·Bedrock이 분류한 entries + lines 반환 |
| **인증** | 필수 |

**요청 쿼리**:
```
?from=YYYY-MM-DD          (필수)
&to=YYYY-MM-DD            (필수)
&limit=N                  (선택, 1–100, default 20)
&offset=N                 (선택, default 0)
```

**응답 200** (실제 라이브):
```json
{
  "entries": [
    {
      "id":           "d3d1e1a0-8f30-486d-8b57-e3712a29f52d",
      "entryDate":    "2026-05-10",
      "source":       "codef_bank",
      "sourceRefId":  "1dc13113-3871-4995-889e-8569a30430b9",
      "description":  "신한체",
      "aiConfidence": 0.6,
      "aiModel":      "global.anthropic.claude-sonnet-4-6",
      "lines": [
        { "lineNo": 1, "accountCode": "5401", "debit": 5000, "credit": 0,    "memo": null },
        { "lineNo": 2, "accountCode": "1002", "debit": 0,    "credit": 5000, "memo": null }
      ]
    }
  ]
}
```

| 필드 | 의미 |
|------|------|
| `source` | `codef_bank` (자동 수집) 또는 `manual` (수동 입력) |
| `sourceRefId` | source가 `codef_bank`이면 raw_transactions.id. 디버깅용 |
| `aiModel` | `global.anthropic.claude-sonnet-4-6` (Bedrock) — dev/prod 모두 실 LLM 사용 |
| `aiConfidence` | 0.0–1.0. 낮을수록 사용자 정정 권장 |

| 에러 | HTTP | code |
|------|------|------|
| 비멤버 tenant | 403 | `FORBIDDEN` |
| `from`/`to` 누락 / `limit` 1–100 벗어남 | 422 | `VALIDATION_ERROR` |

---

### 5.8 `POST /tenants/{tenantId}/journal/classify` 🟡 Advanced

| 항목 | 내용 |
|------|------|
| **기능** | 거래 1건을 즉시 동기 분류해 `journal_entries`에 저장. 보통은 **CODEF 자동 파이프라인이 처리하므로 프론트엔드에서 호출할 일이 거의 없음**. 사용자가 수동으로 거래를 분개하고 싶을 때만 사용 (예: 현금 거래) |
| **인증** | 필수. 멱등성 키 권장 |

**요청 본문**:
```json
{
  "date":         "2026-05-10",
  "amount":       15000,
  "counterparty": "Coffee Shop Inc",
  "memo":         "Office supplies"
}
```

**응답 201**:
```json
{
  "id":           "uuid",
  "tenantId":     "uuid",
  "entryDate":    "2026-05-10",
  "aiConfidence": 0.72,
  "aiModel":      "global.anthropic.claude-sonnet-4-6",
  "lines": [
    { "lineNo": 1, "accountCode": "1002", "debit": 0, "credit": 0, "memo": null }
  ]
}
```

| 에러 | HTTP | code |
|------|------|------|
| 비멤버 | 403 | `FORBIDDEN` |
| `amount=0` 등 입력 오류 | 422 | `VALIDATION_ERROR` |
| AI 분개 결과 차/대 불일치 | 422 | `UNBALANCED_JOURNAL` |
| AI가 모르는 account code 반환 | 422 | `INVALID_ACCOUNT_CODE` |
| Bedrock 모델 비활성/권한 없음 | 503 | `BEDROCK_UNAVAILABLE` |
| Bedrock throttling | 429 | `BEDROCK_THROTTLED` |
| 일일 한도(100/user) 초과 | 429 | `BEDROCK_DAILY_LIMIT_EXCEEDED` |

---

### 5.9 `POST /tenants/{tenantId}/journal/entries` 🟡 Advanced

| 항목 | 내용 |
|------|------|
| **기능** | 사용자가 수동으로 분개를 입력 (회계 전문가 / AI 분류 결과 정정용). **일반 사용자 UI에는 노출 X.** 회계 전문가 모드에서만 활성화 권장 |
| **인증** | 필수 |

**요청 본문**:
```json
{
  "entryDate":   "2026-05-02",
  "description": "Office supplies purchase",
  "lines": [
    { "lineNo": 1, "accountCode": "5401", "debit": 10000, "credit": 0 },
    { "lineNo": 2, "accountCode": "1002", "debit": 0,     "credit": 10000 }
  ]
}
```
- `lines`: 최소 2개. 한 line에 debit과 credit 동시 0 초과 금지. 전체 차변 합 = 대변 합

**응답 201**: 저장된 entry. 

| 에러 | HTTP | code | 의미 |
|------|------|------|------|
| 비멤버 | 403 | `FORBIDDEN` | |
| line 2개 미만 | 422 | `VALIDATION_ERROR` | |
| 한 line이 debit + credit 동시 양수 | 422 | `INVALID_JOURNAL_LINE` | |
| 차변 합 ≠ 대변 합 | 422 | `UNBALANCED_JOURNAL` | |
| 모르는 account code | 422 | `INVALID_ACCOUNT_CODE` | |

---

## 6. AppError code 빠른 참조 (전 endpoint 공통)

| code | HTTP | 트리거 / 대응 |
|------|------|--------------|
| `UNAUTHORIZED` | 401 | 토큰 클레임 검증 실패. 재로그인 |
| `FORBIDDEN` | 403 | tenant 멤버 아님. 다른 tenant 선택 |
| `NOT_FOUND` | 404 | 리소스 없음 (Lambda unknown route 폴백) |
| `CONFLICT` | 409 | 중복(BRN, account 등) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 같은 키, 다른 본문 → 새 키 사용 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 동일 키 처리 중 → 잠시 후 재시도 |
| `VALIDATION_ERROR` | 422 | JSON / Zod 검증 실패. 입력 폼 점검 |
| `NO_BANK_CONNECTION` | 422 | `bank-accounts` 호출 전 `bank-connections` 필요 |
| `INVALID_ACCOUNT_CODE` | 422 | 차트에 없는 계정코드. 회계 전문가 정정 |
| `INVALID_JOURNAL_LINE` | 422 | 한 줄 차변·대변 동시 양수 |
| `UNBALANCED_JOURNAL` | 422 | 차변 합 ≠ 대변 합 |
| `BEDROCK_DAILY_LIMIT_EXCEEDED` | 429 | 사용자별 일일 한도 초과 |
| `BEDROCK_THROTTLED` | 429 | AWS Bedrock throttling |
| `INTERNAL_ERROR` | 500 | 미처리 예외. 재시도 후에도 지속 시 백엔드 점검 |
| `CODEF_ACCOUNT_ERROR` | 502 | CODEF 인증/account-create 실패. 메시지에 "lock" 포함 시 잠금 임박 |
| `CODEF_API_ERROR` | 502 | CODEF 일반 API 실패 (account-list 등) |
| `CODEF_AUTH_ERROR` | 502 | CODEF OAuth 토큰 발급 실패 (백엔드 자격증명 문제) |
| `BEDROCK_UNAVAILABLE` | 503 | Bedrock 모델 접근 미승인/일시 장애 |

---

## 7. Endpoint 일람

| Method | Path | Lambda | Auth | 라벨 |
|--------|------|--------|------|------|
| GET | `/health` | Identity | — | 🟢 External |
| GET | `/me` | Identity | JWT | 🟢 External |
| GET | `/me/tenants` | Identity | JWT | 🟢 External |
| POST | `/tenants` | Identity | JWT | 🟡 Advanced (법인 사용자) |
| POST | `/tenants/{tenantId}/bank-connections` | Identity | JWT | 🟢 External |
| POST | `/tenants/{tenantId}/bank-accounts` | Identity | JWT | 🟢 External |
| GET | `/tenants/{tenantId}/journal/entries` | Journal | JWT | 🟢 External |
| POST | `/tenants/{tenantId}/journal/classify` | Journal | JWT | 🟡 Advanced (수동 분류) |
| POST | `/tenants/{tenantId}/journal/entries` | Journal | JWT | 🟡 Advanced (수동 분개) |

**프론트엔드 일반 사용자 UI 권장 노출**: `/health`, `/me`, `/me/tenants`, 두 `bank-*` POST, `GET /journal/entries`. 그 외(`POST /tenants`, `journal/classify`, `journal/entries POST`)는 회계 전문가 모드 또는 admin tool에서만.

내부 전용(Internal) endpoint는 현재 없음 — 모든 endpoint가 외부에서 호출 가능 (인증 필수).

---

## 8. 변경 이력

| 날짜 | 변경 |
|------|------|
| 2026-05-11 | Slice 6 완료: bank-connections/accounts 2단계 흐름, journal/entries GET, personal tenant 자동 발급, Bedrock dev/prod 일원화, CORS 설정, 프론트엔드 통합 가이드 형식으로 전면 재작성 |
| 2026-05-09 | Slice 5: bank-accounts POST 추가, ai_decisions 마이그레이션 |
| 2026-05-07 | Slice 3-4: identity (`/me`, `/tenants`, `/me/tenants`), journal (classify, entries POST) |

---

## 부록: 미들웨어 설계 메모 (백엔드 참고용)

이 섹션은 프론트엔드 통합과 무관. 백엔드 변경 시 참고:

- **JWT Authorizer (API Gateway)**: `aud=UserPoolClientId` 검증. Access Token (aud 없음)은 자동 차단.
- **Lambda 클레임 검증** (`auth-claims.mapper.ts`): `parseClaims`가 `sub`, `email`, `token_use=id`, `aud=clientId` 재검증. 실패 시 `UNAUTHORIZED`.
- **에러 변환** (`shared/errors/http-error.ts`): 모든 throw → `toHttpErrorResponse`로 변환. 4xx는 `warn`, 5xx는 `error` 로그.
- **분류기**: dev/prod 모두 `BedrockConverseClassifier`. `DeterministicStubClassifier`는 unit test 전용.

전체 슬라이스 구조: `docs/STATUS.md`, `docs/06-slice6.ko.md`.
