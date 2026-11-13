/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { AgentLoopCallbacks, AgentLoopOptions, compactHistory, runAgentLoop } from '../core/agentLoop';
import { ChatChunk, ChatMessage, ChatRequest } from '../core/providerApi';
import { ToolDef } from '../core/tools/registry';
import { HISTORY_OMITTED_MARKER } from '../core/tools/truncate';

describe('compactHistory', () => {
	it('replaces older tool results until under budget', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'q' },
			{ role: 'tool', content: 'x'.repeat(100) },
			{ role: 'assistant', content: 'a' },
			{ role: 'tool', content: 'y'.repeat(100) }
		];
		compactHistory(messages, 150);
		assert.strictEqual(messages[1].content, HISTORY_OMITTED_MARKER);
		assert.strictEqual(messages[3].content, 'y'.repeat(100));
	});

	it('leaves history alone when under budget', () => {
		const messages: ChatMessage[] = [{ role: 'tool', content: 'small' }];
		compactHistory(messages, 1000);
		assert.strictEqual(messages[0].content, 'small');
	});
});

function fakeProvider(scripts: ChatChunk[][], requests: ChatRequest[]): { chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> } {
	let index = 0;
	return {
		chat(req: ChatRequest): AsyncIterable<ChatChunk> {
			requests.push(req);
			const chunks = scripts[Math.min(index, scripts.length - 1)] ?? [];
			index++;
			return (async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			})();
		}
	};
}

function toolCall(name: string, args: string, id = 'call-1'): ChatChunk {
	return { type: 'toolCall', call: { id, type: 'function', function: { name, arguments: args } } };
}

function makeTool(name: string, run: ToolDef['run'], overrides: Partial<ToolDef> = {}): ToolDef {
	return {
		name,
		description: name,
		parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
		requires: ['fs.read'],
		risk: 'read',
		run,
		...overrides
	};
}

function makeRecorder(): {
	callbacks: AgentLoopCallbacks;
	texts: string[];
	results: Array<{ name: string; summary: string; isError: boolean }>;
	notices: string[];
	errors: Array<{ kind: string; message: string }>;
	done: () => number;
	rejected: () => number;
} {
	const texts: string[] = [];
	const results: Array<{ name: string; summary: string; isError: boolean }> = [];
	const notices: string[] = [];
	const errors: Array<{ kind: string; message: string }> = [];
	let doneCount = 0;
	let rejectedCount = 0;
	return {
		callbacks: {
			onText: text => texts.push(text),
			onToolCall: () => { },
			onToolResult: (name, summary, isError) => results.push({ name, summary, isError }),
			onNotice: text => notices.push(text),
			onError: (kind, message) => errors.push({ kind, message }),
			onDone: () => { doneCount++; },
			onToolsRejected: () => { rejectedCount++; }
		},
		texts,
		results,
		notices,
		errors,
		done: () => doneCount,
		rejected: () => rejectedCount
	};
}

function buildOptions(overrides: Partial<AgentLoopOptions> & { callbacks: AgentLoopCallbacks }): AgentLoopOptions {
	return {
		provider: fakeProvider([[]], []),
		model: 'm',
		systemPrompt: '',
		history: [],
		userText: 'hello',
		tools: [],
		toolSupport: 'supported',
		approvalBroker: { requestApproval: async () => true, cancelAll: () => { } },
		maxIterations: 25,
		signal: new AbortController().signal,
		...overrides
	};
}

describe('runAgentLoop', () => {
	it('runs plain chat with no tools', async () => {
		const requests: ChatRequest[] = [];
		const provider = fakeProvider([[{ type: 'text', text: 'hi' }, { type: 'done' }]], requests);
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, callbacks: recorder.callbacks }));
		assert.strictEqual(result.finalText, 'hi');
		assert.strictEqual(result.iterations, 1);
		assert.deepStrictEqual(recorder.texts, ['hi']);
		assert.strictEqual(recorder.done(), 1);
		assert.strictEqual(requests[0].tools, undefined);
		assert.strictEqual(result.history.at(-1)?.role, 'assistant');
	});

	it('executes a tool call and then answers', async () => {
		const requests: ChatRequest[] = [];
		const provider = fakeProvider([
			[toolCall('echo', '{"path":"a"}'), { type: 'done' }],
			[{ type: 'text', text: 'done' }, { type: 'done' }]
		], requests);
		const echo = makeTool('echo', async args => ({ content: `read ${args.path}`, summary: `read ${args.path}` }));
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [echo], callbacks: recorder.callbacks }));
		assert.strictEqual(result.iterations, 2);
		assert.strictEqual(result.finalText, 'done');
		assert.deepStrictEqual(recorder.results, [{ name: 'echo', summary: 'read a', isError: false }]);
		assert.ok(requests[0].tools && requests[0].tools.length === 1);
		assert.ok(result.history.some(message => message.role === 'assistant' && message.toolCalls?.length === 1));
		assert.ok(result.history.some(message => message.role === 'tool' && message.content.includes('read a')));
	});

	it('stops at the iteration cap and asks the user to continue', async () => {
		let counter = 0;
		const provider = {
			chat(): AsyncIterable<ChatChunk> {
				counter++;
				const current = counter;
				return (async function* () {
					yield toolCall('echo', JSON.stringify({ path: `f${current}` }), `c${current}`);
					yield { type: 'done' } as ChatChunk;
				})();
			}
		};
		const echo = makeTool('echo', async () => ({ content: 'ok', summary: 'ok' }));
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [echo], maxIterations: 2, callbacks: recorder.callbacks }));
		assert.strictEqual(result.capped, true);
		assert.ok(recorder.notices.some(text => text.includes('Stopped after 2')));
	});

	it('aborts before starting', async () => {
		const controller = new AbortController();
		controller.abort();
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ signal: controller.signal, callbacks: recorder.callbacks }));
		assert.strictEqual(result.aborted, true);
		assert.strictEqual(result.iterations, 0);
	});

	it('keeps history valid when aborted with pending tool calls', async () => {
		const controller = new AbortController();
		const provider = fakeProvider([[
			toolCall('abort', '{}', 'c1'),
			toolCall('abort', '{}', 'c2'),
			{ type: 'done' }
		]], []);
		const abortTool = makeTool('abort', async () => {
			controller.abort();
			return { content: 'ignored', summary: 'ignored' };
		});
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [abortTool], signal: controller.signal, callbacks: recorder.callbacks }));
		assert.strictEqual(result.aborted, true);
		const toolMessages = result.history.filter(message => message.role === 'tool');
		assert.strictEqual(toolMessages.length, 2);
		assert.ok(toolMessages.every(message => message.content === 'Cancelled.'));
	});

	it('returns error results for malformed, unknown, and invalid calls without throwing', async () => {
		const provider = fakeProvider([
			[
				toolCall('echo', 'not json', 'c1'),
				toolCall('missing', '{}', 'c2'),
				toolCall('echo', '{"extra":1}', 'c3'),
				{ type: 'done' }
			],
			[{ type: 'text', text: 'handled' }, { type: 'done' }]
		], []);
		const echo = makeTool('echo', async () => ({ content: 'ok', summary: 'ok' }));
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [echo], callbacks: recorder.callbacks }));
		assert.strictEqual(result.finalText, 'handled');
		assert.strictEqual(recorder.results.length, 3);
		assert.ok(recorder.results.every(entry => entry.isError));
		assert.ok(recorder.results[0].summary.includes('Invalid JSON'));
		assert.ok(recorder.results[1].summary.includes('Unknown tool'));
		assert.ok(recorder.results[2].summary.includes('unknown argument'));
	});

	it('retries once without tools when the provider rejects tools', async () => {
		const requests: ChatRequest[] = [];
		const provider = fakeProvider([
			[{ type: 'error', message: 'tools are not supported', status: 400 }],
			[{ type: 'text', text: 'plain' }, { type: 'done' }]
		], requests);
		const echo = makeTool('echo', async () => ({ content: 'ok', summary: 'ok' }));
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [echo], toolSupport: 'unknown', callbacks: recorder.callbacks }));
		assert.strictEqual(result.toolsDisabled, true);
		assert.strictEqual(result.finalText, 'plain');
		assert.strictEqual(recorder.rejected(), 1);
		assert.ok(requests[0].tools);
		assert.strictEqual(requests[1].tools, undefined);
	});

	it('does not retry on auth errors', async () => {
		const requests: ChatRequest[] = [];
		const provider = fakeProvider([[{ type: 'error', message: 'unauthorized', status: 401 }]], requests);
		const echo = makeTool('echo', async () => ({ content: 'ok', summary: 'ok' }));
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [echo], toolSupport: 'unknown', callbacks: recorder.callbacks }));
		assert.strictEqual(recorder.errors[0]?.kind, 'key-rejected');
		assert.strictEqual(recorder.rejected(), 0);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(result.toolsDisabled, false);
	});

	it('stops after repeated identical failures', async () => {
		const provider = fakeProvider([[toolCall('fail', '{}', 'c1'), { type: 'done' }]], []);
		const failTool = makeTool('fail', async () => ({ content: 'boom', summary: 'boom', isError: true }));
		const recorder = makeRecorder();
		const result = await runAgentLoop(buildOptions({ provider, tools: [failTool], callbacks: recorder.callbacks }));
		assert.strictEqual(result.repeatedFailure, true);
		assert.ok(recorder.notices.some(text => text.includes('repeated a failing tool call')));
	});

	it('never forwards key-like text from an auth error', async () => {
		const provider = fakeProvider([[{ type: 'error', message: 'bad key sk-secret-1234567890', status: 401 }]], []);
		const recorder = makeRecorder();
		await runAgentLoop(buildOptions({ provider, callbacks: recorder.callbacks }));
		assert.ok(!JSON.stringify(recorder.errors).includes('sk-secret-1234567890'));
	});
});
