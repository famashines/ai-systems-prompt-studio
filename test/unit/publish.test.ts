import assert from "node:assert/strict";
import { test } from "node:test";
import { ConcurrencyError, type EventStore } from "@famashines/ai-systems-kit/event-store";
import { createMemoryEventStore } from "@famashines/ai-systems-kit/testing";
import {
  createPrompt,
  publishPromptVersion,
  readPromptVersion,
} from "../../src/application/prompts.ts";
import { promptStreamId } from "../../src/domain/prompt.ts";

const owner = { kind: "owner", id: "owner-1" } as const;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const promptId = id(100);
const noId = () => "";

const newPrompt = async () => {
  const store = createMemoryEventStore();
  await createPrompt(
    { store, newId: () => promptId },
    { commandId: id(1), actor: owner, payload: { name: "writer" } },
  );
  return store;
};

const publish = (store: EventStore, commandId: string, text: string, expectedVersion?: number) =>
  publishPromptVersion(
    { store, newId: noId },
    {
      commandId,
      actor: owner,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      payload: { promptId, text, variables: [] },
    },
  );

const afterRead = (store: EventStore, during: () => Promise<unknown>): EventStore => {
  let pending: (() => Promise<unknown>) | undefined = during;
  return {
    ...store,
    readStream: async (streamId, options) => {
      const events = await store.readStream(streamId, options);
      const run = pending;
      pending = undefined;
      if (run) await run();
      return events;
    },
  };
};

test("an expectedVersion ahead of the load gives the version of that stream version", async () => {
  const store = await newPrompt();
  const racing = afterRead(store, () => publish(store, id(2), "A"));
  const b = await publish(racing, id(3), "B", 2);
  assert.deepEqual(b.answer, { promptId, version: 2 });
  const stream = await store.readStream(promptStreamId(promptId));
  assert.deepEqual(
    stream.map((event) => [event.version, event.payload]),
    [
      [1, { promptId, name: "writer" }],
      [2, { promptId, text: "A", variables: [], version: 1 }],
      [3, { promptId, text: "B", variables: [], version: 2 }],
    ],
  );
  assert.equal((await readPromptVersion({ store }, promptId, 2)).text, "B");
});

test("a publish without expectedVersion that loses the race gets a conflict", async () => {
  const store = await newPrompt();
  const racing = afterRead(store, () => publish(store, id(2), "A"));
  await assert.rejects(publish(racing, id(3), "B"), ConcurrencyError);
  await assert.rejects(readPromptVersion({ store }, promptId, 2));
});

test("an expectedVersion that is not the stream version gives a conflict", async () => {
  const store = await newPrompt();
  for (const expectedVersion of [0, 2, 5]) {
    await assert.rejects(
      publish(store, id(10 + expectedVersion), "X", expectedVersion),
      ConcurrencyError,
    );
  }
  assert.equal((await store.readStream(promptStreamId(promptId))).length, 1);
});

test("a retry with the same commandId and an old expectedVersion gives the first answer", async () => {
  const store = await newPrompt();
  const first = await publish(store, id(2), "A", 1);
  await publish(store, id(3), "B");
  const retry = await publish(store, id(2), "A", 1);
  assert.deepEqual(retry, { answer: first.answer, replayed: true });
  assert.deepEqual(first.answer, { promptId, version: 1 });
  assert.equal((await store.readStream(promptStreamId(promptId))).length, 3);
});
