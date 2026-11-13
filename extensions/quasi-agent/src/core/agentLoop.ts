/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { classifyChatError } from './errors';
import { ChatChunk, ChatMessage, ChatRequest, ToolCall } from './providerApi';
import { HostErrorKind } from './protocol';
import {
	ApprovalPrompt,
	ToolDef,
	ToolRegistry,
	ToolResult,
	buildToolSpecs,
	createBoundary,
	isObject,
	validateToolArguments,
	wrapToolResult
} from './tools/registry';
import { HISTORY_OMITTED_MARKER, totalContentLength, truncateText } from './tools/truncate';
import { ApprovalBroker } from './approvals';

export const DEFAULT_MAX_ITERATIONS = 25;
export const MAX_TOOL_RESULT_CHARS = 20_000;
export const HISTORY_BUDGET_CHARS = 200_000;
export const REPEAT_FAILURE_LIMIT = 2;

export interface AgentLoopCallbacks {
	onText(delta: string): void;
	onToolCall(name: string, argumentsText: string): void;
	onToolResult(name: string, summary: string, isError: boolean): void;
	onNotice(text: string): void;
	onError(kind: HostErrorKind, message: string): void;
	onDone(usage?: { inputTokens?: number; outputTokens?: number }): void;
	onToolsRejected?(): void;
}

export interface AgentLoopOptions {
	readonly provider: { chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> };
	readonly model: string;
	readonly systemPrompt: string;
	readonly history: ReadonlyArray<ChatMessage>;
	readonly userText: string;
	readonly tools: ReadonlyArray<ToolDef>;
	readonly toolSupport: 'supported' | 'unsupported' | 'unknown';
	readonly approvalBroker: ApprovalBroker;
	readonly maxIterations?: number;
	readonly signal: AbortSignal;
	readonly callbacks: AgentLoopCallbacks;
}

export interface AgentLoopResult {
	readonly history: ChatMessage[];
	readonly finalText: string;
	readonly iterations: number;
	readonly capped: boolean;
	readonly aborted: boolean;
	readonly toolsDisabled: boolean;
	readonly repeatedFailure: boolean;
}

interface ChatFailure {
	readonly status?: number;
	readonly message: string;
}

interface ToolOutcome {
	readonly kind: 'ok';
	readonly content: string;
	readonly summary: string;
	readonly isError: boolean;
}

interface ToolAborted {
	readonly kind: 'aborted';
}

function statusOf(error: unknown): number | undefined {
	if (error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number') {
		return (error as { status: number }).status;
	}
	return undefined;
}

function isToolsRejection(failure: ChatFailure): boolean {
	return (failure.status === 400 || failure.status === 422) && /\b(tools?|functions?)\b/i.test(failure.message);
}

function signatureOf(call: ToolCall): string {
	return `${call.function.name}\u0000${call.function.arguments}`;
}

/** Replace older tool-result contents with a marker to stay within budget. */
export function compactHistory(messages: ChatMessage[], budget: number): void {
	let total = totalContentLength(messages);
	if (total <= budget) {
		return;
	}
	for (const message of messages) {
		if (total <= budget) {
			return;
		}
		if (message.role === 'tool' && message.content !== HISTORY_OMITTED_MARKER) {
			total -= message.content.length;
			message.content = HISTORY_OMITTED_MARKER;
			total += HISTORY_OMITTED_MARKER.length;
		}
	}
}

async function runOneTool(
	call: ToolCall,
	options: AgentLoopOptions,
	registry: ToolRegistry,
	boundary: string
): Promise<ToolOutcome | ToolAborted> {
	const name = call.function.name;
	const errorOutcome = (message: string): ToolOutcome => ({
		kind: 'ok',
		content: wrapToolResult(boundary, name, message, true),
		summary: message,
		isError: true
	});

	const tool = registry.get(name);
	if (!tool) {
		return errorOutcome(`Unknown tool '${name}'.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(call.function.arguments.length > 0 ? call.function.arguments : '{}');
	} catch {
		return errorOutcome('Invalid JSON in tool arguments.');
	}
	if (!isObject(parsed)) {
		return errorOutcome('Tool arguments must be a JSON object.');
	}

	const validation = validateToolArguments(tool.parameters, parsed);
	if (!validation.ok) {
		return errorOutcome(validation.error);
	}

	let prompt: ApprovalPrompt | undefined;
	try {
		prompt = tool.needsApproval ? await tool.needsApproval(validation.value, options.signal) : undefined;
	} catch {
		return errorOutcome('Could not evaluate whether this call needs approval.');
	}
	if (prompt) {
		let approved: boolean;
		try {
			approved = await options.approvalBroker.requestApproval(prompt, options.signal);
		} catch {
			return errorOutcome('Approval could not be requested.');
		}
		if (options.signal.aborted) {
			return { kind: 'aborted' };
		}
		if (!approved) {
			return errorOutcome('Denied by user.');
		}
	}

	let result: ToolResult;
	try {
		result = await tool.run(validation.value, options.signal);
	} catch {
		// Never echo raw error text: it could contain secrets or absolute paths.
		return errorOutcome('Tool failed.');
	}
	if (options.signal.aborted) {
		return { kind: 'aborted' };
	}

	const content = truncateText(result.content, MAX_TOOL_RESULT_CHARS);
	return {
		kind: 'ok',
		content: wrapToolResult(boundary, name, content.text, !!result.isError),
		summary: result.summary,
		isError: !!result.isError
	};
}

function appendCancelledResults(history: ChatMessage[], calls: ReadonlyArray<ToolCall>, fromIndex: number): void {
	for (let index = fromIndex; index < calls.length; index++) {
		history.push({ role: 'tool', toolCallId: calls[index].id, content: 'Cancelled.' });
	}
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
	const maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
	const boundary = createBoundary();
	const history: ChatMessage[] = options.history.map(message => ({ ...message }));
	history.push({ role: 'user', content: options.userText });

	const registry = new ToolRegistry(options.tools);
	const failures = new Map<string, number>();
	let toolSupport = options.toolSupport;
	let toolsDisabled = toolSupport === 'unsupported';
	let iterations = 0;
	let finalText = '';

	if (toolsDisabled) {
		options.callbacks.onNotice('This model does not support tools; continuing in plain chat.');
	}

	const aborted = (): AgentLoopResult => ({
		history, finalText, iterations, capped: false, aborted: true, toolsDisabled, repeatedFailure: false
	});

	while (true) {
		if (options.signal.aborted) {
			return aborted();
		}
		if (iterations >= maxIterations) {
			options.callbacks.onNotice(`Stopped after ${maxIterations} tool iterations. Send another message to continue.`);
			return { history, finalText, iterations, capped: true, aborted: false, toolsDisabled, repeatedFailure: false };
		}
		iterations++;

		const useTools = !toolsDisabled && options.tools.length > 0;
		compactHistory(history, HISTORY_BUDGET_CHARS);

		let text = '';
		const toolCalls: ToolCall[] = [];
		let usage: { inputTokens?: number; outputTokens?: number } | undefined;
		let failure: ChatFailure | undefined;

		try {
			const requestMessages: ChatMessage[] = options.systemPrompt.length > 0
				? [{ role: 'system', content: options.systemPrompt }, ...history]
				: history;
			const request: ChatRequest = {
				model: options.model,
				messages: requestMessages,
				...(useTools ? { tools: buildToolSpecs(options.tools) } : {})
			};
			for await (const chunk of options.provider.chat(request, options.signal)) {
				if (options.signal.aborted) {
					break;
				}
				if (chunk.type === 'text') {
					text += chunk.text;
					options.callbacks.onText(chunk.text);
				} else if (chunk.type === 'toolCall') {
					toolCalls.push(chunk.call);
				} else if (chunk.type === 'done') {
					usage = chunk.usage;
					break;
				} else if (chunk.type === 'error') {
					failure = { status: chunk.status, message: chunk.message };
					break;
				}
			}
		} catch (err) {
			failure = { status: statusOf(err), message: '' };
		}

		if (options.signal.aborted) {
			if (toolCalls.length > 0) {
				history.push({ role: 'assistant', content: text, toolCalls });
				appendCancelledResults(history, toolCalls, 0);
			}
			return aborted();
		}

		if (failure) {
			if (useTools && toolSupport === 'unknown' && isToolsRejection(failure)) {
				toolSupport = 'unsupported';
				toolsDisabled = true;
				options.callbacks.onToolsRejected?.();
				options.callbacks.onNotice('This model rejected tools; retrying once without tools.');
				continue;
			}
			const classified = classifyChatError(failure);
			options.callbacks.onError(classified.kind, classified.message);
			return { history, finalText: text, iterations, capped: false, aborted: false, toolsDisabled, repeatedFailure: false };
		}

		finalText = text;
		if (toolCalls.length === 0) {
			history.push({ role: 'assistant', content: text });
			options.callbacks.onDone(usage);
			return { history, finalText, iterations, capped: false, aborted: false, toolsDisabled, repeatedFailure: false };
		}

		history.push({ role: 'assistant', content: text, toolCalls });

		for (let index = 0; index < toolCalls.length; index++) {
			const call = toolCalls[index];
			if (options.signal.aborted) {
				appendCancelledResults(history, toolCalls, index);
				return aborted();
			}

			options.callbacks.onToolCall(call.function.name, call.function.arguments);
			const outcome = await runOneTool(call, options, registry, boundary);
			if (outcome.kind === 'aborted') {
				appendCancelledResults(history, toolCalls, index);
				return aborted();
			}

			history.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
			options.callbacks.onToolResult(call.function.name, outcome.summary, outcome.isError);

			if (outcome.isError) {
				const signature = signatureOf(call);
				const count = (failures.get(signature) ?? 0) + 1;
				failures.set(signature, count);
				if (count >= REPEAT_FAILURE_LIMIT) {
					options.callbacks.onNotice('The agent repeated a failing tool call; stopping. Send another message to try again.');
					return { history, finalText: text, iterations, capped: false, aborted: false, toolsDisabled, repeatedFailure: true };
				}
			} else {
				failures.delete(signatureOf(call));
			}
		}
	}
}
