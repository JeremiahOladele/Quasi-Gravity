# Windows test builds

The `Quasi Windows build` GitHub Actions workflow builds Windows x64 packages
from the selected commit. It uses the Node version in `.nvmrc`, the pnpm
version in `package.json`, frozen lockfiles, and the existing Code OSS
packaging tasks. Windows packages are built on Windows runners, not in WSL.

## Downloads

Open the repository's **Actions** tab, select **Quasi Windows build**, and open
a successful run. Download the `Quasi-Gravity-win32-x64-<run number>` artifact
and extract the outer artifact ZIP. Artifacts expire after 30 days. The
workflow does not publish a release or enable automatic updates.

- `Quasi-Gravity-win32-x64-portable.zip`: extract the entire ZIP into a writable
  folder, then run `Quasi-Gravity.exe` from that folder. Keep all runtime files
  together. The included `data` directory keeps the portable profile next to
  the application; do not share that directory after entering personal keys.
- `Quasi-Gravity-win32-x64-Setup.exe`: per-user installer, without requiring
  administrator access. Installs Quasi-Gravity separately from VS Code.
- `SHA256SUMS.txt`: SHA-256 checksums for the downloads.

These are unsigned test builds. Windows may show an unknown-publisher or
SmartScreen warning; verify the source and checksum before choosing to run.
The application bundles its runtime: testers do not need Node, pnpm, or the
source repository. Cloud models require the tester's own API key. Local
models require a separately running model server such as Ollama or LM Studio.

## Build again

While bootstrapping, pushes that change the workflow or installer definition
on `codex/windows-build` trigger a build. After the workflow is merged into
the default branch, use **Actions > Quasi Windows build > Run workflow** and
select the desired branch. No signing credentials or model keys are needed.

The workflow installs existing dependencies, compiles and tests both Quasi
extensions, builds `vscode-win32-x64-min`, verifies the packaged extension
entry points and chat assets, then runs
`vscode-win32-x64-inno-updater` and `vscode-win32-x64-user-setup`.

For a native Windows developer checkout with the supported Visual Studio C++
build tools and pinned Node/pnpm installed:

```text
pnpm install --frozen-lockfile
pnpm run gulp compile-extension:quasi-providers compile-extension:quasi-agent
pnpm exec mocha "extensions/quasi-providers/out/test/**/*.test.js" "extensions/quasi-agent/out/test/**/*.test.js"
pnpm run gulp vscode-win32-x64-min
pnpm run gulp vscode-win32-x64-inno-updater
pnpm run gulp vscode-win32-x64-user-setup
```

The application folder is created next to the checkout as `VSCode-win32-x64`.
The installer is `.build/win32-x64/user-setup/Quasi-GravitySetup.exe`.

## Testing with friends

1. Launch with a fresh profile and check the Quasi onboarding.
2. Add a cloud provider with your own key, or connect a local server. Select a
   model and open **Quasi: Open Chat**.
3. Check streamed replies, Stop, New Chat, and model switching.
4. Open a disposable test project. Ask the agent to read, search, and edit a
   small file; inspect the diff and test Revert and Revert all.
5. Check that deleting a file and accessing sensitive files request approval.
6. Restart and check that provider settings persist. Chat history and session
   undo are currently memory-only. Terminal execution is not implemented yet.
7. Report the build commit/run, Windows version, provider/model, reproduction
   steps, and screenshots. Never include API keys or private project contents.

Windows ARM64, macOS, and Linux packages are outside this initial Windows x64
build. Source changes must continue to support those platforms.
