# PR-A 배포 중 마주친 문제들 (2026-05-13 ~ 14)

PR-A (RDS Proxy + WAF 도입 시도) 배포 과정에서 발견한 4 가지 문제와 해결·예방 노트.

브랜치: `feat/260513-traffic-and-security-hardening-pr-a`
연관 spec: [docs/superpowers/specs/2026-05-13-traffic-and-security-hardening-design.md](../superpowers/specs/2026-05-13-traffic-and-security-hardening-design.md)
연관 plan: [docs/superpowers/plans/2026-05-13-traffic-and-security-hardening.md](../superpowers/plans/2026-05-13-traffic-and-security-hardening.md)

---

## 1. AWS WAF v2 가 HTTP API v2 association 을 지원하지 않음 (root cause of WAF 폐기)

### 증상
`AWS::WAFv2::WebACLAssociation` CREATE_FAILED:
```
Error reason: The ARN isn't valid. A valid ARN begins with arn: ...,
field: RESOURCE_ARN,
parameter: arn:aws:apigateway:ap-northeast-2::/apis/p7d9jms82f/stages/$default
```

처음엔 `$default` literal 의 `$` 가 URL encoding 문제로 보여 `%24default` 로 시도했으나 동일 error.

### 원인
AWS WAF v2 의 [`AssociateWebACL` API](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-webaclassociation.html) 의 `ResourceArn` 이 받는 리소스:
- Application Load Balancer
- API Gateway **REST API** stage
- Cognito User Pool
- AppSync GraphQL API
- App Runner service
- Verified Access instance
- Amplify application

**HTTP API (apigatewayv2) 는 제외**. 즉 우리 프로젝트의 `HttpApi` (apigatewayv2) 는 WAF v2 와 직접 association 자체가 불가능. ARN encoding 으로 풀리는 문제가 아님.

### 진단 단서
- error message 의 `parameter:` 가 정확한 ARN literal 을 출력 — encoding 만 의심하지 말고 **그 ARN format 이 지원 대상인지** 확인.
- AWS WAF developer guide 의 "Protected resources" 목록 1차 확인.

### 해결
**PR-A 에서 WAF 부분 전부 revert**. WAF 도입은 다음 중 하나의 fronting 도입 후로 미룸:
- CloudFront distribution + WAF (가장 일반적 — 프론트팀 영역)
- ALB 앞에 두기 (현 풀-서버리스 아키텍처에 어울리지 않음)
- API Gateway HTTP API → REST API 마이그레이션 (비용·latency·재설계 큼, 권장 X)

### 예방 (checklist)
- 새 AWS managed service 도입 spec 작성 시 **"protected resources" / "supported targets" 목록을 docs 에서 1차 확인**.
- 외부 reviewer (Well-Architected, Security) 가 이 부분 놓침. 향후 review 항목에 **"this service supports the target resource type"** 명시.
- cdk-nag / synth 가 이 호환성을 잡지 않음 — synth 통과 ≠ deploy 가능.

---

## 2. RDS Proxy `PENDING_PROXY_CAPACITY` 30 분+ stuck

### 증상
CFN 의 `AWS::RDS::DBProxyTargetGroup` CREATE 가 30 분 이상 wait. `aws rds describe-db-proxy-targets` 호출 시:
```json
{
  "TargetHealth": {
    "State": "UNAVAILABLE",
    "Reason": "PENDING_PROXY_CAPACITY"
  }
}
```
가끔 잠시 `AVAILABLE` 되었다가 다시 `PENDING_PROXY_CAPACITY` 로 떨어지는 flapping.

### 원인 (두 가지가 겹침)
1. **`proxySg.allowAllOutbound: false` + 명시적 egress rule 없음** — Proxy ENI 가 Aurora 5432, SecretsManager/KMS endpoint 443 모두 도달 못 함.
2. **ProxyRole 에 `kms:Decrypt` 권한 누락** — Aurora master secret 이 CMK 로 암호화됐는데, L2 `cluster.addProxy()` 사용 시 자동 부여되던 KMS grant 가 L1 `CfnDBProxy` 직접 사용으로 인해 누락. Proxy 가 secret bytes 는 fetch 했지만 decrypt 불가.

(`lambdaSg` 는 `allowAllOutbound: true` 라 이 함정에 안 빠짐 — `proxySg` 만 다른 패턴이라 발생한 버그.)

### 진단 단서
- `PENDING_PROXY_CAPACITY` 가 5-15 분 이상 지속 → AWS internal 사정 아님. 30분 이상이면 stuck.
- Target health flapping (AVAILABLE ↔ PENDING) — backend warm-up 이 반복 실패.
- CFN events 가 새로 안 찍히는 동안 RDS API 의 target 상태는 잠시 healthy 가 됨 — Proxy 가 연결을 잡았다 KMS decrypt 실패로 놓는 패턴.
- `aws iam get-role-policy` 로 ProxyRole 의 inline policy 직접 확인.

### 해결
1. proxySg 에 `addEgressRule(Peer.ipv4(vpcCidr), Port.allTraffic())` 추가 → VPC 내부 모든 traffic 허용 (외부 인터넷 노출 0).
2. AuroraConstruct 안에서 `secretKey.grantDecrypt(proxyRole)` 호출 추가.

### 예방
- L1 CfnDBProxy 사용 시 L2 가 해주던 자동 grant 를 reviewer checklist 로 enumerate:
  - secret read grant
  - **secret KMS key decrypt grant**
  - Proxy SG 의 egress (Aurora + Secrets/KMS endpoints)
  - Aurora SG ingress from Proxy SG
- spec 에서 `allowAllOutbound` 결정은 SG 마다 명시. default false 라면 명시적 egress rule 함께 정의.

---

## 3. WAF log group 의 KMS encryption — sharedKey 의 logs principal 미허용

### 증상
`AWS::Logs::LogGroup` CREATE_FAILED:
```
The specified KMS key does not exist or is not allowed to be used with Arn
'arn:aws:logs:ap-northeast-2:823401933116:log-group:aws-waf-logs-yourmillionare-dev'
(Service: CloudWatchLogs, Status Code: 400, HandlerErrorCode: AccessDenied)
```

### 원인
WafConstruct 가 `props.sharedKey` (Foundation 의 CMK) 를 log group encryption key 로 사용. sharedKey 의 resource policy 에 `logs.ap-northeast-2.amazonaws.com` ServicePrincipal 허용 없음. CloudWatch Logs service 가 key 를 못 씀.

network.stack.ts 의 `FlowLogsKey` 는 동일 패턴을 위해 명시적으로 service principal 을 허용하는 resource policy 를 가짐:
```ts
flowLogsKey.addToResourcePolicy(
  new PolicyStatement({
    principals: [new ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
    actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
    resources: ['*'],
    conditions: {
      ArnLike: {
        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
      },
    },
  }),
);
```

이 패턴을 WAF log group 에 적용 안 했음.

### 진단 단서
- CloudFormation event 의 `AccessDenied` + KMS key + log group → 십중팔구 key policy 에 logs service principal 미허용.
- 다른 stack 의 비슷한 패턴 (FlowLogsKey) 가 어떻게 했는지 비교.

### 해결 (WAF revert 전까지의 임시 fix)
WafConstruct 가 자체 KMS key 를 만들고 logs service principal 을 허용하도록 변경. (이후 WAF 자체 revert.)

### 예방
- CloudWatch Logs LogGroup 에 customer CMK 를 쓸 때마다 그 키의 resource policy 에 `logs.{region}.amazonaws.com` service principal 허용 여부 확인.
- "log group 이 KMS encrypt" 패턴을 별도 helper 또는 util construct 로 묶으면 빠뜨리지 않음.

---

## 4. `cdk deploy` 의 background bash 가 잘못된 cwd 에서 시작되어 `--app is required` 오류

### 증상
CDK deploy 가 시작되자마자 즉시 종료:
```
--app is required either in command-line, in cdk.json or in ~/.cdk.json
```

heredoc 또는 multi-statement chain 안에 cdk deploy 를 넣고 background 로 보낸 경우 발생.

### 원인
복잡한 chain (예: `git commit -F - <<EOF ... EOF && cdk deploy ...`) 을 single Bash 호출 안에 묶고 background 로 보내면, child process 의 cwd 가 의도와 다른 위치 (e.g. repo root) 에서 시작. cdk 가 `cdk.json` 을 못 찾아 즉시 실패.

### 해결
1. cdk deploy 는 항상 명령 시작부에 `cd infrastructure` 명시.
2. 또는 heredoc/multi-statement 와 cdk deploy 를 별도 Bash 호출로 분리.

### 예방
- background 로 long-running 명령 보내기 전, foreground 로 `pwd` 한 줄 먼저 확인.
- cdk deploy 명령은 가능하면 단일 line (no chain) 으로 작성.

---

## 부차 발견: Aurora Serverless v2 + RDS Proxy 의 최소 비용 ≠ ACU baseline

[DEV.to 기사](https://dev.to/aws-builders/caught-in-a-cost-optimization-trap-aurora-serverless-v2-with-rds-proxy-2mng) 에 따르면 RDS Proxy 가 Aurora Serverless v2 cluster 와 결합 시 **최소 8 ACU 비용 청구**. 즉 Aurora 가 0.5 ACU baseline 으로 sleep 해도 Proxy 자체는 시간당 `8 × $0.015 = $0.12`, 월 약 **~$87**. spec 의 추정치 (~$22/월) 가 4 배 정도 어긋남.

PR-A 머지 후 비용 재검토 필요 (사용자 요청). 적용된 환경 (dev) 의 실제 청구 1-2주 관찰 후 결정.

---

## 메타 학습

1. **synth 통과 ≠ deploy 가능**. cdk-nag 와 snapshot test 만으로는 잡지 못하는 호환성 / 권한 / encoding 이슈가 deploy 시 드러남. 새 리소스 도입 시 **첫 deploy 가 진단 단계** 라는 인식 필요.
2. **L1 (Cfn*) 으로 cross-stack cycle 우회할 때, L2 가 자동으로 해주던 grants/connections 를 수동으로 enumerate**. spec / plan 작성 시 L1 사용 결정과 함께 해야 할 grant 목록을 명시.
3. **외부 reviewer 도 모두 놓치는 함정**: AWS managed service 의 "지원 대상 resource type" 같은 fundamental 호환성. AWS docs 의 해당 페이지를 spec 의 "의존/가정" 절에 항상 인용 + link.
4. spec 의 비용 추정은 **공식 pricing docs + 같은 패턴을 실 운영한 사례 (DEV.to / re:Post) 양쪽** 확인.

## Sources

- [AWS WAF — Protected resources (CloudFormation)](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-webaclassociation.html)
- [Troubleshooting for RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy.troubleshooting.html)
- [AWS re:Post — RDS Proxy stuck with PENDING_PROXY_CAPACITY](https://repost.aws/questions/QUAAbHAAI_SmWN2pwWr_32dw/aws-rds-proxy-stuck-with-pending-proxy-capacity)
- [aws-cdk Issue #8919 — Timed out waiting for target group](https://github.com/aws/aws-cdk/issues/8919)
- [DEV.to — Caught in a Cost Optimization Trap (Aurora Serverless v2 with RDS Proxy)](https://dev.to/aws-builders/caught-in-a-cost-optimization-trap-aurora-serverless-v2-with-rds-proxy-2mng)
