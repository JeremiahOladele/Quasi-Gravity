/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const FORBIDDEN_BARE = new Set(['vscode', 'fs', 'path', 'os', 'child_process']);

function coreSourceDir(): string {
	// __dirname resolves to extensions/quasi-providers/out/test
	return path.join(__dirname, '..', '..', 'src', 'core');
}

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

function isForbidden(specifier: string): boolean {
	return specifier === 'vscode'
		|| specifier.startsWith('node:')
		|| FORBIDDEN_BARE.has(specifier)
		|| FORBIDDEN_BARE.has(specifier.split('/')[0]);
}

describe('core purity', () => {
	it('contains no vscode or Node imports', () => {
		const root = coreSourceDir();
		const files = collectSourceFiles(root);
		assert.ok(files.length > 0, 'expected core source files to exist');

		for (const file of files) {
			const content = fs.readFileSync(file, 'utf8');
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const match = /(?:from|require|import)\s*\(?\s*['"]([^'"]+)['"]/.exec(lines[i]);
				if (match && isForbidden(match[1])) {
					const rel = path.relative(root, file);
					assert.fail(`Forbidden import '${match[1]}' in core/${rel}:${i + 1}`);
				}
			}
		}
	});
});
