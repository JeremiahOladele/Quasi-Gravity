/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseHostToWebview, parseWebviewToHost } from '../core/protocol';

describe('parseWebviewToHost', () => {
	it('accepts bare request frames', () => {
		for (const type of ['ready', 'stop', 'newChat', 'addProvider', 'setApiKey']) {
			assert.deepStrictEqual(parseWebviewToHost({ type }), { type });
		}
	});

	it('accepts send with bounded text', () => {
		assert.deepStrictEqual(parseWebviewToHost({ type: 'send', text: 'hello' }), { type: 'send', text: 'hello' });
	});

	it('rejects invalid frames', () => {
		assert.strictEqual(parseWebviewToHost({ type: 'send', text: '' }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'send', text: 'x'.repeat(100_001) }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'send', text: 42 }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'unknown' }), undefined);
		assert.deepStrictEqual(parseWebviewToHost({ type: 'send', text: 'hi', providerId: 'x' }), { type: 'send', text: 'hi' });
		assert.strictEqual(parseWebviewToHost('nope'), undefined);
		assert.strictEqual(parseWebviewToHost(null), undefined);
	});
});

describe('parseHostToWebview', () => {
	it('accepts history and state frames', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'history', entries: [{ kind: 'user', text: 'hi' }, { kind: 'notice', text: 'note' }] }),
			{ type: 'history', entries: [{ kind: 'user', text: 'hi' }, { kind: 'notice', text: 'note' }] }
		);
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'state', active: { providerName: 'P', model: 'm' }, streaming: false }),
			{ type: 'state', active: { providerName: 'P', model: 'm' }, streaming: false }
		);
		assert.deepStrictEqual(parseHostToWebview({ type: 'state', streaming: true }), { type: 'state', streaming: true });
	});

	it('accepts stream and status frames', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'assistantMarkdown', messageId: 'm1', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }] }),
			{ type: 'assistantMarkdown', messageId: 'm1', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }] }
		);
		assert.deepStrictEqual(parseHostToWebview({ type: 'assistantDone' }), { type: 'assistantDone' });
		assert.deepStrictEqual(parseHostToWebview({ type: 'busy', value: true }), { type: 'busy', value: true });
		assert.deepStrictEqual(parseHostToWebview({ type: 'cleared' }), { type: 'cleared' });
	});

	it('rejects malformed markdown frames', () => {
		assert.strictEqual(parseHostToWebview({ type: 'assistantMarkdown', messageId: '', blocks: [] }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'assistantMarkdown', messageId: 'm', blocks: [{ type: 'unknown' }] }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'assistantMarkdown', messageId: 'm', blocks: 'nope' }), undefined);
	});

	it('accepts only whitelisted error kinds with redacted text', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'assistantError', kind: 'rate-limited', message: 'slow down' }),
			{ type: 'assistantError', kind: 'rate-limited', message: 'slow down' }
		);
		assert.strictEqual(parseHostToWebview({ type: 'assistantError', kind: 'weird', message: 'x' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'assistantError', kind: 'offline', message: 5 }), undefined);
	});

	it('rejects malformed frames', () => {
		assert.strictEqual(parseHostToWebview({ type: 'history', entries: [{ kind: 'user' }] }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'history', entries: 'nope' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'state', active: { providerName: 'P' }, streaming: false }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'state' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'unknown' }), undefined);
	});
});

describe('M2 protocol frames', () => {
	it('parses approval responses', () => {
		assert.deepStrictEqual(parseWebviewToHost({ type: 'approvalResponse', id: 'abc', approved: true }), { type: 'approvalResponse', id: 'abc', approved: true });
		assert.strictEqual(parseWebviewToHost({ type: 'approvalResponse', id: '', approved: true }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'approvalResponse', id: 'x', approved: 'yes' }), undefined);
	});

	it('parses tool call and result frames', () => {
		assert.deepStrictEqual(parseHostToWebview({ type: 'toolCall', name: 'read_file', arguments: '{}' }), { type: 'toolCall', name: 'read_file', arguments: '{}' });
		assert.deepStrictEqual(parseHostToWebview({ type: 'toolResult', name: 'read_file', summary: 'ok', isError: false }), { type: 'toolResult', name: 'read_file', summary: 'ok', isError: false });
		assert.strictEqual(parseHostToWebview({ type: 'toolCall', name: '', arguments: '{}' }), undefined);
		assert.strictEqual(parseHostToWebview({ type: 'toolResult', name: 'x', summary: 'y' }), undefined);
	});

	it('parses approval frames and notices', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'approvalRequest', id: 'a1', toolName: 'read_file', reason: 'sensitive-file', detail: '.env' }),
			{ type: 'approvalRequest', id: 'a1', toolName: 'read_file', reason: 'sensitive-file', detail: '.env' }
		);
		assert.strictEqual(parseHostToWebview({ type: 'approvalRequest', id: 'a1', toolName: 't', reason: 'weird', detail: 'd' }), undefined);
		assert.deepStrictEqual(parseHostToWebview({ type: 'approvalResolved', id: 'a1', approved: false }), { type: 'approvalResolved', id: 'a1', approved: false });
		assert.deepStrictEqual(parseHostToWebview({ type: 'notice', text: 'hello' }), { type: 'notice', text: 'hello' });
	});

	it('parses tool entries in history', () => {
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'history', entries: [{ kind: 'tool', name: 'read_file', args: '{}', summary: 'ok', isError: false }] }),
			{ type: 'history', entries: [{ kind: 'tool', name: 'read_file', args: '{}', summary: 'ok', isError: false }] }
		);
		assert.strictEqual(parseHostToWebview({ type: 'history', entries: [{ kind: 'tool', name: 'x' }] }), undefined);
	});
});

describe('markdown and link protocol frames', () => {
	it('accepts copy frames with a message id and block index', () => {
		assert.deepStrictEqual(parseWebviewToHost({ type: 'copy', messageId: 'm1', blockIndex: 2 }), { type: 'copy', messageId: 'm1', blockIndex: 2 });
		assert.strictEqual(parseWebviewToHost({ type: 'copy', messageId: '', blockIndex: 0 }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'copy', messageId: 'm1', blockIndex: -1 }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'copy', messageId: 'm1', blockIndex: '0' }), undefined);
	});

	it('accepts only http/https openLink frames', () => {
		assert.deepStrictEqual(parseWebviewToHost({ type: 'openLink', url: 'https://example.com' }), { type: 'openLink', url: 'https://example.com' });
		assert.strictEqual(parseWebviewToHost({ type: 'openLink', url: 'javascript:alert(1)' }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'openLink', url: 'file:///etc/passwd' }), undefined);
	});

	it('parses assistant history entries with blocks', () => {
		const blocks = [{ type: 'heading', level: 2, children: [{ type: 'text', text: 'Hi' }] }];
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'history', entries: [{ kind: 'assistant', text: '## Hi', id: 'm1', blocks }] }),
			{ type: 'history', entries: [{ kind: 'assistant', text: '## Hi', id: 'm1', blocks }] }
		);
		assert.strictEqual(parseHostToWebview({ type: 'history', entries: [{ kind: 'assistant', text: 'x', blocks: [{ type: 'bad' }] }] }), undefined);
	});
});

describe('editing and undo protocol frames', () => {
	it('accepts webview editing requests with bounded ids', () => {
		assert.deepStrictEqual(parseWebviewToHost({ type: 'openDiff', id: 'c1' }), { type: 'openDiff', id: 'c1' });
		assert.deepStrictEqual(parseWebviewToHost({ type: 'revertChange', id: 'c1' }), { type: 'revertChange', id: 'c1' });
		assert.deepStrictEqual(parseWebviewToHost({ type: 'revertAll' }), { type: 'revertAll' });
		assert.strictEqual(parseWebviewToHost({ type: 'openDiff', id: '' }), undefined);
		assert.strictEqual(parseWebviewToHost({ type: 'revertChange' }), undefined);
	});

	it('parses change and undo-state frames', () => {
		const change = { type: 'change', id: 'c1', path: 'src/a.ts', summary: 'Edited src/a.ts', diff: ' a\n-b\n+c', diffTruncated: false, canRevert: true };
		assert.deepStrictEqual(parseHostToWebview(change), change);
		assert.strictEqual(parseHostToWebview({ ...change, diff: 'x'.repeat(20_001) }), undefined);
		assert.strictEqual(parseHostToWebview({ ...change, canRevert: 'yes' }), undefined);
		assert.deepStrictEqual(parseHostToWebview({ type: 'changeReverted', id: 'c1' }), { type: 'changeReverted', id: 'c1' });
		assert.deepStrictEqual(parseHostToWebview({ type: 'changesReverted' }), { type: 'changesReverted' });
		assert.deepStrictEqual(parseHostToWebview({ type: 'undoState', canRevertAll: true }), { type: 'undoState', canRevertAll: true });
		assert.strictEqual(parseHostToWebview({ type: 'undoState', canRevertAll: 1 }), undefined);
	});

	it('accepts approval frames with new reasons and a capped diff', () => {
		const frame = { type: 'approvalRequest', id: 'a1', toolName: 'write_file', reason: 'protected-path', detail: '.git/config', diff: '-a\n+b' };
		assert.deepStrictEqual(parseHostToWebview(frame), frame);
		assert.deepStrictEqual(
			parseHostToWebview({ type: 'approvalRequest', id: 'a2', toolName: 'delete_file', reason: 'delete', detail: 'x' }),
			{ type: 'approvalRequest', id: 'a2', toolName: 'delete_file', reason: 'delete', detail: 'x' }
		);
		assert.strictEqual(parseHostToWebview({ ...frame, diff: 'x'.repeat(20_001) }), undefined);
		assert.strictEqual(parseHostToWebview({ ...frame, reason: 'weird' }), undefined);
	});
});
