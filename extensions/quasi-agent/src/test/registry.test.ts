/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	JsonSchema,
	ToolDef,
	ToolRegistry,
	buildToolSpecs,
	validateToolArguments,
	wrapToolResult
} from '../core/tools/registry';

const schema: JsonSchema = {
	type: 'object',
	properties: {
		path: { type: 'string' },
		startLine: { type: 'integer' },
		tags: { type: 'array', items: { type: 'string' } }
	},
	required: ['path'],
	additionalProperties: false
};

function makeTool(name: string, requires: ReadonlyArray<'fs.read' | 'fs.write' | 'exec'> = ['fs.read']): ToolDef {
	return {
		name,
		description: name,
		parameters: schema,
		requires,
		risk: 'read',
		run: async () => ({ content: 'ok', summary: 'ok' })
	};
}

describe('validateToolArguments', () => {
	it('accepts valid arguments', () => {
		assert.deepStrictEqual(validateToolArguments(schema, { path: 'a', startLine: 2, tags: ['x'] }), { ok: true, value: { path: 'a', startLine: 2, tags: ['x'] } });
	});

	it('rejects missing required fields', () => {
		const result = validateToolArguments(schema, {});
		assert.strictEqual(result.ok, false);
	});

	it('rejects unknown fields', () => {
		const result = validateToolArguments(schema, { path: 'a', extra: 1 });
		assert.strictEqual(result.ok, false);
		assert.match(result.ok === false ? result.error : '', /unknown argument/);
	});

	it('rejects wrong types', () => {
		assert.strictEqual(validateToolArguments(schema, { path: 1 }).ok, false);
		assert.strictEqual(validateToolArguments(schema, { path: 'a', startLine: 1.5 }).ok, false);
		assert.strictEqual(validateToolArguments(schema, { path: 'a', tags: [1] }).ok, false);
	});

	it('rejects non-object arguments', () => {
		assert.strictEqual(validateToolArguments(schema, [1, 2]).ok, false);
		assert.strictEqual(validateToolArguments(schema, 'nope').ok, false);
	});
});

describe('ToolRegistry', () => {
	it('looks up tools and filters by capabilities', () => {
		const registry = new ToolRegistry([makeTool('read', ['fs.read']), makeTool('write', ['fs.write'])]);
		assert.strictEqual(registry.get('read')?.name, 'read');
		assert.strictEqual(registry.get('missing'), undefined);
		assert.deepStrictEqual(registry.available(new Set(['fs.read'])).map(tool => tool.name), ['read']);
		assert.deepStrictEqual(registry.available(new Set(['fs.read', 'fs.write'])).map(tool => tool.name).sort(), ['read', 'write']);
	});

	it('builds provider tool specs from schemas', () => {
		const specs = buildToolSpecs([makeTool('read')]);
		assert.strictEqual(specs[0].type, 'function');
		assert.strictEqual(specs[0].function.name, 'read');
		assert.deepStrictEqual(specs[0].function.parameters, schema);
	});
});

describe('wrapToolResult', () => {
	it('wraps content with token-bearing delimiters', () => {
		const wrapped = wrapToolResult('tok-123', 'read_file', 'hello', false);
		assert.ok(wrapped.includes('token="tok-123"'));
		assert.ok(wrapped.includes('hello'));
		assert.ok(wrapped.includes('<<<end_tool_result token="tok-123">>>'));
	});

	it('escapes the boundary token in content so it cannot break out', () => {
		const wrapped = wrapToolResult('tok-123', 'read_file', 'before tok-123 after', false);
		assert.ok(!wrapped.includes('before tok-123 after'));
		assert.ok(wrapped.includes('before [boundary] after'));
	});

	it('marks error results', () => {
		assert.ok(wrapToolResult('t', 'x', 'fail', true).includes('status="error"'));
	});
});
