# YourMillionare

AWS cloud-native AI accounting agent for early-stage Korean startups. See `PLAN.md` for the full product and architecture spec.

## Repository Layout

```
yourmillionare/
├── infrastructure/   # CDK TypeScript app (this slice)
├── apps/             # Hexagonal application code (added from Slice 2)
├── PLAN.md           # Product and architecture plan
├── schema.sql        # Aurora PostgreSQL DDL
└── CLAUDE.md         # Engineering guidelines
```

## Slice 1 Status — Bootstrap & Foundation

This slice ships the CDK baseline only. No real AWS resources are deployed yet.

What is included:

- npm workspaces (`infrastructure/`, `apps/`)
- CDK v2 TypeScript project with strict tsconfig + ESM
- `FoundationStack` — shared KMS CMK + Secrets Manager slot for CODEF credentials
- `cdk-nag` synthesis-time validation
- Vitest assertion tests
- GitHub Actions CI (lint + test + synth)

What is NOT included (next slices):

- Cognito, API Gateway, Aurora, DynamoDB, RDS Proxy, VPC
- Lambda handlers and hexagonal `apps/<domain>/` code
- Real `cdk deploy` (requires AWS account preparation)
- CODEF API integration (slot exists, value injected later)
- AgentCore (Phase 1)

## Local Development

Required: Node.js 20+, npm 10+.

```bash
npm install
npm run lint
npm test
CDK_ENV=dev AWS_ACCOUNT_ID=000000000000 npm run synth
```

The synth output goes to `infrastructure/cdk.out/`.

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CDK_ENV` | yes | — | `dev` or `prod` |
| `AWS_REGION` | no | `ap-northeast-2` | Seoul region |
| `AWS_ACCOUNT_ID` | yes | — | 12-digit account number |

## Deploying (when AWS account is ready)

```bash
# One-time bootstrap per account/region
cd infrastructure
CDK_ENV=dev AWS_ACCOUNT_ID=<your-account> npx cdk bootstrap

# Deploy the foundation stack
CDK_ENV=dev AWS_ACCOUNT_ID=<your-account> npx cdk deploy Ym-Dev-Foundation

# Populate the empty CODEF secret out-of-band
aws secretsmanager put-secret-value \
  --secret-id <CodefCredentialSecretArn from CfnOutput> \
  --secret-string '{"clientId":"...","clientSecret":"..."}'
```

## Open Items

- **Account isolation**: this slice uses a single AWS account with `Ym-Dev-*` / `Ym-Prod-*` stack prefixes. PLAN.md §5.2 recommends account-level separation; revisit before Phase 1.
- **Bedrock model access**: enable `anthropic.claude-sonnet-4` and `anthropic.claude-opus-4` in `ap-northeast-2` Bedrock console before Slice 5.
- **Domain & Route53**: not configured. Decide before exposing public endpoints.
