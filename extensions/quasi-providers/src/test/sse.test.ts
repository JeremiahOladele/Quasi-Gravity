/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseSseEvents } from '../core/sse';

function chunks(...parts: string[]): AsyncIterable<Uint8Array> {
	const encoder = new TextEncoder();
	async function* gen(): AsyncIterable<Uint8Array> {
		for (const part of parts) {
			yield encoder.encode(part);
		}
	}
	return gen();
}

async function collect(input: AsyncIterable<Uint8Array>): Promise<string[]> {
	const out: string[] = [];
	for await (const data of parseSseEvents(input)) {
		out.push(data);
	}
	return out;
}

describe('parseSseEvents', () => {
	it('parses a normal stream with multiple events', async () => {
		const events = await collect(chunks(
			'data: {"a":1}\n\n' +
			'data: {"a":2}\n\n' +
			'data: [DONE]\n\n'
		));
		assert.deepStrictEqual(events, ['{"a":1}', '{"a":2}', '[DONE]']);
	});

	it('parses events split across chunk boundaries', async () => {
		const events = await collect(chunks('data: {"a":', '1}\n\n', 'data: {"a":2}', '\n\n'));
		assert.deepStrictEqual(events, ['{"a":1}', '{"a":2}']);
	});

	it('handles CRLF line endings', async () => {
		const events = await collect(chunks('data: {"a":1}\r\n\r\n'));
		assert.deepStrictEqual(events, ['{"a":1}']);
	});

	it('ignores comments and non-data lines', async () => {
		const events = await collect(chunks(': keep-alive\ndata: {"a":1}\n\nevent: message\ndata: {"a":2}\n\n'));
		assert.deepStrictEqual(events, ['{"a":1}', '{"a":2}']);
	});

	it('joins multiple data lines within a single event', async () => {
		const events = await collect(chunks('data: line1\ndata: line2\n\n'));
		assert.deepStrictEqual(events, ['line1\nline2']);
	});
});
