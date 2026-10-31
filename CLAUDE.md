# CLAUDE.md for ai-systems-prompt-studio

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../../docs/CLAUDE.md`). What the service does: `README.md`.

## Commands

| Command                    | Does                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `npm ci`                   | install from the lock file (builds kit and contracts on install) |
| `npm run check`            | `tsc --noEmit` (TypeScript 7)                                    |
| `npm run lint`             | ESLint (strict type-checked) and Prettier check                  |
| `npm test`                 | unit tests, two coverage gates (see below)                       |
| `npm run verify`           | check, lint and test                                             |
| `npm run test:integration` | `test/integration` with Testcontainers (needs Docker)            |
| `npm start`                | `node src/main.ts`                                               |

## Layout

```
src
├── domain/prompt.ts           decide, evolve, versionOf, no I/O
├── application/prompts.ts     the command handlers and the version read
├── adapters/http.ts           routes, zod schemas of the bodies, params and queries
├── seeds.ts                   the seed prompts and the migration 001-seed-prompts
└── main.ts                    config, wiring by constructor, start, shutdown
test
├── unit                       node:test, kit in-memory event store
└── integration                MongoDB and NATS in Testcontainers
```

The prompt version is not the stream version: `PromptCreated` is stream
version 1, so prompt version `n` is stream version `n + 1`. The publish
handler pins the append to one stream version `k` (the `expectedVersion`
of the command, else the last stream version that it loaded). The new
prompt version is `k`, because a stream at version `k` has `k - 1`
prompt versions. The kit refuses the append with a `ConcurrencyError`
when the stream is not at `k`, so a stored prompt version always matches
its stream version. The kit checks the `commandId` before the version, so
a retry with the same `commandId` and an old `expectedVersion` gets the
first answer (200). Do not add a version check before the append: it
would break that retry.

## Seeds

`001-seed-prompts` appends version 1 of each prompt in `seedPrompts`
with `expectedVersion: 0` and a fixed `commandId`. A `ConcurrencyError`
means "already there", so the seed is safe to run again (two pods, or
after the 45 days of `commands`). Never change the ids. A new seed text
is a new prompt version, not a change of the seed.

## Coverage gates (ADR 0017)

`npm test` runs the unit tests two times, because node:test thresholds are
for all included files together:

- `test:domain`: `src/domain`, 90% lines and 85% branches.
- `test:unit`: `src` without `main.ts`, 70% lines.

`main.ts` is wiring. The integration test covers it through `start()`.

## Integration tests

The NATS config in the test has the grants of the user
`ai-systems-prompt-studio` and `ai-systems-admin` from gitops
(`kubernetes/infrastructure/nats/values.yaml`). Change them together with
gitops. Wait with `waitFor`, never with a fixed sleep. Pass
`drainDelayMs: 0` to `start()`. The restart test calls `start()` two times
in one process, so `startTelemetry` runs two times. This is only in the
tests.

The CI job `integration` runs on `ubuntu-22.04`: `mongo:8.0.34` does not
start on the kernel of `ubuntu-24.04`. See the kit `CLAUDE.md`.

## Dependencies

- Kit and contracts come from git tags. A new tag needs a new
  `allowScripts` entry with the commit of the tag
  (`npm install-scripts approve <package>`).
- Kit v0.3.0 asks for contracts v0.1.0, but npm installs one copy, v0.3.0
  (`npm ls @famashines/ai-systems-contracts`). The default `parse` of the
  event store needs it to know the `prompts.*` events.
- `mongodb` and `zod` have the exact versions that the kit pins, so there
  is one copy of each. Check with `npm ls zod mongodb`.
- TypeScript 6 (`typescript`, for ESLint) and 7 (`typescript-7`, for
  `check`): ADR 0022. Never run `npx tsc`.
- The Docker build stage uses the full Node image, because npm needs `git`
  to install the kit and contracts. The runtime stage is slim.
