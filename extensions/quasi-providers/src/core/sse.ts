/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parse a stream of Server-Sent Events, yielding the payload of each `data:` line.
 *
 * Handles events split across chunk boundaries and CRLF line endings. Only the
 * `data:` payload is surfaced; comments, event names, and other SSE fields are
 * ignored (which is all the OpenAI-compatible streaming API emits).
 */
export async function* parseSseEvents(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string> {
	const decoder = new TextDecoder();
	let buffer = '';

	for await (const chunk of chunks) {
		buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '\n');

		let separator: number;
		while ((separator = buffer.indexOf('\n\n')) >= 0) {
			const block = buffer.slice(0, separator);
			buffer = buffer.slice(separator + 2);
			const data = extractData(block);
			if (data !== undefined) {
				yield data;
			}
		}
	}

	buffer += decoder.decode();
	if (buffer.trim().length > 0) {
		const data = extractData(buffer);
		if (data !== undefined) {
			yield data;
		}
	}
}

function extractData(block: string): string | undefined {
	const dataLines: string[] = [];
	for (const line of block.split('\n')) {
		if (line.startsWith('data:')) {
			dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
		}
	}
	return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}
