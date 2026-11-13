/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { classifyChatError } from '../core/errors';
import { toProviderMessages } from '../core/messages';
import { ActiveProviderInfo, ProvidersApiV1 } from '../core/providerApi';
import { parseWebviewToHost } from '../core/protocol';
import { getProvidersApi } from './providerApi';

type MutableEntry =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string }
	| { kind: 'notice'; text: string };

interface ProviderIdentity {
	readonly kind: string;
	readonly host?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {

	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];
	private api: ProvidersApiV1 | undefined;
	private apiRequested = false;

	private entries: MutableEntry[] = [];
	private streaming = false;
	private abort: AbortController | undefined;
	private generation = 0;
	private lastIdentity: ProviderIdentity | undefined;
	private pendingSwitchCheck = false;

	constructor(private readonly extensionUri: vscode.Uri) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.disposeView();
		view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		view.webview.html = this.getHtml(view.webview);
		this.viewDisposables.push(view.webview.onDidReceiveMessage(raw => this.onMessage(raw)));
		this.viewDisposables.push(view.onDidDispose(() => this.disposeView()));
		void this.ensureApi();
	}

	newChat(): void {
		this.generation++;
		this.stopInternal();
		this.entries = [];
		this.lastIdentity = undefined;
		this.post({ type: 'cleared' });
		this.postState();
	}

	private disposeView(): void {
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
		if (this.apiRequested) {
			return;
		}
		this.apiRequested = true;
		this.api = await getProvidersApi();
		if (this.api) {
			this.viewDisposables.push(this.api.onDidChangeActive(() => this.handleActiveChanged()));
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
		this.entries.push({ kind: 'user', text });
		const assistant: MutableEntry = { kind: 'assistant', text: '' };
		this.entries.push(assistant);
		this.postHistory();

		const generation = ++this.generation;
		const controller = new AbortController();
		this.abort = controller;
		this.setStreaming(true);

		try {
			const request = {
				model: active.model,
				messages: toProviderMessages(this.entries.slice(0, this.entries.length - 1)),
			};
			for await (const chunk of active.provider.chat(request, controller.signal)) {
				if (controller.signal.aborted || generation !== this.generation) {
					break;
				}
				if (chunk.type === 'text') {
					assistant.text += chunk.text;
					this.post({ type: 'assistantDelta', text: chunk.text });
				} else if (chunk.type === 'done') {
					this.post({ type: 'assistantDone', usage: chunk.usage });
					break;
				} else if (chunk.type === 'error') {
					const classified = classifyChatError({ message: chunk.message, status: chunk.status });
					if (classified.kind === 'key-rejected') {
						this.api?.reportKeyRejected(active.providerId);
					}
					this.post({ type: 'assistantError', kind: classified.kind, message: classified.message });
					break;
				}
				// toolCall chunks are ignored in M1 (no tools yet)
			}
		} catch (err) {
			if (!controller.signal.aborted && generation === this.generation) {
				const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
					? (err as { status: number }).status
					: undefined;
				// Never forward the raw error text/object; classify into a safe message.
				const classified = classifyChatError({ message: '', status });
				this.post({ type: 'assistantError', kind: classified.kind, message: classified.message });
			}
		} finally {
			if (generation === this.generation) {
				this.abort = undefined;
				this.setStreaming(false);
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

	private stopInternal(): void {
		this.abort?.abort();
		this.abort = undefined;
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
		this.entries.push({
			kind: 'notice',
			text: `Switched to ${active.providerName} (${identity.kind}). Earlier messages in this chat will be sent to it.`,
		});
		this.postHistory();
	}

	private postHistory(): void {
		this.post({ type: 'history', entries: this.entries.map(entry => ({ kind: entry.kind, text: entry.text })) });
	}

	private postState(): void {
		const active = this.api?.getActive();
		this.post({
			type: 'state',
			...(active ? { active: { providerName: active.providerName, model: active.model } } : {}),
			streaming: this.streaming,
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

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
