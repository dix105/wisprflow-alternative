import { Action, ActionPanel, Form, Icon, showToast, Toast, popToRoot } from "@raycast/api";
import { makeId, saveSnippet } from "./storage";

type Values = {
  name: string;
  keyword?: string;
  tags?: string;
  text: string;
};

export default function Command() {
  async function handleSubmit(values: Values) {
    if (!values.name.trim() || !values.text.trim()) {
      await showToast({ style: Toast.Style.Failure, title: "Name and text are required" });
      return;
    }

    await saveSnippet({
      id: makeId(),
      name: values.name.trim(),
      keyword: values.keyword?.trim(),
      text: values.text,
      tags: (values.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      createdAt: new Date().toISOString(),
    });

    await showToast({ style: Toast.Style.Success, title: "Snippet saved" });
    await popToRoot();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.CheckCircle} title="Save Snippet" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="Support reply" />
      <Form.TextField id="keyword" title="Keyword" placeholder="!reply" />
      <Form.TextField id="tags" title="Tags" placeholder="support, customer, sales" />
      <Form.TextArea id="text" title="Text" placeholder="Paste the reusable text here…" />
    </Form>
  );
}
