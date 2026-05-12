# Case study: Tax 401 — `cognito:groups` API Gateway flattening

> **Status**: Fixed by PR0d (2026-05-12). 5 mappers consolidated into `packages/shared-auth`.

## 1. Symptom (as reported)

프론트엔드 개발자가 정상 Cognito ID Token으로 tax 라우트를 호출했을 때:

```http
GET /tenants/{tid}/tax-invoices
Authorization: Bearer eyJraWQiOiI...   # valid ID token
```

응답:
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```

같은 토큰으로 `GET /me`, `GET /tenants/{tid}/journal/entries`, `POST /tenants/{tid}/sync` 등은 모두 200 정상. **Tax / Tax-knowledge 라우트만 401.**

## 2. 잘못된 가설들 (조사 초기)

- (X) 토큰 만료 → 만료된 토큰은 API Gateway 단에서 차단되어 본문이 `{"message":"Unauthorized"}` (lowercase, 단일 필드)로 와야 함. 우리 응답은 `{"error":{"code":"UNAUTHORIZED",...}}` 구조 → 람다 내부에서 throw됨.
- (X) Audience mismatch → `aud` claim은 `z.string()`(특정 값 검증 X)이라 통과해야 정상.
- (X) Tax 람다만 다른 JWT authorizer → API Gateway 콘솔/CDK 확인 결과 모든 라우트가 동일 authorizer 사용.
- (X) Federated `sub` 형식 → Google federated 사용자도 Cognito User Pool 발급 `sub`은 UUID. 동일.
- (X) Tax-admin 그룹 권한 → admin이 아닌 일반 라우트(`tax-invoices`)에서도 터짐. 권한 검사 이전 단계의 실패.

## 3. Root cause (CloudWatch 직접 증거)

CloudWatch `/aws/lambda/Ym-Dev-Api-TaxFn*` 2026-05-12 로그:

```json
{
  "level": 40,
  "err": {
    "type": "UnauthorizedError",
    "message": "Invalid JWT claims: [{
      \"code\":\"invalid_type\",
      \"expected\":\"array\",
      \"received\":\"string\",
      \"path\":[\"cognito:groups\"],
      \"message\":\"Expected array, received string\"
    }]"
  }
}
```

**원인**: **API Gateway HTTP API의 JWT Authorizer는 모든 claim 값을 string으로 평탄화**한다. JWT 원본의 array claim도 `event.requestContext.authorizer.jwt.claims`에 들어올 때 string으로 변환됨.

```
JWT 원본:       "cognito:groups": ["ym-tax-admin"]
API GW 전달본:  "cognito:groups": "[ym-tax-admin]"   ← string
```

`apps/tax`와 `apps/tax-knowledge`의 (구) `auth-claims.mapper.ts` 만 `z.array(z.string()).optional()`로 검증 → 항상 실패 → `UnauthorizedError(401)`.

## 4. 왜 journal/identity/fx 는 안 터졌나

해당 mapper들은 schema에 `cognito:groups` 필드를 **아예 두지 않았음**. 검증을 안 하니 평탄화된 string이든 array든 통과. **우연한 회피였지 의도된 견고함이 아님** — 미래에 누가 한 mapper에 그룹 검증을 추가하는 순간 같은 버그 재발.

## 5. 영향 범위

- `cognito:groups` 가 비어있는 사용자: 통과 (`optional`이라 검증 안 일어남).
- `cognito:groups` 에 그룹이 1개 이상 들어있는 모든 사용자: **모든 tax / tax-knowledge 라우트에서 401**.
- admin 라우트뿐 아니라 일반 사용자 라우트(`/tax-invoices`, `/filings/upcoming` 등) 전부 영향.
- Google federated 사용자가 admin 그룹에 들어가면 동일 증상.

## 6. Fix

`packages/shared-auth/src/auth-claims.mapper.ts` 신설, 5개 앱의 mapper가 이를 import. 핵심 변경:

```ts
const groupsClaim = z
  .union([
    z.array(z.string()),                              // raw JWT shape
    z.string().transform((s) => {                     // API GW flattened shape
      const t = s.trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        return t.slice(1, -1).split(/[\s,]+/).filter(Boolean);
      }
      return t.length > 0 ? t.split(/[\s,]+/).filter(Boolean) : [];
    }),
  ])
  .optional();

const ClaimsSchema = z.object({
  sub: z.string().min(1),                             // UUID 강제 완화 (federated 대비)
  email: z.string().email(),
  token_use: z.literal('id'),
  aud: z.string(),
  'cognito:groups': groupsClaim,
});
```

`sub: z.string().uuid()` → `z.string().min(1)`: federated 사용자의 sub은 Cognito가 UUID로 발급하지만, IdP 매핑 정책 변경 / Pre Token Generation Lambda 사용 시 발생할 수 있는 미래 깨짐 위험을 차단.

## 7. 단위테스트로 보장 (`packages/shared-auth/test/auth-claims.mapper.test.ts`)

- ✅ array shape: `['a','b']` → `['a','b']`
- ✅ flattened `[a b]`: `'[ym-tax-admin ym-other]'` → `['ym-tax-admin', 'ym-other']`
- ✅ flattened single: `'[ym-tax-admin]'` → `['ym-tax-admin']`
- ✅ comma-separated: `'a,b,c'` → `['a','b','c']`
- ✅ empty string → `[]`
- ✅ federated sub `Google_xxx` 통과
- ✅ `token_use='access'` 거부
- ✅ 잘못된 email 거부
- ✅ 빈 sub 거부
- ✅ `requireGroup` 가 그룹 멤버십 검증

## 8. 재발 방지 체크리스트

API Gateway HTTP API + JWT Authorizer 환경에서 mapper를 작성할 때:

1. **모든 array-typed claim은 `z.union([z.array, z.string().transform])` 패턴 적용**. JWT 원본이 배열이면 평탄화 위험 항상 존재.
2. **5개 앱이 동일 mapper를 복제하지 말 것**. 한 곳(`packages/shared-auth`)에서 관리. 복제는 한 곳만 고치는 부분 수정을 유발 → 본 버그처럼 일부 앱만 검증 누락 → 우연한 회피로 진단 어려움 증가.
3. **federated 사용자 시나리오를 단위테스트로 강제**. `sub` 형식, `cognito:groups` 평탄화 등.
4. **CloudWatch에서 `Invalid JWT claims` 로그 알람 설정**. 한 번이라도 발생하면 알람.

## 9. 관련 문서

- AWS: [API Gateway HTTP API JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) — claims 평탄화 동작은 명시적으로 문서화되지 않았고, AWS 콘솔 테스트 도구로도 보기 어려움. 실 토큰 + CloudWatch만이 신뢰 가능한 단서.
- Cognito ID Token claims spec: `cognito:groups`, `cognito:roles`, `cognito:preferred_role` 모두 array type. 모두 동일 평탄화 위험.
