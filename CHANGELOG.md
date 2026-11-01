# Changelog

## Unreleased

- `/internal/commands/*` needs an owner bearer token (M2-17, ADR 0028).
  Each command handler checks the token with `bearerHook` of `kit/auth`
  before it reads the body, as budget does: role `owner`, issuer,
  audience and `exp`. No token or a bad token gives 401, no `owner` role
  gives 403. A path with empty segments (`//internal/commands/...`) gets
  the same check. The `actor.id` of the command must be the `sub` of the token,
  else 403. The read route, the replay API, `/health`, `/ready` and
  `/metrics` need no token.
- New env: `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE` (the same as
  budget).
- Prompt aggregate on the stream `prompt-<promptId>`: `CreatePrompt` gives
  `prompts.PromptCreated`, `PublishPromptVersion` gives
  `prompts.PromptVersionPublished` with the next immutable version
  (contracts v0.3.0, schema version 1).
- The new prompt version comes from the stream version that the append is
  pinned to, so two events never have the same prompt version.
- `POST /internal/commands/create-prompt` and
  `POST /internal/commands/publish-prompt-version`, owner actor only, with
  command idempotency by `commandId`: 201 the first time, 200 with the
  same answer on a replay, 404 for a missing prompt, 409 on a conflict,
  400 problem JSON on a bad body, 503 when MongoDB is down.
- `GET /internal/prompts/:promptId/versions/:version`: one
  `PromptVersionResultV1`. Old versions stay readable.
- `GET /internal/events`: the replay API in position order.
- Migration `001-seed-prompts`: version 1 of the `orchestrator` and
  `writer` system prompts, with fixed ids. The seed texts treat the data
  block `owner_message` as the owner's request and any other data block as
  untrusted data.
- Outbox relay to the stream `PROMPTS`, `/health`, `/ready`, `/metrics`,
  graceful shutdown.
- Container image on Node 26 slim, uid 1000, read-only root file system,
  and the release workflow (image, SBOM, scan, gitops pull request).
