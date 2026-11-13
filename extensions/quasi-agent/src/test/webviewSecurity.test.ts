/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{ name: 'innerHTML', pattern: /\binnerHTML\b/ },
	{ name: 'outerHTML', pattern: /\bouterHTML\b/ },
	{ name: 'insertAdjacentHTML', pattern: /\binsertAdjacentHTML\b/ },
	{ name: 'document.write', pattern: /\bdocument\s*\.\s*write\b/ },
	{ name: 'eval', pattern: /\beval\s*\(/ },
	{ name: 'new Function', pattern: /\bnew\s+Function\b/ }
];

describe('webview security', () => {
	it('does not use unsafe HTML/JS sinks', () => {
		const dir = path.join(__dirname, '..', '..', 'src', 'webview');
		const files = fs.readdirSync(dir).filter(file => file.endsWith('.js'));
		assert.ok(files.length > 0, 'expected webview JS files');
		for (const file of files) {
			const content = fs.readFileSync(path.join(dir, file), 'utf8');
			for (const forbidden of FORBIDDEN) {
				assert.ok(!forbidden.pattern.test(content), `${file} must not use ${forbidden.name}`);
			}
		}
	});
});
