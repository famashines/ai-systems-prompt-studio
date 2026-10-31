# Changelog

## Unreleased

- Prompt aggregate on the stream `prompt-<promptId>`: `CreatePrompt` gives
  `prompts.PromptCreated`, `PublishPromptVersion` gives
  `prompts.PromptVersionPublished` with the next immutable version
  (contracts v0.3.0, schema version 1).
- `POST /internal/commands/create-prompt` and
  `POST /internal/commands/publish-prompt-version`, owner actor only, with
  command idempotency by `commandId`: 201 the first time, 200 with the
  same answer on a replay, 404 for a missing prompt, 409 on a conflict,
  400 problem JSON on a bad body, 503 when MongoDB is down.
- `GET /internal/prompts/:promptId/versions/:version`: one
  `PromptVersionResultV1`. Old versions stay readable.
- `GET /internal/events`: the replay API in position order.
- Migration `001-seed-prompts`: version 1 of the `orchestrator` and
  `writer` system prompts, with fixed ids.
- Outbox relay to the stream `PROMPTS`, `/health`, `/ready`, `/metrics`,
  graceful shutdown.
- Container image on Node 26 slim, uid 1000, read-only root file system,
  and the release workflow (image, SBOM, scan, gitops pull request).
