/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConversationEntry } from './messages';

const MAX_TEXT_LENGTH = 100_000;

export type HostErrorKind = 'no-model' | 'key-rejected' | 'offline' | 'rate-limited' | 'provider-error';

/** Frames the webview may send to the host. No ids, URLs, or keys. */
export type WebviewToHost =
	| { readonly type: 'ready' }
	| { readonly type: 'send'; readonly text: string }
	| { readonly type: 'stop' }
	| { readonly type: 'newChat' }
	| { readonly type: 'addProvider' }
	| { readonly type: 'setApiKey' };

/** Frames the host may send to the webview. Never carries raw errors or secrets. */
export type HostToWebview =
	| { readonly type: 'history'; readonly entries: ReadonlyArray<ConversationEntry> }
	| { readonly type: 'state'; readonly active?: { readonly providerName: string; readonly model: string }; readonly streaming: boolean }
	| { readonly type: 'assistantDelta'; readonly text: string }
	| { readonly type: 'assistantDone'; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } }
	| { readonly type: 'assistantError'; readonly kind: HostErrorKind; readonly message: string }
	| { readonly type: 'cleared' }
	| { readonly type: 'busy'; readonly value: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

export function parseWebviewToHost(raw: unknown): WebviewToHost | undefined {
	if (!isObject(raw) || typeof raw.type !== 'string') {
		return undefined;
	}
	switch (raw.type) {
		case 'ready':
		case 'stop':
		case 'newChat':
		case 'addProvider':
		case 'setApiKey':
			return { type: raw.type };
		case 'send':
			if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > MAX_TEXT_LENGTH) {
				return undefined;
			}
			return { type: 'send', text: raw.text };
		default:
			return undefined;
	}
}

function parseEntry(raw: unknown): ConversationEntry | undefined {
	if (!isObject(raw) || !isBoundedString(raw.text)) {
		return undefined;
	}
	if (raw.kind === 'user' || raw.kind === 'assistant' || raw.kind === 'notice') {
		return { kind: raw.kind, text: raw.text };
	}
	return undefined;
}

function parseEntries(raw: unknown): ConversationEntry[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const entries: ConversationEntry[] = [];
	for (const item of raw) {
		const entry = parseEntry(item);
		if (!entry) {
			return undefined;
		}
		entries.push(entry);
	}
	return entries;
}

export function parseHostToWebview(raw: unknown): HostToWebview | undefined {
	if (!isObject(raw) || typeof raw.type !== 'string') {
		return undefined;
	}
	switch (raw.type) {
		case 'history': {
			const entries = parseEntries(raw.entries);
			return entries ? { type: 'history', entries } : undefined;
		}
		case 'state': {
			if (typeof raw.streaming !== 'boolean') {
				return undefined;
			}
			if (raw.active === undefined) {
				return { type: 'state', streaming: raw.streaming };
			}
			if (isObject(raw.active) && isBoundedString(raw.active.providerName) && isBoundedString(raw.active.model)) {
				return { type: 'state', streaming: raw.streaming, active: { providerName: raw.active.providerName, model: raw.active.model } };
			}
			return undefined;
		}
		case 'assistantDelta':
			return isBoundedString(raw.text) ? { type: 'assistantDelta', text: raw.text } : undefined;
		case 'assistantDone': {
			if (raw.usage === undefined) {
				return { type: 'assistantDone' };
			}
			if (!isObject(raw.usage)) {
				return undefined;
			}
			const inputTokens = typeof raw.usage.inputTokens === 'number' ? raw.usage.inputTokens : undefined;
			const outputTokens = typeof raw.usage.outputTokens === 'number' ? raw.usage.outputTokens : undefined;
			return { type: 'assistantDone', usage: { inputTokens, outputTokens } };
		}
		case 'assistantError': {
			const kinds: ReadonlyArray<HostErrorKind> = ['no-model', 'key-rejected', 'offline', 'rate-limited', 'provider-error'];
			if (typeof raw.kind === 'string' && (kinds as ReadonlyArray<string>).includes(raw.kind) && isBoundedString(raw.message)) {
				return { type: 'assistantError', kind: raw.kind as HostErrorKind, message: raw.message };
			}
			return undefined;
		}
		case 'cleared':
			return { type: 'cleared' };
		case 'busy':
			return typeof raw.value === 'boolean' ? { type: 'busy', value: raw.value } : undefined;
		default:
			return undefined;
	}
}
