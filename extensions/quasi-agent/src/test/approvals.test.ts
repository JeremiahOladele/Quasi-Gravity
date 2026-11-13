/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ApprovalGate } from '../core/approvals';
import { ApprovalPrompt } from '../core/tools/registry';

const prompt: ApprovalPrompt = { toolName: 'read_file', reason: 'sensitive-file', detail: '.env' };

describe('ApprovalGate', () => {
	it('resolves a pending request once', async () => {
		const gate = new ApprovalGate(() => 'id-1');
		const controller = new AbortController();
		const { id, promise } = gate.create(prompt, controller.signal);
		assert.strictEqual(id, 'id-1');
		assert.strictEqual(gate.pendingCount, 1);
		assert.strictEqual(gate.resolve('id-1', true), true);
		assert.strictEqual(await promise, true);
		assert.strictEqual(gate.pendingCount, 0);
		assert.strictEqual(gate.resolve('id-1', false), false);
	});

	it('rejects unknown ids', () => {
		const gate = new ApprovalGate(() => 'id');
		assert.strictEqual(gate.resolve('nope', true), false);
	});

	it('cancelAll denies every pending request', async () => {
		const gate = new ApprovalGate();
		const controller = new AbortController();
		const first = gate.create(prompt, controller.signal);
		const second = gate.create(prompt, controller.signal);
		gate.cancelAll();
		assert.strictEqual(gate.pendingCount, 0);
		assert.strictEqual(await first.promise, false);
		assert.strictEqual(await second.promise, false);
	});

	it('aborting the signal cancels the request', async () => {
		const gate = new ApprovalGate();
		const controller = new AbortController();
		const { promise } = gate.create(prompt, controller.signal);
		controller.abort();
		assert.strictEqual(await promise, false);
		assert.strictEqual(gate.pendingCount, 0);
	});

	it('generates distinct ids by default', () => {
		const gate = new ApprovalGate();
		const controller = new AbortController();
		const first = gate.create(prompt, controller.signal);
		const second = gate.create(prompt, controller.signal);
		assert.notStrictEqual(first.id, second.id);
	});
});
