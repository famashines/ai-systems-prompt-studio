import type {
  PromptCreatedEventPayloadV1,
  PromptVersionPublishedEventPayloadV1,
  PromptVersionResultV1,
} from "@famashines/ai-systems-contracts";

export interface CreatePrompt {
  type: "CreatePrompt";
  promptId: string;
  name: string;
}

export interface PublishPromptVersion {
  type: "PublishPromptVersion";
  promptId: string;
  text: string;
  variables: string[];
}

export type PromptCommand = CreatePrompt | PublishPromptVersion;

export interface PromptCreated {
  type: "prompts.PromptCreated";
  schemaVersion: 1;
  payload: PromptCreatedEventPayloadV1;
}

export interface PromptVersionPublished {
  type: "prompts.PromptVersionPublished";
  schemaVersion: 1;
  payload: PromptVersionPublishedEventPayloadV1;
}

export type PromptEvent = PromptCreated | PromptVersionPublished;

export type PromptState =
  | { status: "new" }
  | { status: "created"; promptId: string; name: string; versions: PromptVersionResultV1[] };

export class PromptExistsError extends Error {
  constructor() {
    super("The prompt exists");
    this.name = "PromptExistsError";
  }
}

export class PromptNotFoundError extends Error {
  constructor() {
    super("The prompt does not exist");
    this.name = "PromptNotFoundError";
  }
}

export class PromptVersionNotFoundError extends Error {
  constructor() {
    super("The prompt version does not exist");
    this.name = "PromptVersionNotFoundError";
  }
}

export const initialState: PromptState = { status: "new" };

export const promptStreamId = (promptId: string): string => `prompt-${promptId}`;

export function decide(state: PromptState, command: PromptCommand): PromptEvent[] {
  if (command.type === "CreatePrompt") {
    if (state.status !== "new") throw new PromptExistsError();
    const { promptId, name } = command;
    return [{ type: "prompts.PromptCreated", schemaVersion: 1, payload: { promptId, name } }];
  }
  if (state.status === "new") throw new PromptNotFoundError();
  const { promptId, text, variables } = command;
  return [
    {
      type: "prompts.PromptVersionPublished",
      schemaVersion: 1,
      payload: { promptId, text, variables, version: state.versions.length + 1 },
    },
  ];
}

export function evolve(state: PromptState, event: PromptEvent): PromptState {
  switch (event.type) {
    case "prompts.PromptCreated":
      return { status: "created", ...event.payload, versions: [] };
    case "prompts.PromptVersionPublished":
      if (state.status === "new") throw new Error("A version came before the prompt");
      return { ...state, versions: [...state.versions, { ...event.payload, name: state.name }] };
    default:
      throw new Error("Unknown event type");
  }
}

export const isPromptEvent = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: PromptEvent["type"] }> =>
  event.type === "prompts.PromptCreated" || event.type === "prompts.PromptVersionPublished";

export function versionOf(state: PromptState, version: number): PromptVersionResultV1 {
  if (state.status === "new") throw new PromptNotFoundError();
  const found = state.versions[version - 1];
  if (!found) throw new PromptVersionNotFoundError();
  return found;
}
