/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OpenAICompatProvider } from '../core/providers/openaiCompat';
import { ProviderConfig, normalizeBaseUrl } from '../core/types';

const DEV_KEY_ID = 'quasi.key.dev-test';

export function registerTestProviderCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('quasi.provider.test', () => testProvider(context))
	);
}

async function testProvider(context: vscode.ExtensionContext): Promise<void> {
	const baseUrl = await vscode.window.showInputBox({
		prompt: 'Provider base URL (OpenAI-compatible)',
		value: 'https://api.deepseek.com',
		ignoreFocusOut: true,
	});
	if (baseUrl === undefined) {
		return;
	}

	const model = await vscode.window.showInputBox({
		prompt: 'Model',
		value: 'deepseek-chat',
		ignoreFocusOut: true,
	});
	if (model === undefined) {
		return;
	}

	const needsKeyPick = await vscode.window.showQuickPick(['No (local)', 'Yes (cloud)'], {
		placeHolder: 'Does this provider require an API key?',
		ignoreFocusOut: true,
	});
	if (needsKeyPick === undefined) {
		return;
	}
	const requiresKey = needsKeyPick === 'Yes (cloud)';

	let key: string | undefined;
	if (requiresKey) {
		key = await resolveDevKey(context.secrets);
		if (key === undefined) {
			return;
		}
	}

	const message = await vscode.window.showInputBox({
		prompt: 'Message to send',
		value: 'Say hello',
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return;
	}

	const config: ProviderConfig = {
		id: 'dev-test',
		name: 'Dev Test',
		kind: requiresKey ? 'cloud' : 'local',
		apiType: 'openai-compat',
		baseUrl,
		defaultModel: model,
		requiresKey,
	};

	const provider = new OpenAICompatProvider(config, async () => key);

	const output = vscode.window.createOutputChannel('Quasi: Test Provider');
	output.show();
	output.appendLine(`Provider: ${config.name}`);
	output.appendLine(`Base URL: ${normalizeBaseUrl(baseUrl)}`);
	output.appendLine(`Model: ${model}`);
	output.appendLine('---');
	output.appendLine(`> ${message}`);
	output.appendLine('');

	try {
		for await (const chunk of provider.chat({ model, messages: [{ role: 'user', content: message }] })) {
			switch (chunk.type) {
				case 'text':
					output.append(chunk.text);
					break;
				case 'toolCall':
					output.appendLine('');
					output.appendLine(`[tool call: ${chunk.call.function.name}(${chunk.call.function.arguments})]`);
					break;
				case 'done':
					output.appendLine('');
					if (chunk.usage) {
						output.appendLine(`[usage: ${chunk.usage.inputTokens ?? '?'} in / ${chunk.usage.outputTokens ?? '?'} out]`);
					}
					output.appendLine('[done]');
					break;
				case 'error':
					output.appendLine('');
					output.appendLine(`[error] ${chunk.message}`);
					break;
			}
		}
	} catch (err) {
		output.appendLine('');
		output.appendLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function resolveDevKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const saved = await secrets.get(DEV_KEY_ID);
	if (saved) {
		const action = await vscode.window.showQuickPick(['Use saved key', 'Enter new key', 'Clear saved key'], {
			placeHolder: 'A dev API key is already saved',
			ignoreFocusOut: true,
		});
		if (action === 'Use saved key') {
			return saved;
		}
		if (action === 'Enter new key') {
			return enterAndStoreKey(secrets);
		}
		if (action === 'Clear saved key') {
			await secrets.delete(DEV_KEY_ID);
			return enterAndStoreKey(secrets);
		}
		return undefined;
	}
	return enterAndStoreKey(secrets);
}

async function enterAndStoreKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const key = await vscode.window.showInputBox({
		prompt: 'API key (stored in SecretStorage, never logged)',
		password: true,
		ignoreFocusOut: true,
	});
	if (key !== undefined && key.length > 0) {
		await secrets.store(DEV_KEY_ID, key);
	}
	return key;
}
