# Phase 2: Agent loop and chat panel

Goal: a chat panel where the user talks to their active model (from Phase 1),
and an agent that can read the project, edit files, and (with approval) run
commands. This is the first phase where model output can cause actions on the
user's machine, so **safety rules in this document are hard requirements**.

Work milestone by milestone: plan first (list files, wait for approval), small
commits, compile and run tests after each, then tell me what to check by eye.
Follow `AGENTS.md`, especially the cross-platform and web-compatibility rules.

## Architecture

New built-in extension: `extensions/quasi-agent/`

```
extensions/quasi-agent/
  package.json
  src/
    core/                    # PURE TypeScript: no `vscode`, no Node imports
      agentLoop.ts           # the loop (provider + tools + approvals + abort)
      messages.ts            # conversation types, chat <-> provider mapping
      tools/
        registry.ts          # ToolDef, capability requirements, schemas
        pathPolicy.ts        # workspace path sandbox (pure)
        secretFiles.ts       # sensitive-file patterns
        commandPolicy.ts     # allowlist matching (pure)
        truncate.ts          # output limits
      prompt.ts              # system prompt builder
    host/                    # VS Code glue
      extension.ts
      chatView.ts            # WebviewViewProvider
      toolsFs.ts             # fs tools via vscode.workspace.fs / WorkspaceEdit
      commandRunner.ts       # desktop CommandRunner implementation
      approvals.ts
      storage.ts             # conversation persistence
    webview/                 # chat UI (no remote resources)
    test/
```

`core/` must run unchanged in a browser or on a server later. The agent loop
depends only on interfaces. It never imports `vscode`, `fs`, or `child_process`.

### Using the Phase 1 provider layer
`quasi-providers` exposes a small versioned API through its `activate()` return
value (`exports`):

```ts
interface QuasiProvidersApiV1 {
  readonly version: 1;
  getActive(): { provider: Provider; model: string; capabilities: Capabilities } | undefined;
  onDidChangeActive: Event<void>;
  reportKeyRejected(providerId: string): void;   // flips the status bar to "key rejected"
}
```

The agent only ever talks to `Provider`. Never reach into providers' internals,
never read keys. Adjust this API if you find problems, but explain why.

### Capabilities and tools
Every tool declares the capabilities it needs; tools whose capability is missing
are not offered to the model. This is what lets the web version exist later.

```ts
type Capability = 'fs.read' | 'fs.write' | 'exec';
interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;          // sent to the model
  requires: Capability[];
  risk: 'read' | 'write' | 'exec';
}
interface CommandRunner {           // desktop implements this; the web has none
  run(cmd: string, opts: { cwd: string; timeoutMs: number; signal: AbortSignal }): Promise<CommandResult>;
}
```

## Safety requirements (all milestones)

1. **Approvals are decided in code, never by the model.** The model can only
   request a tool call. The loop checks permissions and asks the user. Tool
   output, file contents, and web text can never grant or change permissions.
2. **Treat everything the model reads as untrusted data** (file contents, tool
   output, project instruction files). The system prompt says so explicitly and
   tool results are clearly delimited. The real defense is the approval gates
   above, not prompt wording.
3. **Path sandbox.** Resolve every tool path against the workspace root. Reject
   `..` escapes and absolute paths outside the workspace. Writes outside the
   workspace require approval when `quasi.defaults` says so
   (`askBeforeWriteOutsideWorkspace`). Reads outside the workspace always
   require approval.
4. **Sensitive files.** Reading files that match secret patterns (`.env*`,
   `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, cloud credential files, and similar)
   requires approval every time, because contents would be sent to the model
   provider. The pattern list lives in `core/` and is unit tested.
5. **Terminal.** Follow `quasi.defaults.askBeforeTerminal`: `always` (prompt for
   every command), `unlisted` (allowlisted commands run, everything else
   prompts), `never`. The allowlist matcher accepts a command only if it
   exactly matches an allowed program and argument pattern AND contains none of
   the shell metacharacters `; & | > < $ ( ) \` newline`. Anything else is
   "unlisted". The allowlist is the application-scoped setting
   `quasi.agent.allowedCommands` (default: a small set of read-only commands,
   e.g. `git status`, `git diff`, `git log`). It is device-local: never
   exported, and import must ignore it.
6. **Every approval shows the exact command or the exact diff.** Approvals are
   single-use. No "always allow" in this phase.
7. **Limits:** maximum tool-call iterations per user message (default 25),
   command timeout, output truncation, tool-result size caps, and a visible Stop
   button that cancels the model request and any running command.
8. **Keys never appear** in prompts, logs, conversation storage, tool output,
   or error text. Reuse the Phase 1 redaction helper.
9. **Webview hardening:** strict CSP with a nonce, no remote resources, no
   `innerHTML` with model or file content (build DOM nodes or use a vetted
   sanitizing renderer; propose which, and do not add a dependency without
   asking). Messages between webview and host are validated.
10. **Model without tool support:** if capabilities say tools are known
    unsupported, run plain chat with no tools and say so. If tool support is
    unknown, try tools; if the provider rejects the request because of tools,
    retry once without tools and tell the user. Never loop on failures.
11. **Cross-platform:** tell the model the OS and the shell actually in use
    (PowerShell, cmd, zsh, bash). Preserve each file's line endings when
    editing. Paths via `Uri`, never string concatenation.

## Milestones

### M1: Chat panel, plain streaming chat
- Scaffold `quasi-agent` (built-in; add the build-list lines the same way as
  `quasi-providers`, tagged `// QUASI:`).
- Add `QuasiProvidersApiV1` to `quasi-providers` and use it here.
- A chat view in the **auxiliary (right-hand) side bar**. Verify how an
  extension contributes a view there in this VS Code version. A command
  **Quasi: Open Chat** reveals it; do not change the "hidden by default" patch.
- Webview UI: message list, input box (Enter to send, Shift+Enter newline),
  streaming render, Stop button, New Chat, a header showing the active
  provider and model, and clear error states: no model configured (button to
  Quick Add), key rejected (button to Set API Key), provider offline.
- No tools yet. This milestone is plain streamed chat on the active provider.
- Message protocol and webview hardening per the safety rules.
- Done when: chat works with DeepSeek and with Ollama, Stop works mid-stream,
  switching the active model mid-session works, and no key appears anywhere.

### M2: Agent loop and read-only tools
- `core/agentLoop.ts`: provider + tool registry + approval callback + abort
  signal; iteration cap; loop and repeat-failure detection.
- Tools: `list_dir`, `read_file` (with line ranges), `search` (text search over
  workspace files; propose the implementation without Node `fs`).
- Path sandbox, sensitive-file approval, output truncation, and their tests.
- UI shows each tool call as a collapsible entry (name, arguments, result
  summary). Plain-chat fallback behavior per safety rule 10.
- System prompt builder: OS, shell, workspace name, tool-use guidance, and the
  untrusted-data rule.
- Done when: "summarize this repo" and "where is X defined?" work through tool
  calls; reading `.env` asks for approval; `../` escapes are refused.

### M3: Editing tools and session undo
- Tools: `edit_file` (targeted search-and-replace edits, preferred),
  `write_file` (create or replace), `delete_file` (always requires approval in
  this phase).
- Apply edits through `WorkspaceEdit` so open, unsaved buffers are respected and
  editor undo works. Preserve line endings. Show a diff preview for
  approvals (`vscode.diff` or an inline diff in the chat; propose which).
- Writes outside the workspace follow `askBeforeWriteOutsideWorkspace`.
- **Interim undo:** keep the previous content of every file the agent changes in
  this session and offer **Revert agent changes** in the UI. (Phase 3
  checkpoints will replace this with git snapshots; do not build git logic
  here.)
- Done when: the agent can add a function to a file, the edit appears in the
  editor, and one click reverts it, including for unsaved buffers.

### M4: Terminal tool and approvals
- `CommandRunner` interface in `core/`; desktop implementation in `host/`
  (propose: shell detection, how to capture output cross-platform, whether to
  use the VS Code terminal API with shell integration or a spawned process).
  Always run in the workspace folder, with timeout, output cap, and
  cancellation.
- `run_command` tool; inline approval UI in the chat (exact command, Allow /
  Deny); denial is returned to the model as a tool result.
- `commandPolicy.ts` per safety rule 5, with the allowlist setting. Tests must
  cover metacharacter bypass attempts (`git status; rm -rf x`,
  `git status && ...`, backticks, `$(...)`, newlines, redirects).
- Honor `askBeforeTerminal`: always / unlisted / never.
- The tool is only offered when the `exec` capability exists.
- Done when: "run the tests" prompts and runs; an allowlisted read-only command
  runs without a prompt under `unlisted`; Stop kills a running command;
  nothing runs under `always` without approval.

### M5: Context, persistence, polish
- Attach context: "Add current file" and "Add selection" commands and buttons.
- Optional project instructions: if `AGENTS.md` or `.quasi/instructions.md`
  exists at the workspace root, include it (size-capped) in the system prompt,
  clearly labeled as project notes (untrusted).
- Conversation persistence per workspace using extension storage; history
  picker (Quick Pick); delete history. Never synced, never exported.
- Token usage display from the provider's usage data where available.
- Settings: `quasi.agent.maxIterations`, `quasi.agent.allowedCommands`
  (all application-scoped).
- Update `docs/` with a short description of the agent's permissions model.

## Out of scope for Phase 2
Checkpoints, artifacts, the Agent Manager, parallel agents, browser agent,
inline autocomplete, MCP servers, accounts, shared/remote providers, web
version.

## Tests
- `core/` unit tests for: loop termination and iteration cap, abort,
  tool-call parsing across streamed chunks, path sandbox (escape attempts,
  Windows-style and POSIX-style inputs), sensitive-file patterns, command
  policy (see M4), truncation, fallback-without-tools, and that no key or
  redacted secret ever appears in prompts, errors, or stored conversations.
- Keep the core-purity test green. No new dependencies without asking.

## Definition of done for Phase 2
- With DeepSeek and with a tools-capable local model, I can ask the agent to
  explain the repo, change a file, and run the tests; each action shows what it
  will do and asks according to my safety settings.
- A model without tool support still chats, and says so.
- Stop works everywhere. Denying an approval is handled gracefully.
- Nothing outside the workspace is read or written without approval.
- Compiles cleanly, tests pass, committed in small steps.
