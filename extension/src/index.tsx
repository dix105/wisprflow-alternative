import { Action, ActionPanel, Icon, List, showToast, Toast, Clipboard } from "@raycast/api";
import { getAICommands, getSnippets, getTranscripts } from "./storage";
import { useEffect, useMemo, useState } from "react";

type CommandItem = {
  id: string;
  title: string;
  subtitle: string;
  icon: Icon;
  target: string;
  keywords: string[];
};

const builtInCommands: CommandItem[] = [
  {
    id: "create-snippet",
    title: "Create Snippet",
    subtitle: "Save reusable text with keyword and tags",
    icon: Icon.Text,
    target: "raycast://extensions/dix105/flowdesk-raycast/create-snippet",
    keywords: ["snippet", "text", "keyword"],
  },
  {
    id: "search-snippets",
    title: "Search Snippets",
    subtitle: "Find, copy, and paste saved text",
    icon: Icon.MagnifyingGlass,
    target: "raycast://extensions/dix105/flowdesk-raycast/search-snippets",
    keywords: ["snippet", "paste", "copy"],
  },
  {
    id: "create-ai-command",
    title: "Create AI Command",
    subtitle: "Save a prompt as a reusable command",
    icon: Icon.Wand,
    target: "raycast://extensions/dix105/flowdesk-raycast/create-ai-command",
    keywords: ["ai", "prompt", "automation"],
  },
  {
    id: "run-ai-command",
    title: "Run AI Command",
    subtitle: "Run prompts on clipboard or selected text",
    icon: Icon.Stars,
    target: "raycast://extensions/dix105/flowdesk-raycast/run-ai-command",
    keywords: ["ai", "rewrite", "summarize"],
  },
  {
    id: "transcript-memory",
    title: "Transcript Memory",
    subtitle: "Search and reuse dictation history",
    icon: Icon.Microphone,
    target: "raycast://extensions/dix105/flowdesk-raycast/transcript-memory",
    keywords: ["dictation", "transcript", "history"],
  },
];

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [snippetCount, setSnippetCount] = useState(0);
  const [aiCommandCount, setAICommandCount] = useState(0);
  const [transcriptCount, setTranscriptCount] = useState(0);

  useEffect(() => {
    async function load() {
      const [snippets, aiCommands, transcripts] = await Promise.all([getSnippets(), getAICommands(), getTranscripts()]);
      setSnippetCount(snippets.length);
      setAICommandCount(aiCommands.length);
      setTranscriptCount(transcripts.length);
      setIsLoading(false);
    }
    load();
  }, []);

  const commands = useMemo(() => {
    return builtInCommands.map((command) => {
      if (command.id === "search-snippets") return { ...command, subtitle: `${snippetCount} snippets saved` };
      if (command.id === "run-ai-command") return { ...command, subtitle: `${aiCommandCount} AI commands ready` };
      if (command.id === "transcript-memory") return { ...command, subtitle: `${transcriptCount} transcripts indexed` };
      return command;
    });
  }, [snippetCount, aiCommandCount, transcriptCount]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search FlowDesk commands, snippets, AI workflows…">
      <List.Section title="Command Center" subtitle="Standalone Raycast extension">
        {commands.map((command) => (
          <List.Item
            key={command.id}
            icon={command.icon}
            title={command.title}
            subtitle={command.subtitle}
            keywords={command.keywords}
            accessories={[{ text: "FlowDesk" }]}
            actions={
              <ActionPanel>
                <Action.Open title="Open Command" target={command.target} />
                <Action.CopyToClipboard title="Copy Command Name" content={command.title} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="Quick Capture">
        <List.Item
          icon={Icon.Clipboard}
          title="Save Clipboard as Transcript"
          subtitle="Temporary capture until real dictation API is connected"
          actions={
            <ActionPanel>
              <Action
                title="Copy Clipboard Reminder"
                onAction={async () => {
                  const text = await Clipboard.readText();
                  await showToast({ style: Toast.Style.Success, title: text ? "Clipboard ready" : "Clipboard is empty" });
                }}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
