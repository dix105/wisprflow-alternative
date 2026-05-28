import { Action, ActionPanel, Detail, Form, Icon, showToast, Toast } from "@raycast/api";
import { buildVocabularyPrompt, getGlossary, saveGlossary } from "./storage";
import { useEffect, useState } from "react";

type Values = {
  preferredWords: string;
  corrections: string;
};

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [values, setValues] = useState<Values>({ preferredWords: "", corrections: "" });
  const [preview, setPreview] = useState("");

  useEffect(() => {
    async function load() {
      const glossary = await getGlossary();
      setValues(glossary);
      setPreview(buildVocabularyPrompt(glossary));
      setIsLoading(false);
    }
    load();
  }, []);

  async function handleSubmit(next: Values) {
    await saveGlossary(next);
    setValues(next);
    setPreview(buildVocabularyPrompt(next));
    await showToast({ style: Toast.Style.Success, title: "FlowDesk words saved" });
  }

  if (isLoading) return <Detail isLoading markdown="Loading FlowDesk words…" />;

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.CheckCircle} title="Save Words" onSubmit={handleSubmit} />
          <Action.CopyToClipboard title="Copy Whisper Prompt" content={preview} />
        </ActionPanel>
      }
    >
      <Form.TextArea id="preferredWords" title="Preferred Words" defaultValue={values.preferredWords} />
      <Form.TextArea id="corrections" title="Auto-Corrections" defaultValue={values.corrections} />
      <Form.Description title="Prompt Preview" text={preview || "Add preferred words to generate a Whisper prompt."} />
    </Form>
  );
}
