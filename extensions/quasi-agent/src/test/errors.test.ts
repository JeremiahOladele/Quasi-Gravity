/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { classifyChatError } from '../core/errors';

describe('classifyChatError', () => {
	it('treats 401/403 as a rejected key', () => {
		assert.strictEqual(classifyChatError({ message: 'x', status: 401 }).kind, 'key-rejected');
		assert.strictEqual(classifyChatError({ message: 'x', status: 403 }).kind, 'key-rejected');
	});

	it('treats 429 as rate-limited', () => {
		assert.strictEqual(classifyChatError({ message: 'x', status: 429 }).kind, 'rate-limited');
	});

	it('treats 5xx as a provider error, not offline', () => {
		assert.strictEqual(classifyChatError({ message: 'x', status: 500 }).kind, 'provider-error');
		assert.strictEqual(classifyChatError({ message: 'x', status: 503 }).kind, 'provider-error');
	});

	it('treats a missing status (network failure) as offline', () => {
		assert.strictEqual(classifyChatError({ message: 'fetch failed' }).kind, 'offline');
	});

	it('classifies other statuses as provider errors with the redacted message', () => {
		const classified = classifyChatError({ message: 'bad request', status: 400 });
		assert.strictEqual(classified.kind, 'provider-error');
		assert.strictEqual(classified.message, 'bad request');
	});
});
