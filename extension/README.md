# FlowDesk Raycast Extension

A standalone Raycast extension for users who already live inside Raycast. They do **not** need to install the FlowDesk desktop app.

## Commands

- **Command Center** — one searchable entry point for all FlowDesk workflows.
- **Create Snippet** — save reusable text with keyword and tags.
- **Search Snippets** — search, copy, or paste saved snippets.
- **Create AI Command** — save reusable prompt commands.
- **Run AI Command** — run saved prompts on clipboard/selected text.
- **Transcript Memory** — search and reuse dictation transcripts.

## Development

```bash
npm install
npm run dev
```

Raycast will load the extension in development mode.

## Notes

This first version stores snippets, AI commands, and transcripts in Raycast LocalStorage. Later we can add sync, real dictation APIs, and FlowDesk cloud/desktop bridge integration.
