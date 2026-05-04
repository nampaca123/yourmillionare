# Slice 2 배포 현황 (2026-05-04)

## 스택별 상태

| 스택 | 상태 | 비고 |
|------|------|------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK, CODEF Secrets 슬롯 |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, SG, VPC Endpoints, Flow Logs |
| `Ym-Dev-Data` | ⏳ ROLLBACK_IN_PROGRESS | Aurora 삭제 완료 대기 중 |

## Data 스택 실패 원인 및 조치

### 1차 실패 — `Cannot find DBInstance in DBCluster`
- **원인**: `SchemaMigration` Custom Resource가 `AuroraCluster`(DBCluster CFN 리소스) 완료 직후 실행됨. 그러나 Data API는 `AuroraCluster/writer`(DBInstance)가 **기동 완료된 뒤에만** 호출 가능.
- **조치**: `migrationCR.node.addDependency(aurora.cluster.node.findChild('writer'))` 추가 → writer 인스턴스 CREATE_COMPLETE 이후에만 마이그레이터가 실행되도록 명시.

### 2차 실패 — `Database returned SQL Exception`
- **원인**: `splitStatements()` 내 `;` 분리 로직에 `!inDollarQuote` 가드 누락. `CREATE OR REPLACE FUNCTION ... $$ ... $$` 본문 안의 `;`(PL/pgSQL 내부 세미콜론)가 문장 구분자로 오인되어 함수가 중간에 잘린 채 실행됨.
- **조치**: `if (ch === ';')` → `if (!inDollarQuote && !inSingleQuote && !inBlockComment && ch === ';')` 수정 완료.

## 다음 단계

rollback이 완료되면 아래 명령으로 재배포:
```bash
cd infrastructure
AWS_PROFILE=ym-dev CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 \
  npx cdk deploy --all --require-approval never
```

Aurora 클러스터 삭제·재생성 포함 예상 소요 시간: **약 20~25분**.

## 테스트 현황

```
Test Files  3 passed (3)
Tests       29 passed (29)
```

cdk-nag 에러 0건. 모든 단위 테스트 통과.

## 코드 변경 요약 (Slice 2)

| 파일 | 변경 내용 |
|------|-----------|
| `schema.sql` | `schema_migrations` 테이블 추가, `accounts` self-FK `DEFERRABLE INITIALLY IMMEDIATE`, RLS 정책 전체 추가 |
| `infrastructure/lib/config/env.config.ts` | `vpcCidr`, `isProd` 추가 |
| `infrastructure/lib/stacks/network.stack.ts` | VPC, SG, Flow Logs(로컬 KMS), VPC Endpoints |
| `infrastructure/lib/stacks/data/aurora.construct.ts` | Aurora Serverless v2 PG 15.10, 로컬 KMS(의존성 사이클 방지) |
| `infrastructure/lib/stacks/data/cache.construct.ts` | DynamoDB 4개 테이블 |
| `infrastructure/lib/stacks/data/sql/db-bootstrap.sql` | `app_user`, `rds_iam` 부여, 기본 권한 설정 |
| `infrastructure/lib/stacks/data/schema-migrator.lambda.ts` | Data API 마이그레이터 (달러쿼팅 버그 수정 포함) |
| `infrastructure/lib/stacks/data/verifier-schema.lambda.ts` | 스키마 검증 Lambda |
| `infrastructure/lib/stacks/data/verifier-iam.lambda.ts` | IAM 토큰 인증 리허설 Lambda |
| `infrastructure/lib/stacks/data.stack.ts` | Data 스택 오케스트레이션 |
| `infrastructure/bin/yourmillionare.ts` | 스택 순서 및 의존성 배선 |
| `infrastructure/test/network.stack.test.ts` | NetworkStack 단위 테스트 |
| `infrastructure/test/data.stack.test.ts` | DataStack 단위 테스트 |
| `README.md` | Slice 2 기준 전면 업데이트 |
