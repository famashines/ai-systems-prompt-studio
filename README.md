# ai-systems-prompt-studio

The Prompt Library service of ai-systems (ADR 0021). It keeps prompts as
event-sourced streams `prompt-<promptId>` in MongoDB. Each published
version of a prompt is immutable, so an agent version that pins
`{ promptId, version }` stays reproducible. The `events` collection is the
outbox: a relay publishes each event to the NATS JetStream stream
`PROMPTS`. The service is internal and has no Ingress.

```
api-gateway --POST /internal/commands/create-prompt----------> prompt-studio
            --POST /internal/commands/publish-prompt-version->   | one transaction
                                                                 v
                                             MongoDB prompt_studio: events, commands
                                                                 | outbox relay, Nats-Msg-Id = eventId
                                                                 v
                                             NATS stream PROMPTS (prompts.>)
orchestration --GET /internal/prompts/:promptId/versions/:version--> prompt-studio
projections   --GET /internal/events--> prompt-studio (rebuild only)
```

Architecture and reasons: `ai-systems-docs` (`ARCHITECTURE.md` 3 to 7,
ADR 0006, 0007, 0021, 0023). Schemas: `@famashines/ai-systems-contracts`
v0.3.0, `src/prompts.ts`.

## Seed prompts

At start, the migration `001-seed-prompts` makes version 1 of two system
prompts, with the actor `{ "kind": "system", "id": "prompt-studio" }`.
The ids are fixed. agent-manager points at them (the seed, then
`upgradeOrchestrator` for version 2 of `orchestrator`):

| Agent          | `promptId`                             | `version` |
| -------------- | -------------------------------------- | --------- |
| `orchestrator` | `a0d53ff1-1eda-4636-bb2f-880df141bcb9` | `2`       |
| `writer`       | `cc74090a-534e-4072-8bfd-e6c5b9f22f41` | `1`       |

The texts are in `src/seeds.ts`. Both have no variables. Both say
that the data block named `owner_message` is the request of the owner, and
that any other data block is untrusted data that the agent never follows
(ARCHITECTURE 11.2). The seed
is safe to run again: it never writes a second copy, and it never
changes a prompt that exists. A better text is a new version through
`PublishPromptVersion`.

The migration `002-orchestrator-prompt-v2` publishes version 2 of the
`orchestrator` prompt (`orchestratorV2` in `src/seeds.ts`, fixed
`commandId`). Version 2 names the three orchestrator calls of
orchestration (`plan`, `aggregate`, `check`) and their answers in short,
and keeps the data block rules. The user message of each call has its
exact rules. The migration appends only when the prompt has one version
and its text is the seed text. The append is pinned to that stream
version, so an owner version that comes first gives a conflict, and the
migration skips. It never changes a prompt that the owner changed. The
agent-manager seed step points the seed `orchestrator` agent at version 2.

## API

| Method | Path                                            | Does                                                                                                                                   |
| ------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/internal/commands/create-prompt`              | Create a prompt (no version yet). Needs an owner bearer token.                                                                         |
| POST   | `/internal/commands/publish-prompt-version`     | Publish the next immutable version of a prompt. Needs an owner bearer token.                                                           |
| GET    | `/internal/prompts/:promptId/versions/:version` | Read one version (`PromptVersionResultV1`). No token.                                                                                  |
| GET    | `/internal/events?afterPosition=<n>&limit=<m>`  | Replay API: all events in position order. No token.                                                                                    |
| GET    | `/health`                                       | Liveness: 200 while the process runs                                                                                                   |
| GET    | `/ready`                                        | Readiness: 200 when MongoDB answers and the migrations are done, else 503 with the names of the failing checks (`mongo`, `migrations`) |
| GET    | `/metrics`                                      | Prometheus metrics                                                                                                                     |

Errors are RFC 9457 problem JSON with a `code` (`@famashines/ai-systems-kit/http`).

### Callers and trust

A NetworkPolicy is L4: it limits pod and port, not the caller. So the
service does not trust `actor.kind` `owner` in the body (ADR 0028,
M2-17). Each command handler checks the token first, with `bearerHook`
of `kit/auth`, as budget does: `Authorization: Bearer <access token>`
with the role `owner`, issuer `OIDC_ISSUER`, audience `OIDC_AUDIENCE` and
`exp`. The check comes before the body is read, so a caller with no token
gets 401 and no validation errors. The check is in the handler, not on a
path prefix, so it also applies to a path with empty segments (for
example `//internal/commands/create-prompt`, which the kit router
matches). Then the `actor.id` of the command must be the `sub` of the
token. A new command route must call the same check. The read and replay
routes have no check and stay open to the callers that the network lets
in. The callers are:

| Caller        | Paths                                               | Token                    |
| ------------- | --------------------------------------------------- | ------------------------ |
| api-gateway   | `POST /internal/commands/*`                         | Forwards the owner token |
| orchestration | `GET /internal/prompts/:promptId/versions/:version` | None                     |
| projections   | `GET /internal/events`                              | None                     |
| Prometheus    | `GET /metrics`                                      | None                     |

api-gateway checks the owner JWT with `kit/auth` (role `owner`), takes
the `commandId` from the `Idempotency-Key` header, sends the actor
`{ "kind": "owner", "id": <sub> }`, and must forward the `Authorization`
header of the owner. Its prompt routes are not there yet, so no caller
sends commands today. The kubelet probes `/health` and `/ready`.

The status rows of each command below also apply:

| Status | When                                                         | Body                                                                                                                                                |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | No token, or a token that is not valid                       | Problem JSON                                                                                                                                        |
| 403    | No `owner` role, or `actor.id` is not the `sub` of the token | Problem JSON                                                                                                                                        |
| 503    | MongoDB does not answer, or Keycloak cannot be read          | Problem JSON, `code` `unavailable`, with a fixed `detail`: `The database is not available` or `The keys of the identity provider are not available` |

### `POST /internal/commands/create-prompt`

```json
{
  "commandId": "6f1c2b9e-1d1a-4c55-9b0e-3a7f0d5e8c21",
  "type": "prompts.CreatePrompt",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": { "name": "summary" }
}
```

- `commandId` is the idempotency key: a lower-case UUID v4.
- `expectedVersion` is optional. If it is there, it must be `0`.
- The service makes the prompt id (UUID v4).

| Status | When                             | Body                                 |
| ------ | -------------------------------- | ------------------------------------ |
| 201    | A new prompt                     | `{ "promptId": "<uuid>" }`           |
| 200    | The same `commandId` came before | The first answer again. No new event |
| 400    | The body is not valid            | Problem JSON with `errors`           |
| 409    | The stream exists (an id clash)  | Problem JSON, `code` `conflict`      |

### `POST /internal/commands/publish-prompt-version`

```json
{
  "commandId": "0b7e5a4c-2f2d-4e1b-8c3a-5d6f7e8a9b0c",
  "type": "prompts.PublishPromptVersion",
  "actor": { "kind": "owner", "id": "<sub of the token>" },
  "payload": {
    "promptId": "<uuid>",
    "text": "Summarize {{topic}} in three lines.",
    "variables": ["topic"]
  }
}
```

- The text is 1 to 100,000 characters, not only white space, with no NUL.
  Each variable name (for example `topic`) comes at most once, at most 50.
  The service does not parse the text for the variables.
- `expectedVersion` is optional. It is the stream version (the number of
  events in `prompt-<promptId>`), not the prompt version. The append is
  pinned to it; with no `expectedVersion`, to the stream version that the
  service loaded. A stream at version `k` has `k - 1` prompt versions, so
  the new version is `k` (1 for a new prompt, at stream version 1).
- When the stream is not at the pinned version (another publish came
  first, or a wrong `expectedVersion`), the answer is 409 and the service
  writes nothing. So two events never have the same prompt version.
- The service checks the `commandId` before the version. A retry with
  the same `commandId` gets 200 with the first answer, also with an old
  `expectedVersion`.

| Status | When                                      | Body                                       |
| ------ | ----------------------------------------- | ------------------------------------------ |
| 201    | A new version                             | `{ "promptId": "<uuid>", "version": <n> }` |
| 200    | The same `commandId` came before          | The first answer again. No new event       |
| 400    | The body is not valid                     | Problem JSON with `errors`                 |
| 404    | The prompt does not exist                 | Problem JSON, `code` `not_found`           |
| 409    | Another append came first (version clash) | Problem JSON, `code` `conflict`            |

The events of a command have `correlationId` and `causationId` = the
`commandId`, and the `actor` of the command. The events and the stored
answer are in one MongoDB transaction.

### `GET /internal/prompts/:promptId/versions/:version`

`version` is an integer from 1 (digits only, no leading zero). The answer
is a `PromptVersionResultV1`:

```json
{
  "promptId": "cc74090a-534e-4072-8bfd-e6c5b9f22f41",
  "name": "writer",
  "version": 1,
  "text": "You are the writer agent. ...",
  "variables": []
}
```

A missing prompt or version gives 404. A bad id or version gives 400.
The read replays the stream (see Known limits).

### `GET /internal/events`

| Query           | Default | Rule               |
| --------------- | ------- | ------------------ |
| `afterPosition` | `0`     | integer, 0 or more |
| `limit`         | `100`   | integer, 1 to 1000 |

The answer is `{ "events": [ ... ] }`. Each item is an `EventEnvelopeV1`
with its `position`. Take the `position` of the last item as the next
`afterPosition`. An empty list is the end.

## Configuration

Environment variables (`.env.example` has all of them):

| Variable                                                            | Default                                         | Content                                   |
| ------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| `MONGODB_URI`                                                       | required                                        | MongoDB connection string (replica set)   |
| `MONGODB_DATABASE`                                                  | `prompt_studio`                                 | Database name                             |
| `NATS_SERVERS`                                                      | required                                        | NATS URLs, comma-separated; at least one  |
| `NATS_USER`                                                         | required                                        | `ai-systems-prompt-studio` on the cluster |
| `NATS_PASSWORD`                                                     | required                                        | From the SealedSecret                     |
| `OIDC_ISSUER`                                                       | `https://auth.famashines.com/realms/ai-systems` | Keycloak realm                            |
| `OIDC_JWKS_URL`                                                     | `<issuer>/protocol/openid-connect/certs`        | JWKS inside the cluster                   |
| `OIDC_AUDIENCE`                                                     | `ai-systems-app`                                | Audience and `azp` of the token           |
| `PORT`                                                              | `8080`                                          | HTTP port                                 |
| `LOG_LEVEL`                                                         | `info`                                          | pino level                                |
| `RELEASE`                                                           | `local`                                         | Release id in logs and metrics            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | not set                                         | Traces go over OTLP only when one is set  |

A bad value stops the process at start with the variable name. An empty
value is a value: delete the line to get the default. The kit service
name is fixed to `prompt-studio`, so the NATS inbox prefix is
`_INBOX_prompt-studio` and the grants of ADR 0023 apply. The service
needs only these grants: publish `prompts.>`, `$JS.API.INFO`,
`$JS.API.STREAM.INFO.PROMPTS`, and subscribe `_INBOX_prompt-studio.>`.

Deploy: set `OIDC_JWKS_URL` to the Keycloak service inside the cluster,
and add a NetworkPolicy egress from prompt-studio to Keycloak on port
8080 for the JWKS, as for budget. Keycloak is not a readiness check:
when the JWKS cannot be read, a command gets 503.

At start the service connects to MongoDB, runs the migrations
`000-event-store`, `001-seed-prompts` and `002-orchestrator-prompt-v2`,
connects to NATS, starts the relay, and listens. NATS and the relay are not readiness checks. When NATS
is down or the stream `PROMPTS` does not exist, the service still takes
commands, and the events wait in the outbox. The service does not make
streams: the gitops stream Job makes `PROMPTS`. A stuck relay shows in the
metrics `outbox_oldest_pending_seconds` and
`outbox_publish_failures_total`. Put an alert on the gauge.

## Known limits

- The JWKS comes over plain HTTP inside the cluster (ARCHITECTURE 11.1,
  accepted).
- The read and replay routes have no token check. The NetworkPolicy
  limits who can reach them.
- A command with a `commandId` that came before gives the first answer,
  also when the body is different (kit behavior). The second body is not
  checked and not stored.
- The seed `commandId` values are in this public repo. A caller that
  sends one of them gets the seed answer and writes nothing, while
  `commands` keeps the id (45 days).
- Each version read replays the full stream `prompt-<promptId>`. This
  assumes few versions for each prompt (tens, not thousands). A read
  model or a snapshot is the upgrade when a prompt gets many versions.
- The seed texts name the data block `owner_message`, as orchestration
  writes it. A change of that block name needs a new prompt version.

## Not done

- The prompt routes in api-gateway. They must forward the
  `Authorization` header of the owner.
- The gitops app and the NetworkPolicy with the ingress set above
  (M2-09).

## Run locally

Node 26 (`nvm use`), and a MongoDB replica set and NATS with JetStream and
the stream `PROMPTS`.

```sh
npm ci
cp .env.example .env
node --env-file=.env src/main.ts
```

In `.env`, fill in the required values and delete the lines that you do
not set.

## Container image

```sh
docker build --build-arg RELEASE=$(git rev-parse HEAD) -t ai-systems-prompt-studio .
```

Node 26 slim, pinned by digest, with no npm, no npx and no test packages.
The entrypoint is `node src/main.ts` as uid 1000. It writes nothing to
disk, so a read-only root file system works.

Release: when `ci` passes on a push to `main`, `.github/workflows/release.yml`
builds and scans the image, pushes
`ghcr.io/famashines/ai-systems-prompt-studio:sha-<commit>`, and opens or
updates the pull request from the branch
`release/ai-systems-prompt-studio-prod` in `famashines/gitops`. That step
needs the org secret `GITOPS_TOKEN` with access to this repo, and the
gitops folder `kubernetes/ai-systems/ai-systems-prompt-studio/prod` with a
`kustomization.yaml`. Both are not there yet.

## Test

| Command                    | Does                                                 |
| -------------------------- | ---------------------------------------------------- |
| `npm run verify`           | type check, lint, unit tests with the coverage gates |
| `npm run test:integration` | MongoDB and NATS in Testcontainers (needs Docker)    |

Commands for agents: `CLAUDE.md`.
