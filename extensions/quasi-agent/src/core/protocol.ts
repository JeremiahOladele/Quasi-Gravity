/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownBlock, isAllowedLink, validateMarkdownBlocks } from './markdown';
import { ConversationEntry } from './messages';

const MAX_TEXT_LENGTH = 100_000;
const MAX_ID_LENGTH = 200;
const MAX_BLOCK_INDEX = 100_000;
const MAX_DIFF_LENGTH = 20_000;

export type HostErrorKind = 'no-model' | 'key-rejected' | 'offline' | 'rate-limited' | 'provider-error';

/** Frames the webview may send to the host. No ids, URLs, or keys. */
export type WebviewToHost =
	| { readonly type: 'ready' }
	| { readonly type: 'send'; readonly text: string }
	| { readonly type: 'stop' }
	| { readonly type: 'newChat' }
	| { readonly type: 'addProvider' }
	| { readonly type: 'setApiKey' }
	| { readonly type: 'approvalResponse'; readonly id: string; readonly approved: boolean }
	| { readonly type: 'copy'; readonly messageId: string; readonly blockIndex: number }
	| { readonly type: 'openLink'; readonly url: string }
	| { readonly type: 'openDiff'; readonly id: string }
	| { readonly type: 'revertChange'; readonly id: string }
	| { readonly type: 'revertAll' };

/** Frames the host may send to the webview. Never carries raw errors or secrets. */
export type HostToWebview =
	| { readonly type: 'history'; readonly entries: ReadonlyArray<ConversationEntry> }
	| { readonly type: 'state'; readonly active?: { readonly providerName: string; readonly model: string }; readonly streaming: boolean }
	| { readonly type: 'assistantMarkdown'; readonly messageId: string; readonly blocks: ReadonlyArray<MarkdownBlock> }
	| { readonly type: 'assistantDone'; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } }
	| { readonly type: 'assistantError'; readonly kind: HostErrorKind; readonly message: string }
	| { readonly type: 'toolCall'; readonly name: string; readonly arguments: string }
	| { readonly type: 'toolResult'; readonly name: string; readonly summary: string; readonly isError: boolean }
	| { readonly type: 'approvalRequest'; readonly id: string; readonly toolName: string; readonly reason: ApprovalReason; readonly detail: string; readonly diff?: string }
	| { readonly type: 'approvalResolved'; readonly id: string; readonly approved: boolean }
	| { readonly type: 'change'; readonly id: string; readonly path: string; readonly summary: string; readonly diff: string; readonly diffTruncated: boolean; readonly canRevert: boolean }
	| { readonly type: 'changeReverted'; readonly id: string }
	| { readonly type: 'changesReverted' }
	| { readonly type: 'undoState'; readonly canRevertAll: boolean }
	| { readonly type: 'notice'; readonly text: string }
	| { readonly type: 'cleared' }
	| { readonly type: 'busy'; readonly value: boolean };

export type ApprovalReason = 'sensitive-file' | 'outside-workspace' | 'protected-path' | 'delete' | 'bulk-change' | 'destructive-write';

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
		case 'approvalResponse':
			if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_LENGTH && typeof raw.approved === 'boolean') {
				return { type: 'approvalResponse', id: raw.id, approved: raw.approved };
			}
			return undefined;
		case 'copy':
			if (typeof raw.messageId === 'string' && raw.messageId.length > 0 && raw.messageId.length <= MAX_ID_LENGTH
				&& typeof raw.blockIndex === 'number' && Number.isInteger(raw.blockIndex) && raw.blockIndex >= 0 && raw.blockIndex <= MAX_BLOCK_INDEX) {
				return { type: 'copy', messageId: raw.messageId, blockIndex: raw.blockIndex };
			}
			return undefined;
		case 'openLink':
			if (typeof raw.url === 'string' && isAllowedLink(raw.url)) {
				return { type: 'openLink', url: raw.url.trim() };
			}
			return undefined;
		case 'openDiff':
		case 'revertChange':
			if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_LENGTH) {
				return { type: raw.type, id: raw.id };
			}
			return undefined;
		case 'revertAll':
			return { type: 'revertAll' };
		default:
			return undefined;
	}
}

function parseEntry(raw: unknown): ConversationEntry | undefined {
	if (!isObject(raw)) {
		return undefined;
	}
	if (raw.kind === 'tool') {
		if (isBoundedString(raw.name) && isBoundedString(raw.args) && isBoundedString(raw.summary) && typeof raw.isError === 'boolean') {
			return { kind: 'tool', name: raw.name, args: raw.args, summary: raw.summary, isError: raw.isError };
		}
		return undefined;
	}
	if (!isBoundedString(raw.text)) {
		return undefined;
	}
	if (raw.kind === 'assistant') {
		let blocks: MarkdownBlock[] | undefined;
		if (raw.blocks !== undefined) {
			blocks = validateMarkdownBlocks(raw.blocks);
			if (!blocks) {
				return undefined;
			}
		}
		const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_LENGTH ? raw.id : undefined;
		return { kind: 'assistant', text: raw.text, ...(id ? { id } : {}), ...(blocks ? { blocks } : {}) };
	}
	if (raw.kind === 'user' || raw.kind === 'notice') {
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
		case 'assistantMarkdown': {
			if (typeof raw.messageId !== 'string' || raw.messageId.length === 0 || raw.messageId.length > MAX_ID_LENGTH) {
				return undefined;
			}
			const blocks = validateMarkdownBlocks(raw.blocks);
			return blocks ? { type: 'assistantMarkdown', messageId: raw.messageId, blocks } : undefined;
		}
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
		case 'toolCall':
			if (typeof raw.name === 'string' && raw.name.length > 0 && isBoundedString(raw.name) && isBoundedString(raw.arguments)) {
				return { type: 'toolCall', name: raw.name, arguments: raw.arguments };
			}
			return undefined;
		case 'toolResult':
			if (isBoundedString(raw.name) && isBoundedString(raw.summary) && typeof raw.isError === 'boolean') {
				return { type: 'toolResult', name: raw.name, summary: raw.summary, isError: raw.isError };
			}
			return undefined;
		case 'approvalRequest': {
			const reasons: ReadonlyArray<ApprovalReason> = ['sensitive-file', 'outside-workspace', 'protected-path', 'delete', 'bulk-change', 'destructive-write'];
			if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 200
				&& isBoundedString(raw.toolName)
				&& typeof raw.reason === 'string' && (reasons as ReadonlyArray<string>).includes(raw.reason)
				&& isBoundedString(raw.detail)) {
				let diff: string | undefined;
				if (raw.diff !== undefined) {
					if (typeof raw.diff !== 'string' || raw.diff.length > MAX_DIFF_LENGTH) {
						return undefined;
					}
					diff = raw.diff;
				}
				return { type: 'approvalRequest', id: raw.id, toolName: raw.toolName, reason: raw.reason as ApprovalReason, detail: raw.detail, ...(diff !== undefined ? { diff } : {}) };
			}
			return undefined;
		}
		case 'change': {
			if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_LENGTH
				&& isBoundedString(raw.path)
				&& isBoundedString(raw.summary)
				&& typeof raw.diff === 'string' && raw.diff.length <= MAX_DIFF_LENGTH
				&& typeof raw.diffTruncated === 'boolean'
				&& typeof raw.canRevert === 'boolean') {
				return { type: 'change', id: raw.id, path: raw.path, summary: raw.summary, diff: raw.diff, diffTruncated: raw.diffTruncated, canRevert: raw.canRevert };
			}
			return undefined;
		}
		case 'changeReverted':
			if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= MAX_ID_LENGTH) {
				return { type: 'changeReverted', id: raw.id };
			}
			return undefined;
		case 'changesReverted':
			return { type: 'changesReverted' };
		case 'undoState':
			return typeof raw.canRevertAll === 'boolean' ? { type: 'undoState', canRevertAll: raw.canRevertAll } : undefined;
		case 'approvalResolved':
			if (typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 200 && typeof raw.approved === 'boolean') {
				return { type: 'approvalResolved', id: raw.id, approved: raw.approved };
			}
			return undefined;
		case 'notice':
			return isBoundedString(raw.text) ? { type: 'notice', text: raw.text } : undefined;
		case 'cleared':
			return { type: 'cleared' };
		case 'busy':
			return typeof raw.value === 'boolean' ? { type: 'busy', value: raw.value } : undefined;
		default:
			return undefined;
	}
}
