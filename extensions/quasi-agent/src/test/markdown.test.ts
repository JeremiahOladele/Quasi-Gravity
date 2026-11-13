/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { MarkdownInline, MAX_MARKDOWN_CHARS, isAllowedLink, parseMarkdown } from '../core/markdown';

function flattenInline(nodes: ReadonlyArray<MarkdownInline>): string {
	return nodes.map(node => {
		switch (node.type) {
			case 'text':
			case 'code':
				return node.text;
			case 'strong':
			case 'em':
				return flattenInline(node.children);
			case 'link':
				return `${flattenInline(node.children)} (${node.href})`;
			case 'image':
				return `[image: ${node.alt} — ${node.src}]`;
			case 'break':
				return '\n';
		}
	}).join('');
}

describe('isAllowedLink', () => {
	it('allows only http and https', () => {
		assert.strictEqual(isAllowedLink('https://example.com'), true);
		assert.strictEqual(isAllowedLink('http://example.com/a?b=1'), true);
		assert.strictEqual(isAllowedLink('javascript:alert(1)'), false);
		assert.strictEqual(isAllowedLink('data:text/html,hi'), false);
		assert.strictEqual(isAllowedLink('file:///etc/passwd'), false);
		assert.strictEqual(isAllowedLink('command:workbench.action.x'), false);
		assert.strictEqual(isAllowedLink('relative/path'), false);
	});
});

describe('parseMarkdown blocks', () => {
	it('parses headings', () => {
		const { blocks } = parseMarkdown('# One\n\n### Three');
		assert.strictEqual(blocks.length, 2);
		const first = blocks[0];
		assert.ok(first.type === 'heading' && first.level === 1);
		assert.strictEqual(first.type === 'heading' ? flattenInline(first.children) : '', 'One');
	});

	it('parses bold, italic, inline code, and links', () => {
		const { blocks } = parseMarkdown('Hello **bold** and *em* and `code` and [site](https://example.com).');
		const paragraph = blocks[0];
		assert.strictEqual(paragraph.type, 'paragraph');
		if (paragraph.type !== 'paragraph') {
			return;
		}
		assert.ok(paragraph.children.some(node => node.type === 'strong'));
		assert.ok(paragraph.children.some(node => node.type === 'em'));
		assert.ok(paragraph.children.some(node => node.type === 'code'));
		const link = paragraph.children.find(node => node.type === 'link');
		assert.ok(link && link.type === 'link' && link.href === 'https://example.com');
	});

	it('parses ordered and unordered lists', () => {
		const unordered = parseMarkdown('- a\n- b').blocks[0];
		assert.ok(unordered.type === 'list' && unordered.ordered === false && unordered.items.length === 2);
		const ordered = parseMarkdown('1. a\n2. b').blocks[0];
		assert.ok(ordered.type === 'list' && ordered.ordered === true && ordered.start === 1 && ordered.items.length === 2);
	});

	it('parses nested lists', () => {
		const list = parseMarkdown('- a\n  - b').blocks[0];
		assert.strictEqual(list.type, 'list');
		if (list.type !== 'list') {
			return;
		}
		assert.ok(list.items[0].some(block => block.type === 'list'));
	});

	it('parses GFM tables with alignment', () => {
		const table = parseMarkdown('| A | B |\n| :--- | ---: |\n| 1 | 2 |').blocks[0];
		assert.strictEqual(table.type, 'table');
		if (table.type !== 'table') {
			return;
		}
		assert.deepStrictEqual(table.alignment, ['left', 'right']);
		assert.strictEqual(table.header.length, 2);
		assert.strictEqual(table.rows.length, 1);
	});

	it('parses fenced code with language', () => {
		const code = parseMarkdown('```js\nconst x = 1;\n```').blocks[0];
		assert.ok(code.type === 'code' && code.language === 'js' && code.text === 'const x = 1;');
	});

	it('treats an unterminated fence as code without flagging truncation', () => {
		const result = parseMarkdown('```js\nfoo\nbar');
		const code = result.blocks[0];
		assert.ok(code.type === 'code' && code.text === 'foo\nbar');
		assert.strictEqual(result.truncated, false);
	});

	it('parses blockquotes and horizontal rules', () => {
		const blocks = parseMarkdown('> quoted\n\n---\n').blocks;
		assert.strictEqual(blocks[0].type, 'blockquote');
		assert.strictEqual(blocks[1].type, 'hr');
	});
});

describe('parseMarkdown inline edge cases', () => {
	it('parses nested emphasis', () => {
		const paragraph = parseMarkdown('**bold and *italic* text**').blocks[0];
		assert.strictEqual(paragraph.type, 'paragraph');
		if (paragraph.type !== 'paragraph') {
			return;
		}
		const strong = paragraph.children.find(node => node.type === 'strong');
		assert.ok(strong && strong.type === 'strong');
		if (strong && strong.type === 'strong') {
			assert.ok(strong.children.some(node => node.type === 'em'));
		}
	});

	it('does not treat intraword underscores as emphasis', () => {
		const paragraph = parseMarkdown('snake_case_name and _real emphasis_').blocks[0];
		if (paragraph.type !== 'paragraph') {
			return;
		}
		assert.ok(!paragraph.children.some(node => node.type === 'em' && flattenInline(node.children) === 'case'));
		assert.ok(paragraph.children.some(node => node.type === 'em'));
	});

	it('keeps raw HTML as plain text', () => {
		const result = parseMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
		const paragraph = result.blocks[0];
		assert.strictEqual(paragraph.type, 'paragraph');
		if (paragraph.type === 'paragraph') {
			const text = flattenInline(paragraph.children);
			assert.ok(text.includes('<script>'));
			assert.ok(text.includes('onerror='));
		}
		assert.ok(!JSON.stringify(result).includes('"type":"html"'));
	});

	it('parses image syntax as an image node (rendered as text later)', () => {
		const paragraph = parseMarkdown('![alt text](https://example.com/a.png)').blocks[0];
		assert.strictEqual(paragraph.type, 'paragraph');
		if (paragraph.type === 'paragraph') {
			assert.strictEqual(paragraph.children.length, 1);
			const image = paragraph.children[0];
			assert.ok(image.type === 'image' && image.alt === 'alt text' && image.src === 'https://example.com/a.png');
		}
	});

	it('renders disallowed link schemes as text, never as links', () => {
		for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'command:workbench.action.x']) {
			const paragraph = parseMarkdown(`[x](${url})`).blocks[0];
			assert.strictEqual(paragraph.type, 'paragraph');
			if (paragraph.type === 'paragraph') {
				assert.ok(!paragraph.children.some(node => node.type === 'link'), url);
			}
		}
	});
});

describe('parseMarkdown caps', () => {
	it('truncates very long input', () => {
		const result = parseMarkdown('a'.repeat(MAX_MARKDOWN_CHARS + 50_000));
		assert.strictEqual(result.truncated, true);
		assert.ok(result.blocks.length >= 1);
	});

	it('handles very long single lines safely', () => {
		const result = parseMarkdown(`# ${'x'.repeat(50_000)}`);
		assert.strictEqual(result.blocks[0].type, 'heading');
	});
});
