import { Action, ActionPanel, Clipboard, Icon, List, showToast, Toast, confirmAlert, Alert } from "@raycast/api";
import { deleteSnippet, getSnippets, Snippet } from "./storage";
import { useEffect, useState } from "react";

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  async function load() {
    setIsLoading(true);
    setSnippets(await getSnippets());
    setIsLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search snippets by name, keyword, tag, or text…">
      {snippets.length === 0 ? (
        <List.EmptyView icon={Icon.Text} title="No snippets yet" description="Create your first FlowDesk snippet from Raycast." />
      ) : (
        snippets.map((snippet) => <SnippetItem key={snippet.id} snippet={snippet} reload={load} />)
      )}
    </List>
  );
}

function SnippetItem({ snippet, reload }: { snippet: Snippet; reload: () => Promise<void> }) {
  return (
    <List.Item
      icon={Icon.Text}
      title={snippet.name}
      subtitle={snippet.keyword || snippet.text.slice(0, 90)}
      keywords={[snippet.keyword || "", ...snippet.tags, snippet.text]}
      accessories={[{ text: snippet.tags.join(", ") || "Snippet" }]}
      actions={
        <ActionPanel>
          <Action.Paste title="Paste Snippet" content={snippet.text} />
          <Action.CopyToClipboard title="Copy Snippet" content={snippet.text} />
          <Action
            icon={Icon.Clipboard}
            title="Copy Keyword"
            shortcut={{ modifiers: ["cmd"], key: "k" }}
            onAction={async () => {
              await Clipboard.copy(snippet.keyword || snippet.name);
              await showToast({ style: Toast.Style.Success, title: "Copied keyword" });
            }}
          />
          <Action
            icon={Icon.Trash}
            title="Delete Snippet"
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["ctrl"], key: "x" }}
            onAction={async () => {
              const confirmed = await confirmAlert({
                title: "Delete snippet?",
                message: snippet.name,
                primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
              });
              if (!confirmed) return;
              await deleteSnippet(snippet.id);
              await reload();
            }}
          />
        </ActionPanel>
      }
    />
  );
}
