/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderConfig } from '../types';

export interface ProviderPreset {
	readonly label: string;
	readonly config: Omit<ProviderConfig, 'id'>;
}

/**
 * Presets offered by "Quasi: Add Provider". Local presets are `kind: 'local'`
 * and need no key. Ollama uses its OpenAI-compatible `/v1` endpoint for now;
 * M3 adds native Ollama support.
 */
export const providerPresets: ReadonlyArray<ProviderPreset> = [
	{
		label: 'DeepSeek',
		config: { name: 'DeepSeek', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', requiresKey: true }
	},
	{
		label: 'OpenAI',
		config: { name: 'OpenAI', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', requiresKey: true }
	},
	{
		label: 'OpenRouter',
		config: { name: 'OpenRouter', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true }
	},
	{
		label: 'Ollama',
		config: { name: 'Ollama', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:11434/v1', requiresKey: false }
	},
	{
		label: 'LM Studio',
		config: { name: 'LM Studio', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:1234/v1', requiresKey: false }
	},
	{
		label: 'llama.cpp server',
		config: { name: 'llama.cpp', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:8080/v1', requiresKey: false }
	},
	{
		label: 'vLLM',
		config: { name: 'vLLM', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:8000/v1', requiresKey: false }
	},
	{
		label: 'Custom OpenAI-compatible',
		config: { name: 'Custom', kind: 'cloud', apiType: 'openai-compat', baseUrl: '', requiresKey: true }
	},
];
