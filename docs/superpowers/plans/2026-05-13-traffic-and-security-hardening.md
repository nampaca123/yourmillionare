# Traffic & Security Hardening — PR-A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR-A 단계만 구현 — RDS Proxy 리소스 + WAF (Count mode) + 알람 + RLS `RESET` 제거 + ARCHITECTURE/README 갱신. Lambda env 미변경 (cluster 직결 유지).

**Architecture:** AuroraConstruct 에 `addProxy()` 추가, network 에 `proxySg` 추가, api.stack 에 신규 `WafConstruct` 부착. Lambda IAM 정책은 cluster ARN + proxy ARN 양쪽 허용. WAF managed rules 4종 모두 Count, IP rate limit 만 Block.

**Tech Stack:** CDK v2 (TypeScript), aws-cdk-lib/aws-rds (DatabaseProxy), aws-cdk-lib/aws-wafv2 (CfnWebACL/CfnWebACLAssociation), aws-cdk-lib/aws-cloudwatch (Alarm), vitest, cdk-nag.

**Spec:** [docs/superpowers/specs/2026-05-13-traffic-and-security-hardening-design.md](../specs/2026-05-13-traffic-and-security-hardening-design.md)

---

## Task 1: RDS regional CA bundle commit

**Files:**
- Create: `infrastructure/assets/rds/ap-northeast-2-bundle.pem`

PR-B1 에서 client TLS pinning 에 사용. PR-A 에선 commit만.

- [ ] **Step 1.1: assets 폴더 + CA bundle 다운로드**

```bash
mkdir -p /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/assets/rds
curl -fsSL https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem \
  -o /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/assets/rds/ap-northeast-2-bundle.pem
```

- [ ] **Step 1.2: bundle 유효성 검증**

```bash
openssl crl2pkcs7 -nocrl -certfile /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/assets/rds/ap-northeast-2-bundle.pem \
  | openssl pkcs7 -print_certs -text -noout | grep "Subject:" | head -3
```
Expected: AWS Issued RDS CA 가 1개 이상 출력.

- [ ] **Step 1.3: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/assets/rds/ap-northeast-2-bundle.pem
git commit -m "$(cat <<'EOF'
260513 rdsCaBundle

Commit RDS regional CA bundle for ap-northeast-2 ahead of TLS
server cert pinning in PR-B1.
EOF
)"
```

---

## Task 2: RLS `RESET` 제거 (6개 pg-rls.context.ts)

**Files:**
- Modify: `apps/journal/src/infrastructure/outbound/pg/pg-rls.context.ts`
- Modify: `apps/identity/src/infrastructure/outbound/pg/pg-rls.context.ts`
- Modify: `apps/fx/src/infrastructure/outbound/pg/pg-rls.context.ts`
- Modify: `apps/tax/src/infrastructure/outbound/pg/pg-rls.context.ts`
- Modify: `apps/tax-knowledge/src/infrastructure/outbound/pg/pg-rls.context.ts`
- Modify: `apps/codef/src/infrastructure/outbound/pg/pg-rls.context.ts`

`is_local=true` 변수는 트랜잭션 commit/rollback 시 자동 cleanup. `RESET` 은 session-level statement 이므로 RDS Proxy pinning 트리거. 트랜잭션 시작 시점이라 기능적으로 redundant.

- [ ] **Step 2.1: journal pg-rls.context.ts 변경**

`apps/journal/src/infrastructure/outbound/pg/pg-rls.context.ts` 의 line 21-24 (BEGIN 직후의 3개 RESET 쿼리) 를 제거. 변경 후 구조:

```ts
// Sets PostgreSQL GUC variables within a transaction scope for RLS enforcement.

import type { PoolClient } from 'pg';
import { getPool } from './pg-pool.client.js';

export interface RlsContext {
  cognitoSub?: string;
  userId?: string;
  tenantId?: string;
}

export const withRlsContext = async <T>(
  ctx: RlsContext,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');

    if (ctx.cognitoSub) {
      await client.query("SELECT set_config('app.cognito_sub', $1, true)", [ctx.cognitoSub]);
    }
    if (ctx.userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId]);
    }
    if (ctx.tenantId) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ctx.tenantId]);
    }

    const result = await work(client);

    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
```

- [ ] **Step 2.2: identity/fx/codef pg-rls.context.ts 동일 변경**

Same 3 RESET lines (`RESET app.cognito_sub`, `RESET app.current_user_id`, `RESET app.current_tenant_id`) 제거. 다른 코드는 유지.

- [ ] **Step 2.3: tax pg-rls.context.ts 변경 (RESET 4개)**

`apps/tax/src/infrastructure/outbound/pg/pg-rls.context.ts` 는 `RESET app.is_tax_admin` 도 포함. 4개 RESET 라인 모두 제거. set_config 호출은 그대로 유지 (`is_tax_admin` 포함).

- [ ] **Step 2.4: tax-knowledge pg-rls.context.ts 동일 변경 (RESET 4개 제거)**

- [ ] **Step 2.5: 기존 단위 테스트 실행 — 회귀 확인**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare && npm run build:packages && npm run test
```
Expected: 모든 unit/integration test 통과. RLS context 의 behavior 는 invariant 유지 (트랜잭션 commit 시 LOCAL 변수 해제).

- [ ] **Step 2.6: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add apps/journal/src/infrastructure/outbound/pg/pg-rls.context.ts \
        apps/identity/src/infrastructure/outbound/pg/pg-rls.context.ts \
        apps/fx/src/infrastructure/outbound/pg/pg-rls.context.ts \
        apps/tax/src/infrastructure/outbound/pg/pg-rls.context.ts \
        apps/tax-knowledge/src/infrastructure/outbound/pg/pg-rls.context.ts \
        apps/codef/src/infrastructure/outbound/pg/pg-rls.context.ts
git commit -m "$(cat <<'EOF'
260513 rlsResetRemoval

Remove RESET app.* calls from withRlsContext — RDS Proxy
transaction pinning trigger. set_config(..., true) is already
transaction-scoped and auto-cleared on COMMIT/ROLLBACK.
EOF
)"
```

---

## Task 3: `withRlsContext` 외부 직접 `set_config` 호출 정리

**Files** (확인 대상 8 위치):
- `apps/fx/src/application/fx-strategy-templates.ts:149-150`
- `apps/fx/src/application/revalue-foreign-balances.use-case.ts:28`
- `apps/tax/src/application/strategy-templates.ts:214-215`
- `apps/tax/src/application/financial-statement.use-case.ts:267-268`
- `apps/tax/src/application/tools/get-filing-draft-detail.tool.ts:47-48`
- `apps/codef/src/infrastructure/inbound/http/codef-classify-worker.lambda.ts:56-60`
- `apps/journal/src/infrastructure/outbound/pg/pg-user.repository.ts:19, 31`
- `apps/identity/src/infrastructure/outbound/pg/pg-user.repository.ts:37, 52`

- [ ] **Step 3.1: 각 위치를 읽어 트랜잭션 컨텍스트 확정**

각 파일을 `Read` 로 열어, 직접 `set_config` 호출이 다음 중 하나에 해당하는지 분류:

| 분류 | 처리 |
|---|---|
| **A** `withRlsContext` 안 | 무변경 (이미 안전). PgUserRepository 의 두 호출은 line 13 의 `withRlsContext` 안이므로 A. |
| **B** explicit `client.query('BEGIN')` ... `COMMIT` 안 | 무변경 |
| **C** 트랜잭션 밖 | `withRlsContext` 로 wrap, 또는 explicit BEGIN/COMMIT 추가 |

`codef-classify-worker.lambda.ts:56-60` 은 RESET + set_config 가 inline. 같은 connection 에서 `BEGIN`/`COMMIT` 가 둘러싸여 있는지 확인 — 없으면 wrap. **이 task 의 step별 결과(분류)를 plan 의 commit message 에 enumerate**.

- [ ] **Step 3.2: 분류 C 에 해당하는 위치를 트랜잭션으로 wrap**

분류 C 가 발견되면 (예시 — 실제 파일을 읽어 확정 후), 해당 호출자를 `withRlsContext` 로 감싸거나 explicit `client.query('BEGIN')` / `client.query('COMMIT')` 추가. 변경 전후 코드 양쪽을 commit message 에 명시.

- [ ] **Step 3.3: 단위/통합 테스트 실행**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare && npm run test
```
Expected: 통과. RLS 관련 동작은 변하지 않음 (이미 안전이거나 wrap 으로 안전화).

- [ ] **Step 3.4: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add apps/fx apps/tax apps/codef apps/journal apps/identity
git commit -m "$(cat <<'EOF'
260513 rlsDirectSetConfigAudit

Audit 8 direct set_config call sites outside withRlsContext for
RDS Proxy compatibility. Classification and wrap edits applied.

Sites verified safe (already in withRlsContext or explicit BEGIN/COMMIT):
  <list classification A/B sites here at commit time>
Sites wrapped (were outside transaction):
  <list classification C sites and the wrap applied>
EOF
)"
```

---

## Task 4: `proxySg` 추가 (network.stack.ts)

**Files:**
- Modify: `infrastructure/lib/stacks/network.stack.ts`
- Test: `infrastructure/test/network.stack.test.ts`

`proxySg` 가 Aurora SG 의 ingress 와 Lambda SG 의 outbound 연결을 받음.

- [ ] **Step 4.1: failing snapshot test 추가**

`infrastructure/test/network.stack.test.ts` 에 다음을 추가 (해당 파일이 vitest 패턴인지 기존 테스트 형식 따름):

```ts
it('should expose proxySg with auroraSg ingress on 5432 when proxy SG is requested', () => {
  const app = new App();
  const stack = new NetworkStack(app, 'TestNetwork', {
    deploymentEnv: 'dev',
    availabilityZones: ['ap-northeast-2a', 'ap-northeast-2b', 'ap-northeast-2c'],
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'RDS Proxy ENI security group.',
  });
  // auroraSg should have an ingress rule from proxySg on 5432.
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 5432,
    ToPort: 5432,
    IpProtocol: 'tcp',
  });
});
```

- [ ] **Step 4.2: 테스트 실행 — fail 확인**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure
npx vitest run test/network.stack.test.ts
```
Expected: FAIL — "RDS Proxy ENI security group" 디스크립션을 가진 SG 가 없음.

- [ ] **Step 4.3: `network.stack.ts` 에 proxySg 추가**

`infrastructure/lib/stacks/network.stack.ts` 의 `auroraSg` 정의 (line 126-131) 직후에 추가:

```ts
this.proxySg = new SecurityGroup(this, 'ProxySg', {
  vpc: this.vpc,
  description: 'RDS Proxy ENI security group.',
  allowAllOutbound: false,
});
// Proxy backends to Aurora on 5432.
this.auroraSg.addIngressRule(this.proxySg, Port.tcp(5432), 'Proxy on 5432');
// Lambda → Proxy on 5432. Lambda SG already has allowAllOutbound:true,
// but explicit ingress on proxySg makes the path auditable.
this.proxySg.addIngressRule(this.lambdaSg, Port.tcp(5432), 'Lambda on 5432');
```

NetworkStack 의 public field 와 props 갱신:

```ts
public readonly proxySg: SecurityGroup;
```

그리고 `CfnOutput` 추가:

```ts
new CfnOutput(this, 'ProxySgId', { value: this.proxySg.securityGroupId, exportName: `${id}-ProxySgId` });
```

- [ ] **Step 4.4: 테스트 실행 — pass 확인**

```bash
npx vitest run test/network.stack.test.ts
```
Expected: PASS.

- [ ] **Step 4.5: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/lib/stacks/network.stack.ts infrastructure/test/network.stack.test.ts
git commit -m "$(cat <<'EOF'
260513 proxySgAdd

Add proxySg in network stack: auroraSg ingress on 5432 from
proxySg, proxySg ingress on 5432 from lambdaSg. Prepares for
RDS Proxy in data stack.
EOF
)"
```

---

## Task 5: AuroraConstruct 에 RDS Proxy 추가

**Files:**
- Modify: `infrastructure/lib/stacks/data/aurora.construct.ts`
- Test: `infrastructure/test/data.stack.test.ts`

`AuroraConstructProps` 에 `proxySg` 추가, `cluster.addProxy()` 호출. `proxy` public field 노출.

- [ ] **Step 5.1: failing test 추가 (data.stack.test.ts)**

```ts
it('should create an RDS Proxy attached to Aurora cluster with master secret', () => {
  const app = new App();
  const stack = makeDataStack(app, 'TestData');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::RDS::DBProxy', {
    EngineFamily: 'POSTGRESQL',
    RequireTLS: true,
    Auth: Match.arrayWith([
      Match.objectLike({ AuthScheme: 'SECRETS', IAMAuth: 'REQUIRED' }),
    ]),
  });
  template.hasResourceProperties('AWS::RDS::DBProxyTargetGroup', {
    ConnectionPoolConfigurationInfo: Match.objectLike({
      MaxConnectionsPercent: 90,
      MaxIdleConnectionsPercent: 50,
    }),
  });
});
```

- [ ] **Step 5.2: 테스트 실행 — fail 확인**

```bash
npx vitest run test/data.stack.test.ts
```
Expected: FAIL — `AWS::RDS::DBProxy` 리소스 없음.

- [ ] **Step 5.3: `aurora.construct.ts` 수정 — Proxy 추가**

`AuroraConstructProps` 에 `proxySg` 추가:

```ts
export interface AuroraConstructProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly auroraSg: ISecurityGroup;
  readonly proxySg: ISecurityGroup;
}
```

`AuroraConstruct` 클래스 안에 `proxy` 필드 + 생성자 끝 부분에 `addProxy()` 호출 추가:

```ts
public readonly proxy: DatabaseProxy;

// (안에서, cluster 와 NagSuppressions 사이)
this.proxy = this.cluster.addProxy('AuroraProxy', {
  vpc: props.vpc,
  vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.proxySg],
  secrets: [this.masterSecret],
  iamAuth: true,
  requireTLS: true,
  idleClientTimeout: Duration.minutes(30),
  // 0.5 ACU baseline → small max_connections. 90% keeps headroom.
  maxConnectionsPercent: 90,
  maxIdleConnectionsPercent: 50,
  debugLogging: false,
});

// dev 에서 destroy 가능하도록 removal policy 적용.
const cfnProxy = this.proxy.node.defaultChild as CfnDBProxy;
cfnProxy.applyRemovalPolicy(isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
```

import 추가:

```ts
import { DatabaseProxy, CfnDBProxy } from 'aws-cdk-lib/aws-rds';
```

- [ ] **Step 5.4: data.stack.ts 가 proxySg 전달하도록 수정**

`infrastructure/lib/stacks/data.stack.ts` 의 `DataStackProps` 에 `proxySg` 추가, AuroraConstruct 호출 시 전달:

```ts
export interface DataStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly lambdaSg: ISecurityGroup;
  readonly auroraSg: ISecurityGroup;
  readonly proxySg: ISecurityGroup;
  readonly sharedKey: IKey;
  readonly availabilityZones: string[];
}

// (생성자 내부)
this.aurora = new AuroraConstruct(this, 'AuroraCluster', {
  deploymentEnv: props.deploymentEnv,
  vpc: props.vpc,
  auroraSg: props.auroraSg,
  proxySg: props.proxySg,
});
```

- [ ] **Step 5.5: app entry 가 proxySg 를 data stack 으로 전달하도록 수정**

`infrastructure/bin/` 또는 `infrastructure/lib/` 의 app entry (CDK app 정의 파일) 를 찾아서 NetworkStack 의 `proxySg` 를 DataStack props 로 전달.

```bash
grep -rn "new DataStack\|new NetworkStack" /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/bin /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/lib --include="*.ts" 2>/dev/null
```
출력으로 app entry 찾고, NetworkStack 출력 `proxySg` 를 DataStack 호출에 추가.

- [ ] **Step 5.6: 테스트 재실행 — pass 확인**

```bash
npx vitest run test/data.stack.test.ts
```
Expected: PASS.

- [ ] **Step 5.7: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/lib/stacks/data/aurora.construct.ts \
        infrastructure/lib/stacks/data.stack.ts \
        infrastructure/test/data.stack.test.ts \
        infrastructure/bin/ infrastructure/lib/*.ts 2>/dev/null
git commit -m "$(cat <<'EOF'
260513 rdsProxyAdd

Add RDS Proxy to AuroraConstruct: IAM auth required, TLS required,
maxConnectionsPercent 90 (Serverless v2 0.5 ACU baseline headroom),
maxIdleConnectionsPercent 50, idleClientTimeout 30m. Proxy attached
to master secret. AwsSolutions-SMG4 suppression removed — replaced
by Proxy-based rotation continuity (PR-B1 onwards).
EOF
)"
```

---

## Task 6: Lambda IAM 정책 — cluster + proxy ARN 양쪽 허용 (api.stack.ts)

**Files:**
- Modify: `infrastructure/lib/stacks/api.stack.ts`

5개 HTTP Lambda (Identity / Journal / Fx / Tax / TaxKnowledge) + 3개 SSE Lambda (CodefSync / TaxStrategy / FxStrategy) 의 `rds-db:connect` 정책에 proxy ARN 추가.

- [ ] **Step 6.1: 기존 정책 위치 grep**

```bash
grep -n "rds-db:connect\|clusterResourceIdentifier" /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/lib/stacks/api.stack.ts
```

각 위치를 확인 후 `resources` 배열에 proxy ARN 추가.

- [ ] **Step 6.2: api.stack.ts 의 모든 rds-db:connect 정책에 proxy ARN 추가**

각 Lambda 의 정책 (예시 — 실제 위치별 패턴 동일):

```ts
new PolicyStatement({
  actions: ['rds-db:connect'],
  resources: [
    `arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`,
    `arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.proxy.dbProxyArn.split(':').pop()}/app_user`,
  ],
}),
```

Proxy resource identifier 추출 방식 (CDK token):

```ts
import { Fn } from 'aws-cdk-lib';
const proxyResourceId = Fn.select(6, Fn.split(':', props.aurora.proxy.dbProxyArn));
```

위 두 줄을 stack 생성자 상단에 추가 후, 각 PolicyStatement 의 resources 두 번째 항목으로 사용:

```ts
`arn:aws:rds-db:${region}:${account}:dbuser:${proxyResourceId}/app_user`,
```

- [ ] **Step 6.3: snapshot test (api.stack.test.ts) 갱신**

```ts
it('should grant rds-db:connect on both cluster and proxy resource IDs', () => {
  const template = Template.fromStack(apiStack);
  // 각 Lambda role 의 PolicyDocument 에 cluster ARN AND proxy ARN 둘 다 등장.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'rds-db:connect',
          Resource: Match.arrayWith([
            Match.stringLikeRegexp('arn:aws:rds-db:.*:dbuser:.*/app_user'),
          ]),
        }),
      ]),
    }),
  });
});
```

- [ ] **Step 6.4: test 실행 + commit**

```bash
npx vitest run test/api.stack.test.ts
```
Expected: PASS.

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/lib/stacks/api.stack.ts infrastructure/test/api.stack.test.ts
git commit -m "$(cat <<'EOF'
260513 lambdaIamProxyArn

Add proxy resource ARN to rds-db:connect policy for all 8 Lambdas
(5 HTTP + 3 SSE). Cluster ARN retained for staged cutover. To be
removed in PR-C after prod proxy cutover is stable.
EOF
)"
```

---

## Task 7: Proxy CloudWatch 알람 (data.stack.ts)

**Files:**
- Modify: `infrastructure/lib/stacks/data.stack.ts`
- Test: `infrastructure/test/data.stack.test.ts`

3개 알람: `DatabaseConnections` (Aurora `max_connections` 의 80%), `ConnectionBorrowLatency` p99 > 50ms, `ClientConnectionsBorrowingFromProxy` baseline 5배.

SNS topic 은 ingestion stack 의 `IngestionAlarmTopic` 을 재사용하면 cross-stack ref 가 필요. PR-A 단순화 위해 data stack 안에 신규 `DataAlarmTopic` 생성 후 향후 통합.

- [ ] **Step 7.1: failing test**

```ts
it('should create RDS Proxy alarms on key metrics', () => {
  const template = Template.fromStack(dataStack);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ConnectionBorrowLatency',
    Threshold: 50,
    EvaluationPeriods: 2,
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'DatabaseConnections',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ClientConnectionsBorrowingFromProxy',
  });
});
```

- [ ] **Step 7.2: data.stack.ts 에 알람 + 토픽 추가**

`data.stack.ts` 끝 부분 (CfnOutput 직전) 에 추가:

```ts
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';

// SNS topic for data stack alarms. Subscribers added out-of-band (email/Slack/etc.).
const dataAlarmTopic = new Topic(this, 'DataAlarmTopic', {
  topicName: `${this.stackName}-DataAlarmTopic`,
  masterKey: props.sharedKey,
});

const proxyDims = { DBProxyName: aurora.proxy.dbProxyName };

new Alarm(this, 'ProxyBorrowLatencyAlarm', {
  alarmName: `${this.stackName}-ProxyBorrowLatency-p99-50ms`,
  metric: new Metric({
    namespace: 'AWS/RDS',
    metricName: 'ConnectionBorrowLatency',
    statistic: 'p99',
    period: Duration.minutes(5),
    dimensionsMap: proxyDims,
  }),
  threshold: 50,
  evaluationPeriods: 2,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
}).addAlarmAction(new SnsAction(dataAlarmTopic));

// 80% of Aurora max_connections. Aurora ACU max varies (dev 2 / prod 4).
// Set static numerical threshold conservative (350 in dev, 700 in prod).
const maxConnectionsAlarmThreshold = isProd ? 700 : 350;
new Alarm(this, 'ProxyDatabaseConnectionsAlarm', {
  alarmName: `${this.stackName}-ProxyDatabaseConnections-80pct`,
  metric: new Metric({
    namespace: 'AWS/RDS',
    metricName: 'DatabaseConnections',
    statistic: 'Maximum',
    period: Duration.minutes(5),
    dimensionsMap: proxyDims,
  }),
  threshold: maxConnectionsAlarmThreshold,
  evaluationPeriods: 1,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
}).addAlarmAction(new SnsAction(dataAlarmTopic));

// ClientConnectionsBorrowingFromProxy — baseline 5x signal. PR-A uses
// static threshold (50 dev / 200 prod); refine after dev baseline collected.
const clientConnectionsAlarmThreshold = isProd ? 200 : 50;
new Alarm(this, 'ProxyClientConnectionsAlarm', {
  alarmName: `${this.stackName}-ProxyClientConnections-spike`,
  metric: new Metric({
    namespace: 'AWS/RDS',
    metricName: 'ClientConnectionsBorrowingFromProxy',
    statistic: 'Average',
    period: Duration.minutes(5),
    dimensionsMap: proxyDims,
  }),
  threshold: clientConnectionsAlarmThreshold,
  evaluationPeriods: 3,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: TreatMissingData.NOT_BREACHING,
}).addAlarmAction(new SnsAction(dataAlarmTopic));

new CfnOutput(this, 'DataAlarmTopicArn', { value: dataAlarmTopic.topicArn });
new CfnOutput(this, 'ProxyEndpoint', { value: aurora.proxy.endpoint });
```

- [ ] **Step 7.3: 테스트 재실행 + commit**

```bash
npx vitest run test/data.stack.test.ts
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/lib/stacks/data.stack.ts infrastructure/test/data.stack.test.ts
git commit -m "$(cat <<'EOF'
260513 rdsProxyAlarms

Add 3 CloudWatch alarms for RDS Proxy (BorrowLatency p99 > 50ms,
DatabaseConnections > 80% of max, ClientConnections spike) wired
to a new DataAlarmTopic. Output ProxyEndpoint for downstream env.
EOF
)"
```

---

## Task 8: `waf.construct.ts` 신규 — WebACL + 4 managed + IP rate limit

**Files:**
- Create: `infrastructure/lib/stacks/api/waf.construct.ts`
- Modify: `infrastructure/lib/stacks/api.stack.ts`

신규 디렉토리 `infrastructure/lib/stacks/api/` 가 없으니 `mkdir -p`.

- [ ] **Step 8.1: 디렉토리 생성**

```bash
mkdir -p /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure/lib/stacks/api
```

- [ ] **Step 8.2: failing test (api.stack.test.ts)**

```ts
it('should attach WAF WebACL to HTTP API with 4 managed rules and IP rate limit', () => {
  const template = Template.fromStack(apiStack);
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    Rules: Match.arrayWith([
      Match.objectLike({ Name: 'AWS-Managed-Common' }),
      Match.objectLike({ Name: 'AWS-Managed-KnownBadInputs' }),
      Match.objectLike({ Name: 'AWS-Managed-AmazonIpReputation' }),
      Match.objectLike({ Name: 'AWS-Managed-AnonymousIp' }),
      Match.objectLike({ Name: 'IpRateLimit' }),
    ]),
  });
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
});
```

- [ ] **Step 8.3: `waf.construct.ts` 신규 생성**

```ts
// API WAF v2 WebACL: 4 AWS managed rule groups (count-mode in PR-A) + IP rate limit (block).

import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { CfnLoggingConfiguration, CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../../config/env.config.js';

const RATE_LIMIT_5MIN = { dev: 5000, prod: 2000 } as const;

export interface WafConstructProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly stageArn: string;
  readonly logGroupKey: IKey;
  readonly alarmTopic: ITopic;
}

export class WafConstruct {
  public readonly webAcl: CfnWebACL;
  public readonly association: CfnWebACLAssociation;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    const isProd = props.deploymentEnv === 'prod';
    const rateLimit = isProd ? RATE_LIMIT_5MIN.prod : RATE_LIMIT_5MIN.dev;

    // PR-A: managed rules are Count mode for both dev and prod.
    // PR-C flips managed rules to Block. IP rate limit is Block from PR-A.
    const managedRuleAction = { count: {} };

    this.webAcl = new CfnWebACL(scope, `${id}WebAcl`, {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${id}WebAcl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWS-Managed-Common',
          priority: 0,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-Common',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-Managed-KnownBadInputs',
          priority: 1,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-KnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-Managed-AmazonIpReputation',
          priority: 2,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-AmazonIpReputation',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-Managed-AnonymousIp',
          priority: 3,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAnonymousIpList' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-AnonymousIp',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'IpRateLimit',
          priority: 4,
          action: { block: {} },
          statement: {
            rateBasedStatement: { aggregateKeyType: 'IP', limit: rateLimit },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'IpRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // WAF log group: name MUST be prefixed with `aws-waf-logs-`.
    const logGroup = new LogGroup(scope, `${id}LogGroup`, {
      logGroupName: `aws-waf-logs-yourmillionare-${props.deploymentEnv}`,
      encryptionKey: props.logGroupKey,
      retention: isProd ? RetentionDays.THREE_MONTHS : RetentionDays.TWO_WEEKS,
    });
    new CfnLoggingConfiguration(scope, `${id}LoggingConfig`, {
      logDestinationConfigs: [logGroup.logGroupArn],
      resourceArn: this.webAcl.attrArn,
    });

    this.association = new CfnWebACLAssociation(scope, `${id}Association`, {
      resourceArn: props.stageArn,
      webAclArn: this.webAcl.attrArn,
    });

    // BlockedRequests > 500 / 5min — DDoS signal.
    new Alarm(scope, `${id}BlockedRequestsAlarm`, {
      alarmName: `${id}-WafBlockedRequests-500-5min`,
      metric: new Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        statistic: 'Sum',
        period: Duration.minutes(5),
        dimensionsMap: { WebACL: this.webAcl.name ?? '', Region: 'ap-northeast-2', Rule: 'ALL' },
      }),
      threshold: 500,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));
  }
}
```

- [ ] **Step 8.4: api.stack.ts 에 WafConstruct 호출 추가**

`api.stack.ts` 의 HttpApi 생성 후 (`this.httpApi = ...` 직후) 에 추가:

```ts
import { WafConstruct } from './api/waf.construct.js';
import { Topic } from 'aws-cdk-lib/aws-sns';

// (HttpApi 생성 후)
const apiAlarmTopic = new Topic(this, 'ApiAlarmTopic', {
  topicName: `${this.stackName}-ApiAlarmTopic`,
  masterKey: props.sharedKey,
});

const stageArn = `arn:aws:apigateway:${region}::/apis/${this.httpApi.apiId}/stages/${this.httpApi.defaultStage!.stageName}`;
new WafConstruct(this, 'Waf', {
  deploymentEnv: props.deploymentEnv,
  stageArn,
  logGroupKey: props.sharedKey,
  alarmTopic: apiAlarmTopic,
});
```

- [ ] **Step 8.5: 테스트 재실행 + commit**

```bash
npx vitest run test/api.stack.test.ts
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/lib/stacks/api/waf.construct.ts \
        infrastructure/lib/stacks/api.stack.ts \
        infrastructure/test/api.stack.test.ts
git commit -m "$(cat <<'EOF'
260513 wafAdd

Add WAF v2 WebACL to HTTP API stage: AWS Managed Rules
(Common/KnownBadInputs/AmazonIpReputation/AnonymousIp) in Count
mode + IP rate limit (Block) at 5000/5min dev, 2000/5min prod.
BlockedRequests > 500/5min alarm wired to ApiAlarmTopic. WAF
managed rules flip to Block in PR-C.
EOF
)"
```

---

## Task 9: cdk-nag suppression 추가

**Files:**
- Modify: `infrastructure/lib/stacks/data/aurora.construct.ts`
- Modify: `infrastructure/lib/stacks/api/waf.construct.ts`

Proxy 와 WAF 신규 리소스에 대해 cdk-nag 가 잡을 항목들:

| Rule | 리소스 | Suppression 사유 |
|---|---|---|
| `AwsSolutions-SMG4` | Aurora master secret | RDS Proxy 가 secret 을 backend auth 에 사용 — 기존 30d HostedRotation 유지. Suppression 갱신 사유 명시. |
| `AwsSolutions-WAF1` (있는 경우) | WAF rate-limit only | 4 managed rule + rate limit 가 baseline. Bot Control 등 premium 은 cost 사유 제외 (spec §4.4). |

- [ ] **Step 9.1: aurora.construct.ts 의 SMG4 suppression 갱신**

기존:
```ts
{
  id: 'AwsSolutions-SMG4',
  reason: 'Master secret rotation deferred to Slice 4 when RDS Proxy is introduced.',
},
```

변경:
```ts
{
  id: 'AwsSolutions-SMG4',
  reason: 'Aurora master secret is bound to RDS Proxy (added in this slice). The 30-day HostedRotation single-user schedule remains active; Proxy reads the rotated secret transparently.',
},
```

- [ ] **Step 9.2: waf.construct.ts 에 필요시 suppression 추가**

`cdk synth` 시 cdk-nag 가 잡는 항목을 확인:

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure
AWS_PROFILE=ym-dev npm run synth 2>&1 | grep -E "AwsSolutions-WAF|WafConstruct" | head -20
```

WAF 관련 nag 가 잡히면 (예: WAF-1 — premium ruleset 권장) WafConstruct 에 `NagSuppressions.addResourceSuppressions` 로 명시:

```ts
import { NagSuppressions } from 'cdk-nag';
// (constructor 끝)
NagSuppressions.addResourceSuppressions(this.webAcl, [
  {
    id: 'AwsSolutions-WAF1',  // 또는 실제로 발생한 id
    reason: 'Bot Control and other premium managed rule groups are excluded by cost policy (spec §4.4). Baseline = 4 free managed rule groups + IP rate limit.',
  },
]);
```

- [ ] **Step 9.3: cdk synth 통과 확인**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure
AWS_PROFILE=ym-dev npm run synth
```
Expected: synth 성공 + cdk-nag warning/error 0.

- [ ] **Step 9.4: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add infrastructure/lib/stacks/
git commit -m "$(cat <<'EOF'
260513 cdkNagSuppressions

Update SMG4 suppression on Aurora master secret to reflect Proxy
binding; add WAF baseline-tier suppression covering premium rule
exclusion by cost policy.
EOF
)"
```

---

## Task 10: ARCHITECTURE.md 갱신

**Files:**
- Modify: `docs/ARCHITECTURE.md`

Spec §9.1 의 8개 갱신 항목 모두 반영.

- [ ] **Step 10.1: §1 토폴로지 다이어그램 갱신**

`docs/ARCHITECTURE.md` 의 line 17-23 의 ascii 다이어그램은 stack 의존성 표현 — 변경 없음. 다만 직후 §2.6 의 API 흐름 다이어그램과 §3.1 의 데이터 흐름 다이어그램에 Proxy 노드를 추가:

§3.1 (line 197-212 부근) 의 다이어그램에 `RDS Proxy` 박스 삽입:

```
Lambda (Identity/Journal/Fx/Tax)
  │  RLS GUC set: app.current_tenant_id, app.cognito_sub
  ▼
RDS Proxy (writer endpoint)     ← 신규
  │  IAM auth (client), Secrets Manager (backend)
  │  TLS required (both sides)
  ▼
Aurora Serverless v2 (PRIVATE_ISOLATED)
```

- [ ] **Step 10.2: §2.3 Aurora 갱신**

`pg.Pool({ max: 1 })` 유지 근거와 Proxy endpoint 명시. line 82-86 의 "**연결**" 블록 직후에 한 단락 추가:

```markdown
- **RDS Proxy 도입 (PR-A 머지 후)**: Aurora writer 앞에 RDS Proxy 1개.
  - IAM auth (client), Secrets Manager (backend), TLS 양방향 검증 (PR-B1 부터).
  - `maxConnectionsPercent: 90` / `maxIdleConnectionsPercent: 50` / `idleClientTimeout: 30m`.
  - Lambda 의 `pg.Pool({ max: 1 })` 은 유지 — Lambda 인스턴스 단위 RLS 컨텍스트 격리는 Proxy 와 무관.
```

- [ ] **Step 10.3: §5.1 부하분산 표의 Lambda → Aurora 행 갱신**

기존:
```
| Lambda → Aurora | 각 인스턴스가 `pg.Pool max=1` 직접 연결 | **RDS Proxy 없음** (§5.3 참조) |
```

변경:
```
| Lambda → Aurora | 각 인스턴스가 `pg.Pool max=1` → RDS Proxy 가 multiplex → Aurora writer | Proxy 가 connection 풀링 |
```

- [ ] **Step 10.4: §5.3 "RDS Proxy 부재" 섹션 전체 교체**

기존 §5.3 (line 318-343) 전체를 "**§5.3 RDS Proxy 도입 / 효과 측정**" 으로 교체:

```markdown
### 5.3 RDS Proxy 도입 / 효과 측정

PR-A (2026-05-13) 부터 Aurora writer 앞에 RDS Proxy 가 위치한다.

- **이유**: ACU 비례 `max_connections` (dev 2 ACU ≈ ~430, prod 4 ACU ≈ ~870) 가 동시 Lambda 1000 인스턴스 burst 에 부족해질 수 있음. Proxy 가 client-side 와 backend 를 multiplex 해 connection storm 차단.
- **RLS 호환성**: `set_config(..., is_local=true)` 가 이미 transaction-scoped 라 Proxy pinning 트리거가 아님. `RESET app.*` 는 PR-A 에서 제거 (session-level statement, pinning 트리거).
- **연결 경로**: Lambda → IAM token → Proxy endpoint → master secret → Aurora writer.
- **운영 측정**: §7 의 RDS Proxy metrics 행. `ConnectionBorrowLatency p99 > 50ms`, `DatabaseConnections > 80%`, `ClientConnectionsBorrowing` spike 알람.

후속: PR-C 머지 후 cluster 직결 IAM ARN 제거, `lambdaSg → auroraSg 5432` 인바운드 제거 → Proxy 단일 경로.
```

- [ ] **Step 10.5: §5.4 트래픽 관리 표 갱신**

기존 `WAF | 없음` 행 → `WAF | 있음 (4 AWS Managed Rules Count mode + IP rate limit Block, PR-C 시점에 managed 도 Block)`

- [ ] **Step 10.6: §6.2 보안 모델 — WAF 인벤토리 + SSE 잔여 위험 enumerate**

§6 (보안 모델) 끝에 §6.4 신규 섹션 추가:

```markdown
### 6.4 WAF 인벤토리 (PR-A 부터)

| WebACL | 환경 | Scope | 룰 | 액션 |
|---|---|---|---|---|
| `Ym-{env}-Api-WafWebAcl` | dev/prod | REGIONAL | CRS / KnownBadInputs / AmazonIpReputation / AnonymousIp | Count (PR-A) → Block (PR-C) |
| (위 동일) | | | IpRateLimit (dev 5000 / prod 2000 req per 5min, IP aggregate) | Block |

**WAF 보호 밖**: 3개 SSE Function URL (`CodefSyncStream`, `TaxStrategy`, `FxStrategy`). 잔여 공격 벡터:

1. 유효 Cognito ID Token abuse — 매 호출이 Lambda 10-14분 + Bedrock Opus 슬롯 1 점유, `CostCounter` 일일 한도 안에서 무제한.
2. Connection hold — long-running 호출이 Proxy backend connection 1 + Bedrock concurrency 1 슬롯을 14분 점유, N 토큰 으로 N 배.
3. Function URL 발견 — URL 호스트 안정, 한 번 leak 시 영구.

완화는 Phase 1 CloudFront 도입 시점 또는 per-IP-per-minute DDB counter 도입 시.
```

- [ ] **Step 10.7: §7 관찰가능성 표 — WAF logs / RDS Proxy metrics 두 행 추가**

`| WAF logs | CloudWatch (aws-waf-logs-yourmillionare-{env}) | prod 90d / dev 14d |`
`| RDS Proxy metrics | CloudWatch (ConnectionBorrowLatency, DatabaseConnections, ClientConnectionsBorrowingFromProxy) + Alarms → SNS DataAlarmTopic | — |`

- [ ] **Step 10.8: §9 알려진 한계 표 갱신**

- "RDS Proxy 미도입" 행 → **삭제**
- "WAF 없음" 행 → **삭제**
- 신규 행 추가: `| SSE Function URL WAF 미적용 | CodefSync / Tax / Fx Strategy 가 in-Lambda verifyJwt + CostCounter 만으로 보호. 잔여 공격 벡터는 §6.4 enumerate | Phase 1 CloudFront |`

- [ ] **Step 10.9: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add docs/ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
260513 archDocProxyAndWaf

Sync ARCHITECTURE.md with PR-A: §2.3 RDS Proxy block, §5.1 / §5.3
load-balancing rewrite, §5.4 WAF row, new §6.4 WAF inventory and
SSE residual attack vectors, §7 observability additions, §9 known
limits trimmed.
EOF
)"
```

---

## Task 11: README.md 갱신

**Files:**
- Modify: `README.md`

- [ ] **Step 11.1: README 의 환경 변수 표 확인 + `CLUSTER_ENDPOINT` 행 갱신**

```bash
grep -n "CLUSTER_ENDPOINT" /Users/nampaca123/Desktop/CodeWork/yourmillionare/README.md
```

각 항목의 설명을 갱신: `Aurora writer endpoint (PR-B2 부터 RDS Proxy endpoint).`

- [ ] **Step 11.2: 폴더 구조 요약에 신규 항목 추가**

- `infrastructure/lib/stacks/api/waf.construct.ts`
- `infrastructure/assets/rds/ap-northeast-2-bundle.pem`

- [ ] **Step 11.3: 운영 노트 — RDS CA bundle 갱신 절차**

README 끝의 운영/Troubleshooting 섹션 (없으면 신설) 에 추가:

```markdown
### RDS CA bundle 갱신

AWS 가 RDS regional CA 를 회전할 때 (보통 5년 주기) 갱신:

1. `curl -fsSL https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem -o infrastructure/assets/rds/ap-northeast-2-bundle.pem`
2. dev 먼저 redeploy → smoke test → prod
3. 신구 CA 가 묶인 transitional bundle 이 발급되므로 점진 교체 안전.
```

- [ ] **Step 11.4: 비용 노트 — Proxy + WAF 항목**

기존 비용 섹션이 있으면 항목 추가, 없으면 신설:

```markdown
### 운영 비용 요약 (2026-05 기준)

| 항목 | dev (월) | prod (월) |
|---|---|---|
| Aurora Serverless v2 (baseline) | ~$30 | ~$60 |
| RDS Proxy (max ACU 기준) | ~$22 | ~$44 |
| fck-nat | ~$3.5 | ~$10.5 |
| WAF v2 (WebACL + 5 rules + 1M req) | ~$10.6 | ~$10.6 |
| (그 외 — DDB on-demand, Lambda, CloudWatch logs ...) | — | — |
```

- [ ] **Step 11.5: commit**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git add README.md
git commit -m "$(cat <<'EOF'
260513 readmeProxyAndWaf

Sync README with PR-A: CLUSTER_ENDPOINT note (Proxy from PR-B2),
waf.construct.ts and RDS CA bundle path in folder structure,
new operations note for CA bundle refresh, cost summary block.
EOF
)"
```

---

## Task 12: dev 통합 verify — `cdk synth` + `cdk diff`

**Files:** 없음 (verification only)

- [ ] **Step 12.1: synth 전체 통과**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
AWS_PROFILE=ym-dev npm run synth
```
Expected: 모든 dev/prod 스택 synth 성공. cdk-nag warning/error 0.

- [ ] **Step 12.2: dev diff 검토**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure
AWS_PROFILE=ym-dev npx cdk diff 'Ym-Dev-*' 2>&1 | tee /tmp/ym-dev-prA-diff.txt
```

Expected: diff 안에 다음이 모두 나타나야 함:
- `+ AWS::EC2::SecurityGroup` (ProxySg) 1개
- `+ AWS::EC2::SecurityGroupIngress` (auroraSg from proxySg) 1개
- `+ AWS::RDS::DBProxy` 1개
- `+ AWS::RDS::DBProxyTargetGroup` 1개
- `+ AWS::CloudWatch::Alarm` 3개 (ProxyBorrowLatency, ProxyDatabaseConnections, ProxyClientConnections)
- `+ AWS::SNS::Topic` (DataAlarmTopic, ApiAlarmTopic) 2개
- `+ AWS::WAFv2::WebACL` 1개
- `+ AWS::WAFv2::WebACLAssociation` 1개
- `+ AWS::WAFv2::LoggingConfiguration` 1개
- `+ AWS::Logs::LogGroup` (aws-waf-logs-yourmillionare-dev) 1개
- 8개 Lambda 의 `AWS::IAM::Policy` diff 안에 두 번째 `arn:aws:rds-db:...:dbuser:...` 등장
- HTTP API 자체에 대한 `~` (수정) 변경 없음 — assoc 만 추가

만약 누락된 리소스가 있으면 task 4-8 회귀.

- [ ] **Step 12.3: prod diff 검토 (변경 미적용)**

```bash
AWS_PROFILE=ym-dev npx cdk diff 'Ym-Prod-*' 2>&1 | tail -100
```

Expected: prod 도 동일 패턴 + dev 와 다른 threshold (350 → 700, 50 → 200, rate limit 5000 → 2000).

- [ ] **Step 12.4: diff 파일을 commit 없이 PR description 용으로 보존**

```bash
cp /tmp/ym-dev-prA-diff.txt /tmp/yn-prA-diff-$(date +%Y%m%d).txt
```
(commit 대상 아님. PR description 작성 시 첨부.)

---

## Task 13: dev 배포

**Files:** 없음 (deploy only)

- [ ] **Step 13.1: 전체 dev 배포**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare/infrastructure
AWS_PROFILE=ym-dev npx cdk deploy 'Ym-Dev-*' --require-approval never 2>&1 | tee /tmp/ym-dev-prA-deploy.log
```
Expected: 모든 dev 스택 deploy 성공. Proxy 생성에 5-10분 소요 가능.

- [ ] **Step 13.2: deploy 후 CloudFormation 출력 확인**

```bash
AWS_PROFILE=ym-dev aws cloudformation describe-stacks \
  --stack-name Ym-Dev-Data \
  --query "Stacks[0].Outputs[?OutputKey=='ProxyEndpoint' || OutputKey=='DataAlarmTopicArn'].[OutputKey,OutputValue]" \
  --output table
```
Expected: `ProxyEndpoint` 가 `*.proxy-*.ap-northeast-2.rds.amazonaws.com` 형태로 출력.

- [ ] **Step 13.3: Proxy registration 상태 확인**

```bash
AWS_PROFILE=ym-dev aws rds describe-db-proxy-targets \
  --db-proxy-name Ym-Dev-Data-AuroraProxy 2>&1 | head -30
```
(proxy name 은 deploy 결과로 확인. 일반적으로 `<stack>-AuroraProxy` 접미사를 따른다.)

Expected: target group `default` 안에 RDS cluster target 이 `REGISTERING` 또는 `AVAILABLE` 상태.

- [ ] **Step 13.4: WAF 상태 확인**

```bash
AWS_PROFILE=ym-dev aws wafv2 list-web-acls --scope REGIONAL --region ap-northeast-2 \
  --query "WebACLs[?contains(Name, 'Ym-Dev')].[Name,ARN]" --output table
```
Expected: 1개 WebACL `Ym-Dev-Api-WafWebAcl` (또는 유사 이름).

---

## Task 14: dev E2E 회귀 검증 (PR-A 머지 직후)

**Files:** 없음 (verification only)

PR-A 는 Lambda env 미변경 (cluster 직결). 따라서 모든 기존 워크플로우가 회귀 없이 통과해야 함.

- [ ] **Step 14.1: 시크릿 재확인**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
./scripts/sync-secrets-from-env.sh dev
```
Expected: CODEF / ECOS / Google OAuth 비밀이 정상 적재되어 있음을 확인.

- [ ] **Step 14.2: post-deploy smoke**

```bash
./scripts/post-deploy-smoke.sh dev
```
Expected: 60초 안에 통과. 실패 시 stack rollback (`cdk deploy --rollback`).

- [ ] **Step 14.3: HTTP API e2e**

```bash
./scripts/run-api-e2e.sh dev
```
Expected: PASS. RLS 가 set_config (LOCAL) 만으로 정상 enforce — RESET 제거의 회귀 없음.

- [ ] **Step 14.4: SSE agent e2e (Tax/Fx Strategy)**

```bash
./scripts/run-agents-e2e.sh dev
```
Expected: PASS. SSE 응답이 정상 종료, Bedrock 호출 성공.

- [ ] **Step 14.5: CODEF e2e (한 번만!)**

```bash
./scripts/run-codef-e2e.sh dev
```
Expected: PASS. CODEF 계좌 5회 잠금 보호 — 같은 run 에서 두 번 실행 금지.

- [ ] **Step 14.6: CloudWatch 메트릭 1시간 관찰**

```bash
# Proxy 메트릭 확인 — 알람 NOT IN ALARM 상태여야 함.
AWS_PROFILE=ym-dev aws cloudwatch describe-alarms \
  --alarm-name-prefix "Ym-Dev-Data-Proxy" \
  --query "MetricAlarms[].[AlarmName,StateValue]" --output table

# WAF BlockedRequests — Count mode 라 0 기대.
AWS_PROFILE=ym-dev aws cloudwatch get-metric-statistics \
  --namespace AWS/WAFV2 \
  --metric-name BlockedRequests \
  --dimensions Name=WebACL,Value=Ym-Dev-Api-WafWebAcl Name=Region,Value=ap-northeast-2 Name=Rule,Value=ALL \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 --statistics Sum --output table
```
Expected: 
- 모든 Proxy 알람 `OK`
- BlockedRequests Sum = 0 (Count mode, IpRateLimit 만 Block 이지만 dev e2e 트래픽은 한도 안)

---

## Task 15: PR 생성

- [ ] **Step 15.1: branch push + PR**

```bash
cd /Users/nampaca123/Desktop/CodeWork/yourmillionare
git push -u origin HEAD

gh pr create --base main \
  --title "260513 trafficAndSecurityHardeningPrA" \
  --body "$(cat <<'EOF'
## Summary
- Aurora writer 앞에 RDS Proxy 1개 도입 (IAM auth + Secrets Manager, TLS required, maxConnectionsPercent 90)
- API stage 에 WAF v2 WebACL 부착 — 4 AWS Managed Rules (Count mode) + IP rate limit (Block)
- `withRlsContext` 의 `RESET app.*` 제거 (Proxy pinning 트리거 차단)
- ARCHITECTURE.md / README.md 동기화

Lambda env (`CLUSTER_ENDPOINT`) 는 **변경하지 않음** — cluster 직결 유지. dev 환경 cutover 는 후속 PR-B2.

Spec: `docs/superpowers/specs/2026-05-13-traffic-and-security-hardening-design.md`

## Test plan
- [x] `npm run test` 전체 통과
- [x] `cdk synth` + cdk-nag 0 warning/error
- [x] dev `cdk deploy` 성공
- [x] `post-deploy-smoke.sh dev` 통과
- [x] `run-api-e2e.sh dev` 통과 (RLS 회귀 X)
- [x] `run-agents-e2e.sh dev` 통과
- [x] `run-codef-e2e.sh dev` 통과 (1회)
- [x] Proxy CloudWatch 알람 `OK` (1시간 관찰)
- [x] WAF `BlockedRequests` Sum = 0 (Count mode)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage**:
- ✅ Spec §3.1 (Proxy CDK construct) → Task 5
- ✅ Spec §3.2 (Lambda env 변경 — 미변경 명시) → 0 task (PR-B2 로 미룸)
- ✅ Spec §3.3 (TLS pinning) → 0 task in PR-A (PR-B1 로 분리)
- ✅ Spec §3.4 (IAM 정책 양쪽 허용) → Task 6
- ✅ Spec §3.5 (RLS 호환성 — RESET 제거 + 직접 호출 정리) → Task 2, 3
- ✅ Spec §4 (WAF) → Task 8
- ✅ Spec §5 (관찰가능성) → Task 7 + Task 8 (WAF alarm)
- ✅ Spec §6.2 (E2E 회귀) → Task 14
- ✅ Spec §9 (문서화) → Task 10, 11

**Placeholder scan**: 0 "TBD", 0 "implement later". Task 3 의 분류 작업은 placeholder 가 아니라 실제 audit step — commit message 에 결과 enumerate 요구.

**Type consistency**: `proxySg` 가 Task 4 (network 정의), Task 5 (Aurora props), data.stack props 에서 모두 동일 이름. `AuroraConstruct.proxy.dbProxyArn` 이 Task 6 에서 사용 — `DatabaseProxy` 타입의 표준 필드.

**시간 추정**: 15 task × 평균 4 step = ~60 step. step 당 2-5분 → **3-5시간 총 소요**.

---

## 후속 PR 안내 (이 plan 의 scope 밖)

- **PR-B1**: TLS 검증 강화 (`pg-pool.client.ts:36` 6개 파일 모두 `rejectUnauthorized: true` + CA bundle 적용 + esbuild bundling.commandHooks 로 deployment package 에 포함). cluster 직결 상태에서 dev/prod 양쪽 deploy.
- **PR-B2**: dev `CLUSTER_ENDPOINT` → Proxy endpoint cutover. dev E2E 회귀.
- **PR-C**: prod cutover + WAF managed rules Block 전환 + cluster 직결 IAM ARN 제거 + `lambdaSg → auroraSg 5432` 인바운드 제거. **시작 조건**: §5.3 alarm-driven gate 만족 (PR-B2 안정화 ≥ 1주 + WAF dev Count ≥ 4주).
