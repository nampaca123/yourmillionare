# YourMillionare

AWS cloud-native AI accounting agent for early-stage Korean startups. See `PLAN.md` for the full product and architecture spec.

## Repository Layout

```
yourmillionare/
├── infrastructure/   # CDK TypeScript app (Slices 1–4 code complete)
├── apps/
│   ├── identity/     # Cognito user / tenant domain (Slice 3)
│   └── journal/      # AI accounting journal domain (Slice 4)
├── packages/
│   └── shared-errors/ # AppError hierarchy + toHttpErrorResponse (Slice 4)
├── docs/             # Slice implementation reports (01–04)
├── PLAN.md           # Product and architecture plan
├── schema.sql        # Aurora PostgreSQL DDL baseline (Slice 2); see migrations/ for Slice 3+
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

## Slice 4 Status — NAT + Journal PoC (deploying)

All stacks deployed to `ap-northeast-2` (account 823401933116).

What is deployed (Slices 1–3):

- `Ym-Dev-Foundation` — shared KMS CMK + CODEF credentials secret slot
- `Ym-Dev-Network` — VPC (7 subnets incl. PRIVATE_WITH_EGRESS), t4g.nano NAT Instance (fck-nat), security groups, VPC endpoints, Flow Logs
- `Ym-Dev-Data` — Aurora Serverless v2 PG 15.10, 4 DynamoDB tables, schema migrator (baseline-v1), HostedRotation
- `schema.sql` + migrations 0001 (RLS) + 0002 applied
- `Ym-Dev-Identity` — Cognito User Pool + Client
- `Ym-Dev-Api` — HTTP API, JWT Authorizer, Identity Lambda + Journal Lambda

What is code-complete (Slice 4):

- `Ym-Dev-Identity` — Cognito User Pool + Client
- `Ym-Dev-Api` — HTTP API Gateway, JWT Authorizer, Identity Lambda (VPC)
- `apps/identity` — hexagonal domain package (`/me`, `/tenants`, `/me/tenants`, `/health`)
- 6 KMS CMKs total across stacks (see `PLAN.md §4.4` for inventory)

What is NOT included yet (Slice 4+):

- RDS Proxy — Slice 4 (connection pooling when Lambda volume warrants)
- NAT Gateway decision — Slice 4 (needed for CODEF outbound; NAT GW vs NAT instance vs PrivateLink)
- `POST /tenants` Idempotency-Key (DynamoDB 24h response replay) — Slice 4
- First journal-entry domain Lambda — Slice 4
- Master secret rotation — Slice 4 (with RDS Proxy)
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
- **NAT Gateway decision**: Slice 4 chooses between NAT Gateway ($32+/mo), `t4g.nano` NAT instance (~$3.5/mo), or PrivateLink for CODEF.
- **Master secret rotation**: deferred to Slice 4 (with RDS Proxy).
- **Bedrock model access**: enable `anthropic.claude-sonnet-4` and `anthropic.claude-opus-4` in `ap-northeast-2` before Slice 5.
- **Domain & Route53**: not configured. Decide before exposing public endpoints.
- **CDK Pipelines**: local `cdk deploy` only. GitHub Actions pipeline deferred to Phase 1.
