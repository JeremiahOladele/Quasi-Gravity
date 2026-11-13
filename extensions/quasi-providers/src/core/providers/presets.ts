/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCheck } from '../keyCheck';
import { ProviderConfig } from '../types';

export interface ProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly config: Omit<ProviderConfig, 'id'>;
	/** Extra note for the picker, e.g. "beta" or "compatibility layer, not for production". */
	readonly note?: string;
	/** Whether the API-key prefix used for detection is documented by the provider. */
	readonly keyPrefixVerified?: boolean;
	/** Free, authenticated endpoint that validates the key (verified from docs). */
	readonly keyCheck?: KeyCheck;
}

/**
 * Presets offered by "Quasi: Add Provider". Local presets are `kind: 'local'`
 * and need no key. No preset hardcodes a default model; the add/quick-add flows
 * take the user to the model picker, which reads the real model list.
 *
 * Base URLs were verified against the providers' official docs. Perplexity is
 * intentionally omitted: its docs now point at a private-preview Orchestrator
 * API rather than a stable OpenAI-compatible base.
 */
export const providerPresets: ReadonlyArray<ProviderPreset> = [
	{
		id: 'deepseek',
		label: 'DeepSeek',
		config: { name: 'DeepSeek', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.deepseek.com', requiresKey: true },
		keyCheck: { url: 'https://api.deepseek.com/user/balance' }
	},
	{
		id: 'openai',
		label: 'OpenAI',
		config: { name: 'OpenAI', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.openai.com/v1', requiresKey: true }
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		config: { name: 'OpenRouter', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true },
		keyPrefixVerified: true,
		keyCheck: { url: 'https://openrouter.ai/api/v1/auth/key' }
	},
	{
		id: 'groq',
		label: 'Groq',
		config: { name: 'Groq', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }
	},
	{
		id: 'together',
		label: 'Together',
		config: { name: 'Together', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.together.ai/v1', requiresKey: true }
	},
	{
		id: 'mistral',
		label: 'Mistral',
		config: { name: 'Mistral', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true }
	},
	{
		id: 'fireworks',
		label: 'Fireworks',
		config: { name: 'Fireworks', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.fireworks.ai/inference/v1', requiresKey: true }
	},
	{
		id: 'xai',
		label: 'xAI',
		config: { name: 'xAI', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.x.ai/v1', requiresKey: true }
	},
	{
		id: 'moonshot',
		label: 'Moonshot',
		config: { name: 'Moonshot', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.moonshot.ai/v1', requiresKey: true },
		keyCheck: { url: 'https://api.moonshot.ai/v1/users/me/balance' }
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		config: { name: 'Anthropic', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://api.anthropic.com/v1', requiresKey: true },
		note: 'compatibility layer, not for production'
	},
	{
		id: 'gemini',
		label: 'Gemini',
		config: { name: 'Gemini', kind: 'cloud', apiType: 'openai-compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresKey: true },
		note: 'beta'
	},
	{
		id: 'ollama',
		label: 'Ollama',
		config: { name: 'Ollama', kind: 'local', apiType: 'ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }
	},
	{
		id: 'lmstudio',
		label: 'LM Studio',
		config: { name: 'LM Studio', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:1234/v1', requiresKey: false }
	},
	{
		id: 'llamacpp',
		label: 'llama.cpp server',
		config: { name: 'llama.cpp', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:8080/v1', requiresKey: false }
	},
	{
		id: 'vllm',
		label: 'vLLM',
		config: { name: 'vLLM', kind: 'local', apiType: 'openai-compat', baseUrl: 'http://localhost:8000/v1', requiresKey: false }
	},
	{
		id: 'custom',
		label: 'Custom OpenAI-compatible',
		config: { name: 'Custom', kind: 'cloud', apiType: 'openai-compat', baseUrl: '', requiresKey: true }
	},
];
