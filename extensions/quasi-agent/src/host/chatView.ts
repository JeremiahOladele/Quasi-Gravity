/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DEFAULT_MAX_ITERATIONS, runAgentLoop } from '../core/agentLoop';
import { MarkdownBlock, isAllowedLink, parseMarkdown } from '../core/markdown';
import { dropEmptyAssistant } from '../core/messages';
import { ActiveProviderInfo, ChatMessage, ProvidersApiV1 } from '../core/providerApi';
import { buildSystemPrompt } from '../core/prompt';
import { parseWebviewToHost } from '../core/protocol';
import { WebviewApprovalBroker } from './approvals';
import { getProvidersApi } from './providerApi';
import { createReadTools } from './toolsFs';
import { detectShell, osName, resolveWorkspaceContext, today } from './workspace';

type DisplayEntry =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string; id: string; blocks: MarkdownBlock[] }
	| { kind: 'notice'; text: string }
	| { kind: 'tool'; name: string; args: string; summary: string; isError: boolean };

type AssistantEntry = Extract<DisplayEntry, { kind: 'assistant' }>;
type ToolEntry = Extract<DisplayEntry, { kind: 'tool' }>;

interface ProviderIdentity {
	readonly kind: string;
	readonly host?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];
	private api: ProvidersApiV1 | undefined;
	private apiResolved = false;
	private apiDisposable: vscode.Disposable | undefined;

	private entries: DisplayEntry[] = [];
	private providerHistory: ChatMessage[] = [];
	private streaming = false;
	private abort: AbortController | undefined;
	private generation = 0;
	private lastIdentity: ProviderIdentity | undefined;
	private pendingSwitchCheck = false;
	private currentAssistant: AssistantEntry | undefined;
	private lastToolEntry: ToolEntry | undefined;
	private markdownTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingMarkdownEntry: AssistantEntry | undefined;
	private messageCounter = 0;
	private readonly refusedModels = new Set<string>();
	private readonly shownNotices = new Set<string>();
	private readonly approvals: WebviewApprovalBroker;

	constructor(private readonly extensionUri: vscode.Uri) {
		this.approvals = new WebviewApprovalBroker(message => this.post(message));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.clearViewDisposables();
		view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		view.webview.html = this.getHtml(view.webview);
		this.viewDisposables.push(view.webview.onDidReceiveMessage(raw => this.onMessage(raw)));
		this.viewDisposables.push(view.onDidChangeVisibility(() => {
			if (!view.visible) {
				this.approvals.cancelAll();
			}
		}));
		this.viewDisposables.push(view.onDidDispose(() => this.handleViewDisposed()));
		void this.ensureApi();
	}

	newChat(): void {
		this.generation++;
		this.stopInternal();
		this.clearMarkdownTimer();
		this.entries = [];
		this.providerHistory = [];
		this.currentAssistant = undefined;
		this.lastToolEntry = undefined;
		this.lastIdentity = undefined;
		this.post({ type: 'cleared' });
		this.postState();
	}

	private handleViewDisposed(): void {
		this.clearMarkdownTimer();
		this.abort?.abort();
		this.abort = undefined;
		this.approvals.cancelAll();
		this.clearViewDisposables();
	}

	private clearMarkdownTimer(): void {
		if (this.markdownTimer !== undefined) {
			clearTimeout(this.markdownTimer);
			this.markdownTimer = undefined;
		}
		this.pendingMarkdownEntry = undefined;
	}

	private clearViewDisposables(): void {
		for (const disposable of this.viewDisposables) {
			try {
				disposable.dispose();
			} catch {
				// ignore
			}
		}
		this.viewDisposables = [];
	}

	private async ensureApi(): Promise<void> {
		if (!this.apiResolved) {
			this.apiResolved = true;
			this.api = await getProvidersApi();
		}
		if (this.api && !this.apiDisposable) {
			this.apiDisposable = this.api.onDidChangeActive(() => this.handleActiveChanged());
		}
	}

	private onMessage(raw: unknown): void {
		const message = parseWebviewToHost(raw);
		if (!message) {
			return;
		}
		switch (message.type) {
			case 'ready':
				void this.sendInitial();
				break;
			case 'send':
				void this.send(message.text);
				break;
			case 'stop':
				this.stopInternal();
				break;
			case 'newChat':
				this.newChat();
				break;
			case 'approvalResponse':
				this.approvals.resolve(message.id, message.approved);
				break;
			case 'copy':
				this.copyCodeBlock(message.messageId, message.blockIndex);
				break;
			case 'openLink':
				if (isAllowedLink(message.url)) {
					void vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			case 'addProvider':
				void vscode.commands.executeCommand('quasi.provider.quickAdd');
				break;
			case 'setApiKey':
				void vscode.commands.executeCommand('quasi.provider.setKey');
				break;
		}
	}

	private async sendInitial(): Promise<void> {
		await this.ensureApi();
		if (this.lastIdentity === undefined) {
			const active = this.api?.getActive();
			if (active) {
				this.lastIdentity = providerIdentity(active);
			}
		}
		this.postHistory();
		this.postState();
		this.notifyWorkspaceChanged();
	}

	/** Called when trust or workspace folders change. */
	notifyWorkspaceChanged(): void {
		const workspace = resolveWorkspaceContext();
		if (workspace.disabledReason) {
			this.maybeNotice(`Tools unavailable: ${workspace.disabledReason}. Chatting without tools.`);
		} else if (workspace.multiRoot) {
			this.maybeNotice(`More than one folder is open. Tools only see '${workspace.rootName ?? 'the first folder'}'.`);
		}
		this.postState();
	}

	private async send(text: string): Promise<void> {
		if (this.streaming) {
			return;
		}
		await this.ensureApi();
		const active = this.api?.getActive();
		if (!active) {
			this.post({ type: 'assistantError', kind: 'no-model', message: 'No active model. Add a provider or pick a model.' });
			return;
		}
		this.noteProviderSwitch(active);

		const workspace = resolveWorkspaceContext();
		const rootTools = workspace.rootUri && workspace.capabilities.has('fs.read') ? createReadTools(workspace.rootUri) : [];
		const refused = this.refusedModels.has(`${active.providerId}:${active.model}`);
		const toolSupport = refused ? 'unsupported' as const : active.capabilityStates.tools;
		const tools = toolSupport === 'unsupported' ? [] : rootTools;
		const toolsDisabledReason = tools.length > 0
			? undefined
			: workspace.disabledReason
			?? (toolSupport === 'unsupported'
				? (refused ? 'this model rejected tools earlier in this session' : 'this model does not support tools')
				: 'no tools are available');
		if (toolsDisabledReason) {
			this.maybeNotice(`Tools unavailable: ${toolsDisabledReason}. Chatting without tools.`);
		}

		const systemPrompt = buildSystemPrompt({
			date: today(),
			os: osName(),
			shell: detectShell(),
			workspaceName: workspace.rootName ?? 'workspace',
			tools: tools.map(tool => tool.name),
			toolsDisabledReason
		});
		if (workspace.multiRoot) {
			this.maybeNotice(`More than one folder is open. Tools only see '${workspace.rootName ?? 'the first folder'}'.`);
		}

		this.entries.push({ kind: 'user', text });
		this.currentAssistant = undefined;
		this.lastToolEntry = undefined;
		this.postHistory();

		const generation = ++this.generation;
		const controller = new AbortController();
		this.abort = controller;
		this.setStreaming(true);

		try {
			const result = await runAgentLoop({
				provider: active.provider,
				model: active.model,
				systemPrompt,
				history: this.providerHistory,
				userText: text,
				tools,
				toolSupport,
				approvalBroker: this.approvals,
				maxIterations: DEFAULT_MAX_ITERATIONS,
				signal: controller.signal,
				callbacks: {
					onText: delta => {
						if (generation === this.generation) {
							this.onText(delta);
						}
					},
					onToolCall: (name, argsText) => {
						if (generation === this.generation) {
							this.onToolCall(name, argsText);
						}
					},
					onToolResult: (name, summary, isError) => {
						if (generation === this.generation) {
							this.onToolResult(name, summary, isError);
						}
					},
					onNotice: notice => {
						if (generation === this.generation) {
							this.onNotice(notice);
						}
					},
					onError: (kind, message) => {
						if (generation === this.generation) {
							if (kind === 'key-rejected') {
								this.api?.reportKeyRejected(active.providerId);
							}
							this.post({ type: 'assistantError', kind, message });
						}
					},
					onDone: () => { },
					onToolsRejected: () => {
						this.refusedModels.add(`${active.providerId}:${active.model}`);
					}
				}
			});
			if (generation === this.generation) {
				this.providerHistory = result.history;
			}
		} finally {
			if (generation === this.generation) {
				this.abort = undefined;
				this.flushMarkdown(this.currentAssistant);
				this.setStreaming(false);
				if (this.currentAssistant && dropEmptyAssistant(this.entries, this.currentAssistant)) {
					this.postHistory();
				}
				this.currentAssistant = undefined;
				if (this.pendingSwitchCheck) {
					this.pendingSwitchCheck = false;
					const current = this.api?.getActive();
					if (current) {
						this.noteProviderSwitch(current);
					}
				}
				this.postState();
			}
		}
	}

	private onText(delta: string): void {
		if (!this.currentAssistant) {
			this.currentAssistant = { kind: 'assistant', text: '', id: `m-${++this.messageCounter}`, blocks: [] };
			this.entries.push(this.currentAssistant);
		}
		this.currentAssistant.text += delta;
		this.scheduleMarkdown(this.currentAssistant);
	}

	private scheduleMarkdown(entry: AssistantEntry): void {
		this.pendingMarkdownEntry = entry;
		if (this.markdownTimer !== undefined) {
			return;
		}
		this.markdownTimer = setTimeout(() => {
			this.markdownTimer = undefined;
			const pending = this.pendingMarkdownEntry;
			this.pendingMarkdownEntry = undefined;
			if (pending) {
				this.postMarkdown(pending);
			}
		}, 50);
	}

	private postMarkdown(entry: AssistantEntry): void {
		const blocks = parseMarkdown(entry.text).blocks;
		entry.blocks = blocks;
		this.post({ type: 'assistantMarkdown', messageId: entry.id, blocks });
	}

	private flushMarkdown(entry: AssistantEntry | undefined): void {
		if (this.markdownTimer !== undefined) {
			clearTimeout(this.markdownTimer);
			this.markdownTimer = undefined;
		}
		this.pendingMarkdownEntry = undefined;
		if (entry) {
			this.postMarkdown(entry);
		}
	}

	private copyCodeBlock(messageId: string, blockIndex: number): void {
		const entry = this.entries.find(item => item.kind === 'assistant' && item.id === messageId);
		if (!entry || entry.kind !== 'assistant') {
			return;
		}
		const block = entry.blocks[blockIndex];
		if (block && block.type === 'code') {
			void vscode.env.clipboard.writeText(block.text);
		}
	}

	private onToolCall(name: string, argsText: string): void {
		this.flushMarkdown(this.currentAssistant);
		this.currentAssistant = undefined;
		const entry: ToolEntry = { kind: 'tool', name, args: prettyJson(argsText), summary: '', isError: false };
		this.entries.push(entry);
		this.lastToolEntry = entry;
		this.post({ type: 'toolCall', name, arguments: entry.args });
	}

	private onToolResult(name: string, summary: string, isError: boolean): void {
		const entry = this.lastToolEntry;
		if (entry && entry.name === name) {
			entry.summary = summary;
			entry.isError = isError;
		}
		this.lastToolEntry = undefined;
		this.post({ type: 'toolResult', name, summary, isError });
	}

	private onNotice(text: string): void {
		this.entries.push({ kind: 'notice', text });
		this.post({ type: 'notice', text });
	}

	private maybeNotice(text: string): void {
		if (this.shownNotices.has(text)) {
			return;
		}
		this.shownNotices.add(text);
		this.onNotice(text);
	}

	private stopInternal(): void {
		this.abort?.abort();
		this.abort = undefined;
		this.approvals.cancelAll();
		if (this.streaming) {
			this.setStreaming(false);
		}
	}

	private setStreaming(value: boolean): void {
		this.streaming = value;
		this.post({ type: 'busy', value });
	}

	private handleActiveChanged(): void {
		if (this.streaming) {
			this.pendingSwitchCheck = true;
		} else {
			const active = this.api?.getActive();
			if (active) {
				this.noteProviderSwitch(active);
			}
		}
		this.postState();
	}

	private noteProviderSwitch(active: ActiveProviderInfo): void {
		const identity = providerIdentity(active);
		if (this.lastIdentity === undefined) {
			this.lastIdentity = identity;
			return;
		}
		if (identity.kind === this.lastIdentity.kind && identity.host === this.lastIdentity.host) {
			return;
		}
		const hadConversation = this.entries.some(entry => entry.kind === 'user' || entry.kind === 'assistant');
		this.lastIdentity = identity;
		if (!hadConversation) {
			return;
		}
		this.onNotice(`Switched to ${active.providerName} (${identity.kind}). Earlier messages in this chat will be sent to it.`);
	}

	private postHistory(): void {
		this.post({
			type: 'history',
			entries: this.entries.map(entry => {
				if (entry.kind === 'assistant') {
					if (entry.blocks.length === 0 && entry.text.length > 0) {
						entry.blocks = parseMarkdown(entry.text).blocks;
					}
					return { kind: 'assistant', text: entry.text, id: entry.id, blocks: entry.blocks };
				}
				return { ...entry };
			})
		});
	}

	private postState(): void {
		const active = this.api?.getActive();
		this.post({
			type: 'state',
			...(active ? { active: { providerName: active.providerName, model: active.model } } : {}),
			streaming: this.streaming
		});
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'main.css'));
		const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src 'none'; font-src ${webview.cspSource};`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Quasi Chat</title>
</head>
<body>
<header id="header">
	<span id="active">No model</span>
	<button id="newChat" type="button">New Chat</button>
</header>
<div id="messages" role="log" aria-live="polite"></div>
<div id="error" class="error" hidden>
	<span id="errorText"></span>
	<button id="errorAction" type="button" hidden></button>
</div>
<footer id="composer">
	<textarea id="input" rows="2" placeholder="Ask the active model…"></textarea>
	<div id="actions">
		<button id="send" type="button">Send</button>
		<button id="stop" type="button" disabled>Stop</button>
	</div>
</footer>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function providerIdentity(active: ActiveProviderInfo): ProviderIdentity {
	const config = active.provider.config;
	const kind = config?.kind ?? 'unknown';
	let host: string | undefined;
	try {
		host = config ? new URL(config.baseUrl).host : undefined;
	} catch {
		host = undefined;
	}
	return { kind, host };
}

function prettyJson(text: string): string {
	let pretty = text;
	try {
		pretty = JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		// keep raw text
	}
	return pretty.length > 2000 ? `${pretty.slice(0, 2000)}…` : pretty;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
