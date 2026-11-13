/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyResolver, Provider, ProviderConfig, ProviderError } from '../types';
import { OpenAICompatProvider } from './openaiCompat';

/** Build a `Provider` for the given configuration. Pure: no `vscode`/Node imports. */
export function createProvider(config: ProviderConfig, keyResolver: KeyResolver): Provider {
	switch (config.apiType) {
		case 'openai-compat':
			return new OpenAICompatProvider(config, keyResolver);
		default:
			throw new ProviderError(`Unsupported API type '${config.apiType}' (not implemented yet)`);
	}
}
