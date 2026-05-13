# 2026-05 — CORS-disguised errors on SSE Function URLs and missing API GW routes

> Symptom: frontend sees a CORS error in the browser console. Real cause is something else (route not registered, preflight headers not allow-listed, lambda 500 before SSE start). Documented so the next person doesn't waste an afternoon on the CORS red herring.

## 1. What the frontend reported

- "POST `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com/tenants/{tid}/fs/sync` → CORS error"
- Later: "POST `https://vh3nq63kxcjcrjkabaikqrddzm0ymhbf.lambda-url.ap-northeast-2.on.aws/tenants/{tid}/fs/sync` → CORS error"
- Tax strategy route had a separate-looking CORS error days earlier.

Three different surface stories, three different root causes — but all looked the same in the browser console.

## 2. The three real causes (verified via AWS CLI)

### Cause A — Frontend hit API GW for a route that lives on a Function URL

`fs/sync` and `tax/strategy` moved to Lambda Function URLs (SSE Response Streaming, API Gateway HTTP API does not support streaming responses). The frontend's `VITE_SYNC_STREAM_URL` / `VITE_TAX_STRATEGY_URL` were unset, so the API client fell back to `VITE_YM_API_BASE_URL` (the API GW URL). The API GW had no matching route. The result:

| Verb | Response from API GW | CORS headers? |
|------|---------------------|---------------|
| OPTIONS preflight | 204 (handled by API GW's `corsPreflight`) | Yes |
| POST | 404 (no route matched) | **No** |

Browser saw "POST OK at preflight, then no CORS headers on POST" → labelled it a CORS error. The actual problem was "your route doesn't exist."

### Cause B — Function URL preflight rejected an unlisted header

`aws lambda get-function-url-config` showed AllowHeaders = `[authorization, content-type, idempotency-key]`. The frontend `streamSync` fetch sent:

```
Accept: text/event-stream
Authorization: Bearer …
Cache-Control: no-cache
Content-Type: application/json
```

`Accept` and `Cache-Control` were not allow-listed. AWS Function URL CORS behaviour when **any one** preflight-requested header is not allow-listed:

```
OPTIONS .../fs/sync (Access-Control-Request-Headers: accept,authorization,cache-control,content-type)
→ 200 OK, body empty, NO Access-Control-Allow-* headers
```

The 200 was misleading — there were no CORS headers, so the browser blocked. Browsers don't tell you "the server returned 200 but no CORS headers"; they tell you "CORS error." Verify directly with curl + `-I`.

### Cause C — Lambda threw before opening the SSE stream

Earlier, `tax-strategy` threw inside `buildContext` with `column "filing_kind" does not exist`. The 500 path went through the lambda's catch-all but did not set CORS headers on the response. Same browser appearance as A and B.

## 3. Diagnostic recipe (next time, follow in order)

```bash
PROFILE=ym-dev
REGION=ap-northeast-2
FN_URL="https://vh3nq63kxcjcrjkabaikqrddzm0ymhbf.lambda-url.ap-northeast-2.on.aws"
ORIGIN="https://dashboard.yourmillionaire.kro.kr"

# 1. Is the request actually a CORS issue, or did the route just not exist?
curl -sI -X OPTIONS "$FN_URL/tenants/x/fs/sync" \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"

# 2. If preflight is missing Access-Control-Allow-* headers, replay with each
#    header the frontend actually sends. A single unlisted header strips them all.
curl -sI -X OPTIONS "$FN_URL/tenants/x/fs/sync" \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: accept,authorization,cache-control,content-type"

# 3. Does the POST itself return CORS headers? If not, the lambda is throwing
#    before/around the streaming response. Look at CloudWatch.
curl -i -X POST "$FN_URL/tenants/x/fs/sync" \
  -H "Origin: $ORIGIN" -H "Content-Type: application/json" -d '{}'

# 4. Did the frontend hit the wrong host? Cross-check that the request URL
#    matches the SSE Function URL output, not the API GW URL.
aws cloudformation describe-stacks --stack-name Ym-Dev-Api \
  --region $REGION --profile $PROFILE \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `FnUrl`)].[OutputKey,OutputValue]' \
  --output table
```

The frontend's browser Network tab is the fastest source of truth: open the OPTIONS preflight row, copy `Request URL` and `Access-Control-Request-Headers`. One screenshot beats an hour of guessing.

## 4. What we centralised so this doesn't recur

| Concern | Single source |
|---------|--------------|
| Allowed origins, headers, methods, max-age | [infrastructure/lib/config/cors.config.ts](../../infrastructure/lib/config/cors.config.ts) — both `buildApiGwCors` and `buildFunctionUrlCors` read from the same constants |
| SSE allow-list (Accept, Cache-Control, Last-Event-Id, X-Requested-With) | Same module — added once, applied to every CORS surface |
| 404 with CORS headers + hint to the Function URL | [infrastructure/lib/lambdas/api-not-found.lambda.ts](../../infrastructure/lib/lambdas/api-not-found.lambda.ts) on `ANY /` and `ANY /{proxy+}` |
| New SSE Function URL boilerplate (env, IAM, CORS) | [infrastructure/lib/constructs/sse-function-url.construct.ts](../../infrastructure/lib/constructs/sse-function-url.construct.ts) — new SSE lambdas drop in via this construct |
| Lambda init/JWT/DB throw never reaching the SSE error event | [packages/agent-core/src/streaming-handler.ts](../../packages/agent-core/src/streaming-handler.ts) — `withStreamingErrorBoundary` wraps the streamifyResponse handler |
| Cognito ID-token verification on Function URLs | [packages/shared-auth/src/verify-jwt.function-url.ts](../../packages/shared-auth/src/verify-jwt.function-url.ts) — same `cognito:groups` flattening as the API GW path |

If you find another CORS-shaped bug, before guessing: run the 4 curl commands above, paste the output, then pick the right concern from this table.
