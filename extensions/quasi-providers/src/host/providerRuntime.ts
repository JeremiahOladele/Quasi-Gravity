/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { providerKeyId } from '../core/providerConfig';
import { createProvider } from '../core/providers/factory';
import { KeyResolver, Provider, ProviderConfig } from '../core/types';
import { KeyStore } from './secrets';

/** Key resolver that reads from the KeyStore (persisted or session-only). */
export function makeKeyResolver(keyStore: KeyStore): KeyResolver {
	return async (providerId: string) => (await keyStore.getKey(providerKeyId(providerId))).key;
}

/** Build a `Provider` for a config, resolving its key through the KeyStore. */
export function providerFor(config: ProviderConfig, keyStore: KeyStore): Provider {
	return createProvider(config, makeKeyResolver(keyStore));
}
