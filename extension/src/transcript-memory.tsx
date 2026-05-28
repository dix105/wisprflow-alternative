import { Action, ActionPanel, Clipboard, Form, Icon, List, showToast, Toast } from "@raycast/api";
import { getTranscripts, makeId, saveTranscript, Transcript } from "./storage";
import { useEffect, useState } from "react";

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);

  async function load() {
    setIsLoading(true);
    setTranscripts(await getTranscripts());
    setIsLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search transcript memory…">
      <List.Section title="Capture">
        <List.Item
          icon={Icon.Plus}
          title="Save Clipboard as Transcript"
          subtitle="Use this until direct Raycast dictation capture is connected"
          actions={
            <ActionPanel>
              <Action.Push title="Save Clipboard" target={<SaveClipboardTranscript reload={load} />} />
            </ActionPanel>
          }
        />
      </List.Section>
      <List.Section title="Transcripts">
        {transcripts.map((transcript) => (
          <List.Item
            key={transcript.id}
            icon={Icon.Microphone}
            title={transcript.text.slice(0, 80)}
            subtitle={transcript.source}
            accessories={[{ date: new Date(transcript.createdAt) }]}
            keywords={[transcript.text, transcript.source]}
            actions={
              <ActionPanel>
                <Action.Paste title="Paste Transcript" content={transcript.text} />
                <Action.CopyToClipboard title="Copy Transcript" content={transcript.text} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function SaveClipboardTranscript({ reload }: { reload: () => Promise<void> }) {
  const [text, setText] = useState("");

  useEffect(() => {
    Clipboard.readText().then((value) => setText(value || ""));
  }, []);

  async function handleSubmit(values: { source?: string; text: string }) {
    if (!values.text.trim()) {
      await showToast({ style: Toast.Style.Failure, title: "Transcript text is required" });
      return;
    }
    await saveTranscript({
      id: makeId(),
      source: values.source?.trim() || "Clipboard",
      text: values.text.trim(),
      createdAt: new Date().toISOString(),
    });
    await reload();
    await showToast({ style: Toast.Style.Success, title: "Transcript saved" });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Transcript" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="source" title="Source" defaultValue="Clipboard" />
      <Form.TextArea id="text" title="Text" defaultValue={text} />
    </Form>
  );
}
