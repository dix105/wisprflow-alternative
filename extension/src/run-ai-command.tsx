import { Action, ActionPanel, Clipboard, Detail, getPreferenceValues, Icon, List, showToast, Toast } from "@raycast/api";
import { AICommand, getAICommands } from "./storage";
import { useEffect, useState } from "react";

type Preferences = {
  openaiApiKey?: string;
};

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [commands, setCommands] = useState<AICommand[]>([]);

  useEffect(() => {
    async function load() {
      setCommands(await getAICommands());
      setIsLoading(false);
    }
    load();
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search AI commands…">
      {commands.map((command) => (
        <List.Item
          key={command.id}
          icon={Icon.Wand}
          title={command.name}
          subtitle={command.prompt}
          actions={
            <ActionPanel>
              <Action.Push icon={Icon.Play} title="Run on Clipboard" target={<AIResult command={command} />} />
              <Action.CopyToClipboard title="Copy Prompt" content={command.prompt} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function AIResult({ command }: { command: AICommand }) {
  const [markdown, setMarkdown] = useState("Running command…");

  useEffect(() => {
    async function run() {
      const input = (await Clipboard.readText()) || "";
      const preferences = getPreferenceValues<Preferences>();
      if (!input.trim()) {
        setMarkdown(`## ${command.name}\n\nClipboard is empty. Copy text first, then run this command again.`);
        return;
      }

      if (!preferences.openaiApiKey) {
        setMarkdown(`## ${command.name}\n\n**Prompt**\n\n${command.prompt}\n\n**Input from clipboard**\n\n${input}\n\n---\n\nAdd an OpenAI API key in Raycast preferences to generate a real AI result. This preview confirms the command pipeline works.`);
        return;
      }

      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${preferences.openaiApiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a concise productivity assistant inside Raycast." },
              { role: "user", content: `${command.prompt}\n\n${input}` },
            ],
          }),
        });

        if (!response.ok) throw new Error(`OpenAI error ${response.status}`);
        const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        setMarkdown(data.choices?.[0]?.message?.content || "No output returned.");
      } catch (error) {
        await showToast({ style: Toast.Style.Failure, title: "AI command failed", message: String(error) });
        setMarkdown(`## ${command.name}\n\nAI request failed.\n\n\`${String(error)}\``);
      }
    }
    run();
  }, [command]);

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Result" content={markdown} />
        </ActionPanel>
      }
    />
  );
}
