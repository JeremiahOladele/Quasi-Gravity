/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProvidersApiV1 } from '../core/providerApi';

const PROVIDERS_EXTENSION_ID = 'quasi-gravity.quasi-providers';

export async function getProvidersApi(): Promise<ProvidersApiV1 | undefined> {
	const extension = vscode.extensions.getExtension(PROVIDERS_EXTENSION_ID);
	if (!extension) {
		return undefined;
	}
	try {
		const exports = extension.isActive ? extension.exports : await extension.activate();
		if (exports && (exports as ProvidersApiV1).version === 1) {
			return exports as ProvidersApiV1;
		}
	} catch {
		// Treat a failing provider extension as unavailable.
	}
	return undefined;
}
