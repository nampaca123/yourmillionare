# 유어밀리어네어(YourMillionare) 프로젝트 - AWS 클라우드 네이티브 회계 AI Agent

# 1. 페르소나 UX 설계

## 1.1 페르소나 프로필 (심화)

**김민지 / 25세 / 청년창업 스타트업 공동창업자**

- **본업**: UX/UI 디자이너. Figma·Notion·Slack은 익숙. 회계 SW는 한 번도 본 적 없음.
- **법적 구조**: 작년에 친구 2명과 법인 설립. 법인 통장 1개 + 법인카드 3장(공동대표·이사 1명씩).
- **수입**: 사실상 0. 정부지원금·시드 투자금 일부로 버티는 중.
- **지출 패턴**: 월 100~200만원 규모. 클라우드 비용, 외주 디자인 툴, 도메인, 카페 미팅, 출장.
- **회계 인식 수준**: "세무사 써야 한다"는 들었지만 비용 부담. "재무제표"라는 단어는 들어봤지만 만들 줄도 읽을 줄도 모름.
- **공포 포인트**: 국세청 문자, 가산세, "이거 비용 처리 되나요?" 질문, 통장 잔고 확인.

## 1.2 민지의 멘탈 모델

민지는 회계를 "정답이 있는 골치아픈 정리 작업"으로 생각해. 그래서 다음과 같은 관념이 박혀 있어.

- 영수증은 모아야 한다 (실제론 카드/통장 데이터로 대부분 해결됨)
- 세금 계산은 어렵고 틀리면 큰일 난다 (실제론 패턴화 가능한 룰 + 검증)
- 재무제표는 회계사만 만든다 (실제론 분개만 정확하면 자동 생성)

이 멘탈 모델을 뒤집는 게 우리 UX의 임무야. **"네가 결제만 하면, 나머지는 끝나 있어."**

## 1.3 UX 3원칙

**원칙 1. 무행동 우선 (No-Action First)**

민지가 가장 좋아하는 인터랙션은 "안 한 인터랙션"이야. 영수증 사진을 찍게 만들지 않음. 카테고리를 분류하라고 하지 않음. 모든 자동화를 일단 시도하고, AI가 확신 없을 때만 묻고, 그 질문도 카드 좌우 스와이프 한 번으로 끝나야 함.

**원칙 2. 친숙한 옷, 낯선 속**

내부적으로는 정식 복식부기·재무제표 구조로 데이터를 관리하지만 (감사·세무 신고에 필요), 화면에서는 노션 DB / 갤러리 뷰 / 칸반 / 챗으로 보임. "거래원장" 대신 "이번 달 카드값", "매출채권" 대신 "받을 돈" 식의 자연어 라벨을 쓰고, 호버나 작은 (i) 버튼에 정확한 회계 용어를 포함한 쉽고 친절한 설명을 담음.

**원칙 3. 챗을 메인 메뉴로**

기존 회계 SW는 좌측 메뉴 트리(매입/매출/세무/결산…)가 첫 화면. 민지는 그 트리 자체를 모름. 우리는 노션 방식의 화면과 융합된 형태의 챗 인터페이스가 홈이고, 민지가 자연어로 묻거나 AI가 먼저 카드를 던지면, 그 자리에서 적절한 뷰(노션 DB, 차트, 캘린더)가 펼쳐짐. 메뉴는 보조.

## 1.4 핵심 사용자 여정

**여정 A — 온보딩 (한 번)**

1. 회원가입 (Cognito 소셜 로그인 + 선택적으로 사업자등록번호 입력)
2. 법인 통장·카드·외화통장·세금계산서 연결 — 토스/카카오 인증서 1회로 CODEF에 권한 위임 (개별 API 키 발급 절차 없음)
3. **휴리스틱 1차 분류로 큰 그림 즉시 표시 (≤5초)** — 거래처명 매칭 + 금액대 룰 기반. "지난 3개월 손익 미리보기" 카드를 바로 띄움.
4. **정밀 분류는 백그라운드** — Step Functions 워크플로우가 200~500건 거래를 Sonnet으로 분류. 완료 시 알림톡으로 "정밀 결과 정리됐어요!" 전달 (10~30분).
5. 카카오 알림톡 연동 → 끝

총 5분 이내. 이후 민지는 앱을 안 열어도 됨. **"5분 온보딩"이 진짜로 5분 안에 끝나고 AI 작업은 비동기로 흘러가는 패턴**이 1.3 원칙 1 "무행동 우선"과 맞물림.

**여정 B — 일상 (수동적)**

- 민지는 평소처럼 법인카드로 결제만 함.
- 앱은 백그라운드에서 데이터를 수집·분류·기장.
- 매일 오전 9시 알림톡 1개: "오늘 확인할 거 1가지" (없으면 "오늘은 다 정리됐어요!").

**여정 C — 능동 알림 (월 2~5회)**

- "다음 주가 부가세 신고 마감이야. 자료는 다 준비해뒀어. [확인하기]"
- "이번 달 USD 1,200 들어왔어. 환율이 최근 30일 평균보다 1.5% 높은데 지금 환전할까?"
- "[거래처A] 입금 예정일이 3일 지났어. 알림톡 자동 발송 시작할까?"

**여정 D — 분기 패닉 모먼트 (분기 1회)**

- 부가세 신고 시즌. "신고서 초안이 다 만들어졌어. 검토만 하면 돼." 한 화면에서 매출/매입/공제/납부세액 요약 + "세무사에게 전달" 버튼 (제휴 세무사 연계).

## 1.5 디자인 언어

- **톤**: 친근한 동료. 존댓말 기본, 알림은 짧고 단정.
- **색**: 화이트 베이스 + 1개 액센트 컬러. 빨강은 진짜 위험할 때만 (가산세 위험 등).
- **타이포**: Pretendard. 숫자는 탭 정렬.
- **모바일 우선**, 데스크톱은 동일 컴포넌트의 반응형.

---

# 2. 핵심 MVP

## 2.1 MVP 한 줄 정의

> **법인카드/통장만 연결하면, AI가 알아서 장부를 쓰고, 세금·환율·미수금을 챙겨주는 자동조종 회계 비서.**

## 2.2 페이즈 분할

F1~F5를 한 MVP에 묶으면 검증 난이도·외부 의존성·비용 영향이 너무 달라 동시에 가면 어느 것도 제대로 안 됨. 셋으로 분할:

### Phase 0 — Foundation (4주)

**목표**: 1명 베타 사용자가 "와, 진짜 결제만 하면 장부가 써지네" 경험.

| 범위 | 비고 |
|---|---|
| 인증/온보딩 (Cognito + 오픈뱅킹 1개 은행) | 서울 리전 |
| F1 자동 기장 엔진 | **CODEF 어댑터 1개**로 통장+카드+외화통장 통합. 베타는 1통장+1카드부터 |
| F2 노션형 장부 뷰 | 거래 DB + 이번 달 요약 카드만 |
| 알림톡 1건 | "오늘 확인할 거 있어요" 패턴 |

**검증 지표**: 분개 정확도 측정 가능, 사용자가 5분 안에 1차 결과 봄.

### Phase 1 — Tax & Chat with AgentCore (6주)

**목표**: 첫 분기 부가세 신고를 사용자가 패닉 없이 통과. **AgentCore 풀세트 도입.**

| 범위 | 비고 |
|---|---|
| F3 AI 매니저 챗 (수동 응답 모드) | AgentCore Runtime + Memory + Gateway + Code Interpreter |
| F4 세금 캘린더 + 부가세 자료 자동 생성 | Step Functions Saga |
| F2에 "받을 돈 칸반" 추가 | |
| AgentCore Evaluations 도입 | 분개 정확도 자동 측정 시작 |

**리스크**: AgentCore 일부 서비스(Agent Registry 등)는 서울 리전 미지원. 도쿄 리전 활용 또는 우회 검토 필요.

### Phase 2 — Differentiation (6주)

**목표**: 글로벌 매출 있는 팀이 "이거 없으면 못 살아" 단계.

| 범위 | 비고 |
|---|---|
| F5 FX 스마트 정산 | ECOS API + Code Interpreter 시뮬레이션 |
| F3 능동 알림 모드 | 룰셋 v1 풀세트 |
| 멀티 에이전트 코디네이터 | 단일 챗 → Coordinator + 4 Specialist |
| 제휴 세무사 연계 | 첫 수익 모델 |

## 2.4 비용 제약 ↔ 기능 결정

월 사용자당 인프라 비용 목표는 **$3.20 미만** (₩10,000 가격 기준 마진 ~55%). 자세한 분해는 §4.6.

핵심 의사결정:
- **영수증 OCR 제외**: Textract는 이미지 1장당 $0.0015. 월 100장이면 $0.15. 누적 효과 큼. 카드 API로 대체.
- **챗 항상 켜두지 않음**: 민지의 질문은 월 5~10회 추정. 나머지는 능동 알림(스케줄 배치)으로 처리해 LLM 호출 줄임.
- **모델 라우팅**: Sonnet 4.6 기본, Opus 4.7 어려운 케이스만. Haiku는 분개에 안 씀(가산세 리스크).
- **AgentCore Code Interpreter**: 수치 계산은 LLM에 맡기지 않고 샌드박스 Python에서 실행 → 신뢰도 ↑.

## 2.5 성공 지표 (페이즈별)

**Phase 0**:
- 온보딩 5분 이내 1차 결과 도달률 ≥ 80%
- 1차 분류 정확도 ≥ 85% (휴리스틱)
- 정밀 분류 정확도 ≥ 95% (Sonnet)

**Phase 1**:
- 가입 후 30일 잔존 ≥ 50%
- 부가세 신고 자료 자동 생성률 100%
- AgentCore Evaluations 점수 7일 이동평균 ≥ 93%

**Phase 2**:
- 사용자당 월 인프라 비용 ≤ $3.20
- 능동 알림으로 막은 가산세/환차손 사례 ≥ 사용자당 1건/분기
- 제휴 세무사 연계 전환율 ≥ 20%

---

# 3. 기능 명세

각 기능에 **AWS 서비스 매핑**을 함께 명시. 매핑은 §4 아키텍처와 일관됨.

## F1. 자동 기장 엔진

**목적**: 민지가 결제만 하면 복식부기 장부가 알아서 써지게 한다.

**입력 데이터 소스 — CODEF 단일 게이트웨이**

청년 법인이 직접 KFTC 이용기관 등록·카드사 API 계약을 할 수는 없으니, 우리 앱이 CODEF와 계약하고 사용자는 인증서 1회로 권한 위임. CODEF 한 곳에서 14개 카드사·20개 은행·홈택스·전자세금계산서를 모두 수집:

- **법인 통장 입출금** — CODEF 은행 기업 거래내역 API
- **법인카드 매입내역** — CODEF 카드 매입내역 API
- **외화통장 거래** — CODEF 은행 기업 외화 거래내역 API (F5 FX와 같은 소스)
- **홈택스 매입자료** — CODEF 홈택스 수집 API (사업용 신용카드 자동 수집 포함, 별도 등록 불필요)
- **전자세금계산서** — CODEF 전자세금계산서 통합 API

사용자 인증은 카카오 인증서로 Connected ID 발급. 은행이 N차 추가인증을 요구할 때만 단계 추가. 카드사 매출 알림톡 파싱은 CODEF 장애 시 fallback으로만 유지.

**처리 파이프라인 (Step Functions 워크플로우)**

1. EventBridge Scheduler가 6시간마다 트리거 (실시간 X → 비용 절감)
2. Step Functions State Machine 시작: `Fetch → Dedup → Classify → Record`
3. **Fetch**: Lambda가 오픈뱅킹·카드 API 호출, raw 거래를 가져옴
4. **Dedup**: DynamoDB에 `external_id` 존재 확인 → 신규만 SQS로
5. **Classify**: Lambda 워커가 SQS에서 꺼내 Bedrock Sonnet 4.6 호출 → 분개 결과
6. **Record**: Aurora의 `journal_entries` + `journal_lines` INSERT (트랜잭션). 동시에 사용자 화면용 DynamoDB 캐시 갱신.

**유저 노출 동작**

- 결제 후 평균 3~6시간 내에 노션형 DB에 거래가 나타남
- 신뢰도 낮은 항목은 "확인 필요" 뷰에 따로 모임 → 카드 스와이프로 "맞아 / 아니야" 응답
- 사용자가 정정한 케이스는 `ai_decisions` 테이블에 학습 데이터로 저장 → 다음 동일 거래처는 자동 처리

**엣지 케이스**

- 사적 사용 의심 거래 (예: 주말 야간 카페) → AI가 "이거 회사 비용 맞아?" 1회 질문
- 환불·취소 → 원거래 매칭하여 역분개
- 분할결제·할부 → 첫 회 등장 시 사용자에게 1회 확인

**AWS 매핑**

| 단계 | AWS 서비스 | 사용자당 월 비용 |
|---|---|---|
| 폴링 트리거 | EventBridge Scheduler (rate 6h) | 무료 |
| 워크플로우 | Step Functions Standard | $0.025 |
| 거래 fetch (CODEF 호출) | Lambda + Secrets Manager(Connected ID) → CODEF | $0.001 + CODEF 호출 단가 별도 |
| 큐잉 | SQS Standard + DLQ | $0.00004 |
| AI 분개 | Bedrock Sonnet 4.6 → Opus 4.7 escalation | $0.30 |
| 멱등성 | DynamoDB On-Demand (`raw_tx_id` PK) | $0.001 |
| 영구 저장 | Aurora Serverless v2 PostgreSQL | 분담 ~$0.44 |
| 학습 데이터 | S3 + Athena | $0.005 |

**핵심 패턴 (서버리스 EDA 베스트 프랙티스 준수)**:
- Step Functions로 오케스트레이션. **Lambda 직접 invoke 체이닝 금지**.
- 모든 거래 처리는 idempotent. dedup key는 `(source, external_id)` 복합 — CODEF 응답의 출처(은행/카드/외화/홈택스/세금계산서)와 거래 식별자 조합.
- DLQ에 1건 이상 쌓이면 즉시 CloudWatch 알람 → Slack.
- Lambda Powertools로 구조화 로그·메트릭·X-Ray 트레이스 일관 처리.

## F2. 노션형 장부 뷰

**목적**: 회계를 모르는 민지가 자기 회사 돈을 직관적으로 본다.

**핵심 뷰 4개**

1. **거래 DB 뷰**: 노션 데이터베이스 그대로. 컬럼은 날짜 / 내용 / 금액 / 카테고리 / 상태. 필터·정렬·검색 자유.
2. **받을 돈 칸반**: "예정 / 임박 / 지연 / 수금완료" 4개 컬럼. 카드 끌어다 옮기면 상태 변경.
3. **이번 달 요약 카드**: 들어온 돈, 나간 돈, 남은 돈, 다음 달 예상. 큰 숫자 4개로만.
4. **계정별 잔액 갤러리**: 통장별·카드별 현재 잔액과 한도.

**내부 ↔ 외부 매핑 예시**

| 내부 (회계) | 외부 (UX) |
|---|---|
| 매출 | 들어온 돈 |
| 영업비용 | 회사가 쓴 돈 |
| 매출채권 | 받을 돈 |
| 매입채무 | 줄 돈 |
| 현금성자산 잔액 | 통장에 있는 돈 |
| 부가세 예수금 | 나라에 줄 부가세 |

**AWS 매핑**

| 컴포넌트 | AWS 서비스 |
|---|---|
| API | API Gateway HTTP API → Lambda (NodejsFunction) |
| 정규화 데이터 | Aurora `journal_*` 테이블 (감사·신고용 정확성) |
| 화면 캐시 | DynamoDB (denormalized: `tenant#{id}#month#{ym}`) |
| 캐시 갱신 | DynamoDB Streams로 Aurora 변경 → DynamoDB 동기화 (eventual consistency 허용) |
| 정적 자산 | CloudFront + S3 |

**왜 두 DB?** 분개의 무결성·트랜잭션·복합 조인은 Aurora가 강함. 화면 표시는 단일 키 조회가 압도적이라 DynamoDB가 빠르고 저렴. 두 DB 동기화는 Streams로 자동화 → 화면 응답 50ms 이하 + 회계 정합성 둘 다 챙김.

## F3. AI 매니저 챗 (Phase 1, AgentCore 풀세트)

**목적**: 민지의 회계 친구. 묻는 말에 답하고, 묻기 전에 챙긴다.

**아키텍처: AgentCore 5개 서비스 조합**

```
[사용자 질문]
     ↓
[Coordinator Agent] ─── AgentCore Memory (대화·사용자 컨텍스트)
     ├─ 의도 분류 (Sonnet 4.6, 짧은 토큰)
     └─ 적절한 스페셜리스트 라우팅
          ↓
   ┌──────┼──────┬──────┐
[Bookkeeper] [Tax] [FX] [Cashflow]   ← Phase 2 도입
          ↓ (Phase 1은 단일 에이전트로 시작)
[AgentCore Gateway] ── 내부 회계 API를 MCP 도구로 자동 노출
     ├─ get_journal(date_range)
     ├─ get_balance(account)
     ├─ predict_runway()
     ├─ search_tax_law(query)  [Bedrock Knowledge Base]
     └─ run_calculation(expr)  ──→ AgentCore Code Interpreter
                                    (LLM 직접 계산 X, 샌드박스 Python)
```

**Phase 1에서 AgentCore의 5개 서비스가 직접 매핑**:

- **Runtime**: 챗 에이전트 컨테이너를 자동 스케일링. FastAPI 직접 운영보다 운영 부담 ↓.
- **Memory**: 대화 히스토리·사용자 메모리(예: "민지는 비건 카페를 회의실 대용으로 자주 씀")를 자체 관리. DynamoDB로 직접 만들 필요 없음.
- **Gateway**: 내부 회계 REST API를 OpenAPI 스키마 등록만으로 MCP 도구로 변환. Bedrock Agent action group 수동 정의보다 빠름.
- **Identity**: 오픈뱅킹·카드사 OAuth 토큰을 안전 보관·90일 자동 로테이션. 신용정보법 영향권에서 직접 구현보다 안전.
- **Code Interpreter**: 핵심 차별점. "다음 달 통장 잔고 예상", "환차손 시뮬레이션"은 Python 코드로 돌리고 결과만 LLM에 전달. LLM 직접 산수의 신뢰성 문제 회피.

**두 가지 모드**

**(a) 수동 응답 모드** (Phase 1)
- "이번 달 우리 얼마 썼어?"
- "이 거래 비용처리 돼?"
- "다음 달 통장 잔고 어떻게 될 것 같아?"

→ Coordinator가 적절한 도구 호출(장부 조회, 예측, 세법 KB 검색)로 답변

**(b) 능동 알림 모드** (Phase 2)
- 매일 새벽 1회 EventBridge 배치 잡이 룰셋을 돌림
- 트리거 조건이 충족된 사용자만 알림 큐에 들어감
- 알림톡 1건 + 앱 푸시 1건

**능동 트리거 룰셋 (Phase 2 v1)**

- 부가세 신고 마감 14일 / 7일 / 3일 전
- 원천세·지방세 마감 7일 전
- 미수금 입금예정일 +3일 경과
- 법인 통장 잔고가 월평균 지출의 2개월 미만 (Runway 경고)
- 외화 입금 발생 + 환율이 30일 이동평균 대비 +1% 이상
- 동일 거래처 분개에서 사용자 정정이 3회 누적 (학습 필요 신호)

**비용 최적화 포인트**

- 능동 알림은 룰 엔진이 사용자를 먼저 필터링 → 해당자에게만 LLM 호출
- 알림 메시지 자체는 Sonnet 4.6으로 생성 (간단한 문장 1~2개)
- 동일 유형 알림은 템플릿 캐싱 → 변수만 치환

**왜 Phase 2에 멀티 에이전트?** (agent-designer 스킬 Supervisor 패턴)
- 단일 에이전트에 모든 도구를 묶으면 컨텍스트 비대 + 도구 선택 오류율 ↑.
- 스페셜리스트는 narrow scope → 더 작은 모델로 충분한 케이스가 늘어 비용 ↓.
- Bookkeeper는 분개 한 가지에 집중 → 시스템 프롬프트 짧음 → 토큰 절약.

## F4. 세금 캘린더 & 리마인더 (Phase 1)

**목적**: 민지가 모르는 세금 일정을 놓치지 않게 한다.

**관리하는 세목 (MVP)**

- 부가가치세: 1월·7월 (예정신고는 일반과세자만)
- 원천세: 매월 10일 (직원·외주 지급 시)
- 지방세: 분기별
- 종합소득세 / 법인세: 5월 / 3월

**Saga 패턴 (Step Functions)**

부가세 신고 자료 준비는 다단계라 중간에 실패하면 데이터 무결성 문제 발생. Step Functions로 보상 트랜잭션 보장:

```
[자료 수집] → [세액 계산] → [PDF 생성] → [세무사 송부] → [완료 기록]
     ↓ 실패            ↓ 실패         ↓ 실패        ↓ 실패
[원상복구]        [원상복구]       [원상복구]    [수동 알림]
```

**동작**

1. 사업자 유형(법인/개인사업자)·과세 유형을 온보딩 시 1회 입력
2. 일정은 시스템이 미리 계산 (사용자별 `tax_events` row 자동 생성)
3. 마감 14일 전 알림 시작
4. 부가세의 경우, 마감 14일 전에 신고 자료(매출/매입 합계, 공제 가능 항목, 납부예상세액)가 자동 생성되어 챗으로 푸시
5. "세무사에게 전달" 버튼 → 제휴 세무사 또는 사용자가 지정한 세무사 이메일로 PDF 송부

**AWS 매핑**

| 컴포넌트 | AWS 서비스 |
|---|---|
| 일정 저장 | Aurora `tax_events` |
| D-day 검사 | EventBridge 일별 스케줄 → Lambda |
| 신고 자료 생성 | Step Functions Saga + Lambda + 서버리스 PDF 라이브러리 |
| 발송 | SNS → SES (이메일) / KakaoTalk Lambda (알림톡) |
| 보상 트랜잭션 | Step Functions Catch + Compensate |

## F5. FX 스마트 정산 (Phase 2)

**목적**: 해외 매출이 있는 청년팀의 환차손을 줄인다. 차별화 포인트.

**트리거**: CODEF 기업 외화 거래내역 API로 외화통장 입금 감지 또는 외화 송금 예정 등록. 외화통장 자체도 별도 자산이라 분개·잔액 추적이 F1과 같은 어댑터로 끝남 (별도 연동 불필요).

**제공 기능**

1. **현재 환율 + 최근 30일 추세 시각화** — 한국은행 ECOS API 매매기준율 + 시중은행 고시환율
2. **벤치마크 권고** — "지금 환전 시 30일 평균 대비 +1.5%" 한 줄
3. **분할 환전 플랜 제안** — "다음 4주에 25%씩 나눠 환전" (DCA 전략)
4. **외화통장 vs 즉시 환전 시뮬레이션** — Code Interpreter로 두 시나리오 손익 계산
5. **세무 영향 안내** — 외화 매출의 부가세 영세율 적용, 외환차익/차손 회계 처리

**AWS 매핑**

| 컴포넌트 | AWS 서비스 |
|---|---|
| 환율 수집 | EventBridge 1h 스케줄 → Lambda → ECOS API |
| 환율 캐시 | DynamoDB TTL (1시간) |
| 추세 분석 | Lambda + 단순 통계 (NumPy 불필요) |
| 시뮬레이션 | AgentCore Code Interpreter (Python 샌드박스) |
| 트리거 알림 | EventBridge → SNS |

**의도적으로 빼는 것**

- 선물환·옵션 등 파생상품 (페르소나 수준에 부적합, 규제 이슈)
- 자동 환전 실행 (책임 이슈, 은행 라이선스 필요)

## F6. (전체 공통) 비용 최적화 설계 원칙

기능 명세에 포함되지 않지만 **모든 기능이 따라야 하는 제약**.

- **항상 켜진 컴포넌트 금지**: VPC 내부 NAT Gateway 등 시간당 과금 인프라는 처음부터 회피. 가능한 모든 워크로드를 Lambda + 매니지드 서비스로.
- **Aurora Serverless v2 최소 ACU = 0.5**: 미사용 시 자동 일시정지에 가깝게.
- **LLM 라우팅 계층화**: 일반 작업은 Sonnet 4.6, 심화 작업은 Opus 4.7 순으로 에스컬레이션.
- **캐싱 적극 활용**: 세법 RAG 답변, 환율 조회 결과는 DynamoDB TTL 캐시.
- **실시간 대신 배치**: 거래 폴링·알림 모두 배치. 사용자에게 "실시간"이 필요한 기능은 없음.
- **DynamoDB On-Demand**: 트래픽 패턴 예측 어려운 초기에는 프로비저닝보다 저렴.
- **CloudFront + S3로 정적 자산 100% 오프로드**: Lambda 호출 횟수 최소화.
- **사용자별 비용 모니터링 대시보드 필수**: 누가 비용을 많이 쓰는지 추적해서 무료 사용자 abuse 방지.

---

# 4. AWS 아키텍처

## 4.1 전체 레이어

```
[사용자]      React Native 앱 / Next.js 웹
                 ↓
[Edge]        CloudFront + WAF + Cognito Authorizer
                 ↓
[API]         API Gateway HTTP API → Lambda (NodejsFunction, ARM64)
                 ↓
[코어]         ├─ 자동 기장 (Step Functions)
              ├─ 알림 (EventBridge → SNS → KakaoTalk Lambda)
              └─ AI 매니저 (AgentCore Runtime, Phase 1+)
                 ↓
[데이터]       Aurora Serverless v2 (분개장) + DynamoDB (캐시/세션)
              + S3 (학습데이터, 신고서 PDF) + KMS
                 ↓
[외부]         CODEF (통장·카드·외화·홈택스·세금계산서) / ECOS / 카카오 알림톡 / 제휴 세무사
```

## 4.2 데이터베이스 전략 — Aurora + DynamoDB 듀얼 스토리지

분개의 무결성과 화면의 응답속도는 요구사항이 다르기 때문에 한 DB로 둘 다 만족시키려 하지 않음.

### Aurora Serverless v2 PostgreSQL — 정확성·감사 영역

복식부기 분개장은 트랜잭션 무결성이 절대적. 차변/대변 합 일치, 외래키 무결성, 다중 row 트랜잭션이 필수. 또한 부가세 신고 시 6개월~수년치 거래를 다양한 조건으로 조회·집계해야 하므로 SQL의 표현력이 필요.

**핵심 테이블**

```sql
tenants(id, biz_reg_no, tax_type, plan, created_at)

accounts(tenant_id, code, name_internal, name_display)

journal_entries(id, tenant_id, entry_date, source, source_ref,
                ai_confidence, created_at)

journal_lines(entry_id, account_code, debit, credit, memo)
  -- DEFERRABLE CHECK (per-entry SUM(debit) = SUM(credit))

raw_transactions(id, tenant_id, source, external_id, fetched_at, raw_json)
  -- (tenant_id, source, external_id) UNIQUE → 멱등성 보장

ai_decisions(entry_id, model, input_tokens, output_tokens, confidence,
             user_corrected, corrected_at, correction_diff)
  -- 정확도 KPI + 학습 데이터 원천

tax_events(tenant_id, kind, due_date, status, prepared_doc_s3)
fx_observations(date, currency, rate, source)  -- 공유, tenant_id 없음
notifications(tenant_id, kind, channel, status, sent_at, payload)
```

**멀티테넌시**: 모든 사용자별 테이블 PK 첫 컬럼은 `tenant_id`. PostgreSQL **RLS(Row Level Security) 정책**으로 application 레벨 누출 방지. (schema-per-tenant는 Aurora에서 비용·관리 부담 큼.)

> **현재 구현 상태 (Slice 3)**: 위 목록 중 `tax_events`, `notifications`, `ai_decisions`는 아직 `schema.sql`에 없습니다. `schema.sql` 헤더의 "MVP 제외" 섹션에 명시돼 있으며 Phase 1 마이그레이션 파일로 추가될 예정입니다. 현재 배포된 테이블은 8개(users, user_profiles, tenants, tenant_members, accounts, journal_entries, journal_lines, raw_transactions, fx_observations + schema_migrations)입니다.

### DynamoDB On-Demand — 속도·확장성 영역

화면이 보여주는 모든 정보는 단일 키 조회로 끝남. "이번 달 요약 카드"는 한 row, "거래 DB 뷰"는 한 파티션 스캔. 이런 패턴엔 DynamoDB가 훨씬 빠르고 저렴.

**키 설계**

| 용도 | PK | SK |
|---|---|---|
| 월별 요약 캐시 | `tenant#{id}` | `summary#{ym}` |
| 거래 리스트 캐시 | `tenant#{id}` | `tx#{date}#{seq}` |
| 멱등성 키 | `tenant#{id}#tx` | `ext#{external_id}` |
| 환율 캐시 (TTL 1h) | `fx#{currency}` | `t#{epoch_h}` |
| 사용자 일일 비용 카운터 | `tenant#{id}#cost` | `day#{ymd}` |

### Aurora ↔ DynamoDB 동기화

DynamoDB는 Aurora의 캐시. 일관성은 eventual로 충분 (사용자 화면이 1분 늦는 건 OK, 대신 50ms 응답).

**구현**: Aurora 분개 INSERT 직후 같은 Lambda에서 DynamoDB 갱신 (write-through). 실패하면 DynamoDB Streams 기반 보정 잡이 5분 뒤 재시도. 둘 다 실패하면 DLQ → 알람.

이 패턴이 매력적인 이유는 **장애 격리**도 가능하다는 것. DynamoDB가 잠깐 죽어도 Aurora는 살아있으므로 분개 자체는 손실 없음. 화면만 잠깐 stale.

## 4.3 AI 매니저 챗 — AgentCore 기반 (Phase 1부터)

§3 F3에서 자세히 다룸. 핵심 요약:

- **Phase 1**: 단일 Coordinator Agent + AgentCore Runtime/Memory/Gateway/Identity/Code Interpreter
- **Phase 2**: Coordinator + 4개 Specialist (Bookkeeper, Tax, FX, Cashflow)
- 평가는 AgentCore Evaluations로 5% 샘플링 → CloudWatch 대시보드

**리전 주의**: AgentCore Agent Registry는 us-east-1, us-west-2, eu-west-1, ap-northeast-1(도쿄), ap-southeast-2만 지원. 서울 리전 미지원이므로 도쿄 활용 또는 우회 필요. Phase 1 시작 전 최신 가용성 재확인.

## 4.4 보안 및 컴플라이언스

오픈뱅킹·세금 정보 → PIPA + 신용정보법 + 전자금융거래법 영향권. 핵심:

- **PII 컬럼 단위 암호화**: 사업자등록번호, 거래처명 일부 → pgcrypto + KMS CMK
- **CODEF Connected ID + 사용자 인증서/키 파일**: AgentCore Identity로 관리, 90일 자동 로테이션. 인증서·키는 KMS CMK envelope 암호화로 별도 보관
- **Aurora 접근**: VPC 내부, IAM DB Auth + RDS Proxy. 인터넷 노출 없음
- **CloudTrail + S3 Object Lock**: 감사 로그 5년 변조 불가 보존
- **데이터 export 권리** (PIPA 35조): Step Functions로 PDF/CSV 생성 → S3 presigned URL

> **현재 구현 상태 (Slice 3)**:
> - `pgcrypto` extension은 `schema.sql`에서 활성화되지만 암호화에는 사용하지 않음. `biz_reg_no`는 KMS `Encrypt` API 직접 호출 (10자리 이하라 DEK 패턴 불필요). 거래처명(`counterparty`)은 현재 미암호화.
> - RDS Proxy는 Slice 4에서 도입 예정. 현재는 Lambda → Aurora 직접 연결.
> - CloudTrail, S3 Object Lock, CDK Pipelines은 미구현 (Phase 1 목표).
> - KMS CMK 현황은 아래 "KMS CMK 설계 원칙" 섹션 참조.

### KMS CMK 설계 원칙 — Cryptographic Separation of Concerns

**"키 1개 공유"보다 "용도별 키 분리"가 더 안전하고 실현 가능하다.**

CloudFormation은 스택 간 양방향 참조(순환 의존)를 허용하지 않는다.
`grantEncryptDecrypt()` · `grantDataApiAccess()` 같은 CDK 헬퍼는 편하지만, **호출 측(다운스트림 스택)의 Lambda ARN을 키 정책(업스트림 Foundation 스택)에 자동으로 기록**한다.
다운스트림이 Foundation의 키 ARN을 참조하면서 Foundation의 키 정책이 다운스트림 ARN을 다시 참조하면 사이클이 발생한다.

DynamoDB는 이 문제를 우연히 피했다. DDB 테이블에 KMS를 붙일 때는 키 정책을 건드리지 않고 IAM 역할 쪽에서 권한을 처리하기 때문이다.

결론적으로 **키 정책 변경이 필요 없는 리소스(CODEF Secret, DynamoDB)**만 Foundation 공유 키를 쓸 수 있고, 나머지는 자기 스택에 로컬 키를 둔다. 이는 "차선책"이 아니라 암호학적 관심사 분리 원칙과도 일치한다. 서로 다른 보호 목적의 데이터에 같은 키를 쓰면 키 노출 시 피해 범위가 커진다.

### KMS CMK 인벤토리

| 키 이름 | 스택 | 보호 대상 | 회전 | RemovalPolicy (dev / prod) | 비고 |
|---|---|---|---|---|---|
| `SharedKey` | Foundation | CODEF 자격증명 Secret, DynamoDB 4개 테이블 | 연간 자동 | DESTROY / RETAIN | 키 정책 변경 없이 참조만 하는 리소스 전용 |
| `FlowLogsKey` | Network | VPC Flow Logs (CloudWatch Logs) | 연간 자동 | DESTROY / DESTROY | CloudWatch Logs 서비스 프린시펄을 키 정책에 추가해야 해서 로컬 키 필요 |
| `AuroraClusterStorageKey` | Data | Aurora Serverless v2 스토리지 암호화 | 연간 자동 | DESTROY / RETAIN | `grantDataApiAccess()`가 Lambda ARN을 키 정책에 기록 → 사이클 방지를 위해 로컬 키 |
| `AuroraClusterSecretKey` | Data | Aurora 마스터 시크릿 암호화 | 연간 자동 | DESTROY / RETAIN | 위와 동일 이유 |
| `BizRegNoKey` | Api | `tenants.biz_reg_no` 필드 암호화 | 연간 자동 | DESTROY / RETAIN | `grantEncryptDecrypt()`가 Lambda ARN을 키 정책에 기록 → 로컬 키 |
| `BizRegNoHmacKey` | Api | `biz_reg_no` 중복 제거 HMAC | **OFF** | DESTROY / RETAIN | 회전하면 HMAC 값이 바뀌어 기존 dedup 인덱스가 깨짐. 의도적으로 회전 비활성화 |

**감사 정책**: CloudTrail은 모든 KMS API 호출을 기록한다. 운영 체크리스트:
- 월 1회 CloudTrail → Athena로 키별 `kms:Decrypt` 호출 주체 쿼리 (비정상 IAM 역할 탐지)
- `BizRegNoHmacKey`는 회전이 없으므로 연 1회 키 정책 검토 필수
- prod에서 키를 삭제할 경우 최소 7일 대기 기간(KMS 기본값) 적용. RETAIN 정책이 CloudFormation 삭제를 막지만 AWS Console 직접 삭제는 막지 않으므로 IAM SCP로 프로덕션 KMS 키 삭제를 제한한다

## 4.5 관측성

- **Lambda Powertools (TS)**: 구조화 로그·메트릭·X-Ray 트레이스 일관 처리
- **AgentCore Observability**: 에이전트 호출별 토큰·비용·레이턴시 자동 수집
- **CloudWatch 알람 (필수)**:

| 알람 | 임계값 | 채널 |
|---|---|---|
| SQS DLQ 깊이 | ≥ 1 | PagerDuty |
| Bedrock 4xx/5xx 에러율 | > 1% | Slack |
| Aurora ACU | > 4 (비용 스파이크) | Slack |
| 사용자당 일일 비용 | > $0.30 (월 $9 = abuse 의심) | 자동 throttle |
| 분개 정확도 (Evaluations) | 7일 이동평균 < 93% | 모델/프롬프트 리뷰 |
| Step Functions 실패율 | > 0.5% | Slack |

## 4.6 비용 모델 — 사용자당 월 비용 분해

| 구성요소 | 가정 | 월 비용 |
|---|---|---|
| Lambda (ARM, 256MB) | 200 inv × 1s | $0.001 |
| API Gateway HTTP | 500 req | $0.0005 |
| EventBridge | 200 events | $0.0002 |
| SQS | 100 msgs | $0.00004 |
| Step Functions Standard | 사용자당 ~50 state transitions | $0.025 |
| DynamoDB On-Demand | 1000 ops | $0.001 |
| Aurora Serverless v2 | 0.5 ACU avg, 100사용자 분담 (prod 기준; dev는 min ACU=0으로 유휴 시 ~$0) | $0.44 |
| S3 + 전송 | 100MB | $0.005 |
| Bedrock Sonnet 4.6 | 50 분개 + 10 챗 | $0.30 |
| Bedrock Opus 4.7 | 5 어려운 케이스 | $0.30 |
| AgentCore Runtime | 챗 30분 × 10회 | $0.50 (보수적 추정) |
| AgentCore Memory + Gateway | 사용자당 메모리 + 도구 호출 | $0.30 |
| AgentCore Code Interpreter | 5회 × 5초 | $0.10 |
| 카카오 알림톡 | 30건 | $0.25 |
| CloudWatch Logs/Metrics | ~100MB | $0.05 |
| KMS, Secrets Manager | 키 + 시크릿 | $0.02 |
| **합계** | | **~$2.30** |
| **40% 버퍼** | | $0.92 |
| **목표가 ₩10,000 ≈ $7.14** | | **마진 ~55%** |

AgentCore의 Runtime/Memory/Gateway/Code Interpreter는 미공개·변동 가격이 섞여 있어서 위 값은 보수적으로 잡았어. 실배포 전 Pricing MCP로 재검증 필수.

---

# 5. 운영

## 5.1 정확도 측정 인프라 (Phase 1부터)

원안 KPI "자동 분개 정확도 ≥ 95%"는 측정 방법이 없으면 슬로건. Phase 1에서 인프라 도입:

- **온라인 평가**: AgentCore Evaluations로 분개 결과 5% 샘플링. 평가자 두 종류:
  - `Builtin.Helpfulness` (베이스라인)
  - 커스텀 "회계 정합성" 평가자: Sonnet 4.6 LLM-as-Judge. 프롬프트는 "차변/대변 합치, 계정과목 적절성, 금액 오류 여부" 체크
- **그라운드 트루스**: 사용자가 "이 분개 틀렸어" 정정한 케이스를 ground truth로 → `ai_decisions` 테이블 누적 → 주간 리포트
- **회귀 테스트셋**: 100건 익명화된 분개 케이스 셋 유지. 모델·프롬프트 변경 시 자동 통과 검사
- **CloudWatch 대시보드**: 일별 정확도 추세, 모델별 분포, 정정 빈도 상위 거래처 노출

## 5.2 IaC 및 배포 (Phase 0부터)

- **CDK TypeScript** 사용. 리소스 명시적 네이밍 금지 (CDK 베스트 프랙티스 — 패턴 재사용성·병렬 배포 가능성 보장)
- **cdk-nag**를 합성 시간에 자동 실행. 예외 처리는 코드에 사유 명기
- **환경 분리**: 계정 수준 분리 (dev / staging / prod) — 같은 계정 내 prefix 분리는 보안상 비추 (AWS Security Pillar)
- **Pipeline**: GitHub Actions → CDK Pipelines → 자동 카나리 (10% 트래픽 → 100%)
- **롤백**: CDK Pipelines의 자동 롤백 + Aurora point-in-time recovery

> **현재 구현 상태 (Slice 3)**: 환경 분리는 단일 계정 + `Ym-Dev-*` prefix로 운영 중. Pipeline 미구축 — 로컬에서 `cdk deploy` 직접 실행. CDK Pipelines + 카나리는 Phase 1 도입 예정.

## 5.3 사용자 abuse 방지

월 $4 가정은 평균. 한 사용자가 챗을 무한 호출하면 깨짐. 방어:

- **사용자당 일일 LLM 호출 100회 하드 리밋** (Token Bucket, DynamoDB 카운터 `tenant#{id}#cost`)
- **AgentCore Memory 컨텍스트 8K 토큰 캡** — 컨텍스트가 너무 커지면 토큰 비용 급증
- **일일 비용 알람 → 자동 throttle**: 사용자당 일일 $0.30 초과 시 Lambda Authorizer가 챗 API를 24h 차단
- 차단 시 사용자에게 "오늘은 챗 사용량이 많았어요. 내일 다시 시도해주세요" 알림톡

## 5.4 페이즈별 운영 체크리스트

**Phase 0 종료 시점에 갖춰야 할 것**:
- [ ] CDK 스택 dev/prod 분리, cdk-nag 통과
- [ ] CloudWatch 알람 5종 (DLQ, Bedrock, Aurora, Lambda 에러율, S3 4xx)
- [ ] 1건 베타 사용자 30일 운영 기록
- [ ] Pricing MCP로 실비용 측정 vs 4.6 모델 비교

**Phase 1 종료 시점**:
- [ ] AgentCore Evaluations 점수 7일 이동평균 ≥ 93%
- [ ] 첫 분기 부가세 자료 자동 생성률 100%
- [ ] AgentCore Runtime 콜드스타트 p95 < 3s
- [ ] 일일 abuse throttle 발동 사용자 < 1%

**Phase 2 종료 시점**:
- [ ] 멀티 에이전트 도구 선택 정확도 ≥ 95%
- [ ] FX 권고 채택률 ≥ 30% (사용자가 "환전할게" 답한 비율)
- [ ] 사용자당 월 비용 < $3.20 (목표가 마진 ≥ 55% 유지)
- [ ] 제휴 세무사 연계 전환율 ≥ 20%
