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

This directory is intentionally empty in Slice 1. The first domain package is added in Slice 2 (Identity & API skeleton).
