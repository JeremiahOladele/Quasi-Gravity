/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolSpec } from '../providerApi';

export type Capability = 'fs.read' | 'fs.write' | 'exec';

export type ToolRisk = 'read' | 'write' | 'exec';

export type JsonSchema =
	| { readonly type: 'object'; readonly properties?: Readonly<Record<string, JsonSchema>>; readonly required?: ReadonlyArray<string>; readonly additionalProperties?: boolean }
	| { readonly type: 'string' }
	| { readonly type: 'integer' }
	| { readonly type: 'number' }
	| { readonly type: 'boolean' }
	| { readonly type: 'array'; readonly items?: JsonSchema }
	| { readonly type: 'null' };

export interface ToolResult {
	/** Content sent to the model (delimited by the loop). */
	readonly content: string;
	/** Short summary shown in the UI. */
	readonly summary: string;
	readonly isError?: boolean;
}

export interface ApprovalPrompt {
	readonly toolName: string;
	readonly reason: 'sensitive-file' | 'outside-workspace';
	readonly detail: string;
}

export interface ToolDef {
	readonly name: string;
	readonly description: string;
	readonly parameters: JsonSchema;
	readonly requires: ReadonlyArray<Capability>;
	readonly risk: ToolRisk;
	/** Decision: return a prompt when this call needs approval. May do async checks (e.g. symlinks). */
	readonly needsApproval?: (args: Record<string, unknown>, signal: AbortSignal) => ApprovalPrompt | undefined | Promise<ApprovalPrompt | undefined>;
	run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ArgsValidation =
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| { readonly ok: false; readonly error: string };

function validateValue(schema: JsonSchema, value: unknown, path: string): { ok: true } | { ok: false; error: string } {
	switch (schema.type) {
		case 'object': {
			if (!isObject(value)) {
				return { ok: false, error: `${path} must be an object` };
			}
			const properties = schema.properties ?? {};
			for (const required of schema.required ?? []) {
				if (!(required in value)) {
					return { ok: false, error: `${path}.${required} is required` };
				}
			}
			for (const [key, entry] of Object.entries(value)) {
				const propertySchema = properties[key];
				if (!propertySchema) {
					if (schema.additionalProperties !== true) {
						return { ok: false, error: `unknown argument '${path}.${key}'` };
					}
					continue;
				}
				const result = validateValue(propertySchema, entry, `${path}.${key}`);
				if (!result.ok) {
					return result;
				}
			}
			return { ok: true };
		}
		case 'string':
			return typeof value === 'string' ? { ok: true } : { ok: false, error: `${path} must be a string` };
		case 'boolean':
			return typeof value === 'boolean' ? { ok: true } : { ok: false, error: `${path} must be a boolean` };
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value) ? { ok: true } : { ok: false, error: `${path} must be an integer` };
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? { ok: true } : { ok: false, error: `${path} must be a number` };
		case 'array': {
			if (!Array.isArray(value)) {
				return { ok: false, error: `${path} must be an array` };
			}
			if (schema.items) {
				for (let index = 0; index < value.length; index++) {
					const result = validateValue(schema.items, value[index], `${path}[${index}]`);
					if (!result.ok) {
						return result;
					}
				}
			}
			return { ok: true };
		}
		case 'null':
			return value === null ? { ok: true } : { ok: false, error: `${path} must be null` };
	}
}

/** Validate untrusted model tool arguments against the tool's JSON schema. */
export function validateToolArguments(schema: JsonSchema, raw: unknown): ArgsValidation {
	if (!isObject(raw)) {
		return { ok: false, error: 'arguments must be a JSON object' };
	}
	const result = validateValue(schema, raw, 'arguments');
	return result.ok ? { ok: true, value: raw } : result;
}

export class ToolRegistry {
	private readonly tools = new Map<string, ToolDef>();

	constructor(tools: ReadonlyArray<ToolDef> = []) {
		for (const tool of tools) {
			this.tools.set(tool.name, tool);
		}
	}

	get(name: string): ToolDef | undefined {
		return this.tools.get(name);
	}

	list(): ToolDef[] {
		return [...this.tools.values()];
	}

	/** Tools whose required capabilities are all available. */
	available(capabilities: ReadonlySet<Capability>): ToolDef[] {
		return this.list().filter(tool => tool.requires.every(capability => capabilities.has(capability)));
	}
}

export function buildToolSpecs(tools: ReadonlyArray<ToolDef>): ToolSpec[] {
	return tools.map(tool => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as unknown as Record<string, unknown>
		}
	}));
}

export function createBoundary(): string {
	const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (cryptoObject?.randomUUID) {
		return cryptoObject.randomUUID();
	}
	return `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Wrap a tool result in delimiters carrying a random per-request token. Any
 * occurrence of the token in the content is escaped so file contents cannot
 * break out of the block.
 */
export function wrapToolResult(token: string, name: string, content: string, isError: boolean): string {
	const safeName = name.replace(/[^A-Za-z0-9_.-]/g, '');
	const safeContent = content.split(token).join('[boundary]');
	const status = isError ? ' status="error"' : '';
	return `<<<tool_result token="${token}" name="${safeName}"${status}>>>\n${safeContent}\n<<<end_tool_result token="${token}">>>`;
}
