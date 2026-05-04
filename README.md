# YourMillionare

AWS cloud-native AI accounting agent for early-stage Korean startups. See `PLAN.md` for the full product and architecture spec.

## Repository Layout

```
yourmillionare/
├── infrastructure/   # CDK TypeScript app (Slices 1–2 deployed)
├── apps/             # Hexagonal application code (added from Slice 3)
├── docs/             # Slice implementation reports
├── PLAN.md           # Product and architecture plan
├── schema.sql        # Aurora PostgreSQL DDL (Slice 2: RLS baseline applied)
└── CLAUDE.md         # Engineering guidelines
```

## AWS Credentials Setup

AWS keys live in `~/.aws/credentials` (never in `.env`).

```bash
aws configure --profile ym-dev
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region: ap-northeast-2
# Default output: json
```

`.env` holds non-AWS secrets only:

```
ECOS_API_KEY=...
CODEF_CLIENT_ID=...
CODEF_CLIENT_SECRET=...
CODEF_PUBLIC_KEY=...
```

## Slice 2 Status — Network & Data Foundation

Deployed to `ap-northeast-2` (account 823401933116).

What is deployed:

- `Ym-Dev-Foundation` — shared KMS CMK + CODEF credentials secret
- `Ym-Dev-Network` — VPC (6 subnets, no NAT), security groups, VPC endpoints (KMS/SM interface, S3/DDB gateway), Flow Logs
- `Ym-Dev-Data` — Aurora Serverless v2 PG 15.10 (Data API, IAM auth, min ACU 0), 4 DynamoDB tables, schema migrator, verifier Lambdas
- `schema.sql` applied with full RLS baseline (tenant isolation + user PII)

What is NOT included yet (Slice 3+):

- Cognito User Pool, API Gateway, public endpoints — Slice 3
- Domain Lambda handlers under `apps/` — Slice 3
- RDS Proxy — Slice 4 (added when Lambda volume warrants pooling)
- NAT Gateway — Slice 4 (needed for CODEF outbound)
- CODEF API integration — Slice 4+

## Local Development

Required: Node.js 20+, npm 10+.

```bash
npm install
npm test
CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 AWS_PROFILE=ym-dev npm run synth
```

## Deploy Commands

```bash
cd infrastructure

# One-time bootstrap (already done)
AWS_PROFILE=ym-dev CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 npx cdk bootstrap

# Deploy all stacks
AWS_PROFILE=ym-dev CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 npx cdk deploy --all --require-approval never

# Deploy a specific stack
AWS_PROFILE=ym-dev CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 npx cdk deploy Ym-Dev-Network

# Populate the CODEF secret (one-time, out-of-band)
AWS_PROFILE=ym-dev aws secretsmanager put-secret-value \
  --secret-id <CodefCredentialSecretArn> \
  --secret-string '{"clientId":"...","clientSecret":"...","publicKey":"..."}' \
  --region ap-northeast-2
```

## Environment Variables (CDK)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CDK_ENV` | yes | — | `dev` or `prod` |
| `AWS_REGION` | no | `ap-northeast-2` | Seoul region |
| `AWS_ACCOUNT_ID` | yes | — | 12-digit account number |
| `VPC_CIDR` | no | `10.20.0.0/16` | Override if CIDR conflicts |

## Open Items

- **Account isolation**: single AWS account with `Ym-Dev-*` / `Ym-Prod-*` prefixes. PLAN.md §5.2 recommends account-level separation; revisit before Phase 1.
- **NAT Gateway decision**: Slice 4 chooses between NAT Gateway ($32+), `t4g.nano` NAT instance (~$3.5/mo), or PrivateLink for CODEF.
- **Bedrock model access**: enable `anthropic.claude-sonnet-4` and `anthropic.claude-opus-4` in `ap-northeast-2` before Slice 5.
- **Domain & Route53**: not configured. Decide before exposing public endpoints.
- **Master secret rotation**: deferred to Slice 4 (with RDS Proxy).
