/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiType, ProviderKind } from './types';

// WSL dev note: a model server running on the Windows host may not be reachable
// from WSL via `localhost`. That is a developer-setup quirk only; discovery
// deliberately probes loopback addresses only and never scans other hosts/ports.

export interface DiscoveredServer {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly apiType: ApiType;
	readonly kind: ProviderKind;
	readonly port: number;
	readonly models: string[];
}

interface LocalProbe {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly apiType: ApiType;
	readonly probeUrl: string;
	readonly parseModels: (json: unknown) => string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Parse an OpenAI-compatible `GET /v1/models` response. */
export function parseOpenAiModels(json: unknown): string[] {
	if (!isObject(json) || !Array.isArray(json.data)) {
		return [];
	}
	return json.data
		.map(item => (isObject(item) && typeof item.id === 'string' ? item.id : undefined))
		.filter((id): id is string => id !== undefined);
}

/** Parse an Ollama `GET /api/tags` response. */
export function parseOllamaTags(json: unknown): string[] {
	if (!isObject(json) || !Array.isArray(json.models)) {
		return [];
	}
	return json.models
		.map(item => {
			if (!isObject(item)) {
				return undefined;
			}
			if (typeof item.name === 'string') {
				return item.name;
			}
			return typeof item.model === 'string' ? item.model : undefined;
		})
		.filter((name): name is string => name !== undefined);
}

const LOCAL_PROBES: ReadonlyArray<LocalProbe> = [
	{
		id: 'ollama',
		label: 'Ollama',
		baseUrl: 'http://localhost:11434/v1',
		apiType: 'ollama',
		probeUrl: 'http://localhost:11434/api/tags',
		parseModels: parseOllamaTags
	},
	{
		id: 'lmstudio',
		label: 'LM Studio',
		baseUrl: 'http://localhost:1234/v1',
		apiType: 'openai-compat',
		probeUrl: 'http://localhost:1234/v1/models',
		parseModels: parseOpenAiModels
	},
	{
		id: 'llamacpp',
		label: 'llama.cpp',
		baseUrl: 'http://localhost:8080/v1',
		apiType: 'openai-compat',
		probeUrl: 'http://localhost:8080/v1/models',
		parseModels: parseOpenAiModels
	},
	{
		id: 'vllm',
		label: 'vLLM',
		baseUrl: 'http://localhost:8000/v1',
		apiType: 'openai-compat',
		probeUrl: 'http://localhost:8000/v1/models',
		parseModels: parseOpenAiModels
	},
];

/**
 * Probe the four default loopback endpoints with short, cancellable GET
 * requests (no auth headers, never other hosts/ports). Returns the servers
 * that responded. A 2xx response counts as found even if the model list is empty.
 */
export async function probeLocalServers(signal?: AbortSignal, timeoutMs = 1500): Promise<DiscoveredServer[]> {
	const results = await Promise.allSettled(LOCAL_PROBES.map(probe => probeOne(probe, signal, timeoutMs)));
	const found: DiscoveredServer[] = [];
	for (const result of results) {
		if (result.status === 'fulfilled' && result.value) {
			found.push(result.value);
		}
	}
	return found;
}

async function probeOne(probe: LocalProbe, parentSignal: AbortSignal | undefined, timeoutMs: number): Promise<DiscoveredServer | undefined> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	parentSignal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(probe.probeUrl, { method: 'GET', signal: controller.signal });
		if (!res.ok) {
			return undefined;
		}
		const json = await res.json();
		const port = Number(new URL(probe.baseUrl).port) || 0;
		return {
			id: probe.id,
			label: probe.label,
			baseUrl: probe.baseUrl,
			apiType: probe.apiType,
			kind: 'local',
			port,
			models: probe.parseModels(json)
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener('abort', onAbort);
	}
}
