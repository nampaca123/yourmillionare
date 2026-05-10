# apps/

Hexagonal application code lives here. Each subdirectory is a npm workspace package and corresponds to one bounded context.

Folder convention (per `CLAUDE.md`):

```
apps/<domain>/
├── package.json
├── src/
│   ├── domain/              # entities, value objects, domain errors. zero external deps.
│   ├── application/         # use cases + port interfaces (ports/)
│   └── infrastructure/
│       ├── inbound/         # HTTP controllers, queue consumers
│       └── outbound/        # Prisma repos, HTTP clients (port implementations)
└── test/
```

Dependency direction (enforced in code review):

- `domain` imports nothing.
- `application` imports only `domain`.
- `infrastructure` implements `application` ports; may import `domain`.
- `application` MUST NOT import `infrastructure`.

## Current packages (Slice 6 complete)

| Package | 역할 |
|---------|------|
| `identity/` | Cognito users + tenants + tenant-members + bank-connections (CODEF 인증) + bank-accounts (계좌 confirm). HTTP routes 5개 |
| `journal/` | AI 분개 use cases (HTTP `/journal/classify`, `/journal/entries` POST/GET). `BedrockConverseClassifier` 사용 |
| `codef/` | CODEF EDA Lambda 3개 (tenants-list, codef-fetch, codef-classify-worker). SQS-driven 워커가 raw_transactions를 Bedrock으로 분류해 journal_entries 저장 |
| `fx/` | ECOS FX collector (skeleton, Slice 7+에서 활성화) |

`packages/journal-core/`는 위 앱들이 공유하는 도메인 — 분개 엔티티, 분류기 인터페이스, K-IFRS seed accounts, PG/DDB 어댑터.

자세한 슬라이스별 내역: `docs/01-foundation.ko.md` ~ `docs/06-slice6.ko.md`.
