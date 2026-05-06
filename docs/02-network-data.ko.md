# 슬라이스 2 — 네트워크 & 데이터 기반

*작성 기준: 2026-05-05. 배포 및 검증 완료. 슬라이스 2 닫힘.*

---

## 뭘 만들었나

슬라이스 1은 CDK 골격과 KMS 키 하나였다. 슬라이스 2는 실제 DB와 네트워크다.

기존 Foundation 위에 Network 스택(VPC, 보안 그룹, Endpoint, Flow Logs)과 Data 스택(Aurora, DynamoDB, 마이그레이터)이 올라갔다.

---

## 네트워크

### VPC

서울 리전 3개 AZ에 서브넷 6개를 만들었다. PUBLIC 3개, PRIVATE_ISOLATED 3개, NAT 없음.

NAT를 넣지 않은 건 비용 때문이다. CODEF 외부 API 호출은 슬라이스 4에서 처음 필요해지는데, 그때 NAT Gateway($32+/월)와 t4g.nano NAT 인스턴스(~$3.5/월)를 비교해서 고르기로 미뤘다. 지금은 외부 호출이 없으니 굳이 NAT를 달아서 돈을 낼 이유가 없다.

### 보안 그룹

`sg-aurora`는 `sg-lambda`의 5432 포트 인바운드만 받는다. CIDR 기반 인그레스는 없다. Aurora가 직접 외부에 응답할 일도 없으니 아웃바운드도 막았다.

`sg-lambda`는 아웃바운드를 전부 허용한다. 슬라이스 3에서 앱 Lambda가 VPC 안으로 들어올 때 쓸 그룹이다.

### VPC Endpoint

무료 Gateway Endpoint는 둘 다 붙였다.

| 서비스 | 타입 | dev 비용 |
|--------|------|----------|
| S3 | Gateway | $0 |
| DynamoDB | Gateway | $0 |
| Secrets Manager | Interface | ~$7.3/월 (1 AZ) |
| KMS | Interface | ~$7.3/월 (1 AZ) |

Interface Endpoint를 dev에서 1개 AZ로 제한한 이유가 있다. 풀 구성(3 AZ)이면 ENI 12개가 붙어 $87/월이 된다. NAT Gateway보다 비싸다. dev 트래픽은 미미하니 1 AZ로 충분하다.

### VPC Flow Logs

Flow Logs는 CloudWatch Logs로 보내고 KMS CMK로 암호화한다.

처음엔 Foundation의 공유 키를 썼다가 배포에서 막혔다. CloudWatch Logs 서비스가 KMS 키를 쓰려면 키 정책에 `logs.<region>.amazonaws.com` 서비스 프린시펄이 명시돼 있어야 하는데, 공유 키 정책을 Network 스택에서 건드리면 CDK가 의존성 사이클 오류를 낸다. 그래서 Network 스택 안에 로컬 CMK를 따로 만들었다.

---

## 데이터

### Aurora Serverless v2

PostgreSQL 15.10, Serverless v2.

| 설정 | dev | prod |
|------|-----|------|
| 최소 ACU | **0** (scale-to-zero) | 0.5 |
| 최대 ACU | 2 | 4 |
| Data API | ✅ | ✅ |
| IAM 인증 | ✅ | ✅ |
| 삭제 방지 | ❌ | ✅ |
| 백업 보존 | 1일 | 14일 |

`minCapacity: 0`이 중요하다. 쓰지 않을 때 Aurora가 완전히 꺼진다. 기존에는 Serverless v2가 자동 일시정지를 지원하지 않았는데, AWS가 2024년 말에 scale-to-zero를 GA로 내놨다. 덕분에 dev 유휴 비용이 $0에 가까워진다. 콜드 스타트가 5~15초 걸리는 건 감수할 수 있다.

Aurora의 KMS 키는 Data 스택 내부에 별도로 만들었다. Foundation 공유 키를 쓰면 `grantDataApiAccess()` 호출이 Foundation 키 정책에 Lambda ARN을 써서, Foundation → Data → Network → Foundation 의존성 사이클이 생긴다.

### DynamoDB

4개 테이블 모두 온디맨드 빌링, Foundation KMS CMK 암호화.

| 테이블 | 용도 | TTL |
|--------|------|-----|
| MonthlySummaryCache | 월별 재무 집계 캐시 | — |
| TransactionCache | 거래 목록 페이지 캐시 | — |
| IdempotencyKeys | POST 중복 방지 | ✅ |
| CostCounter | AI 토큰 비용 추적 | — |

캐시 테이블은 PITR(특정 시점 복구)을 dev에서 꺼놨다. 캐시는 잃어버려도 Aurora에서 재생성할 수 있으니 추가 비용을 낼 이유가 없다.

---

## 스키마

`schema.sql`은 8개 테이블로 K-IFRS 복식부기 구조를 구현한다.

```
users / user_profiles   Cognito 사용자, 표시명·알림
tenants                 법인/개인사업자 (사업자번호 KMS 암호화)
tenant_members          사용자 ↔ 테넌트 N:M
accounts                테넌트별 계정과목
journal_entries         분개 헤더
journal_lines           분개 라인 (차변·대변)
raw_transactions        CODEF 원응답 보관
fx_observations         환율 데이터 (테넌트 공유)
```

`journal_lines`에는 `AFTER INSERT OR UPDATE OR DELETE` 트리거가 달려 있어서, 한 분개 내 차변 합계 ≠ 대변 합계면 트랜잭션 끝에 예외를 낸다.

### Row Level Security

`app_user`로 연결한 Lambda는 `SET app.current_tenant_id = '<uuid>'`를 먼저 실행해야 한다. 이게 없으면 어떤 테이블도 읽지 못한다.

```sql
CREATE POLICY tenant_isolation ON journal_entries
  FOR ALL TO app_user
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

`users`와 `user_profiles`는 `app.current_user_id` 기준으로 사용자별 격리를 추가로 적용한다. `fx_observations`는 테넌트 공유 데이터라 RLS에서 제외했다.

### 마이그레이션 버전 관리

`schema_migrations` 테이블이 현재 적용된 스키마 버전의 SHA-256 해시를 보관한다. 마이그레이터가 실행될 때 해시가 이미 있으면 스킵한다. `schema.sql` 내용이 바뀌면 CDK가 감지해서 Custom Resource를 다시 호출한다.

슬라이스 2 이후 스키마 변경은 `schema.sql`을 건드리지 않고 별도 파일로 관리한다. `schema.sql`은 이제 초기화 스크립트로 고정이다.

---

## 마이그레이터 구조

CloudFormation Custom Resource 패턴(`Provider` + `CustomResource`)으로 구현했다. `AwsCustomResource`가 아닌 이유는 간단하다 — `AwsCustomResource`는 AWS SDK 호출 하나만 감쌀 수 있고 임의 코드를 실행하지 못한다.

마이그레이터 Lambda는 VPC 밖에서 Data API로 연결한다. VPC 안에 두면 ENI 프로비저닝에 10~15초가 더 걸리고, 외부 인터넷이 필요 없는 Lambda를 위해 NAT를 달아야 한다. Data API는 그 문제를 둘 다 피해간다.

실행 순서:

1. `db-bootstrap.sql` — `schema_migrations` 테이블 생성, `app_user` 역할 생성, `rds_iam` 부여, 기본 권한 설정
2. `schema_migrations`에서 현재 버전 조회 → 이미 있으면 커밋 후 종료
3. `schema.sql` 전체 적용
4. `schema_migrations`에 버전 기록 후 커밋

마이그레이터가 끝나면 두 검증 Lambda가 순서대로 실행된다.

`verifier-schema`는 VPC 밖에서 Data API로 붙어서, 테이블 목록과 RLS 정책이 올바르게 만들어졌는지 CloudWatch Logs에 기록한다.

`verifier-iam`은 VPC 안에서 `@aws-sdk/rds-signer`로 IAM 토큰을 발급하고 `app_user`로 Aurora에 직접 연결한다. 슬라이스 3 앱 Lambda가 쓸 방식과 완전히 같다. 여기서 연결이 안 되면 슬라이스 3로 넘어가봤자 똑같이 막힌다.

---

## 배포 중에 막혔던 부분

배포가 세 번 실패했다. 원인과 수정 내용을 간략히 기록한다.

**ESM `__dirname` 없음**
CDK 프로젝트가 ES Module로 설정돼 있어 `__dirname`이 없다. `fileURLToPath(import.meta.url)`로 교체했다.

**writer 인스턴스 의존성 누락**
`SchemaMigration` Custom Resource가 `AWS::RDS::DBCluster` 완료 직후 실행됐다. Data API는 `AWS::RDS::DBInstance`(writer)가 뜬 뒤에야 작동한다. CDK는 이를 자동으로 연결하지 않는다.

```typescript
migrationCR.node.addDependency(aurora.cluster.node.findChild('writer'));
```

**`splitStatements` 버그**
PL/pgSQL 함수 본문(`$$ ... $$`) 안의 `;`를 문장 구분자로 잘못 처리했다. 함수가 중간에 잘린 채 Data API로 전달되면서 SQL 오류가 났다.

```typescript
// 수정 전
if (ch === ';') { ... }

// 수정 후
if (!inDollarQuote && !inSingleQuote && !inBlockComment && ch === ';') { ... }
```

---

## 예상 dev 월 비용

| 항목 | 비용 |
|------|------|
| Aurora (scale-to-zero 적용, 유휴 시) | $0 |
| Aurora (활성 시, ACU 0.5 기준) | ~$0.06/시간 |
| VPC Interface Endpoint 2개 × 1 AZ | ~$14.6 |
| Flow Logs (CloudWatch) | ~$1~3 |
| DynamoDB (초기 트래픽 없음) | ~$0 |
| KMS 키 4개 (SharedKey + FlowLogsKey + AuroraStorageKey + AuroraSecretKey) | ~$4 |
| Secrets Manager (CODEF 자격증명 슬롯, Slice 1 생성) | ~$0.40 |
| **합계 (유휴 시)** | **~$19~21/월** |

원래 계획이 ~$177/월이었는데, 비용 최적화 작업으로 ~$23/월까지 줄었다. 가장 큰 기여는 Aurora scale-to-zero와 Interface Endpoint 1 AZ 제한이다.

---

## 검증 결과 (2026-05-05 17:50 KST)

`verifier-schema` — `status: OK`. 테이블 10개, RLS 정책 8개 모두 확인.

`verifier-iam` — `status: OK`. IAM 토큰으로 `app_user` 직접 연결 성공 (2127ms).

슬라이스 2 닫힘.

---

## 다음은

슬라이스 3: Cognito + API Gateway + 첫 앱 Lambda. `apps/` 디렉터리가 처음 채워진다.
