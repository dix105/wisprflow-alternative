import { Action, ActionPanel, Clipboard, Detail, Form, getPreferenceValues, Icon, showToast, Toast } from "@raycast/api";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { useState } from "react";
import { applyCorrections, buildVocabularyPrompt, getGlossary, makeId, saveTranscript } from "./storage";

type Preferences = {
  groqApiKey?: string;
};

type Values = {
  audio: string[];
  saveToMemory: boolean;
};

export default function Command() {
  const [result, setResult] = useState("");

  async function handleSubmit(values: Values) {
    const audioPath = values.audio?.[0];
    if (!audioPath) {
      await showToast({ style: Toast.Style.Failure, title: "Choose an audio file" });
      return;
    }

    const { groqApiKey } = getPreferenceValues<Preferences>();
    if (!groqApiKey) {
      await showToast({ style: Toast.Style.Failure, title: "Add Groq API key in preferences" });
      return;
    }

    await showToast({ style: Toast.Style.Animated, title: "Transcribing audio…" });
    const glossary = await getGlossary();
    const rawText = await transcribeWithGroq(groqApiKey, audioPath, buildVocabularyPrompt(glossary));
    const text = applyCorrections(rawText, glossary.corrections);

    if (values.saveToMemory) {
      await saveTranscript({ id: makeId(), text, source: basename(audioPath), createdAt: new Date().toISOString() });
    }

    setResult(text || "No text returned.");
    await showToast({ style: Toast.Style.Success, title: "Transcription ready" });
  }

  if (result) {
    return (
      <Detail
        markdown={result}
        actions={
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Transcript" content={result} />
            <Action.Paste title="Paste Transcript" content={result} />
            <Action title="Copy and Clear" icon={Icon.Clipboard} onAction={async () => { await Clipboard.copy(result); setResult(""); }} />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Microphone} title="Transcribe Audio" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker id="audio" title="Audio File" allowMultipleSelection={false} />
      <Form.Checkbox id="saveToMemory" title="Transcript Memory" label="Save result to transcript memory" defaultValue />
      <Form.Description text="Uses Groq Whisper with your FlowDesk Words Glossary and auto-corrections." />
    </Form>
  );
}

async function transcribeWithGroq(apiKey: string, audioPath: string, prompt: string) {
  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(audioPath));
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");
  if (prompt) form.append("prompt", prompt.slice(0, 900));

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) throw new Error(`Groq transcription error ${response.status}`);
  const data = (await response.json()) as { text?: string };
  return data.text?.trim() || "";
}
