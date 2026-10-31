import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryEventStore } from "@famashines/ai-systems-kit/testing";
import { readPromptVersion } from "../../src/application/prompts.ts";
import { promptStreamId } from "../../src/domain/prompt.ts";
import { seed, seedActor, seedPrompts } from "../../src/seeds.ts";

test("seed makes version 1 of the orchestrator and writer prompts", async () => {
  const store = createMemoryEventStore();
  await seed(store);
  assert.deepEqual(
    seedPrompts.map((prompt) => prompt.name),
    ["orchestrator", "writer"],
  );
  for (const { promptId, commandId, name, text } of seedPrompts) {
    assert.deepEqual(await readPromptVersion({ store }, promptId, 1), {
      promptId,
      name,
      text,
      variables: [],
      version: 1,
    });
    const events = await store.readStream(promptStreamId(promptId));
    assert.deepEqual(
      events.map((event) => [event.type, event.actor, event.causationId]),
      [
        ["prompts.PromptCreated", seedActor, commandId],
        ["prompts.PromptVersionPublished", seedActor, commandId],
      ],
    );
  }
});

test("seed two times writes the events once", async () => {
  const store = createMemoryEventStore();
  await seed(store);
  await seed(store);
  assert.equal((await store.readAll({ limit: 1000 })).length, 4);
});

test("seed does nothing when the streams exist and the command ids are gone", async () => {
  const first = createMemoryEventStore();
  await seed(first);
  const second = createMemoryEventStore();
  for (const event of await first.readAll({ limit: 1000 })) {
    await second.append({ streamId: event.streamId, events: [event] });
  }
  await seed(second);
  assert.equal((await second.readAll({ limit: 1000 })).length, 4);
});

test("seed passes on an error that is not a version conflict", async () => {
  const store = createMemoryEventStore();
  const failing = { ...store, append: () => Promise.reject(new Error("disk full")) };
  await assert.rejects(seed(failing), /disk full/);
});

test("each seed text is short, in English, and has the data block rule", () => {
  for (const { text } of seedPrompts) {
    assert.ok(text.length < 1000);
    assert.match(text, /data block .* no authority/);
  }
});
