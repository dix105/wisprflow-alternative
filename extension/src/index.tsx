import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { getGlossary, getTranscripts } from "./storage";
import { useEffect, useMemo, useState } from "react";

type CommandItem = {
  id: string;
  title: string;
  subtitle: string;
  icon: Icon;
  target: string;
  keywords: string[];
};

const commands: CommandItem[] = [
  {
    id: "transcribe-audio",
    title: "Transcribe Audio File",
    subtitle: "Whisper transcription with FlowDesk glossary corrections",
    icon: Icon.Microphone,
    target: "raycast://extensions/dix105/flowdesk-raycast/transcribe-audio",
    keywords: ["dictation", "audio", "whisper", "speech"],
  },
  {
    id: "words-glossary",
    title: "Words Glossary",
    subtitle: "Preferred spellings and correction rules",
    icon: Icon.TextCursor,
    target: "raycast://extensions/dix105/flowdesk-raycast/words-glossary",
    keywords: ["words", "glossary", "corrections"],
  },
  {
    id: "polish-clipboard",
    title: "Polish Clipboard Text",
    subtitle: "Rewrite copied text into clean FlowDesk output",
    icon: Icon.Wand,
    target: "raycast://extensions/dix105/flowdesk-raycast/polish-clipboard",
    keywords: ["polish", "rewrite", "clipboard"],
  },
  {
    id: "transcript-memory",
    title: "Transcript Memory",
    subtitle: "Search and reuse saved dictations",
    icon: Icon.Clock,
    target: "raycast://extensions/dix105/flowdesk-raycast/transcript-memory",
    keywords: ["history", "transcript", "dictation"],
  },
];

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [transcriptCount, setTranscriptCount] = useState(0);
  const [wordCount, setWordCount] = useState(0);

  useEffect(() => {
    async function load() {
      const [glossary, transcripts] = await Promise.all([getGlossary(), getTranscripts()]);
      setTranscriptCount(transcripts.length);
      setWordCount(glossary.preferredWords.split(/[\n,]/).filter((word) => word.trim()).length);
      setIsLoading(false);
    }
    load();
  }, []);

  const displayCommands = useMemo(() => {
    return commands.map((command) => {
      if (command.id === "words-glossary") return { ...command, subtitle: `${wordCount} preferred words configured` };
      if (command.id === "transcript-memory") return { ...command, subtitle: `${transcriptCount} transcripts saved` };
      return command;
    });
  }, [transcriptCount, wordCount]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search FlowDesk dictation commands…">
      <List.Section title="FlowDesk">
        {displayCommands.map((command) => (
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
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
