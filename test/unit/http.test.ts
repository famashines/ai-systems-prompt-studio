import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { JwtVerifier } from "@famashines/ai-systems-kit/auth";
import { createService, ForbiddenError, UnauthorizedError } from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { createMemoryEventStore, fakeClock, fakeIds } from "@famashines/ai-systems-kit/testing";
import { commandsNeedOwner, routes } from "../../src/adapters/http.ts";

const clock = fakeClock();
const store = createMemoryEventStore({ now: clock.now, newId: fakeIds(1) });
const promptIds = fakeIds(2);
let nextPromptId = promptIds;
const tokens: Record<string, JwtVerifier> = {
  owner: () => Promise.resolve({ sub: "owner-1", roles: ["owner"], exp: 0 }),
  guest: () => Promise.reject(new ForbiddenError("The role is missing")),
};
const verify: JwtVerifier = (token) =>
  (tokens[token] ?? (() => Promise.reject(new UnauthorizedError())))(token);
const app = createService({
  logger: createLogger({ service: "prompt-studio", release: "test", level: "silent" }),
  before: [commandsNeedOwner(verify)],
  routes: routes({ store, newId: () => nextPromptId() }),
  drainDelayMs: 0,
});
let base: string;

before(async () => {
  const { port } = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await app.close();
});

const commandIds = fakeIds(3);
const owner = { kind: "owner", id: "owner-1" } as const;
const missingId = "00000000-0000-4000-8000-0000000000ff";

const post = (path: string, body: unknown, authorization: string | null = "Bearer owner") =>
  fetch(`${base}/internal/commands/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });

const createEnvelope = (overrides: Record<string, unknown> = {}) => ({
  commandId: commandIds(),
  type: "prompts.CreatePrompt",
  actor: owner,
  payload: { name: "writer" },
  ...overrides,
});

const publishEnvelope = (promptId: string, overrides: Record<string, unknown> = {}) => ({
  commandId: commandIds(),
  type: "prompts.PublishPromptVersion",
  actor: owner,
  payload: { promptId, text: "Answer the owner.", variables: [] },
  ...overrides,
});

const newPrompt = async (): Promise<string> => {
  const response = await post("create-prompt", createEnvelope());
  assert.equal(response.status, 201);
  return ((await response.json()) as { promptId: string }).promptId;
};

const read = (promptId: string, version: string) =>
  fetch(`${base}/internal/prompts/${promptId}/versions/${version}`);

const problemCode = async (response: Response): Promise<string> => {
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  return ((await response.json()) as { code: string }).code;
};

test("no token or a bad token gives 401, no owner role gives 403, on each command", async () => {
  const promptId = await newPrompt();
  const count = (await store.readAll({ limit: 1000 })).length;
  for (const [path, body] of [
    ["create-prompt", createEnvelope({ payload: { name: "guarded" } })],
    ["publish-prompt-version", publishEnvelope(promptId)],
    ["unknown", {}],
  ] as const) {
    for (const authorization of [null, "Bearer bad", "Basic YTpi"]) {
      const response = await post(path, body, authorization);
      assert.equal(response.status, 401, `${path} ${String(authorization)}`);
      assert.equal(await problemCode(response), "unauthorized");
    }
    const response = await post(path, body, "Bearer guest");
    assert.equal(response.status, 403, path);
    assert.equal(await problemCode(response), "forbidden");
  }
  assert.equal((await store.readAll({ limit: 1000 })).length, count);
});

test("an actor that is not the subject of the token gives 403 on each command", async () => {
  const promptId = await newPrompt();
  const count = (await store.readAll({ limit: 1000 })).length;
  const other = { actor: { kind: "owner", id: "owner-2" } };
  for (const [path, body] of [
    ["create-prompt", createEnvelope({ ...other, payload: { name: "other" } })],
    ["publish-prompt-version", publishEnvelope(promptId, other)],
  ] as const) {
    const response = await post(path, body);
    assert.equal(response.status, 403, path);
    assert.equal(await problemCode(response), "forbidden");
  }
  assert.equal((await store.readAll({ limit: 1000 })).length, count);
});

test("the read and replay routes, health and ready need no token", async () => {
  const promptId = await newPrompt();
  assert.equal((await post("publish-prompt-version", publishEnvelope(promptId))).status, 201);
  assert.equal((await read(promptId, "1")).status, 200);
  for (const path of ["/internal/events", "/health", "/ready"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
});

test("CreatePrompt gives 201 with the prompt id, and appends PromptCreated", async () => {
  const command = createEnvelope();
  const response = await post("create-prompt", command);
  assert.equal(response.status, 201);
  const { promptId } = (await response.json()) as { promptId: string };
  const stream = await store.readStream(`prompt-${promptId}`);
  assert.deepEqual(stream, [
    {
      eventId: stream[0]?.eventId,
      type: "prompts.PromptCreated",
      schemaVersion: 1,
      streamId: `prompt-${promptId}`,
      version: 1,
      occurredAt: clock.now().toISOString(),
      correlationId: command.commandId,
      causationId: command.commandId,
      actor: owner,
      payload: { promptId, name: "writer" },
      position: stream[0]?.position,
    },
  ]);
});

test("the same CreatePrompt commandId gives 200 with the same answer and no second event", async () => {
  const command = createEnvelope();
  const first = await post("create-prompt", command);
  const count = (await store.readAll({ limit: 1000 })).length;
  const second = await post("create-prompt", command);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal((await store.readAll({ limit: 1000 })).length, count);
});

test("CreatePrompt on an existing stream gives 409", async () => {
  const promptId = promptIds();
  nextPromptId = () => promptId;
  assert.equal((await post("create-prompt", createEnvelope())).status, 201);
  const response = await post("create-prompt", createEnvelope());
  nextPromptId = promptIds;
  assert.equal(response.status, 409);
  assert.equal(await problemCode(response), "conflict");
});

test("PublishPromptVersion gives versions 1 and 2, and version 1 stays readable", async () => {
  const promptId = await newPrompt();
  const first = await post(
    "publish-prompt-version",
    publishEnvelope(promptId, {
      payload: { promptId, text: "Hello {{name}}", variables: ["name"] },
    }),
  );
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { promptId, version: 1 });
  const second = await post("publish-prompt-version", publishEnvelope(promptId));
  assert.deepEqual(await second.json(), { promptId, version: 2 });
  const one = await read(promptId, "1");
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), {
    promptId,
    name: "writer",
    text: "Hello {{name}}",
    variables: ["name"],
    version: 1,
  });
  assert.equal(
    ((await (await read(promptId, "2")).json()) as { text: string }).text,
    "Answer the owner.",
  );
});

test("the same PublishPromptVersion commandId gives 200 and no new version", async () => {
  const promptId = await newPrompt();
  const command = publishEnvelope(promptId);
  assert.equal((await post("publish-prompt-version", command)).status, 201);
  const replay = await post("publish-prompt-version", command);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { promptId, version: 1 });
  assert.equal((await read(promptId, "2")).status, 404);
});

test("PublishPromptVersion with an old expectedVersion gives 409", async () => {
  const promptId = await newPrompt();
  assert.equal((await post("publish-prompt-version", publishEnvelope(promptId))).status, 201);
  const stale = await post(
    "publish-prompt-version",
    publishEnvelope(promptId, { expectedVersion: 1 }),
  );
  assert.equal(stale.status, 409);
  const current = await post(
    "publish-prompt-version",
    publishEnvelope(promptId, { expectedVersion: 2 }),
  );
  assert.deepEqual(await current.json(), { promptId, version: 2 });
});

test("PublishPromptVersion for a missing prompt gives 404", async () => {
  const response = await post("publish-prompt-version", publishEnvelope(missingId));
  assert.equal(response.status, 404);
  assert.equal(await problemCode(response), "not_found");
});

test("the read gives 404 for a missing prompt and a missing version", async () => {
  assert.equal(await problemCode(await read(missingId, "1")), "not_found");
  const promptId = await newPrompt();
  const response = await read(promptId, "1");
  assert.equal(response.status, 404);
  assert.equal(await problemCode(response), "not_found");
});

for (const [name, promptId, version] of [
  ["version 0", missingId, "0"],
  ["a negative version", missingId, "-1"],
  ["a decimal version", missingId, "1.5"],
  ["a leading zero", missingId, "01"],
  ["a version that is too large", missingId, "1234567890"],
  ["a bad prompt id", "not-a-uuid", "1"],
] as const) {
  test(`the read with ${name} gives 400`, async () => {
    assert.equal((await read(promptId, version)).status, 400);
  });
}

for (const [name, path, body, issue] of [
  ["no name", "create-prompt", createEnvelope({ payload: {} }), "body.payload.name"],
  ["a bad type", "create-prompt", createEnvelope({ type: "prompts.Other" }), "body.type"],
  [
    "an expectedVersion that is not 0",
    "create-prompt",
    createEnvelope({ expectedVersion: 1 }),
    "body.expectedVersion",
  ],
  [
    "a system actor",
    "create-prompt",
    createEnvelope({ actor: { kind: "system", id: "x" } }),
    "body.actor.kind",
  ],
  ["a bad commandId", "create-prompt", createEnvelope({ commandId: "x" }), "body.commandId"],
  [
    "a blank text",
    "publish-prompt-version",
    publishEnvelope(missingId, { payload: { promptId: missingId, text: "  ", variables: [] } }),
    "body.payload.text",
  ],
  [
    "a repeated variable",
    "publish-prompt-version",
    publishEnvelope(missingId, {
      payload: { promptId: missingId, text: "a", variables: ["x", "x"] },
    }),
    "body.payload.variables",
  ],
  [
    "an agent actor",
    "publish-prompt-version",
    publishEnvelope(missingId, { actor: { kind: "agent", id: "a" } }),
    "body.actor.kind",
  ],
] as const) {
  test(`a command with ${name} gives 400 problem JSON`, async () => {
    const response = await post(path, body);
    assert.equal(response.status, 400);
    const problem = (await response.json()) as { code: string; errors: { path: string }[] };
    assert.equal(problem.code, "validation_failed");
    assert.ok(problem.errors.some((item) => item.path === issue));
  });
}

test("the replay API gives events in position order, in pages", async () => {
  const all = (await (await fetch(`${base}/internal/events?limit=1000`)).json()) as {
    events: { position: number }[];
  };
  assert.ok(all.events.length >= 3);
  assert.deepEqual(
    all.events.map((event) => event.position),
    all.events.map((_, index) => index + 1),
  );
  const page = (await (await fetch(`${base}/internal/events?afterPosition=1&limit=2`)).json()) as {
    events: unknown[];
  };
  assert.deepEqual(page.events, all.events.slice(1, 3));
  assert.equal((await fetch(`${base}/internal/events?limit=1001`)).status, 400);
});
