# Slice 1 — CDK 골격 & Foundation 스택

*작성 기준: 2026-05-04. 배포 및 검증 완료. 슬라이스 1 닫힘.*

---

## 뭘 만들었나

프로젝트 뼈대와 공유 보안 리소스다. 코드 한 줄 없이도 CDK 합성·테스트·CI가 돌아가는 상태를 먼저 만들고, 그 위에 공유 KMS 키와 CODEF 자격증명 슬롯을 올렸다.

---

## 결과물 목록

| 파일 / 리소스 | 설명 |
|---|---|
| `infrastructure/lib/stacks/foundation.stack.ts` | SharedKey(KMS CMK) + CodefCredentialSecret |
| `infrastructure/lib/config/env.config.ts` | CDK_ENV, AWS_ACCOUNT_ID 검증 + 타입 |
| `infrastructure/test/foundation.stack.test.ts` | cdk-nag 통과 포함 유닛 테스트 |
| `.github/workflows/ci.yml` | synth + test CI |
| `CLAUDE.md` | 엔지니어링 가이드라인 (파일명, 금지사항, 에러 처리 등) |
| `PLAN.md` | 제품 비전 + AWS 아키텍처 초안 |

---

## Foundation 스택 세부

### SharedKey (KMS CMK)

연간 자동 회전 활성화. dev는 `RemovalPolicy.DESTROY`, prod는 `RETAIN`.

용도는 **키 정책을 건드리지 않아도 되는 리소스**로 제한된다. DynamoDB 테이블 4개와 CODEF 시크릿이 여기에 해당한다. 키 정책 변경이 필요한 리소스(Aurora, Flow Logs, biz_reg_no)는 각 스택에 로컬 키를 따로 만든다. 이유는 스택 간 CDK 사이클 문제 때문이며 자세한 설명은 `PLAN.md §4.4` 참조.

### CodefCredentialSecret

CODEF API 자격증명 슬롯. **값은 비어 있다**. 실제 CODEF 연동은 슬라이스 4+에서 시작된다. 슬롯을 먼저 만들어둔 이유는 다운스트림 스택들이 ARN을 환경변수로 참조해야 하기 때문이다.

비용: ~$0.40/월 (자격증명 1개). 슬라이스 4 이전에는 죽은 자원이지만 무시할 수준이다.

AWS-managed 자동 회전은 적용하지 않는다 (`AwsSolutions-SMG4` suppression). CODEF 자격증명은 90일 주기 AgentCore Identity 플로우로 회전한다(Phase 1 도입 예정).

---

## CI

`npm test`와 `cdk synth`를 PR마다 실행한다. cdk-nag를 합성 시간에 돌려서 보안 위반이 있으면 합성 자체가 실패한다. 린트(`eslint`)와 타입 체크(`tsc --noEmit`)도 CI에 포함됐다.

---

## 배포

```bash
AWS_PROFILE=ym-dev CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 npx cdk deploy Ym-Dev-Foundation
```

배포 중 막히는 지점은 없었다.

---

## 다음은

슬라이스 2: VPC + Aurora + DynamoDB. Foundation이 export하는 `SharedKeyArn`을 Data 스택이 처음으로 소비한다.
