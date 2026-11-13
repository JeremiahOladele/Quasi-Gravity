# Phase 1: Provider layer

Goal: let a user connect to AI models with their own API keys or local model
servers ("waypoints"), manage them, and move their configuration between
machines, with no account and no Quasi-Gravity server. Phase 2 (agent loop and
chat) will build on this, so the interfaces matter more than the UI.

Work milestone by milestone. For each: plan first (list files, wait for approval),
small commits, compile after each, tell me what to check by eye. Follow
`AGENTS.md`, especially the cross-platform and web-compatibility rules.

## Architecture

New built-in extension: `extensions/quasi-providers/`

```
extensions/quasi-providers/
  package.json              # commands, configuration, activation events
  src/
    core/                   # PURE TypeScript: no `vscode`, no Node imports
      types.ts              # interfaces below
      providers/
        openaiCompat.ts     # adapter (fetch + SSE streaming)
      settingsSchema.ts     # quasi-settings.json types + validation
      capabilities.ts       # capability detection helpers
      sse.ts                # SSE stream parser
    host/                   # VS Code API glue
      extension.ts          # activate()
      secrets.ts            # SecretStorage wrapper
      commands.ts           # command palette commands
      statusBar.ts
      discovery.ts          # local server probing
    test/                   # unit tests for core/ (mocked fetch)
```

`core/` must run unchanged in a browser or on a server later. `host/` is the only
place that may import `vscode`. Use standard `fetch` and `AbortSignal`. No new
dependencies without asking first (write the validator by hand).

## Core interfaces (starting point; improve if you find problems, but explain why)

```ts
type ProviderKind = 'cloud' | 'local' | 'remote'; // 'remote' reserved, not built
type ApiType = 'openai-compat' | 'ollama' | 'anthropic' | 'gemini';

interface ProviderConfig {
  id: string;                 // stable slug, unique
  name: string;               // display name
  kind: ProviderKind;
  apiType: ApiType;
  baseUrl: string;            // e.g. https://api.deepseek.com or http://localhost:11434/v1
  defaultModel?: string;
  requiresKey: boolean;       // key itself is NEVER part of this object
  capabilities?: Partial<Capabilities>; // manual overrides
}

interface Capabilities {
  tools: boolean;             // tool/function calling
  vision: boolean;
  streaming: boolean;
  contextLength?: number;
}

interface ModelInfo { id: string; name?: string; capabilities?: Partial<Capabilities>; }

interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  toolCalls?: ToolCall[]; toolCallId?: string; }

interface ChatRequest { model: string; messages: ChatMessage[]; tools?: ToolSpec[];
  temperature?: number; maxTokens?: number; }

type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; message: string };

interface Provider {
  readonly config: ProviderConfig;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; models?: ModelInfo[] }>;
}

// Adapters receive the key through a function so keys are never stored in adapter state or logged.
type KeyResolver = (providerId: string) => Promise<string | undefined>;
```

Rules for these interfaces:
- No `vscode` or Node types anywhere in `core/`.
- Nothing in `ProviderConfig` or any exported object may contain a secret.
- Errors become `{type:'error'}` chunks or typed exceptions. Never swallow them,
  and never include keys or full request headers in error text.
- The agent (Phase 2) will only ever talk to `Provider`. A future shared/remote
  provider must be implementable without changing these interfaces.

## Settings storage

- Non-secret config lives in VS Code settings under `quasi.providers` (array of
  `ProviderConfig`) and `quasi.defaults` (see M5).
- API keys live only in `SecretStorage`, keyed `quasi.key.<providerId>`.
- Never write keys to settings, logs, the output channel, or the export file.

## Milestones

### M1: Scaffold, core types, OpenAI-compatible adapter
- Create the extension, register it as built-in, make sure it activates in the
  dev build.
- Implement `core/types.ts`, `core/sse.ts`, and the `openaiCompat` adapter:
  `listModels` (`GET {baseUrl}/models`), streaming `chat` (`POST
  {baseUrl}/chat/completions` with `stream: true`), tool-call chunk assembly,
  `testConnection`.
- Handle base URLs with or without a trailing `/v1` or slash sensibly
  (DeepSeek uses `https://api.deepseek.com`; Ollama uses
  `http://localhost:11434/v1`).
  Decision: append `/v1` only when the base URL has no path; URLs that already
  have a path (for example `/v1beta/openai` or `/inference/v1`) are used as-is.
  A `baseUrlIsExact` flag was considered but is not needed (Perplexity was
  omitted because its OpenAI-compatible base is not stable).
- Unit tests for the SSE parser and adapter with mocked `fetch`: normal stream,
  tool calls split across chunks, 401, 429, network failure, abort.
- Add a temporary command **Quasi: Test Provider (dev)** that prompts for a
  provider and a message, streams the reply into an output channel.
- Done when: unit tests pass, and a real streamed reply works against DeepSeek
  (my key) and against local Ollama.

### M2: Provider and waypoint management
- Commands (Quick Pick / Input Box based; no custom webview yet):
  **Quasi: Add Provider**, **Edit**, **Remove**, **Set API Key**,
  **Test Connection**, **Select Active Model**.
- "Add Provider" offers presets that pre-fill the URL and fields: DeepSeek,
  OpenAI, OpenRouter, Ollama, LM Studio, llama.cpp server, vLLM, and
  "Custom OpenAI-compatible". Local presets set `kind: 'local'`,
  `requiresKey: false`.
- Keys go to `SecretStorage` via `host/secrets.ts`. Show only masked
  confirmation ("key saved"), never the key.
- Status bar item shows the active provider and model, and its connection state
  (online / offline / unknown). Clicking it opens the model picker. Health
  checks are infrequent and cancellable.
- Warn when a non-local, non-HTTPS `baseUrl` is entered.

### M3: Local discovery and capabilities
- On first startup (and via **Quasi: Detect Local Models**), probe these default
  endpoints with a short timeout: Ollama `11434`, LM Studio `1234`, llama.cpp
  `8080`, vLLM `8000`. Offer "Found Ollama on :11434, add it?". Never
  auto-add without confirmation. Never scan beyond localhost.
- Ollama niceties via its native API when `apiType` is `ollama` or auto-detected:
  list models with `/api/tags`; read capabilities where available.
  Decision: new Ollama providers (preset and discovery) use `apiType: 'ollama'`
  with an `OllamaProvider` whose chat stays on the OpenAI-compatible adapter;
  native `/api/tags` and `/api/show` are metadata-only and fall back to the
  OpenAI-compatible model list. Existing `openai-compat` Ollama providers keep
  working unchanged.
- Capability detection: use what the server reports; otherwise conservative
  defaults (tools: false unless known). Let the user override per provider.
  Surface "this model may not support tools" as a clear warning, because Phase 2
  must degrade to plain chat for such models.
- Make `baseUrl` fully configurable, including LAN addresses and non-localhost
  hosts. Document the WSL quirk in a comment in `discovery.ts` and in the
  README (a Windows-hosted server may not be reachable from WSL via
  `localhost`; this affects the dev setup only).

### M4: Exportable settings
- Define `quasi-settings.json` v1 in `core/settingsSchema.ts`:
  ```json
  {
    "version": 1,
    "providers": [ /* ProviderConfig[] without secrets */ ],
    "defaults": { /* see M5 */ },
    "activeProviderId": "...",
    "activeModel": "..."
  }
  ```
- Commands: **Quasi: Export Settings** and **Quasi: Import Settings** using VS
  Code file dialogs. Import validates against the schema (hand-written
  validator), reports exactly what is wrong, shows a summary before applying,
  and never executes anything from the file. UTF-8, LF endings on all platforms.
  Unknown future `version` values are rejected with a clear message.
- The export contains no keys, tokens, or passwords. Add a test that fails if
  any string in the export matches a key-like pattern or equals a stored key.
- After import, providers that need a key show "key missing, set it on this
  device".
- Portable: no absolute OS paths in the file.
- Optional (only after the above works): setting `quasi.sync.folder`; when set,
  read/write `quasi-settings.json` there and watch for changes (last-write-wins).

### M5: First-run experience and defaults
- Replace the placeholder "Learn the Fundamentals" walkthrough with a
  Quasi-Gravity getting-started walkthrough (small, text-first): 1) add a cloud
  provider and key, 2) connect a local model, 3) pick the active model,
  4) export your settings. Keep the patch to the walkthrough registration
  minimal and tagged `// QUASI:`.
- `quasi.defaults`: default provider and model, permission defaults for the
  future agent (`askBeforeTerminal: true`, `askBeforeWriteOutsideWorkspace: true`),
  and named profiles "Safe", "Balanced", "Autonomous" (data only for now; they
  are consumed in Phase 2).
- First-run prompt (shown once): "Local (Ollama)", "Bring your own key", or
  "Skip", which leads into the relevant Add Provider flow.

### M6 (optional, after the rest): More adapters
- Anthropic and Gemini adapters behind the same `Provider` interface, with the
  same tests. Do not start this without asking.

## Out of scope for Phase 1
Agent loop, chat panel, tool execution, artifacts, accounts, any server, the
remote/shared provider, the web version.

## Cross-platform and quality checks
- No hardcoded path separators or shell assumptions anywhere.
- Unit tests in `core/` must pass on Windows, macOS, and Linux (they use no OS
  features).
- Everything in `host/` that touches files uses `vscode.workspace.fs` / `Uri`.
- No telemetry, no network calls except to the user's configured provider
  endpoints (and localhost discovery probes).
- Keys never appear in logs, errors, settings, exports, or test snapshots.

## Definition of done for Phase 1
- I can add DeepSeek with my key and Ollama as a waypoint, test both, pick a
  model, and get a streamed reply from each using the dev command.
- Export on one machine and import on another restores providers (minus keys).
- No secret is ever visible in settings.json or the export.
- Compiles cleanly, unit tests pass, committed in small steps.
