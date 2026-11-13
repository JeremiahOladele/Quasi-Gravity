# Quasi Providers

Bring-your-own-key and local model providers for Quasi-Gravity.

- Add cloud providers with your own API key (kept in the OS secure storage) or
  local OpenAI-compatible servers.
- API keys never go into settings, logs, or the export file. They live in secure
  storage, or in memory only for the current session if no system keyring is
  available.
- Everything is Quick Pick / Input Box based. No webviews.

## Local servers

Discovery probes only the standard loopback endpoints:

- Ollama: `http://localhost:11434`
- LM Studio: `http://localhost:1234`
- llama.cpp server: `http://localhost:8080`
- vLLM: `http://localhost:8000`

Run **Quasi: Detect Local Models** to search again. Discovery never scans other
hosts or ports and never adds anything without confirmation. On first startup it
may ask once (a non-modal prompt); set `quasi.discovery.dontAskAgain` to disable
that automatic prompt.

Providers can point at any base URL, including LAN and remote hosts. Plain HTTP
to a non-loopback host is allowed but warns before saving.

## WSL note

On the maintainer's WSL setup, a model server running on the Windows host may not
be reachable from WSL via `localhost`. Use the Windows host's LAN IP (or enable
WSL networking mirroring) instead. This affects the development setup only, not
the product.
