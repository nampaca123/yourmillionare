# Bedrock KB: S3 Vectors → Aurora pgvector Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bedrock Knowledge Base의 벡터 저장소를 S3 Vectors에서 Aurora pgvector로 교체하여 (1) 실제 동작하는 SEMANTIC_HYBRID 검색을 확보하고, (2) S3 Vectors의 2KB 필터링 메타데이터 한도 때문에 92.7%의 청크가 색인 실패하던 문제를 해소한다.

**Architecture:** `AWS::Bedrock::KnowledgeBase`의 `StorageConfiguration.Type`을 `S3_VECTORS`에서 `RDS`로 교체한다. 이미 활성화된 Aurora PostgreSQL 15.15의 Data API HTTPS 엔드포인트(`rds-data.{region}.amazonaws.com`)로 Bedrock KB가 접근하므로 PRIVATE_ISOLATED subnet 변경은 불필요하다. pgvector 0.8.0, pg_bigm 1.2가 이미 설치된 상태이므로, 신규 작업은 `bedrock_integration` 스키마/테이블 생성, 전용 DB 사용자, KB 자격 시크릿, CDK construct 교체 4가지로 압축된다.

**Tech Stack:** AWS CDK (TypeScript), Aurora PostgreSQL 15.15, pgvector 0.8.0, pg_bigm 1.2, Bedrock Knowledge Base, Bedrock Titan Embed v2 (1024-dim), AWS RDS Data API.

---

## File Structure

**Modify:**
- `infrastructure/lib/stacks/data/aurora.construct.ts` — 커스텀 DB cluster parameter group 신설 + ACU 상향
- `infrastructure/lib/stacks/ingestion/legal-kb.construct.ts` — S3 Vectors 리소스 제거, RDS storage configuration으로 교체, IAM 권한 재구성
- `infrastructure/lib/stacks/ingestion.stack.ts` — `LegalKbConstruct` props 시그니처 변경 (Aurora cluster, secret 전달)
- `infrastructure/lib/stacks/data.stack.ts` — KB 전용 시크릿 신설 및 export
- `docs/ARCHITECTURE.md` — 백엔드 표기 갱신 ("S3 Vectors" → "Aurora pgvector")
- `README.md` — 환경 변수/실행 명령 변경분 반영
- `infrastructure/lib/stacks/data/sql/schema.sql` — 최신 스키마 재생성 (bedrock_integration 포함)

**Create:**
- `infrastructure/lib/stacks/data/sql/migrations/0025-bedrock-kb-vector-table.sql` — `bedrock_integration.bedrock_kb_legal` 테이블 + HNSW + pg_bigm GIN 인덱스
- `infrastructure/lib/stacks/data/sql/migrations/0026-bedrock-kb-db-role.sql` — `bedrock_kb_user` DB role + GRANT
- `infrastructure/lib/stacks/data/aurora-vector-param-group.construct.ts` — 커스텀 cluster parameter group construct (재사용성)
- `scripts/verify-bedrock-kb-aurora.sh` — Data API로 색인 결과/하이브리드 검색 검증

---

## Pre-flight (이미 확인 완료)

다음은 본 플랜 작성 시점(2026-05-17)에 dev에서 이미 확정된 사실들이다. 실행 시 변동 가능성이 있으면 재확인:

- Aurora cluster: `ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm` (engine `aurora-postgresql 15.15`, ACU 0.5–2.0)
- Data API: 활성화됨 (`enableDataApi: true`)
- Master secret ARN: `arn:aws:secretsmanager:ap-northeast-2:823401933116:secret:YmDevDataAuroraClusterSecre-ubRXVwKarzBy-6p43Zw`
- Migration 0024까지 모두 적용됨 (0016 포함 → pgvector + pg_bigm 설치 완료)
- pg_extension 확인: `vector 0.8.0`, `pg_bigm 1.2`, `pgcrypto 1.3` 설치됨
- 기존 KB: `XDCWAUFING` (legal-kb-dev, S3_VECTORS), 마지막 ingestion에서 583/629 실패
- 코퍼스 S3 버킷: `ym-dev-ingestion-legalkbbucketb3596809-ehnxjfewfudp`, 청크 629개 (data + metadata 쌍 1258 객체)
- AWS account: `823401933116`, region: `ap-northeast-2`, profile: `ym-dev`

---

## Task 1: Custom DB Cluster Parameter Group 신설

기본 `default.aurora-postgresql15`는 수정 불가하므로, `pg_bigm`을 `shared_preload_libraries`에 추가하고 벡터 워크로드용 메모리 파라미터를 튜닝하기 위해 커스텀 그룹이 필요하다. 이 그룹 적용은 cluster 재기동을 요구하지만, 변경 자체는 안전하다(스키마/데이터에 영향 없음).

**Files:**
- Create: `infrastructure/lib/stacks/data/aurora-vector-param-group.construct.ts`
- Modify: `infrastructure/lib/stacks/data/aurora.construct.ts` (parameters 적용)

- [ ] **Step 1: 파라미터 그룹 construct 작성**

`infrastructure/lib/stacks/data/aurora-vector-param-group.construct.ts` 신규 생성:

```typescript
// Aurora vector parameter group: tuned for pgvector HNSW workloads + pg_bigm preload.

import { CfnDBClusterParameterGroup } from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface AuroraVectorParamGroupProps {
  readonly family: string;
}

export class AuroraVectorParamGroup extends Construct {
  public readonly parameterGroup: CfnDBClusterParameterGroup;

  constructor(scope: Construct, id: string, props: AuroraVectorParamGroupProps) {
    super(scope, id);

    this.parameterGroup = new CfnDBClusterParameterGroup(this, 'ParamGroup', {
      family: props.family,
      description: 'Aurora pg15 with pg_bigm preload and vector workload tuning',
      parameters: {
        shared_preload_libraries: 'pg_bigm',
        work_mem: '65536',
        maintenance_work_mem: '262144',
        max_parallel_workers_per_gather: '2',
      },
    });
  }
}
```

- [ ] **Step 2: Aurora construct에 wire**

`infrastructure/lib/stacks/data/aurora.construct.ts:25-26` 다음 위치에 import 추가:

```typescript
import { AuroraVectorParamGroup } from './aurora-vector-param-group.construct.js';
```

`infrastructure/lib/stacks/data/aurora.construct.ts:56`의 `new DatabaseCluster(...)` 직전에 추가:

```typescript
const vectorParamGroup = new AuroraVectorParamGroup(scope, `${id}VectorParamGroup`, {
  family: 'aurora-postgresql15',
});
```

그리고 `DatabaseCluster` 옵션에 `parameterGroup` 추가 (현재 라인 80의 `cloudwatchLogsRetention` 다음에):

```typescript
parameterGroup: vectorParamGroup.parameterGroup as unknown as IParameterGroup,
```

import도 추가:

```typescript
import type { IParameterGroup } from 'aws-cdk-lib/aws-rds';
```

- [ ] **Step 3: CDK synth로 변경 확인**

Run:
```bash
cd infrastructure && pnpm cdk synth Ym-Dev-Data 2>&1 | grep -A 3 'AWS::RDS::DBClusterParameterGroup'
```

Expected: `AWS::RDS::DBClusterParameterGroup` 리소스가 출력에 포함되고 `Parameters.shared_preload_libraries = pg_bigm`이 보임.

- [ ] **Step 4: Dev에 배포 (재기동 동반)**

Run:
```bash
cd infrastructure && pnpm cdk deploy Ym-Dev-Data --profile ym-dev --require-approval never
```

Expected: 배포 도중 cluster가 `rebooting` → `available` 전이. 5–10분 소요. 배포 중 Lambda/API의 DB 쿼리 일부 실패는 정상.

- [ ] **Step 5: shared_preload_libraries 적용 확인**

Run:
```bash
aws rds-data execute-statement \
  --profile ym-dev --region ap-northeast-2 \
  --resource-arn "arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm" \
  --secret-arn "arn:aws:secretsmanager:ap-northeast-2:823401933116:secret:YmDevDataAuroraClusterSecre-ubRXVwKarzBy-6p43Zw" \
  --database yourmillionare \
  --sql "SHOW shared_preload_libraries"
```

Expected: 결과에 `pg_bigm` 포함.

- [ ] **Step 6: Commit**

```bash
git add infrastructure/lib/stacks/data/aurora-vector-param-group.construct.ts infrastructure/lib/stacks/data/aurora.construct.ts
git commit -m "260517 add custom Aurora parameter group with pg_bigm preload"
```

---

## Task 2: Dev Aurora ACU 상향 (2 → 4)

지난 7일 dev 클러스터의 ACU 사용량 측정에서 168시간 중 65시간(39%)이 2.0 ACU 천장에 머물렀다. 벡터 HNSW 인덱스 빌드/검색을 추가하기 전 헤드룸 확보가 필요하다.

**Files:**
- Modify: `infrastructure/lib/stacks/data/aurora.construct.ts:63`

- [ ] **Step 1: ACU max 상향**

`infrastructure/lib/stacks/data/aurora.construct.ts:63`을 다음으로 변경:

```typescript
serverlessV2MaxCapacity: isProd ? 8 : 4,
```

(prod 값은 현 시점 측정 데이터가 없으므로 보수적으로 4 → 8. prod 배포 전 별도 측정 필수 — Task 11 참조.)

- [ ] **Step 2: 배포**

Run:
```bash
cd infrastructure && pnpm cdk deploy Ym-Dev-Data --profile ym-dev --require-approval never
```

Expected: ACU 변경은 무중단. 즉시 반영.

- [ ] **Step 3: 변경 확인**

Run:
```bash
aws rds describe-db-clusters --profile ym-dev --region ap-northeast-2 \
  --db-cluster-identifier ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm \
  --query 'DBClusters[0].ServerlessV2ScalingConfiguration' --output json
```

Expected: `{"MinCapacity": 0.5, "MaxCapacity": 4.0}`.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/lib/stacks/data/aurora.construct.ts
git commit -m "260517 raise dev Aurora ACU max to 4 for vector workload headroom"
```

---

## Task 3: Migration 0025 — Bedrock KB 벡터 테이블

Bedrock KB의 RDS storage가 요구하는 정확한 스키마: `id uuid PK`, `embedding vector(1024)`, `chunks text`, `metadata jsonb`, plus `custom_metadata jsonb` (data source의 .metadata.json sidecar 보관용). HNSW(cosine)과 pg_bigm GIN 인덱스를 함께 만든다.

**Files:**
- Create: `infrastructure/lib/stacks/data/sql/migrations/0025-bedrock-kb-vector-table.sql`

- [ ] **Step 1: 마이그레이션 SQL 작성**

`infrastructure/lib/stacks/data/sql/migrations/0025-bedrock-kb-vector-table.sql` 신규 생성:

```sql
-- Migration 0025: Bedrock KB vector table for RDS storage configuration. Schema follows AWS-required field mapping (id, embedding, chunks, metadata) plus a custom_metadata column for data-source side metadata.

CREATE SCHEMA IF NOT EXISTS bedrock_integration;

CREATE TABLE IF NOT EXISTS bedrock_integration.bedrock_kb_legal (
  id              UUID         PRIMARY KEY,
  embedding       vector(1024) NOT NULL,
  chunks          TEXT         NOT NULL,
  metadata        JSONB        NOT NULL,
  custom_metadata JSONB
);

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_embedding_hnsw_idx
  ON bedrock_integration.bedrock_kb_legal
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_chunks_bigm_idx
  ON bedrock_integration.bedrock_kb_legal
  USING gin (chunks gin_bigm_ops);
```

- [ ] **Step 2: 마이그레이션 적용 (CDK Custom Resource 재호출)**

마이그레이션 러너는 파일 해시가 바뀌면 자동 재실행되므로 CDK 배포로 충분:

```bash
cd infrastructure && pnpm cdk deploy Ym-Dev-Data --profile ym-dev --require-approval never
```

Expected: SchemaMigratorFn Lambda가 0025를 새로 적용. CloudWatch logs `/aws/lambda/Ym-Dev-Data-SchemaMigratorFn*` 에 `applied 0025-bedrock-kb-vector-table.sql` 로그.

- [ ] **Step 3: 테이블/인덱스 생성 확인**

Run:
```bash
aws rds-data execute-statement \
  --profile ym-dev --region ap-northeast-2 \
  --resource-arn "arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm" \
  --secret-arn "arn:aws:secretsmanager:ap-northeast-2:823401933116:secret:YmDevDataAuroraClusterSecre-ubRXVwKarzBy-6p43Zw" \
  --database yourmillionare \
  --sql "SELECT indexname FROM pg_indexes WHERE schemaname = 'bedrock_integration' ORDER BY indexname"
```

Expected: `bedrock_kb_legal_chunks_bigm_idx`, `bedrock_kb_legal_embedding_hnsw_idx`, `bedrock_kb_legal_pkey` 3개 행 반환.

- [ ] **Step 4: schema_migrations에 0025 기록 확인**

Run:
```bash
aws rds-data execute-statement \
  --profile ym-dev --region ap-northeast-2 \
  --resource-arn "arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm" \
  --secret-arn "arn:aws:secretsmanager:ap-northeast-2:823401933116:secret:YmDevDataAuroraClusterSecre-ubRXVwKarzBy-6p43Zw" \
  --database yourmillionare \
  --sql "SELECT version, applied_at FROM schema_migrations WHERE version LIKE '0025%'"
```

Expected: 1개 행, version=`0025-bedrock-kb-vector-table.sql`, applied_at은 현재 시각.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/lib/stacks/data/sql/migrations/0025-bedrock-kb-vector-table.sql
git commit -m "260517 add migration 0025 for Bedrock KB vector table"
```

---

## Task 4: KB 전용 DB Role + 시크릿 신설

Bedrock KB가 마스터 시크릿을 쓰지 않고 권한 제한된 별도 사용자(`bedrock_kb_user`)로 접속하게 한다. 시크릿은 CDK가 Secrets Manager에 생성하고 KB construct에 ARN을 전달.

**Files:**
- Create: `infrastructure/lib/stacks/data/sql/migrations/0026-bedrock-kb-db-role.sql`
- Modify: `infrastructure/lib/stacks/data.stack.ts` (시크릿 생성, export)

- [ ] **Step 1: DB role 마이그레이션 작성**

`infrastructure/lib/stacks/data/sql/migrations/0026-bedrock-kb-db-role.sql` 신규 생성:

```sql
-- Migration 0026: Bedrock KB DB role with scoped privileges on bedrock_integration schema only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_kb_user') THEN
    CREATE ROLE bedrock_kb_user LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA bedrock_integration TO bedrock_kb_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock_integration.bedrock_kb_legal TO bedrock_kb_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA bedrock_integration
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedrock_kb_user;
```

비밀번호는 다음 Step에서 CDK가 생성/주입.

- [ ] **Step 2: 시크릿 생성을 위한 헬퍼 마이그레이션 작성**

`infrastructure/lib/stacks/data/sql/migrations/0027-bedrock-kb-db-password.sql` 신규 생성. 이 SQL은 CDK Custom Resource로 호출되며, `:password` 파라미터로 들어온 값을 사용한다. SchemaMigratorFn은 파라미터 바인딩을 지원하지 않으므로, 별도 ad-hoc Custom Resource 또는 init Lambda로 처리한다. 여기서는 가장 단순한 방법으로 진행:

대신, **데이터 스택에 SecretBinding Custom Resource**를 추가한다. `infrastructure/lib/stacks/data.stack.ts`에 다음을 추가:

```typescript
// Bedrock KB credentials: Secrets Manager + Aurora role binding via Data API.

import { Secret as SmSecret } from 'aws-cdk-lib/aws-secretsmanager';

// 기존 클래스 내부 cluster 생성 직후:
const kbDbSecret = new SmSecret(this, 'BedrockKbDbSecret', {
  secretName: `${id}-bedrock-kb-db-credentials`,
  description: 'Credentials for bedrock_kb_user role on Aurora pgvector store',
  generateSecretString: {
    secretStringTemplate: JSON.stringify({
      username: 'bedrock_kb_user',
      dbname: 'yourmillionare',
      host: aurora.cluster.clusterEndpoint.hostname,
      port: 5432,
      engine: 'postgres',
      dbClusterIdentifier: aurora.cluster.clusterIdentifier,
    }),
    generateStringKey: 'password',
    excludePunctuation: true,
    passwordLength: 32,
  },
});

// 시크릿 변경 시 ALTER ROLE을 실행해서 비밀번호를 DB에 적용.
// Custom Resource 구현은 단순 Lambda로:
const passwordBinder = new NodejsFunction(this, 'KbDbPasswordBinderFn', {
  entry: join(__dirname, 'data/kb-password-binder.lambda.ts'),
  handler: 'handler',
  runtime: Runtime.NODEJS_20_X,
  timeout: Duration.minutes(2),
  environment: {
    CLUSTER_ARN: aurora.cluster.clusterArn,
    MASTER_SECRET_ARN: aurora.masterSecret.secretArn,
    KB_SECRET_ARN: kbDbSecret.secretArn,
    DATABASE_NAME: 'yourmillionare',
  },
});
aurora.cluster.grantDataApiAccess(passwordBinder);
aurora.masterSecret.grantRead(passwordBinder);
kbDbSecret.grantRead(passwordBinder);

const passwordBinderProvider = new Provider(this, 'KbDbPasswordBinderProvider', {
  onEventHandler: passwordBinder,
});

new CustomResource(this, 'KbDbPasswordBinding', {
  serviceToken: passwordBinderProvider.serviceToken,
  properties: {
    secretArn: kbDbSecret.secretArn,
  },
});

this.bedrockKbDbSecret = kbDbSecret;
```

`DataStack` 클래스에 public 필드 추가:

```typescript
public readonly bedrockKbDbSecret: SmSecret;
```

- [ ] **Step 3: Password binder Lambda 작성**

`infrastructure/lib/stacks/data/kb-password-binder.lambda.ts` 신규 생성:

```typescript
// Custom Resource handler: reads the bedrock-kb-db-credentials secret and ALTER ROLE to apply the password to bedrock_kb_user.

import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';

const rds = new RDSDataClient({});
const sm = new SecretsManagerClient({});

const REQUIRED_ENV = ['CLUSTER_ARN', 'MASTER_SECRET_ARN', 'KB_SECRET_ARN', 'DATABASE_NAME'] as const;
const env = Object.fromEntries(REQUIRED_ENV.map((k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return [k, v];
})) as Record<typeof REQUIRED_ENV[number], string>;

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<CloudFormationCustomResourceResponse> => {
  if (event.RequestType === 'Delete') {
    return { ...common(event), Status: 'SUCCESS' };
  }

  const kbSecretRaw = await sm.send(new GetSecretValueCommand({ SecretId: env.KB_SECRET_ARN }));
  const kbSecret = JSON.parse(kbSecretRaw.SecretString ?? '{}');
  const password = kbSecret.password;
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('KB secret missing password');
  }

  await rds.send(new ExecuteStatementCommand({
    resourceArn: env.CLUSTER_ARN,
    secretArn: env.MASTER_SECRET_ARN,
    database: env.DATABASE_NAME,
    sql: `ALTER ROLE bedrock_kb_user WITH PASSWORD '${password.replace(/'/g, "''")}'`,
  }));

  return { ...common(event), Status: 'SUCCESS' };
};

const common = (event: CloudFormationCustomResourceEvent): Omit<CloudFormationCustomResourceResponse, 'Status'> => ({
  PhysicalResourceId: event.LogicalResourceId,
  StackId: event.StackId,
  RequestId: event.RequestId,
  LogicalResourceId: event.LogicalResourceId,
});
```

- [ ] **Step 4: 배포 + 검증**

Run:
```bash
cd infrastructure && pnpm cdk deploy Ym-Dev-Data --profile ym-dev --require-approval never
```

Expected: 새 시크릿 생성, password binder Lambda 실행 후 0026/0027 마이그레이션 적용.

확인:
```bash
aws rds-data execute-statement \
  --profile ym-dev --region ap-northeast-2 \
  --resource-arn "arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm" \
  --secret-arn "arn:aws:secretsmanager:ap-northeast-2:823401933116:secret:YmDevDataAuroraClusterSecre-ubRXVwKarzBy-6p43Zw" \
  --database yourmillionare \
  --sql "SELECT rolname FROM pg_roles WHERE rolname = 'bedrock_kb_user'"
```

Expected: 1개 행 `bedrock_kb_user`.

Bedrock KB 자격으로 SELECT 가능한지 확인 — Aurora KB secret ARN을 환경에 export 후:

```bash
KB_SECRET_ARN=$(aws secretsmanager list-secrets --profile ym-dev --region ap-northeast-2 \
  --query "SecretList[?contains(Name, 'bedrock-kb-db-credentials')].ARN | [0]" --output text)
aws rds-data execute-statement --profile ym-dev --region ap-northeast-2 \
  --resource-arn "arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm" \
  --secret-arn "$KB_SECRET_ARN" \
  --database yourmillionare \
  --sql "SELECT COUNT(*) FROM bedrock_integration.bedrock_kb_legal"
```

Expected: 0 (테이블은 비어 있지만 SELECT 권한 있음).

- [ ] **Step 5: Commit**

```bash
git add infrastructure/lib/stacks/data/sql/migrations/0026-bedrock-kb-db-role.sql \
        infrastructure/lib/stacks/data/kb-password-binder.lambda.ts \
        infrastructure/lib/stacks/data.stack.ts
git commit -m "260517 add scoped DB role and secret for Bedrock KB Aurora access"
```

---

## Task 5: LegalKbConstruct 리팩토링 (S3 Vectors → RDS)

KB의 StorageConfiguration 변경은 CFN replacement를 트리거하므로 새 KB ID가 발급된다. 기존 KB는 `RemovalPolicy.RETAIN`이라 자동 삭제되지 않고 orphan으로 남는다(나중에 Task 9에서 정리).

**Files:**
- Modify: `infrastructure/lib/stacks/ingestion/legal-kb.construct.ts` (전면 개편)
- Modify: `infrastructure/lib/stacks/ingestion.stack.ts:419-440` (props 전달 변경)

- [ ] **Step 1: legal-kb.construct.ts 교체**

`infrastructure/lib/stacks/ingestion/legal-kb.construct.ts` 파일 전체를 다음으로 교체:

```typescript
// Construct: Bedrock Knowledge Base wired to Aurora pgvector storage + S3 data source for legal corpus retrieval.

import { CfnResource, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const EMBED_MODEL_DEFAULT = 'amazon.titan-embed-text-v2:0';
const EMBED_DIMENSION_DEFAULT = 1024;
const INCLUSION_PREFIX = 'chunks/';
const KB_TABLE_NAME = 'bedrock_integration.bedrock_kb_legal';
const KB_DATABASE_NAME = 'yourmillionare';

export interface LegalKbConstructProps {
  readonly corpusBucket: IBucket;
  readonly kbName: string;
  readonly auroraCluster: DatabaseCluster;
  readonly auroraKbSecret: ISecret;
  readonly embedModel?: string;
  readonly embedDimension?: number;
  readonly embedRegion?: string;
}

export class LegalKbConstruct extends Construct {
  public readonly kbId: string;
  public readonly dataSourceId: string;
  public readonly kbArn: string;

  constructor(scope: Construct, id: string, props: LegalKbConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const embedModel = props.embedModel ?? EMBED_MODEL_DEFAULT;
    const embedDimension = props.embedDimension ?? EMBED_DIMENSION_DEFAULT;
    const embedRegion = props.embedRegion ?? region;
    const embedModelArn = `arn:aws:bedrock:${embedRegion}::foundation-model/${embedModel}`;

    const kbRole = new Role(this, 'KbRole', {
      assumedBy: new ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${region}:${account}:knowledge-base/*` },
        },
      }),
      inlinePolicies: {
        S3Corpus: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [props.corpusBucket.bucketArn, `${props.corpusBucket.bucketArn}/*`],
              conditions: { StringEquals: { 'aws:ResourceAccount': account } },
            }),
          ],
        }),
        BedrockEmbed: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: [embedModelArn],
            }),
          ],
        }),
        RdsDataApi: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [props.auroraCluster.clusterArn],
            }),
          ],
        }),
        SecretAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.auroraKbSecret.secretArn],
            }),
          ],
        }),
      },
    });

    NagSuppressions.addResourceSuppressions(
      kbRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Bedrock KB ingestion role needs s3:GetObject across the corpus bucket prefix (chunks/*) because object keys are generated per-law-revision. RDS Data API actions are scoped to the cluster ARN.',
        },
      ],
      true,
    );

    const kb = new CfnResource(this, 'KnowledgeBase', {
      type: 'AWS::Bedrock::KnowledgeBase',
      properties: {
        Name: props.kbName,
        RoleArn: kbRole.roleArn,
        KnowledgeBaseConfiguration: {
          Type: 'VECTOR',
          VectorKnowledgeBaseConfiguration: {
            EmbeddingModelArn: embedModelArn,
            EmbeddingModelConfiguration: {
              BedrockEmbeddingModelConfiguration: {
                Dimensions: embedDimension,
                EmbeddingDataType: 'FLOAT32',
              },
            },
          },
        },
        StorageConfiguration: {
          Type: 'RDS',
          RdsConfiguration: {
            ResourceArn: props.auroraCluster.clusterArn,
            CredentialsSecretArn: props.auroraKbSecret.secretArn,
            DatabaseName: KB_DATABASE_NAME,
            TableName: KB_TABLE_NAME,
            FieldMapping: {
              PrimaryKeyField: 'id',
              VectorField: 'embedding',
              TextField: 'chunks',
              MetadataField: 'metadata',
              CustomMetadataField: 'custom_metadata',
            },
          },
        },
      },
    });
    kb.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.kbId = kb.getAtt('KnowledgeBaseId').toString();
    this.kbArn = kb.getAtt('KnowledgeBaseArn').toString();

    const dataSource = new CfnResource(this, 'DataSource', {
      type: 'AWS::Bedrock::DataSource',
      properties: {
        KnowledgeBaseId: this.kbId,
        Name: `${props.kbName}-s3-chunks`,
        DataSourceConfiguration: {
          Type: 'S3',
          S3Configuration: {
            BucketArn: props.corpusBucket.bucketArn,
            InclusionPrefixes: [INCLUSION_PREFIX],
          },
        },
        VectorIngestionConfiguration: {
          ChunkingConfiguration: { ChunkingStrategy: 'NONE' },
        },
        DataDeletionPolicy: 'RETAIN',
      },
    });
    dataSource.addDependency(kb);
    this.dataSourceId = dataSource.getAtt('DataSourceId').toString();
  }
}
```

- [ ] **Step 2: ingestion.stack.ts에서 props 변경**

`infrastructure/lib/stacks/ingestion.stack.ts:419-428`을 다음으로 교체:

```typescript
const isProdEnv = props.deploymentEnv === 'prod';
const legalKb = new LegalKbConstruct(this, 'LegalKbV2', {
  corpusBucket: legalKbBucket,
  kbName: `legal-kb-${isProdEnv ? 'prod' : 'dev'}`,
  auroraCluster: props.auroraCluster,
  auroraKbSecret: props.bedrockKbDbSecret,
  embedModel: props.bedrockEmbedModel,
  embedDimension: 1024,
  embedRegion: region,
});
```

`IngestionStackProps` 인터페이스(같은 파일 상단)에 다음 추가:

```typescript
readonly auroraCluster: DatabaseCluster;
readonly bedrockKbDbSecret: ISecret;
```

필요한 import:
```typescript
import type { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
```

App 레벨 (보통 `infrastructure/bin/`)에서 IngestionStack을 인스턴스화하는 곳에 `auroraCluster: dataStack.aurora.cluster, bedrockKbDbSecret: dataStack.bedrockKbDbSecret` 전달.

- [ ] **Step 3: CDK synth로 RdsConfiguration 검증**

Run:
```bash
cd infrastructure && pnpm cdk synth Ym-Dev-Ingestion --profile ym-dev 2>&1 | grep -A 20 '"StorageConfiguration"'
```

Expected: `"Type": "RDS"`, `RdsConfiguration` 블록에 ResourceArn/CredentialsSecretArn/DatabaseName/TableName/FieldMapping 모두 채워져 있음.

- [ ] **Step 4: 배포 (KB replacement)**

Run:
```bash
cd infrastructure && pnpm cdk deploy Ym-Dev-Ingestion --profile ym-dev --require-approval never
```

Expected: 기존 KB `XDCWAUFING`은 RETAIN으로 orphan, 새 KB ID 발급. 배포 후 새 KB ID 확인:

```bash
aws cloudformation describe-stacks --profile ym-dev --region ap-northeast-2 \
  --stack-name Ym-Dev-Ingestion \
  --query "Stacks[0].Outputs[?OutputKey=='LegalKbId'].OutputValue" --output text
```

새 ID를 기록 (예: `NEWKBABCD`).

- [ ] **Step 5: Commit**

```bash
git add infrastructure/lib/stacks/ingestion/legal-kb.construct.ts infrastructure/lib/stacks/ingestion.stack.ts infrastructure/bin/
git commit -m "260517 switch Bedrock KB storage from S3 Vectors to Aurora pgvector"
```

---

## Task 6: Ingestion 트리거 + 색인 결과 검증

이전 S3 Vectors KB에서는 583/629가 메타데이터 2KB 한도 위반으로 실패했다. Aurora JSONB는 사실상 무제한이므로 전 청크가 성공해야 한다.

**Files:** (실행만, 코드 수정 없음)

- [ ] **Step 1: 새 KB ID 확인**

Run:
```bash
NEW_KB_ID=$(aws cloudformation describe-stacks --profile ym-dev --region ap-northeast-2 \
  --stack-name Ym-Dev-Ingestion \
  --query "Stacks[0].Outputs[?OutputKey=='LegalKbId'].OutputValue" --output text)
NEW_DS_ID=$(aws cloudformation describe-stacks --profile ym-dev --region ap-northeast-2 \
  --stack-name Ym-Dev-Ingestion \
  --query "Stacks[0].Outputs[?OutputKey=='LegalKbDataSourceId'].OutputValue" --output text)
echo "KB=$NEW_KB_ID DS=$NEW_DS_ID"
```

Expected: 두 값 모두 비어 있지 않음.

- [ ] **Step 2: Ingestion job 시작**

Run:
```bash
aws bedrock-agent start-ingestion-job --profile ym-dev --region ap-northeast-2 \
  --knowledge-base-id "$NEW_KB_ID" \
  --data-source-id "$NEW_DS_ID" \
  --query 'ingestionJob.ingestionJobId' --output text
```

JOB_ID로 받음.

- [ ] **Step 3: 완료까지 polling**

Run:
```bash
JOB_ID=<위 단계 결과>
while true; do
  STATUS=$(aws bedrock-agent get-ingestion-job --profile ym-dev --region ap-northeast-2 \
    --knowledge-base-id "$NEW_KB_ID" --data-source-id "$NEW_DS_ID" \
    --ingestion-job-id "$JOB_ID" --query 'ingestionJob.status' --output text)
  echo "$(date +%H:%M:%S) status=$STATUS"
  [ "$STATUS" = "COMPLETE" ] && break
  [ "$STATUS" = "FAILED" ] && break
  sleep 10
done
```

Expected: 약 1–3분 후 `COMPLETE`.

- [ ] **Step 4: 통계 확인 — 전수 색인 검증**

Run:
```bash
aws bedrock-agent get-ingestion-job --profile ym-dev --region ap-northeast-2 \
  --knowledge-base-id "$NEW_KB_ID" --data-source-id "$NEW_DS_ID" \
  --ingestion-job-id "$JOB_ID" --query 'ingestionJob.statistics'
```

Expected:
- `numberOfDocumentsScanned`: 629
- `numberOfNewDocumentsIndexed`: 629 (또는 629에 근접, 0 또는 1자리 실패만 허용)
- `numberOfDocumentsFailed`: 0 (또는 한 자릿수). 만약 583 같은 큰 숫자가 나오면 실패. failureReasons 확인하여 메타데이터 형태 디버그.

- [ ] **Step 5: Aurora에서 직접 행 수 검증**

Run:
```bash
KB_SECRET_ARN=$(aws secretsmanager list-secrets --profile ym-dev --region ap-northeast-2 \
  --query "SecretList[?contains(Name, 'bedrock-kb-db-credentials')].ARN | [0]" --output text)
aws rds-data execute-statement --profile ym-dev --region ap-northeast-2 \
  --resource-arn "arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm" \
  --secret-arn "$KB_SECRET_ARN" \
  --database yourmillionare \
  --sql "SELECT COUNT(*) FROM bedrock_integration.bedrock_kb_legal"
```

Expected: 629 (또는 ingestion 통계의 indexed 수와 일치).

---

## Task 7: 하이브리드 검색 E2E 스모크 테스트

색인이 됐어도 실제로 `overrideSearchType: 'HYBRID'`가 통하는지, pg_bigm GIN 인덱스가 사용되는지 확인이 필요.

**Files:**
- Create: `scripts/verify-bedrock-kb-aurora.sh`

- [ ] **Step 1: 검증 스크립트 작성**

`scripts/verify-bedrock-kb-aurora.sh` 신규 생성:

```bash
#!/usr/bin/env bash
# Verify Bedrock KB Aurora pgvector hybrid search end-to-end.

set -euo pipefail

CLUSTER_ARN="arn:aws:rds:ap-northeast-2:823401933116:cluster:ym-dev-data-auroracluster23d869c0-dcyyjbfutpcm"
MASTER_SECRET="arn:aws:secretsmanager:ap-northeast-2:823401933116:secret:YmDevDataAuroraClusterSecre-ubRXVwKarzBy-6p43Zw"
DB=yourmillionare
PROFILE=ym-dev
REGION=ap-northeast-2

KB_ID="${1:?Usage: $0 <kb-id>}"

echo "=== 1. Row count ==="
aws rds-data execute-statement --profile $PROFILE --region $REGION \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET" --database $DB \
  --sql "SELECT COUNT(*) FROM bedrock_integration.bedrock_kb_legal" \
  --query 'records[0][0].longValue' --output text

echo "=== 2. Index usage on bigm GIN (Korean keyword search) ==="
aws rds-data execute-statement --profile $PROFILE --region $REGION \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET" --database $DB \
  --sql "EXPLAIN ANALYZE SELECT id FROM bedrock_integration.bedrock_kb_legal WHERE chunks LIKE '%부가가치세%' LIMIT 5" \
  --query 'records[*][0].stringValue' --output text

echo "=== 3. KB retrieve via Bedrock API (HYBRID) ==="
aws bedrock-agent-runtime retrieve --profile $PROFILE --region $REGION \
  --knowledge-base-id "$KB_ID" \
  --retrieval-query '{"text": "부가가치세 신고 기한"}' \
  --retrieval-configuration '{"vectorSearchConfiguration": {"numberOfResults": 5, "overrideSearchType": "HYBRID"}}' \
  --query 'retrievalResults[*].content.text' --output text | head -c 2000
echo
```

권한:
```bash
chmod +x scripts/verify-bedrock-kb-aurora.sh
```

- [ ] **Step 2: 실행**

Run:
```bash
./scripts/verify-bedrock-kb-aurora.sh $NEW_KB_ID
```

Expected:
- 섹션 1: 629 (또는 indexed 행 수)
- 섹션 2: EXPLAIN 출력에 `Bitmap Index Scan on bedrock_kb_legal_chunks_bigm_idx` 또는 비슷한 표현이 보여야 함 (테이블 전체 scan이면 인덱스 미사용)
- 섹션 3: 한국어 부가세 관련 법령 인용 텍스트가 반환됨

- [ ] **Step 4: 기존 search-tax-law endpoint 테스트**

Lambda 환경변수 `BEDROCK_KB_ID`가 새 KB ID로 갱신됐는지 확인 (Task 5 배포 후 자동 반영됐어야 함):

```bash
aws lambda get-function-configuration --profile ym-dev --region ap-northeast-2 \
  --function-name <tax-knowledge-lambda-name> \
  --query 'Environment.Variables.BEDROCK_KB_ID' --output text
```

Expected: `$NEW_KB_ID`과 일치.

(실제 함수명은 ApiStack의 출력에서 확인. CFN export 또는 `aws lambda list-functions | grep tax-knowledge`)

API 호출은 인증이 필요하므로 별도 토큰 발급 후 수동 테스트. 또는 기존 통합 테스트 스위트 실행:

```bash
cd apps/tax-knowledge && pnpm test:integration -- search-tax-law
```

Expected: 통합 테스트 통과 (만약 통합 테스트가 KB 의존이면).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-bedrock-kb-aurora.sh
git commit -m "260517 add Bedrock KB Aurora hybrid search verification script"
```

---

## Task 8: 문서 갱신

CLAUDE.md 규칙에 따라 README와 ARCHITECTURE.md가 코드와 동기화돼야 한다. 그리고 schema.sql도 bedrock_integration 포함하도록 재생성.

**Files:**
- Modify: `docs/ARCHITECTURE.md:152` (그 부근의 KB 백엔드 설명)
- Modify: `README.md` (환경변수 섹션, 외부 의존성 섹션)
- Modify: `infrastructure/lib/stacks/data/sql/schema.sql` (재생성)

- [ ] **Step 1: ARCHITECTURE.md 수정**

`docs/ARCHITECTURE.md`에서 "S3 Vectors" 언급을 찾아 모두 Aurora pgvector로 수정. 특히 라인 152 부근의 백엔드 설명. 함께 다음을 추가:

```markdown
### Vector store

- Backend: **Aurora pgvector** (PostgreSQL 15, pgvector 0.8.0, pg_bigm 1.2)
- Table: `bedrock_integration.bedrock_kb_legal`
- Embedding: Titan Embed v2, 1024-dim, cosine distance, HNSW index
- Korean keyword search: pg_bigm GIN index on `chunks` column
- KB → DB transport: RDS Data API (HTTPS public endpoint, no VPC requirement)
- Hybrid search: `overrideSearchType: 'HYBRID'` now works (was silently no-op on S3 Vectors)
```

기존 "S3 Vectors" 문단은 "Historical note: 2026-05-12 ~ 2026-05-17 동안 S3 Vectors를 사용했으나 메타데이터 2KB 한도로 92.7% 색인 실패. Aurora pgvector로 이전."로 압축.

- [ ] **Step 2: README.md 수정**

환경변수 섹션에서 `BEDROCK_KB_ID`는 그대로(값만 새 KB ID로 바뀜). 새로 추가 환경변수는 없음. 외부 의존성 섹션에 다음 추가:

```markdown
### Aurora pgvector

- Aurora PostgreSQL 15.15 with `pgvector` 0.8.0 and `pg_bigm` 1.2
- Custom DB cluster parameter group preloads `pg_bigm` and tunes work_mem/maintenance_work_mem for HNSW
- Bedrock Knowledge Base connects via RDS Data API (no VPC peering needed)
```

S3 Vectors 관련 언급이 있으면 삭제.

- [ ] **Step 3: schema.sql 재생성**

`infrastructure/lib/stacks/data/sql/schema.sql`을 최신 DB 상태로 재생성. 두 가지 옵션:

(a) `pg_dump`로 직접 dump:
```bash
KB_SECRET_ARN=$(aws secretsmanager list-secrets --profile ym-dev --region ap-northeast-2 \
  --query "SecretList[?contains(Name, 'bedrock-kb-db-credentials')].ARN | [0]" --output text)
# pg_dump를 Aurora에 붙이려면 VPN/bastion 필요 — 간단한 우회: schema.sql에 수동 추가.
```

(b) 수동 추가 — `schema.sql` 끝부분에 0025/0026 적용 결과를 그대로 반영:

```sql
-- Bedrock KB integration (migrations 0025, 0026)
CREATE SCHEMA IF NOT EXISTS bedrock_integration;

CREATE TABLE IF NOT EXISTS bedrock_integration.bedrock_kb_legal (
  id              UUID         PRIMARY KEY,
  embedding       vector(1024) NOT NULL,
  chunks          TEXT         NOT NULL,
  metadata        JSONB        NOT NULL,
  custom_metadata JSONB
);

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_embedding_hnsw_idx
  ON bedrock_integration.bedrock_kb_legal
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bedrock_kb_legal_chunks_bigm_idx
  ON bedrock_integration.bedrock_kb_legal
  USING gin (chunks gin_bigm_ops);

-- bedrock_kb_user role created by migration 0026; password set by CDK Custom Resource.
```

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md README.md infrastructure/lib/stacks/data/sql/schema.sql
git commit -m "260517 update docs and schema.sql for Aurora pgvector migration"
```

---

## Task 9: 기존 S3 Vectors 리소스 정리

새 KB가 1주일 이상 안정 운영된 뒤에만 진행. 기존 KB(`XDCWAUFING`)와 S3 Vectors 버킷/인덱스는 RETAIN으로 orphan 상태. CDK 코드에서 이미 제거됐으므로 AWS Console/CLI로 수동 삭제.

**Files:** (실행만)

- [ ] **Step 1: 안정성 확인 (배포 후 7일 경과)**

새 KB에 대한 ingestion이 월간 cron으로 1회 이상 정상 완료됐는지 확인:

```bash
aws bedrock-agent list-ingestion-jobs --profile ym-dev --region ap-northeast-2 \
  --knowledge-base-id "$NEW_KB_ID" --data-source-id "$NEW_DS_ID" \
  --max-results 5 --query 'ingestionJobSummaries[*].{Started:startedAt,Status:status,Failed:statistics.numberOfDocumentsFailed}'
```

Expected: 최근 job들 모두 `COMPLETE`, Failed가 모두 0 또는 한 자릿수.

- [ ] **Step 2: 기존 KB 삭제**

```bash
aws bedrock-agent delete-knowledge-base --profile ym-dev --region ap-northeast-2 \
  --knowledge-base-id XDCWAUFING
```

Expected: HTTP 202. 비동기 삭제 진행.

- [ ] **Step 3: S3 Vectors 인덱스/버킷 삭제**

S3 Vectors CLI 명령이 현재 로컬 AWS CLI에 없으므로 AWS Console에서 수동 삭제 또는 신버전 CLI 사용:

```bash
# 신버전 AWS CLI에 s3vectors가 포함되어 있는 경우:
aws s3vectors delete-index --profile ym-dev --region ap-northeast-2 \
  --vector-bucket-name "ym-dev-legal-kb-v2-823401933116" \
  --index-name legal-kb-index
aws s3vectors delete-vector-bucket --profile ym-dev --region ap-northeast-2 \
  --vector-bucket-name "ym-dev-legal-kb-v2-823401933116"
```

Expected: 두 명령 모두 성공.

- [ ] **Step 4: 확인 + Commit (코드 변경 없음, no-op commit 생략)**

```bash
# 코드는 이미 Task 5에서 제거됐으므로 추가 커밋 없음.
echo "S3 Vectors cleanup complete."
```

---

## Task 10: Prod Rollout 준비

Prod는 dev와 다른 데이터/부하 특성이 있고 다운타임 허용 윈도우가 다르다. dev에서 검증 완료된 동일 변경을 prod에 배포하기 전에 prod-only 확인 사항을 수행.

**Files:** (계측 위주)

- [ ] **Step 1: Prod ACU 사용량 측정**

`ym-prod` 프로파일 설정 후 다음 실행 (현재 로컬에 ym-prod 없음 — 사용자가 설정 필요):

```bash
PROD_CLUSTER=<prod cluster identifier>
aws cloudwatch get-metric-statistics --profile ym-prod --region ap-northeast-2 \
  --namespace AWS/RDS --metric-name ServerlessDatabaseCapacity \
  --dimensions Name=DBClusterIdentifier,Value=$PROD_CLUSTER \
  --start-time $(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 --statistics Average Maximum --output json | python3 -c "
import json, sys
d = json.load(sys.stdin)
pts = d.get('Datapoints', [])
avg = sum(p['Average'] for p in pts) / max(len(pts), 1)
mx = max((p['Maximum'] for p in pts), default=0)
sat = sum(1 for p in pts if p['Maximum'] >= 4.0)
print(f'samples={len(pts)} avg_acu={avg:.2f} max_acu={mx:.2f} hours_at_4_ceiling={sat}')
"
```

Expected: hours_at_4_ceiling이 0이거나 매우 작으면 prod max 4 유지로 충분. 1자릿수~두 자릿수면 max 8로 상향. 30% 이상이면 max 16으로 검토.

- [ ] **Step 2: Prod 데이터 규모 추정**

```bash
aws s3 ls s3://<prod-corpus-bucket>/chunks/ --profile ym-prod --recursive --summarize | tail -3
```

Expected: 청크 수 X. 1024-dim float32 → 4KB/vector. 디스크 사용 ≈ X * 4KB * 1.5 (HNSW 오버헤드). 100K chunks라면 600MB — Aurora 입장에서 무시 가능.

- [ ] **Step 3: Prod 배포 계획**

Prod 배포는 dev와 동일 순서로:
1. Custom param group 배포 (재기동 동반 — **사용자 트래픽이 적은 시간대로 예약**)
2. ACU 상향
3. Migration 0025/0026 적용
4. KB credentials 시크릿 생성
5. KB construct 교체 → 기존 prod KB는 RETAIN으로 orphan
6. Ingestion 트리거
7. E2E 스모크 테스트
8. 7일 안정성 관찰 후 기존 KB/S3 Vectors 정리

각 단계마다 dev에서 했던 verification 명령을 prod cluster ARN/secret ARN으로 치환해 재실행.

- [ ] **Step 4: 다운타임 윈도우 고지**

KB replacement 중 약 5–10분간 `search_tax_law`, `find_benefits` 호출이 빈 결과를 반환할 수 있음. 사용자에게 사전 공지. 또는 blue/green 전략으로:

- 새 KB construct를 별도 logical ID로 추가 (예: `LegalKbV3`)
- 새 KB ingestion 완료 후 Lambda 환경변수만 swap
- 기존 KB 후속 정리

이 경우 plan 확장 필요.

---

## Self-Review

**Spec coverage 점검:**

| 요구사항 | 구현 Task |
|---------|----------|
| S3 Vectors → Aurora pgvector 백엔드 교체 | Task 5 |
| Hybrid search 실제 동작 | Task 5 (RDS storage), Task 7 (검증) |
| pg_bigm 한국어 키워드 | Task 1 (preload), Task 3 (인덱스), Task 7 (EXPLAIN) |
| ACU 헤드룸 확보 | Task 2 |
| KB 자격 분리 (최소 권한) | Task 4 |
| 583 청크 실패 해소 | Task 6 (재색인 후 검증) |
| 문서 동기화 | Task 8 |
| 기존 S3 Vectors 정리 | Task 9 |
| Prod 적용 가이드 | Task 10 |

**Placeholder 점검:** 모든 단계에 actual code와 actual commands를 포함했음. `<tax-knowledge-lambda-name>`, `<prod cluster identifier>`, `<위 단계 결과>` 같은 환경 의존 변수는 실행자가 채워야 하는 placeholder이지만 의도된 것.

**Type/네이밍 일관성:**
- 테이블명 `bedrock_integration.bedrock_kb_legal` — Task 3/5/6/7/8 모두 동일.
- 컬럼명 `id, embedding, chunks, metadata, custom_metadata` — Task 3/5 일치.
- DB role명 `bedrock_kb_user` — Task 4 일치.
- 시크릿 logical ID `BedrockKbDbSecret` + 이름 `${id}-bedrock-kb-db-credentials` — Task 4.
- Construct prop명 `auroraCluster`, `auroraKbSecret`, `bedrockKbDbSecret` — Task 5에서 `auroraKbSecret`로 받고 IngestionStackProps는 `bedrockKbDbSecret`로 전달 (이름 다름). **Fix:** IngestionStackProps의 prop명을 `bedrockKbDbSecret`로 유지하고 LegalKbConstruct로 넘길 때 `auroraKbSecret: props.bedrockKbDbSecret`로 매핑 — 이미 Task 5 Step 2에서 그렇게 작성됨.

**알려진 한계:**
- Prod ACU 측정은 `ym-prod` 프로파일 부재로 본 플랜 외부 작업.
- Blue/green 배포 패턴은 Task 10에서 옵션으로 언급만 함. 필요시 별도 플랜.
- `pg_dump` 기반 schema.sql 재생성은 PRIVATE_ISOLATED subnet 때문에 어려움. 수동 추가로 우회.
