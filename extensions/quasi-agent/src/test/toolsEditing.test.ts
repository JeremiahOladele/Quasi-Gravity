/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { BulkChangeGuard } from '../core/tools/bulkGuard';
import { computeDiff, computeLineStats } from '../core/tools/diff';
import { detectEol, newFileText, planEdits, toLf } from '../core/tools/editPlan';
import { requiresWriteApproval } from '../core/tools/protectedPaths';
import { planRevert, UndoBook } from '../core/tools/undo';

describe('protected paths', () => {
	const protectedPaths = [
		'.git/config',
		'.GIT/config',
		'.git\\config',
		'.git\\config::$DATA',
		'.vscode/settings.json',
		'.vscode\\settings.json',
		'.github/workflows/ci.yml',
		'.devcontainer/devcontainer.json',
		'.husky/pre-commit',
		'.quasi/instructions.md',
		'AGENTS.md',
		'sub/AGENTS.md',
		'package.json',
		'package.JSON.',
		'package.json ',
		'package.json::$DATA',
		'package.json:stream',
		'requirements.txt',
		'requirements-dev.txt',
		'pyproject.toml',
		'setup.py',
		'Cargo.toml',
		'build.rs',
		'app.csproj',
		'pom.xml',
		'build.gradle',
		'build.gradle.kts',
		'Gemfile',
		'go.mod',
		'composer.json',
		'deploy.sh',
		'scripts\\build.PS1',
		'run.bat',
		'run.cmd',
		'Makefile',
		'Dockerfile',
		'docker-compose.dev.yml',
		'docker-compose.yaml',
		'.gitlab-ci.yml',
		'Jenkinsfile',
		'app.service',
		'app.desktop',
		'my.code-workspace',
		'.npmrc',
		'.yarnrc.yml',
		'Rakefile',
		'justfile',
		'Taskfile.yml',
		'lefthook.yml',
		'.pre-commit-config.yaml',
		'.env',
		'.env.local'
	];

	for (const path of protectedPaths) {
		it(`requires approval for ${JSON.stringify(path)}`, () => {
			assert.strictEqual(requiresWriteApproval(path), true);
		});
	}

	const ordinaryPaths = ['src/index.ts', 'README.md', 'docs/guide.md', 'src/app.json', 'notes.mk.txt', 'Dockerfile.dev', 'script.shell'];
	for (const path of ordinaryPaths) {
		it(`does not require approval for ${JSON.stringify(path)}`, () => {
			assert.strictEqual(requiresWriteApproval(path), false);
		});
	}

	it('treats a resolved symlink target as the path that matters', () => {
		assert.strictEqual(requiresWriteApproval('src/../../.git/config'), true);
		assert.strictEqual(requiresWriteApproval('src/index.ts'), false);
	});
});

describe('edit plan', () => {
	it('applies a single unique edit', () => {
		const result = planEdits('const a = 1;\nconst b = 2;\n', [{ oldText: 'const b = 2;', newText: 'const b = 3;' }]);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.text, 'const a = 1;\nconst b = 3;\n');
			assert.strictEqual(result.replacements, 1);
		}
	});

	it('rejects a missing match', () => {
		const result = planEdits('abc', [{ oldText: 'zzz', newText: 'y' }]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /was not found/);
		}
	});

	it('rejects an ambiguous match', () => {
		const result = planEdits('a\na\n', [{ oldText: 'a', newText: 'b' }]);
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /more than once/);
		}
	});

	it('rejects an empty oldText', () => {
		const result = planEdits('abc', [{ oldText: '', newText: 'x' }]);
		assert.strictEqual(result.ok, false);
	});

	it('applies multiple edits in order', () => {
		const result = planEdits('one two three', [
			{ oldText: 'one', newText: '1' },
			{ oldText: 'three', newText: '3' }
		]);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.text, '1 two 3');
			assert.strictEqual(result.replacements, 2);
		}
	});

	it('matches LF text inside a CRLF file and preserves CRLF', () => {
		const before = 'a\r\nb\r\nc\r\n';
		const result = planEdits(before, [{ oldText: 'b\n', newText: 'B\nB2\n' }]);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.text, 'a\r\nB\r\nB2\r\nc\r\n');
		}
		assert.strictEqual(detectEol(before), '\r\n');
	});

	it('counts added and removed lines', () => {
		const result = planEdits('a\nb\n', [{ oldText: 'b', newText: 'b\nc' }]);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.addedLines, 1);
			assert.strictEqual(result.removedLines, 0);
		}
	});

	it('normalizes to LF and adds a configurable EOL for new files', () => {
		assert.strictEqual(toLf('a\r\nb\rc'), 'a\nb\nc');
		assert.strictEqual(newFileText('a\nb'), 'a\nb');
		assert.strictEqual(newFileText('a\nb', { configuredEol: '\r\n' }), 'a\r\nb');
		assert.strictEqual(newFileText('a\r\nb', { configuredEol: 'auto' }), 'a\nb');
	});
});

describe('diff', () => {
	it('reports identical content', () => {
		assert.deepStrictEqual(computeLineStats('a\nb', 'a\nb'), { added: 0, removed: 0, exact: true });
	});

	it('reports exact additions and removals', () => {
		const stats = computeLineStats('a\nb\nc', 'a\nB\nc\nd');
		assert.strictEqual(stats.exact, true);
		assert.strictEqual(stats.added, 2);
		assert.strictEqual(stats.removed, 1);
	});

	it('produces prefixed lines', () => {
		const diff = computeDiff('a\nb\n', 'a\nc\n');
		assert.deepStrictEqual(diff.lines, [' a', '-b', '+c', ' ']);
		assert.strictEqual(diff.added, 1);
		assert.strictEqual(diff.removed, 1);
	});

	it('caps very large inputs instead of diffing them', () => {
		const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
		const stats = computeLineStats(before, `${before}\nextra`);
		assert.strictEqual(stats.exact, false);
	});

	it('caps the visible output', () => {
		const before = Array.from({ length: 500 }, (_, i) => `a${i}`).join('\n');
		const after = Array.from({ length: 500 }, (_, i) => `b${i}`).join('\n');
		const diff = computeDiff(before, after);
		assert.strictEqual(diff.outputTruncated, true);
		assert.ok(diff.lines.length <= 300);
	});
});

describe('undo book', () => {
	const make = () => {
		let counter = 0;
		return new UndoBook(() => `id-${++counter}`);
	};

	it('records and finds changes', () => {
		const book = make();
		const record = book.record({ path: 'a.txt', kind: 'modified', before: 'old', after: 'new' });
		assert.ok(record);
		assert.strictEqual(book.count, 1);
		assert.strictEqual(book.find('id-1'), record);
		assert.strictEqual(book.last(), record);
	});

	it('skips a single change larger than the budget', () => {
		const book = new UndoBook(undefined, 10);
		assert.strictEqual(book.record({ path: 'a', kind: 'created', after: '12345678901' }), undefined);
		assert.strictEqual(book.empty, true);
	});

	it('evicts the oldest records to stay under the budget', () => {
		const book = new UndoBook(undefined, 10);
		book.record({ path: 'a', kind: 'created', after: '123456' });
		book.record({ path: 'b', kind: 'created', after: '1234567' });
		assert.strictEqual(book.count, 1);
		assert.strictEqual(book.all()[0].path, 'b');
	});

	it('removes and clears records', () => {
		const book = make();
		const record = book.record({ path: 'a', kind: 'created', after: 'x' })!;
		book.remove(record.id);
		assert.strictEqual(book.empty, true);
		book.record({ path: 'b', kind: 'created', after: 'y' });
		book.clear();
		assert.strictEqual(book.empty, true);
	});

	it('plans reverts and detects conflicts', () => {
		const modified = { id: 'm', path: 'a', kind: 'modified' as const, before: 'old', after: 'new', bytes: 6, createdAt: 0 };
		assert.deepStrictEqual(planRevert(modified, 'new'), { action: 'restore', content: 'old', conflict: false });
		assert.deepStrictEqual(planRevert(modified, 'user edit'), { action: 'restore', content: 'old', conflict: true });

		const created = { id: 'c', path: 'b', kind: 'created' as const, after: 'new', bytes: 3, createdAt: 0 };
		assert.deepStrictEqual(planRevert(created, 'new'), { action: 'delete', conflict: false });
		assert.deepStrictEqual(planRevert(created, undefined), { action: 'noop', conflict: false });

		const deleted = { id: 'd', path: 'c', kind: 'deleted' as const, before: 'old', bytes: 3, createdAt: 0 };
		assert.deepStrictEqual(planRevert(deleted, undefined), { action: 'restore', content: 'old', conflict: false });
		assert.deepStrictEqual(planRevert(deleted, 'exists'), { action: 'noop', conflict: true });
	});
});

describe('bulk change guard', () => {
	it('asks once after the limit and remembers approval', () => {
		const guard = new BulkChangeGuard(3);
		assert.strictEqual(guard.register(), 'ok');
		assert.strictEqual(guard.register(), 'ok');
		assert.strictEqual(guard.register(), 'ok');
		assert.strictEqual(guard.register(), 'ask');
		guard.approve();
		assert.strictEqual(guard.register(), 'already-approved');
		assert.strictEqual(guard.register(), 'already-approved');
		guard.reset();
		assert.strictEqual(guard.register(), 'ok');
	});
});
