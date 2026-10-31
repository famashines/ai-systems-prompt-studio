import {
  Actor,
  CommandEnvelopeV1,
  CreatePromptCommandPayloadV1,
  Id,
  PublishPromptVersionCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import {
  ConflictError,
  NotFoundError,
  UnavailableError,
  validate,
  type Handler,
  type Route,
} from "@famashines/ai-systems-kit/http";
import { isInfrastructure } from "@famashines/ai-systems-kit/messaging";
import { z } from "zod";
import {
  createPrompt,
  publishPromptVersion,
  readPromptVersion,
  type Deps,
} from "../application/prompts.ts";
import {
  PromptExistsError,
  PromptNotFoundError,
  PromptVersionNotFoundError,
} from "../domain/prompt.ts";

const Owner = Actor.extend({ kind: z.literal("owner") });

const CreatePromptBody = CommandEnvelopeV1(CreatePromptCommandPayloadV1).extend({
  type: z.literal("prompts.CreatePrompt"),
  expectedVersion: z.literal(0).exactOptional(),
  actor: Owner,
});

const PublishPromptVersionBody = CommandEnvelopeV1(PublishPromptVersionCommandPayloadV1).extend({
  type: z.literal("prompts.PublishPromptVersion"),
  actor: Owner,
});

const count = (fallback: string, schema: z.ZodInt) =>
  z.string().regex(/^\d+$/).default(fallback).transform(Number).pipe(schema);

const EventsQuery = z.object({
  afterPosition: count("0", z.int().min(0)),
  limit: count("100", z.int().min(1).max(1000)),
});

const VersionParams = z.object({
  promptId: Id,
  version: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
});

export function toHttpError(error: unknown): unknown {
  if (error instanceof PromptExistsError) return new ConflictError(error.message);
  if (error instanceof PromptNotFoundError || error instanceof PromptVersionNotFoundError) {
    return new NotFoundError(error.message);
  }
  if (isInfrastructure(error)) return new UnavailableError("The database is not available");
  return error;
}

const guard =
  (handler: Handler): Handler =>
  async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      throw toHttpError(error);
    }
  };

export function routes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      path: "/internal/commands/create-prompt",
      handler: guard(async (request) => {
        const { body } = await validate(request, { body: CreatePromptBody });
        const { answer, replayed } = await createPrompt(deps, body);
        return { status: replayed ? 200 : 201, body: answer };
      }),
    },
    {
      method: "POST",
      path: "/internal/commands/publish-prompt-version",
      handler: guard(async (request) => {
        const { body } = await validate(request, { body: PublishPromptVersionBody });
        const { answer, replayed } = await publishPromptVersion(deps, body);
        return { status: replayed ? 200 : 201, body: answer };
      }),
    },
    {
      method: "GET",
      path: "/internal/prompts/:promptId/versions/:version",
      handler: guard(async (request) => {
        const { params } = await validate(request, { params: VersionParams });
        return { body: await readPromptVersion(deps, params.promptId, params.version) };
      }),
    },
    {
      method: "GET",
      path: "/internal/events",
      handler: guard(async (request) => {
        const { query } = await validate(request, { query: EventsQuery });
        return { body: { events: await deps.store.readAll(query) } };
      }),
    },
  ];
}
