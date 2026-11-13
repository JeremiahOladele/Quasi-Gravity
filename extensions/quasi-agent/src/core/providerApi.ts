/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structural copies of the subset of the Phase 1 provider API the agent uses.
 * The real objects come from `quasi-providers` via its `activate()` exports;
 * these types keep `core/` free of `vscode`/Node imports and of cross-extension
 * build coupling.
 */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface Capabilities {
	tools: boolean;
	vision: boolean;
	streaming: boolean;
	contextLength?: number;
}

export interface ToolSpec {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ToolSpec[];
	temperature?: number;
	maxTokens?: number;
}

export type ChatChunk =
	| { type: 'text'; text: string }
	| { type: 'toolCall'; call: ToolCall }
	| { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
	| { type: 'error'; message: string; status?: number };

export interface AgentProviderConfig {
	readonly kind: string;
	readonly baseUrl: string;
}

export interface AgentProvider {
	readonly config?: AgentProviderConfig;
	chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
	getModelCapabilities?(modelId: string, signal?: AbortSignal): Promise<Partial<Capabilities> | undefined>;
}

export interface EventLike<T> {
	(listener: (event: T) => unknown, thisArgs?: unknown, disposables?: unknown[]): { dispose(): void };
}

export interface ActiveProviderInfo {
	readonly provider: AgentProvider;
	readonly model: string;
	readonly providerId: string;
	readonly providerName: string;
	readonly capabilities: Capabilities;
	readonly capabilityStates: { readonly tools: CapabilityState; readonly vision: CapabilityState };
}

export interface ProvidersApiV1 {
	readonly version: 1;
	getActive(): ActiveProviderInfo | undefined;
	readonly onDidChangeActive: EventLike<void>;
	reportKeyRejected(providerId: string): void;
}
