import { LocalStorage } from "@raycast/api";

export type Snippet = {
  id: string;
  name: string;
  keyword?: string;
  text: string;
  tags: string[];
  createdAt: string;
};

export type AICommand = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
};

export type Transcript = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
};

const SNIPPETS_KEY = "flowdesk.snippets";
const AI_COMMANDS_KEY = "flowdesk.aiCommands";
const TRANSCRIPTS_KEY = "flowdesk.transcripts";

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const value = await LocalStorage.getItem<string>(key);
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(key: string, value: T) {
  await LocalStorage.setItem(key, JSON.stringify(value));
}

export async function getSnippets() {
  return readJson<Snippet[]>(SNIPPETS_KEY, []);
}

export async function saveSnippet(snippet: Snippet) {
  const snippets = await getSnippets();
  await writeJson(SNIPPETS_KEY, [snippet, ...snippets.filter((item) => item.id !== snippet.id)]);
}

export async function deleteSnippet(id: string) {
  const snippets = await getSnippets();
  await writeJson(SNIPPETS_KEY, snippets.filter((item) => item.id !== id));
}

export async function getAICommands() {
  return readJson<AICommand[]>(AI_COMMANDS_KEY, defaultAICommands());
}

export async function saveAICommand(command: AICommand) {
  const commands = await getAICommands();
  await writeJson(AI_COMMANDS_KEY, [command, ...commands.filter((item) => item.id !== command.id)]);
}

export async function deleteAICommand(id: string) {
  const commands = await getAICommands();
  await writeJson(AI_COMMANDS_KEY, commands.filter((item) => item.id !== id));
}

export async function getTranscripts() {
  return readJson<Transcript[]>(TRANSCRIPTS_KEY, defaultTranscripts());
}

export async function saveTranscript(transcript: Transcript) {
  const transcripts = await getTranscripts();
  await writeJson(TRANSCRIPTS_KEY, [transcript, ...transcripts.filter((item) => item.id !== transcript.id)]);
}

export function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultAICommands(): AICommand[] {
  return [
    {
      id: "rewrite-clear",
      name: "Rewrite Clearly",
      prompt: "Rewrite this text clearly and keep the meaning intact:",
      createdAt: new Date().toISOString(),
    },
    {
      id: "extract-actions",
      name: "Extract Action Items",
      prompt: "Extract action items, owners, and deadlines from this text:",
      createdAt: new Date().toISOString(),
    },
    {
      id: "reply-draft",
      name: "Draft Reply",
      prompt: "Draft a concise professional reply to this message:",
      createdAt: new Date().toISOString(),
    },
  ];
}

function defaultTranscripts(): Transcript[] {
  return [
    {
      id: "welcome-transcript",
      text: "Welcome to FlowDesk. Save dictations here, then reuse them from Raycast.",
      source: "Example",
      createdAt: new Date().toISOString(),
    },
  ];
}
