import { LocalStorage } from "@raycast/api";

export type GlossarySettings = {
  preferredWords: string;
  corrections: string;
};

export type Transcript = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
};

const GLOSSARY_KEY = "flowdesk.glossary";
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

export async function getGlossary(): Promise<GlossarySettings> {
  return readJson<GlossarySettings>(GLOSSARY_KEY, {
    preferredWords: "Dixit\nFlowDesk\nOpenClaw\nAmpere\nMaxStudio\nChromaStudio\nRemix AI",
    corrections: "whisper flow => WisprFlow\nopen claw => OpenClaw\nflow desk => FlowDesk",
  });
}

export async function saveGlossary(settings: GlossarySettings) {
  await writeJson(GLOSSARY_KEY, settings);
}

export async function getTranscripts() {
  return readJson<Transcript[]>(TRANSCRIPTS_KEY, []);
}

export async function saveTranscript(transcript: Transcript) {
  const transcripts = await getTranscripts();
  await writeJson(TRANSCRIPTS_KEY, [transcript, ...transcripts.filter((item) => item.id !== transcript.id)]);
}

export async function deleteTranscript(id: string) {
  const transcripts = await getTranscripts();
  await writeJson(TRANSCRIPTS_KEY, transcripts.filter((item) => item.id !== id));
}

export function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildVocabularyPrompt(settings: GlossarySettings) {
  const words = settings.preferredWords
    .split(/[\n,]/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 80)
    .join(", ");

  if (!words) return "";
  return `This is desktop dictation. Use these preferred spellings and common terms when heard: ${words}. Preserve capitalization and exact spelling for these terms.`;
}

export function applyCorrections(text: string, corrections: string) {
  let output = text;
  for (const line of corrections.split("\n")) {
    const match = line.trim().match(/^(.*?)\s*(?:=>|->|=)\s*(.*?)$/);
    if (!match) continue;
    const from = match[1].trim();
    const to = match[2].trim();
    if (!from || !to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    output = output.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), to);
  }
  return output.replace(/\s+/g, " ").trim();
}
