import { Action, ActionPanel, Clipboard, Detail, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";

type Preferences = {
  groqApiKey?: string;
};

export default function Command() {
  const [markdown, setMarkdown] = useState("Polishing clipboard text…");

  useEffect(() => {
    async function run() {
      const input = (await Clipboard.readText()) || "";
      if (!input.trim()) {
        setMarkdown("## Clipboard is empty\n\nCopy text first, then run **Polish Clipboard Text** again.");
        return;
      }

      const { groqApiKey } = getPreferenceValues<Preferences>();
      if (!groqApiKey) {
        setMarkdown(`## Add Groq API key\n\nFlowDesk needs a Groq API key in Raycast preferences to polish clipboard text.\n\n### Clipboard preview\n\n${input}`);
        return;
      }

      try {
        const result = await polishWithGroq(groqApiKey, input);
        setMarkdown(result);
      } catch (error) {
        await showToast({ style: Toast.Style.Failure, title: "Polish failed", message: String(error) });
        setMarkdown(`## Polish failed\n\n\`${String(error)}\``);
      }
    }
    run();
  }, []);

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Result" content={markdown} />
          <Action.Paste title="Paste Result" content={markdown} />
        </ActionPanel>
      }
    />
  );
}

async function polishWithGroq(apiKey: string, input: string) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "Rewrite dictated text clearly. Preserve meaning. Return only the polished text." },
        { role: "user", content: input },
      ],
    }),
  });

  if (!response.ok) throw new Error(`Groq error ${response.status}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || "No polished text returned.";
}
