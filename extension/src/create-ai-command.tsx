import { Action, ActionPanel, Form, Icon, showToast, Toast, popToRoot } from "@raycast/api";
import { makeId, saveAICommand } from "./storage";

type Values = {
  name: string;
  prompt: string;
};

export default function Command() {
  async function handleSubmit(values: Values) {
    if (!values.name.trim() || !values.prompt.trim()) {
      await showToast({ style: Toast.Style.Failure, title: "Name and prompt are required" });
      return;
    }

    await saveAICommand({
      id: makeId(),
      name: values.name.trim(),
      prompt: values.prompt.trim(),
      createdAt: new Date().toISOString(),
    });

    await showToast({ style: Toast.Style.Success, title: "AI command saved" });
    await popToRoot();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Wand} title="Save AI Command" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="Summarize Clipboard" />
      <Form.TextArea id="prompt" title="Prompt" placeholder="Summarize this text into concise bullets:" />
    </Form>
  );
}
