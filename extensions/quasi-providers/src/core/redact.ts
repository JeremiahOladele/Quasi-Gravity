/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Replace every occurrence of each (non-empty) secret in `text` with `***`.
 *
 * Used to make sure API keys never leak into error messages, logs, or UI, even
 * when an underlying error message happens to include the value.
 */
export function redactSecrets(text: string, ...secrets: Array<string | undefined>): string {
	let result = text;
	for (const secret of secrets) {
		if (secret && secret.length > 0) {
			result = result.split(secret).join('***');
		}
	}
	return result;
}
