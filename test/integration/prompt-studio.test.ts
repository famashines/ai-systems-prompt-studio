import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { loadConfig } from "@famashines/ai-systems-kit/config";
import { connectNats, type Nats } from "@famashines/ai-systems-kit/messaging";
import { connectMongo, type Mongo } from "@famashines/ai-systems-kit/mongo";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import {
  createStreams,
  startMongo,
  startNats,
  waitFor,
  type Started,
} from "@famashines/ai-systems-kit/testing";
import { envSchema, start } from "../../src/main.ts";
import { seedPrompts } from "../../src/seeds.ts";

const promptStudioGrants = [
  "prompts.>",
  "dlq.prompt-studio.>",
  "$JS.API.INFO",
  "$JS.API.STREAM.INFO.PROMPTS",
];

const adminGrants = [
  "$JS.API.>",
  "$JS.ACK.>",
  "orchestration.>",
  "conversation.>",
  "llm.>",
  "budget.>",
  "agents.>",
  "prompts.>",
  "dlq.>",
];

const list = (subjects: string[]): string => subjects.map((s) => `"${s}"`).join(", ");

const natsConfig = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      {
        user: ai-systems-admin, password: admin
        permissions {
          publish { allow: [${list(adminGrants)}] }
          subscribe { allow: ["_INBOX_admin.>"] }
        }
      }
      {
        user: ai-systems-prompt-studio, password: prompt-studio
        permissions {
          publish { allow: [${list(promptStudioGrants)}] }
          subscribe { allow: ["_INBOX_prompt-studio.>"] }
        }
      }
    ]
  }
}
`;

const logger = createLogger({ service: "test", release: "test", level: "silent" });
const prompts = { name: "PROMPTS", subjects: ["prompts.>"] };
let mongoContainer: Started;
let natsContainer: Started;
let mongo: Mongo;
let admin: Nats;
let manager: JetStreamManager;
let running: Awaited<ReturnType<typeof start>> | undefined;
let base = "";

const startService = async (): Promise<void> => {
  const config = loadConfig(envSchema, {
    MONGODB_URI: mongoContainer.url,
    NATS_SERVERS: natsContainer.url,
    NATS_USER: "ai-systems-prompt-studio",
    NATS_PASSWORD: "prompt-studio",
    LOG_LEVEL: "silent",
  });
  running = await start({ ...config, PORT: 0 }, { drainDelayMs: 0 });
  base = `http://127.0.0.1:${String(running.address.port)}`;
  await waitFor(async () => (await fetch(`${base}/ready`)).ok);
};

const stopService = async (): Promise<void> => {
  const stopping = running;
  running = undefined;
  if (stopping) assert.equal(await stopping.app.close(), true);
};

before(async () => {
  [mongoContainer, natsContainer] = await Promise.all([
    startMongo(),
    startNats({ config: natsConfig }),
  ]);
  mongo = await connectMongo({ url: mongoContainer.url, database: "prompt_studio" });
  admin = await connectNats({
    servers: natsContainer.url,
    user: "ai-systems-admin",
    pass: "admin",
    service: "admin",
    logger,
  });
  manager = await jetstreamManager(admin.connection);
  await createStreams(admin.connection, [prompts]);
  await startService();
});

after(async () => {
  await stopService();
  await admin.close();
  await mongo.close();
  await Promise.all([mongoContainer.stop(), natsContainer.stop()]);
});

const events = () =>
  mongo.db.collection<{ _id: string; streamId: string; publishedAt: Date | null }>("events");

const owner = { kind: "owner", id: "owner-1" } as const;

const post = (path: string, body: unknown) =>
  fetch(`${base}/internal/commands/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const createPrompt = (commandId = randomUUID()) =>
  post("create-prompt", {
    commandId,
    type: "prompts.CreatePrompt",
    actor: owner,
    payload: { name: "summary" },
  });

const publish = (promptId: string, text: string, commandId = randomUUID()) =>
  post("publish-prompt-version", {
    commandId,
    type: "prompts.PublishPromptVersion",
    actor: owner,
    payload: { promptId, text, variables: [] },
  });

const streamMessages = async (eventId: string) => {
  const { state } = await manager.streams.info("PROMPTS");
  const found = [];
  for (let seq = state.first_seq; seq <= state.last_seq && state.messages > 0; seq += 1) {
    const message = await manager.streams.getMessage("PROMPTS", { seq });
    if (message?.header.get("Nats-Msg-Id") === eventId) found.push(message);
  }
  return found;
};

const published = async (eventId: string): Promise<void> => {
  await waitFor(async () => (await events().findOne({ _id: eventId }))?.publishedAt != null);
};

const seedStreams = seedPrompts.map((prompt) => `prompt-${prompt.promptId}`);

test("the service is ready after the event store and seed migrations", async () => {
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  const names = await mongo.db
    .collection<{ _id: string }>("migrations")
    .find()
    .map((migration) => migration._id)
    .toArray();
  assert.deepEqual(names.sort(), ["000-event-store", "001-seed-prompts"]);
});

test("the seed prompts are readable and in PROMPTS once", async () => {
  for (const { promptId, name, text } of seedPrompts) {
    const response = await fetch(`${base}/internal/prompts/${promptId}/versions/1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { promptId, name, text, variables: [], version: 1 });
  }
  const stored = await events()
    .find({ streamId: { $in: seedStreams } })
    .toArray();
  assert.equal(stored.length, 4);
  for (const event of stored) {
    await published(event._id);
    assert.equal((await streamMessages(event._id)).length, 1);
  }
});

test("a new prompt with two versions is in PROMPTS once each, and version 1 stays readable", async () => {
  const created = await createPrompt();
  assert.equal(created.status, 201);
  const { promptId } = (await created.json()) as { promptId: string };
  assert.equal((await publish(promptId, "First")).status, 201);
  assert.deepEqual(await (await publish(promptId, "Second")).json(), { promptId, version: 2 });
  const one = (await (await fetch(`${base}/internal/prompts/${promptId}/versions/1`)).json()) as {
    text: string;
  };
  assert.equal(one.text, "First");
  const stored = await events()
    .find({ streamId: `prompt-${promptId}` })
    .toArray();
  assert.equal(stored.length, 3);
  for (const event of stored) {
    await published(event._id);
    const [message, ...more] = await streamMessages(event._id);
    assert.equal(more.length, 0);
    assert.ok(message?.subject.startsWith("prompts.Prompt"));
  }
});

test("the same commandId twice gives one event and the same answer", async () => {
  const commandId = randomUUID();
  const first = await createPrompt(commandId);
  const second = await createPrompt(commandId);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(await events().countDocuments({ causationId: commandId }), 1);
});

test("without the stream the service stays ready and the event waits in the outbox", async () => {
  await manager.streams.delete("PROMPTS");
  const response = await createPrompt();
  assert.equal(response.status, 201);
  const { promptId } = (await response.json()) as { promptId: string };
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  const stored = await events().findOne({ streamId: `prompt-${promptId}` });
  assert.ok(stored);
  assert.equal(stored.publishedAt, null);
  await createStreams(admin.connection, [prompts]);
  await published(stored._id);
  assert.equal((await streamMessages(stored._id)).length, 1);
});

test("a restart that runs the seed again writes no new seed events", async () => {
  await stopService();
  await mongo.db.collection<{ _id: string }>("migrations").deleteOne({ _id: "001-seed-prompts" });
  await mongo.db.collection("commands").deleteMany({});
  await startService();
  assert.equal(await events().countDocuments({ streamId: { $in: seedStreams } }), 4);
});
