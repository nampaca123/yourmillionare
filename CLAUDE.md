# CLAUDE.md
 
본 백엔드 저장소의 공용 코드 가이드라인. 모든 구현은 이 문서를 따른다.
 
## 언어와 주석
 
- 모든 로그, 사용자 메시지, 식별자, 주석, 테스트 이름은 **영어**로 작성한다.
- 주석은 **파일 최상단 한 줄**로 그 파일의 역할을 설명하는 것만 허용한다. ( 형식: // <Role>: <one-line description> )
- 그 외의 주석은 작성하지 않는다.

## Claude Skills 활용

- ' ~/.claude/skills/ ' 경로에 개발에 활용할 Claude Skill들이 위치해 있다. AWS 클라우드 작업의 경우 aws-skills-main를 활용하는 등 필요한 스킬을 적재적소에 사용하도록 한다.

## 금지사항
 
### 절대 금지
- `any` 타입 (`unknown` 또는 구체 타입 사용)
- `console.*` (구조화 로거만 사용)
- `require()` / CommonJS (ES Modules만)
- `export default`
- 매직 넘버 (모듈 상수로 정의)
- 중첩 삼항 연산자
- `catch (e) {}` 식의 swallow. 무시할 거면 명시적으로 로깅한다.
- 비밀(API 키, 토큰, DB 비번)을 코드/저장소에 하드코딩
### 피해야 할 패턴
- God Service / God Class. **파일이 300줄을 넘으면** 도메인 / 액션 / 외부 의존성 축으로 분리한다.
- 상대 경로 3단계 이상 (`../../../`). barrel `index.ts` 또는 path alias ( @ ) 사용.
## 네이밍 컨벤션
 
### 파일명
- **kebab-case**. 형식: `<domain>-<subject>.<role>.ts`
- 역할 suffix는 아래 중 하나:
  - `.controller.ts` — HTTP/RPC 진입점
  - `.use-case.ts` / `.service.ts` — 도메인 유스케이스
  - `.repository.ts` — 영속성 어댑터
  - `.client.ts` — 외부 API 클라이언트
  - `.mapper.ts` — DTO ↔ 도메인 변환
  - `.schema.ts` — 입력 검증 스키마(zod)
  - `.types.ts` — 타입/인터페이스 모음
  - `.errors.ts` — 도메인 에러
  - `.config.ts` — 설정
  - `.port.ts` — 포트 인터페이스 (헥사고날)
  - `.test.ts` / `.integration.test.ts` — 테스트
### 금지 파일명
- 한 단어짜리 일반 명칭: `llm.ts`, `auth.ts`, `db.ts`
- Dumping ground: `utils.ts`, `helpers.ts`, `common.ts`, `misc.ts`, `shared.ts`
- 같은 이름을 폴더만 달리해서 두지 않는다 (`service/llm.ts` + `controller/llm.ts` 금지). **항상 `<role>` suffix로 구분.**
- 유틸이 필요하면 무엇을 위한 유틸인지 드러낸다: `string-formatter.ts`, `date-range.ts`
### 식별자
- 클래스/타입/인터페이스/enum: `PascalCase`. `I-` 접두사 금지.
- 변수/함수: `camelCase`
- 모듈 상수: `SCREAMING_SNAKE_CASE`
- 한 파일의 주요 export는 하나. 보조 타입은 함께 export 가능.
### PR관리
- git commit을 만든다면 날짜+주요작업을 commit 이름으로 한다. (예: 260504 bedrockLinked )

## 폴더 구조 (Hexagonal / Ports & Adapters)
 
```
src/
├── modules/
│   └── <domain>/
│       ├── domain/              외부 의존 0. 엔티티, 값 객체, 도메인 에러.
│       ├── application/         유스케이스. 포트 인터페이스를 여기서 정의한다.
│       │   └── ports/           user.repository.port.ts, password-hasher.port.ts ...
│       └── infrastructure/
│           ├── inbound/         외부 → 앱 (HTTP controller, queue consumer)
│           └── outbound/        앱 → 외부 (Prisma repo, HTTP client) — 포트 구현체
├── shared/                      2개 이상 모듈에서 쓰는 인프라/유틸만
└── main.ts                      의존성 조립
```
 
### 의존 방향 (위반 시 머지 불가)
- `domain` → 누구도 import 안 함. 외부 라이브러리 import 금지.
- `application` → `domain`만 import.
- `infrastructure` → `application`의 포트를 구현. `domain`도 import 가능.
- **`application`은 `infrastructure`를 import하지 않는다.** 필요하면 포트를 추가한다.
## 백엔드 공통 규칙
 
### 입력 검증
- 모든 외부 입력은 inbound 어댑터 **경계에서** 스키마(zod)로 검증한다.
- 검증 실패는 `ValidationError(422)`로 변환한다.
- 검증된 타입을 `application`으로 넘기고, 그 안에서는 다시 검증하지 않는다.
### 비밀 관리
- 비밀은 환경변수에서만 읽고, 시작 시 한 번 검증한 뒤 타입이 부여된 `config` 객체로 export한다.
- 비밀, 토큰, 카드/주민번호 등 민감 정보는 절대 로깅하지 않는다.
### 로깅
- 구조화 로거(pino)만 사용.
- 모든 요청에 request id를 부여하고 로그에 포함시킨다.
- 4xx 에러는 `warn`, 5xx는 `error`로 기록한다.
### 비동기
- callback 스타일 금지. `async/await` 사용.
- 독립적인 I/O는 `Promise.all`로 병렬화. 단 외부 호출은 동시성 한계를 둔다.
- 다중 쓰기는 트랜잭션으로 묶는다.
### 멱등성
- `PUT`, `DELETE`는 멱등하게 구현한다.
- 결제 등 부수효과가 큰 `POST`는 idempotency key를 받는다.
## 에러 처리
 
### HTTP Status Code 매핑
 
| 상황 | Status |
|------|--------|
| 요청 본문/쿼리 형식이 망가짐 | 400 |
| 토큰 없음 / 만료 / 위조 | 401 |
| 인증됐지만 권한 부족 | 403 |
| 리소스 없음 | 404 |
| 중복, 버전 충돌, 상태 전이 불가 | 409 |
| 스키마/유효성 검증 실패 | 422 |
| 요청 횟수 초과 | 429 |
| 예상 못한 내부 오류 | 500 |
| 외부 서비스 장애 | 502 / 503 / 504 |
 
**401은 "credential 자체가 없거나 무효", 403은 "credential은 유효하지만 권한 없음"** 으로 명확히 구분한다. API를 개발할 때마다 위와 같은 에러 처리 분류를 충분히 고려하도록 한다. ZodError는 어떤 경로로 빠져나와도 toHttpErrorResponse에서 422로 변환한다.
 
### 표준 에러 클래스
 
```ts
// Base error class for all domain and HTTP errors.
 
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly userMessage: string,
    logMessage?: string,
  ) {
    super(logMessage ?? userMessage);
    this.name = new.target.name;
  }
}
 
export class UnauthorizedError extends AppError {
  constructor(logMessage?: string) {
    super(401, 'UNAUTHORIZED', 'Authentication required.', logMessage);
  }
}
// ForbiddenError(403), NotFoundError(404), ConflictError(409),
// ValidationError(422) 등 동일 패턴으로 정의한다.
```
 
- `userMessage`는 클라이언트에 노출. 내부 ID, 경로, 스택 정보 포함 금지.
- `logMessage`는 디버깅용 상세 정보.
### 응답 포맷
 
모든 에러 응답은 아래 형식만 사용한다. stack trace, 내부 객체 노출 금지.
 
```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```
 
### 프레임워크 무관 처리
 
응답 변환은 `shared/errors/http-error.ts`의 `toHttpErrorResponse(err, ctx)` 함수만 사용한다. Express middleware, Fastify error handler, Nest filter는 이 함수의 **얇은 어댑터**일 뿐이다. status 결정 로직을 각 프레임워크 어댑터에 두지 않는다.
 
```ts
// Maps any error into a framework-agnostic HTTP response shape.
 
const SERVER_ERROR_THRESHOLD = 500;
const FALLBACK = {
  status: 500,
  body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
};
 
export const toHttpErrorResponse = (
  err: unknown,
  context: { path: string; requestId?: string },
) => {
  if (err instanceof AppError) {
    const level = err.statusCode >= SERVER_ERROR_THRESHOLD ? 'error' : 'warn';
    logger[level]({ err, ...context }, err.message);
    return {
      status: err.statusCode,
      body: { error: { code: err.code, message: err.userMessage } },
    };
  }
  logger.error({ err, ...context }, 'Unhandled error');
  return FALLBACK;
};
```
 
### 던지기 규칙
 
- `domain` / `application`은 `AppError` 또는 그 서브클래스만 던진다.
- 외부 라이브러리(ORM, HTTP client) 에러는 **outbound 어댑터에서 잡아** `AppError`로 변환한다.
  - Prisma `P2002` (unique) → `ConflictError`
  - Prisma `P2025` (not found) → `NotFoundError`
  - axios `ECONNREFUSED` → `AppError(503, ...)`
- 컨트롤러에서 try-catch로 응답을 만들지 않는다. 던지기만 하고 어댑터에 위임한다.
- 사용자 입력 검증 실패는 `ValidationError(422)`. `400`이 아니다.
## 테스트
 
### 러너
- **Vitest** 사용. ESM/TypeScript 네이티브 동작.
- 글로벌 API는 명시적으로 import한다 (`globals: false`).
### 위치
- 유닛 테스트는 대상 파일과 같은 폴더에 콜로케이션: `register-user.use-case.test.ts`.
- 통합 테스트는 `*.integration.test.ts`. 별도 vitest project로 분리.
### 구조: Arrange-Act-Assert
- 모든 테스트는 세 블록을 빈 줄 하나로 분리한다.
- 한 `it` 블록은 하나의 시나리오만 검증한다.
### 이름: should-when 패턴
- 형식: `should <기대 결과> when <조건>`
- `describe`는 대상(클래스/유스케이스), `it`은 시나리오.
### 의존성 다루기
- `application` 레이어 테스트는 포트의 **in-memory 구현을 직접 작성**해 주입한다. 모킹 라이브러리보다 우선한다.
- 외부 라이브러리 모킹은 `vi.mock`으로 같은 파일 안에서만 사용한다.
```ts
// Unit tests for the RegisterUserUseCase.
 
import { describe, it, expect, beforeEach } from 'vitest';
 
describe('RegisterUserUseCase', () => {
  let useCase: RegisterUserUseCase;
  let userRepository: InMemoryUserRepository;
 
  beforeEach(() => {
    userRepository = new InMemoryUserRepository();
    useCase = new RegisterUserUseCase(userRepository, new FakePasswordHasher());
  });
 
  it('should persist a new user when the email is not taken', async () => {
    const input = { email: 'a@b.com', password: 'secret123' };
 
    const user = await useCase.execute(input);
 
    expect(user.email).toBe('a@b.com');
  });
 
  it('should throw ConflictError when the email is already taken', async () => {
    await userRepository.save({ email: 'a@b.com', passwordHash: 'x' });
 
    const promise = useCase.execute({ email: 'a@b.com', password: 'secret123' });
 
    await expect(promise).rejects.toBeInstanceOf(ConflictError);
  });
});
```