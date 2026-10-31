import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  evolve,
  initialState,
  isPromptEvent,
  PromptExistsError,
  PromptNotFoundError,
  promptStreamId,
  PromptVersionNotFoundError,
  versionOf,
  type PromptCommand,
  type PromptEvent,
} from "../../src/domain/prompt.ts";

const promptId = "00000000-0000-4000-8000-000000000001";

const create: PromptCommand = { type: "CreatePrompt", promptId, name: "writer" };

const publish = (text: string, variables: string[] = []): PromptCommand => ({
  type: "PublishPromptVersion",
  promptId,
  text,
  variables,
});

const created: PromptEvent = {
  type: "prompts.PromptCreated",
  schemaVersion: 1,
  payload: { promptId, name: "writer" },
};

const published = (version: number, text: string, variables: string[] = []): PromptEvent => ({
  type: "prompts.PromptVersionPublished",
  schemaVersion: 1,
  payload: { promptId, text, variables, version },
});

const state = (events: PromptEvent[]) => events.reduce(evolve, initialState);

const given = (events: PromptEvent[]) => ({
  when: (command: PromptCommand) => () => decide(state(events), command),
});

test("given no events, when CreatePrompt, then PromptCreated", () => {
  assert.deepEqual(given([]).when(create)(), [created]);
});

test("given PromptCreated, when CreatePrompt, then PromptExistsError", () => {
  assert.throws(given([created]).when(create), PromptExistsError);
});

test("given no events, when PublishPromptVersion, then PromptNotFoundError", () => {
  assert.throws(given([]).when(publish("Be short.")), PromptNotFoundError);
});

test("given PromptCreated, when PublishPromptVersion, then version 1 with its variables", () => {
  assert.deepEqual(given([created]).when(publish("Hello {{name}}", ["name"]))(), [
    published(1, "Hello {{name}}", ["name"]),
  ]);
});

test("given two versions, when PublishPromptVersion, then version 3", () => {
  assert.deepEqual(
    given([created, published(1, "One"), published(2, "Two")]).when(publish("Three"))(),
    [published(3, "Three")],
  );
});

test("an old version stays readable after a new version", () => {
  const after = state([created, published(1, "One", ["a"]), published(2, "Two")]);
  assert.deepEqual(versionOf(after, 1), {
    promptId,
    name: "writer",
    text: "One",
    variables: ["a"],
    version: 1,
  });
  assert.equal(versionOf(after, 2).text, "Two");
});

test("versionOf refuses a missing prompt and a missing version", () => {
  assert.throws(() => versionOf(initialState, 1), PromptNotFoundError);
  assert.throws(() => versionOf(state([created]), 1), PromptVersionNotFoundError);
  assert.throws(
    () => versionOf(state([created, published(1, "One")]), 2),
    PromptVersionNotFoundError,
  );
});

test("evolve refuses a version before the prompt and an unknown event type", () => {
  assert.throws(() => evolve(initialState, published(1, "One")), /before the prompt/);
  const unknown = { ...created, type: "prompts.Unknown" } as unknown as PromptEvent;
  assert.throws(() => evolve(initialState, unknown), /Unknown event type/);
});

test("isPromptEvent takes only the prompt events", () => {
  const event = (type: string) => ({ type });
  assert.equal(isPromptEvent(event("prompts.PromptCreated")), true);
  assert.equal(isPromptEvent(event("prompts.PromptVersionPublished")), true);
  assert.equal(isPromptEvent(event("orchestration.TaskSubmitted")), false);
});

test("the stream id is prompt-<promptId>", () => {
  assert.equal(promptStreamId(promptId), `prompt-${promptId}`);
});
