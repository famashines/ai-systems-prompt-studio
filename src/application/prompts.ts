import type {
  Actor,
  CreatePromptCommandPayloadV1,
  PromptVersionResultV1,
  PublishPromptVersionCommandPayloadV1,
} from "@famashines/ai-systems-contracts";
import type { EventStore } from "@famashines/ai-systems-kit/event-store";
import {
  decide,
  evolve,
  initialState,
  isPromptEvent,
  promptStreamId,
  versionOf,
  type PromptEvent,
  type PromptState,
} from "../domain/prompt.ts";

export interface Deps {
  store: EventStore;
  newId: () => string;
}

export interface CommandInput<P> {
  commandId: string;
  actor: Actor;
  expectedVersion?: number;
  payload: P;
}

export interface CreatePromptAnswer {
  promptId: string;
}

export interface PublishPromptVersionAnswer {
  promptId: string;
  version: number;
}

async function load(store: EventStore, promptId: string) {
  const events = await store.readStream(promptStreamId(promptId));
  const state: PromptState = events.filter(isPromptEvent).reduce(evolve, initialState);
  return { state, last: events.at(-1)?.version ?? 0 };
}

async function append<A>(
  store: EventStore,
  promptId: string,
  expectedVersion: number,
  events: PromptEvent[],
  { commandId, actor }: CommandInput<unknown>,
  answer: A,
): Promise<{ answer: A; replayed: boolean }> {
  const result = await store.append({
    streamId: promptStreamId(promptId),
    expectedVersion,
    events: events.map((event) => ({
      ...event,
      correlationId: commandId,
      causationId: commandId,
      actor,
    })),
    command: { commandId, answer },
  });
  return { answer: result.answer ?? answer, replayed: result.replayed };
}

export async function createPrompt(
  { store, newId }: Deps,
  input: CommandInput<CreatePromptCommandPayloadV1>,
): Promise<{ answer: CreatePromptAnswer; replayed: boolean }> {
  const promptId = newId();
  const events = decide(initialState, { type: "CreatePrompt", promptId, ...input.payload });
  return append(store, promptId, 0, events, input, { promptId });
}

export async function publishPromptVersion(
  { store }: Deps,
  input: CommandInput<PublishPromptVersionCommandPayloadV1>,
): Promise<{ answer: PublishPromptVersionAnswer; replayed: boolean }> {
  const { promptId } = input.payload;
  const { state, last } = await load(store, promptId);
  const streamVersion = input.expectedVersion ?? last;
  const events = decide(state, { type: "PublishPromptVersion", ...input.payload, streamVersion });
  return append(store, promptId, streamVersion, events, input, {
    promptId,
    version: streamVersion,
  });
}

export async function readPromptVersion(
  { store }: Pick<Deps, "store">,
  promptId: string,
  version: number,
): Promise<PromptVersionResultV1> {
  return versionOf((await load(store, promptId)).state, version);
}
