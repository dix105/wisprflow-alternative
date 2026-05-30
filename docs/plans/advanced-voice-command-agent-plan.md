---
title: Advanced Voice Command Agent
status: active
date: 2026-05-30
origin: Telegram request to make the voice command system advanced
---

# Advanced Voice Command Agent Plan

## Problem Frame

The current implementation can recognize simple always-on commands and optionally use Cerebras GPT-OSS to classify fuzzy `open` / `close` intents. The advanced version should behave more like an instant desktop voice agent:

- Listen continuously when enabled.
- Understand flexible commands, not only exact grammar.
- Open websites or installed applications.
- Close known apps safely.
- Support user-defined aliases and command mappings.
- Stay fast enough to feel instant.
- Avoid dangerous arbitrary shell execution.

## Scope

### In scope

- Advanced command configuration UI.
- User-defined apps/websites/aliases.
- GPT-OSS intent parsing via Cerebras.
- Exact/local parser first, GPT fallback second.
- Open and close known mapped targets.
- Confirm or reject unsafe/unknown actions.
- Command history/debug log.
- Tests for parser and command mapping logic.

### Out of scope for first advanced pass

- Arbitrary shell command execution.
- Autonomous multi-step computer control.
- Sending messages in apps.
- Reading private app content.
- Cross-platform close behavior beyond known safe mappings.

## Product Behavior

### Example commands

- “Open Notion” → open Notion app / URL.
- “Open my notes” → GPT maps alias to Notion.
- “Open Agentplace dashboard” → open configured website.
- “Close Discord” → close mapped Discord processes.
- “Close the chat app” → GPT maps to Discord/Telegram only if confident.
- “Open the browser and search pricing” → deferred; should return `none` for now.

### Command pipeline

1. Always-on listener emits recognized phrase.
2. Exact parser checks local command grammar.
3. User alias parser checks configured aliases.
4. GPT-OSS classifier runs only if local parsing fails.
5. Safety gate validates action + target.
6. Executor opens/closes mapped target.
7. Command history records phrase, decision, confidence, and result.

## Data Model

Store in localStorage first:

- `flowDeskCommandTargets`
  - `id`
  - `label`
  - `aliases[]`
  - `kind`: `url | app | process`
  - `openValue`: URL/protocol/app path
  - `closeProcesses[]`
  - `enabled`

- `flowDeskCommandHistory`
  - `id`
  - `phrase`
  - `action`
  - `target`
  - `confidence`
  - `source`: `exact | alias | gpt-oss`
  - `result`
  - `createdAt`

## Implementation Units

### Unit 1 — Command target registry

Files:

- `src/main.ts`
- `src-tauri/src/lib.rs`

Build:

- Add default command target registry for Notion, Telegram, Discord, X, WhatsApp, Gmail, GitHub, Chrome, Calendar.
- Add alias support: e.g. “notes” → Notion, “chat” → Discord/Telegram depending user config.
- Keep defaults editable in UI.

Tests / verification:

- Add parser test helper or script under `scripts/`.
- Verify exact target IDs normalize: `twitter` → `x`.
- Verify unknown target returns `none`.

### Unit 2 — Advanced voice command UI

Files:

- `src/main.ts`
- `src/style.css`

Build:

- Add a Command Center / Voice Commands settings section.
- Show toggles:
  - Always-on app commands
  - GPT-OSS command brain
- Show Cerebras key field.
- Show editable target list with aliases and URL/app mapping.
- Show recent command history.

Tests / verification:

- `npm run build`.
- Manually verify settings render without breaking existing panels.

### Unit 3 — GPT-OSS intent classifier v2

Files:

- `src-tauri/src/lib.rs`
- `src/main.ts`

Build:

- Send available configured targets + aliases to Cerebras, not hardcoded list only.
- Response schema:
  - `action`: `open | close | none`
  - `targetId`
  - `confidence`
  - `reason`
- Reject confidence below threshold.
- Reject target IDs not in local registry.

Tests / verification:

- Mock sample phrases through a script:
  - “open my notes” → Notion
  - “close the chat app” → either configured chat target or none
  - “delete all files” → none

### Unit 4 — Safer executor

Files:

- `src-tauri/src/lib.rs`

Build:

- Replace hardcoded `open_voice_target` with target registry driven executor.
- Open URL/protocol safely.
- Close only preconfigured process names.
- Never execute arbitrary shell text from GPT.

Tests / verification:

- `cargo check`.
- Verify unknown target cannot execute.
- Verify close action requires mapped process list.

### Unit 5 — Command history and observability

Files:

- `src/main.ts`

Build:

- Record every command decision.
- Show last 20 commands with phrase, source, action, target, confidence, result.
- Add “copy command debug bundle”.

Tests / verification:

- Trigger exact command and GPT fallback command.
- Confirm both appear in history.

## Safety Rules

- GPT can classify; GPT cannot execute raw commands.
- Unknown apps/websites require user mapping first.
- Low-confidence commands do nothing.
- Close actions only operate on allowlisted process names.
- No message sending or account actions in this phase.

## Recommended Build Sequence

1. Add target registry + alias parser.
2. Update GPT classifier to use registry.
3. Add editable UI for targets.
4. Add safer registry-driven executor.
5. Add command history/debug view.
6. Build and push.

## Success Criteria

- User can say “open my notes” and it opens Notion through alias/GPT.
- User can add a website target and say “open dashboard”.
- User can say “close Discord” and it safely closes Discord.
- Random speech does not trigger actions.
- Build passes with `npm run build` and `cargo check`.
