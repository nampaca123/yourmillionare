# Slice 4 — 인프라 마무리 + apps/journal PoC

Slice 3에서 만들어진 Identity/Api 스택 위에, 이번 슬라이스는 네트워크 egress 경로·자동 시크릿 교체·AI 분개를 완성한다.

## 완성된 컴포넌트

| 컴포넌트 | 스택 | 역할 |
|---|---|---|
| t4g.nano NAT Instance (fck-nat) | Network | Lambda → Bedrock outbound 경로 |
| `PRIVATE_WITH_EGRESS` 서브넷 | Network | Journal Lambda 배치 전용 (NAT 경유) |
| Aurora masterSecret HostedRotation | Data | 30일 주기 자동 교체, `lambdaSg` 재사용 |
| `packages/shared-errors` | 공통 | `AppError` 계층 + `toHttpErrorResponse` 모노레포 공유 |
| DynamoDB IdempotencyKeys (TTL 24h) | Data | `POST /tenants` + `POST .../journal/classify` dedup |
| `apps/journal` 헥사고날 패키지 | 앱 | AI 분개 도메인·유스케이스·어댑터 |
| Journal Lambda (512MB, 30s, ARM64) | Api | PRIVATE_WITH_EGRESS · Bedrock Converse |

## apps/journal 아키텍처

```
journal/src/
├── domain/           # JournalEntry, JournalLine, errors, K-IFRS 30개 계정과목
├── application/
│   ├── ports/        # AccountRepository, JournalRepository, TenantMemberRepository,
│   │                 # CostCounter, TransactionClassifier, UserRepository
│   └── *.use-case.ts # EnsureUserExists, VerifyTenantMembership, EnsureAccountsSeeded,
│                     # ClassifyTransaction, CreateJournalEntry
└── infrastructure/
    ├── inbound/http/ # journal.lambda.ts, controllers (classify / create-entry),
    │                 # Zod schemas, idempotency.config.ts
    └── outbound/
        ├── pg/       # Pg{User,TenantMember,Account,Journal}Repository + RLS context
        ├── ddb/      # DdbCostCounterAdapter (atomic conditional increment)
        └── bedrock/  # BedrockConverseClassifier (Converse API + toolConfig)
```

## Bedrock 모델

`global.anthropic.claude-sonnet-4-6` inference profile을 사용한다.

- IAM resource: `arn:aws:bedrock:{region}:{account}:inference-profile/global.anthropic.claude-sonnet-4-6`
- cross-region routing destination: foundation-model wildcard (`arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`)

## 제약 및 향후 작업

### classify endpoint는 PoC용 동기 엔드포인트

`POST /tenants/{tenantId}/journal/classify`는 Bedrock 호출을 동기로 처리한다.
Slice 5에서 CODEF 거래 데이터가 들어오면 이 라우트는 deprecated/admin-only로 좁히고,
정식 흐름은 **EventBridge → Step Functions → SQS → Lambda** EDA 파이프라인으로 교체한다.

### RDS Proxy — Slice 5 prod 시점으로 연기

dev에서는 `pg.Pool max:1` 직결이 충분하다. Proxy는 CODEF 폴링으로 동시성이 올라가는
Slice 5 prod 배포 때 `deploymentEnv === 'prod'` 조건으로 도입한다.

### Bedrock VPC Endpoint — 호출 빈도 증가 후 전환

NAT instance → 인터넷 → Bedrock 경로로 운영 중.
월 Bedrock 호출이 수천 건을 넘으면 `com.amazonaws.region.bedrock-runtime` VPCe로 전환해
outbound 데이터 비용을 줄인다.

### `ai_decisions` 테이블 — Slice 5+

AI 분개 결과 학습 루프에 필요. 현재 `journal_entries.ai_confidence` 컬럼만 유지하며
Slice 5에서 테이블 및 피드백 API를 추가한다.

### NAT Instance 보안 업데이트

fck-nat AMI는 분기마다 새 버전이 배포된다. Data 스택 배포 때 최신 AMI ID를
`aws ec2 describe-images`로 조회해 교체하는 SSM Automation 문서를 Slice 5에 추가한다.

### CostCounter 수동 리셋

현재 일별 사용자 카운터는 DynamoDB에 저장되며 TTL이 없어 자동 삭제되지 않는다.
`expires_at` TTL 추가 또는 정기 배치 삭제를 Slice 5에서 구현한다.

## 월 비용 (dev, 근사치)

| 항목 | 근사값 |
|---|---|
| Aurora Serverless v2 (scale-to-zero) | ~$0.06/hr · 가동 시간 기준 |
| t4g.nano NAT Instance | ~$3.5/월 |
| DynamoDB (on-demand) | ~$0 (dev 트래픽) |
| Bedrock Sonnet (100 calls/일 한도) | 호출당 ~$0.01 수준 |
| 합계 (Aurora 제외) | **~$28/월** |
