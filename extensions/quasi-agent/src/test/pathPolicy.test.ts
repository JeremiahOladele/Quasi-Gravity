/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isAbsolutePath, resolveSandboxPath } from '../core/tools/pathPolicy';

describe('isAbsolutePath', () => {
	it('detects POSIX, drive, and UNC paths', () => {
		assert.strictEqual(isAbsolutePath('/a/b'), true);
		assert.strictEqual(isAbsolutePath('C:\\a'), true);
		assert.strictEqual(isAbsolutePath('C:/a'), true);
		assert.strictEqual(isAbsolutePath('//server/share'), true);
		assert.strictEqual(isAbsolutePath('a/b'), false);
	});
});

describe('resolveSandboxPath', () => {
	const root = '/work';

	it('resolves relative paths', () => {
		assert.deepStrictEqual(resolveSandboxPath(root, 'a/b'), { ok: true, relativePath: 'a/b', outsideWorkspace: false });
		assert.deepStrictEqual(resolveSandboxPath(root, './a/./b'), { ok: true, relativePath: 'a/b', outsideWorkspace: false });
	});

	it('rejects .. escapes', () => {
		assert.strictEqual(resolveSandboxPath(root, '../evil').outsideWorkspace, true);
		assert.strictEqual(resolveSandboxPath(root, 'a/../../evil').outsideWorkspace, true);
	});

	it('handles absolute paths inside and outside', () => {
		assert.deepStrictEqual(resolveSandboxPath(root, '/work/a/b'), { ok: true, relativePath: 'a/b', outsideWorkspace: false });
		assert.strictEqual(resolveSandboxPath(root, '/etc/passwd').outsideWorkspace, true);
	});

	it('handles Windows-style separators and drives', () => {
		assert.deepStrictEqual(resolveSandboxPath('C:/work', 'C:\\work\\a'), { ok: true, relativePath: 'a', outsideWorkspace: false });
		assert.strictEqual(resolveSandboxPath('C:/work', 'D:\\x').outsideWorkspace, true);
		assert.strictEqual(resolveSandboxPath('C:/work', '..\\..\\evil').outsideWorkspace, true);
	});

	it('respects case-insensitivity for the root', () => {
		assert.strictEqual(resolveSandboxPath('C:/Work', 'c:/work/a', true).ok, true);
		assert.strictEqual(resolveSandboxPath('C:/Work', 'c:/work/a', false).outsideWorkspace, true);
	});

	it('rejects empty input', () => {
		assert.strictEqual(resolveSandboxPath(root, '   ').ok, false);
	});
});
