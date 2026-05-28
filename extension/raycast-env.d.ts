/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** OpenAI API Key - Used by AI commands. Leave empty to use mock output while testing. */
  "openaiApiKey"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `index` command */
  export type Index = ExtensionPreferences & {}
  /** Preferences accessible in the `create-snippet` command */
  export type CreateSnippet = ExtensionPreferences & {}
  /** Preferences accessible in the `search-snippets` command */
  export type SearchSnippets = ExtensionPreferences & {}
  /** Preferences accessible in the `create-ai-command` command */
  export type CreateAiCommand = ExtensionPreferences & {}
  /** Preferences accessible in the `run-ai-command` command */
  export type RunAiCommand = ExtensionPreferences & {}
  /** Preferences accessible in the `transcript-memory` command */
  export type TranscriptMemory = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `index` command */
  export type Index = {}
  /** Arguments passed to the `create-snippet` command */
  export type CreateSnippet = {}
  /** Arguments passed to the `search-snippets` command */
  export type SearchSnippets = {}
  /** Arguments passed to the `create-ai-command` command */
  export type CreateAiCommand = {}
  /** Arguments passed to the `run-ai-command` command */
  export type RunAiCommand = {}
  /** Arguments passed to the `transcript-memory` command */
  export type TranscriptMemory = {}
}

