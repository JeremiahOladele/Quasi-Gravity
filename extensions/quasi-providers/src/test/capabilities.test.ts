/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { assessCapabilities, effectiveCapabilities } from '../core/capabilities';

describe('assessCapabilities', () => {
	it('reports supported/unsupported when the server reports a value', () => {
		assert.strictEqual(assessCapabilities({ tools: true }, undefined).tools, 'supported');
		assert.strictEqual(assessCapabilities({ tools: false }, undefined).tools, 'unsupported');
		assert.strictEqual(assessCapabilities({ vision: true }, undefined).vision, 'supported');
	});

	it('reports unknown when nothing is known', () => {
		const assessment = assessCapabilities(undefined, undefined);
		assert.strictEqual(assessment.tools, 'unknown');
		assert.strictEqual(assessment.vision, 'unknown');
		assert.strictEqual(assessment.contextLength, undefined);
	});

	it('lets the manual override win', () => {
		assert.strictEqual(assessCapabilities({ tools: false }, { tools: true }).tools, 'supported');
		assert.strictEqual(assessCapabilities({ tools: true }, { tools: false }).tools, 'unsupported');
		assert.strictEqual(assessCapabilities(undefined, { tools: false }).tools, 'unsupported');
	});

	it('carries context length from either source', () => {
		assert.strictEqual(assessCapabilities({ contextLength: 4096 }, undefined).contextLength, 4096);
		assert.strictEqual(assessCapabilities({ contextLength: 4096 }, { contextLength: 8192 }).contextLength, 8192);
	});
});

describe('effectiveCapabilities', () => {
	it('treats only supported as enabled for fallback', () => {
		const effective = effectiveCapabilities({ tools: 'unknown', vision: 'unsupported' });
		assert.strictEqual(effective.tools, false);
		assert.strictEqual(effective.vision, false);
		assert.strictEqual(effective.streaming, true);
	});

	it('enables known-supported capabilities', () => {
		const effective = effectiveCapabilities({ tools: 'supported', vision: 'supported', contextLength: 8192 });
		assert.strictEqual(effective.tools, true);
		assert.strictEqual(effective.vision, true);
		assert.strictEqual(effective.contextLength, 8192);
	});
});
