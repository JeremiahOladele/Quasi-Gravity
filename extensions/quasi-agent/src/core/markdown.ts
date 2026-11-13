/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const MAX_MARKDOWN_CHARS = 100_000;
export const MAX_BLOCKS = 5_000;
export const MAX_INLINE_NODES = 20_000;
export const MAX_DEPTH = 8;
export const MAX_URL_LENGTH = 2_000;

export type MarkdownBlock =
	| { readonly type: 'heading'; readonly level: number; readonly children: MarkdownInline[] }
	| { readonly type: 'paragraph'; readonly children: MarkdownInline[] }
	| { readonly type: 'code'; readonly language?: string; readonly text: string }
	| { readonly type: 'list'; readonly ordered: boolean; readonly start: number; readonly items: MarkdownBlock[][] }
	| { readonly type: 'blockquote'; readonly blocks: MarkdownBlock[] }
	| { readonly type: 'table'; readonly alignment: ReadonlyArray<'left' | 'center' | 'right' | undefined>; readonly header: MarkdownInline[][]; readonly rows: MarkdownInline[][][] }
	| { readonly type: 'hr' };

export type MarkdownInline =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'strong'; readonly children: MarkdownInline[] }
	| { readonly type: 'em'; readonly children: MarkdownInline[] }
	| { readonly type: 'code'; readonly text: string }
	| { readonly type: 'link'; readonly href: string; readonly children: MarkdownInline[] }
	| { readonly type: 'image'; readonly alt: string; readonly src: string }
	| { readonly type: 'break' };

export interface MarkdownParseResult {
	readonly blocks: MarkdownBlock[];
	readonly truncated: boolean;
}

interface Budget {
	blocks: number;
	nodes: number;
	truncated: boolean;
}

/** Only http/https links may become clickable. Everything else is text. */
export function isAllowedLink(url: string): boolean {
	const trimmed = url.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
		return false;
	}
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

function indentOf(line: string): number {
	let indent = 0;
	for (const char of line) {
		if (char === ' ') {
			indent++;
		} else if (char === '\t') {
			indent += 4;
		} else {
			break;
		}
	}
	return indent;
}

function stripIndent(line: string, indent: number): string {
	let index = 0;
	let consumed = 0;
	while (index < line.length && consumed < indent) {
		const char = line[index];
		if (char === ' ') {
			consumed++;
			index++;
		} else if (char === '\t') {
			consumed += 4;
			index++;
		} else {
			break;
		}
	}
	return line.slice(index);
}

interface FenceStart {
	readonly char: string;
	readonly length: number;
	readonly language?: string;
}

function fenceStart(line: string): FenceStart | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) {
		return undefined;
	}
	const marker = match[2];
	const info = match[3].trim();
	const language = info.length > 0 ? info.split(/\s+/)[0] : undefined;
	return { char: marker[0], length: marker.length, language };
}

function isFenceClose(line: string, fence: FenceStart): boolean {
	const trimmed = line.trim();
	if (trimmed.length < fence.length) {
		return false;
	}
	for (const char of trimmed) {
		if (char !== fence.char) {
			return false;
		}
	}
	return true;
}

function parseHeading(line: string): { level: number; text: string } | undefined {
	const match = /^( {0,3})(#{1,6})[ \t]+(.*)$/.exec(line);
	if (!match) {
		return undefined;
	}
	const text = match[3].replace(/[ \t]+#+[ \t]*$/, '').trim();
	return { level: match[2].length, text };
}

function isHr(line: string): boolean {
	const stripped = line.trim().replace(/[ \t]/g, '');
	if (stripped.length < 3) {
		return false;
	}
	const char = stripped[0];
	if (char !== '-' && char !== '*' && char !== '_') {
		return false;
	}
	for (const current of stripped) {
		if (current !== char) {
			return false;
		}
	}
	return true;
}

function isBlockquoteStart(line: string): boolean {
	return /^ {0,3}>/.test(line);
}

interface ListMarker {
	readonly indent: number;
	readonly ordered: boolean;
	readonly start: number;
	readonly content: string;
	readonly contentIndent: number;
}

function parseListMarker(line: string): ListMarker | undefined {
	const match = /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+)(.*)$/.exec(line);
	if (!match) {
		return undefined;
	}
	const indent = match[1].length;
	const marker = match[2];
	const whitespace = match[4].length;
	const ordered = /^\d/.test(marker);
	return {
		indent,
		ordered,
		start: ordered ? Number.parseInt(marker, 10) : 1,
		content: match[5],
		contentIndent: indent + marker.length + whitespace
	};
}

function isTableDelimiter(line: string): { alignments: Array<'left' | 'center' | 'right' | undefined> } | undefined {
	if (!line.includes('-')) {
		return undefined;
	}
	const cells = splitTableRow(line);
	if (cells.length === 0) {
		return undefined;
	}
	const alignments: Array<'left' | 'center' | 'right' | undefined> = [];
	for (const cell of cells) {
		if (!/^:?-{3,}:?$/.test(cell)) {
			return undefined;
		}
		const left = cell.startsWith(':');
		const right = cell.endsWith(':');
		alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : undefined);
	}
	return { alignments };
}

function splitTableRow(line: string): string[] {
	let value = line.trim();
	if (value.startsWith('|')) {
		value = value.slice(1);
	}
	if (value.endsWith('|') && !value.endsWith('\\|')) {
		value = value.slice(0, -1);
	}
	return value.split('|').map(cell => cell.trim());
}

function isBlockStart(lines: ReadonlyArray<string>, index: number): boolean {
	const line = lines[index];
	if (line === undefined) {
		return false;
	}
	if (fenceStart(line) || parseHeading(line) || isHr(line) || isBlockquoteStart(line) || parseListMarker(line)) {
		return true;
	}
	if (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
		return true;
	}
	return false;
}

function parseMarkdownInternal(input: string): MarkdownParseResult {
	let text = input.replace(/\r\n?/g, '\n');
	let truncated = false;
	if (text.length > MAX_MARKDOWN_CHARS) {
		text = text.slice(0, MAX_MARKDOWN_CHARS);
		truncated = true;
	}
	const budget: Budget = { blocks: 0, nodes: 0, truncated };
	const blocks = parseBlocks(text.split('\n'), 0, budget);
	if (budget.truncated) {
		truncated = true;
	}
	return { blocks, truncated };
}

/** Parse markdown into a safe AST. Never throws; caps input and node counts. */
export function parseMarkdown(input: string): MarkdownParseResult {
	try {
		return parseMarkdownInternal(input);
	} catch {
		return { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: input.slice(0, MAX_MARKDOWN_CHARS) }] }], truncated: true };
	}
}

function parseBlocks(lines: ReadonlyArray<string>, depth: number, budget: Budget): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	if (depth > MAX_DEPTH) {
		budget.truncated = true;
		return blocks;
	}
	let index = 0;
	while (index < lines.length) {
		if (budget.blocks >= MAX_BLOCKS) {
			budget.truncated = true;
			break;
		}
		const line = lines[index];
		if (isBlank(line)) {
			index++;
			continue;
		}

		const fence = fenceStart(line);
		if (fence) {
			const content: string[] = [];
			index++;
			while (index < lines.length && !isFenceClose(lines[index], fence)) {
				content.push(lines[index]);
				index++;
			}
			if (index < lines.length) {
				index++;
			}
			blocks.push({ type: 'code', language: fence.language, text: content.join('\n') });
			budget.blocks++;
			continue;
		}

		const heading = parseHeading(line);
		if (heading) {
			blocks.push({ type: 'heading', level: heading.level, children: parseInline(heading.text, depth, budget) });
			budget.blocks++;
			index++;
			continue;
		}

		if (isHr(line)) {
			blocks.push({ type: 'hr' });
			budget.blocks++;
			index++;
			continue;
		}

		if (isBlockquoteStart(line)) {
			const inner: string[] = [];
			while (index < lines.length && isBlockquoteStart(lines[index])) {
				inner.push(lines[index].replace(/^ {0,3}> ?/, ''));
				index++;
			}
			blocks.push({ type: 'blockquote', blocks: parseBlocks(inner, depth + 1, budget) });
			budget.blocks++;
			continue;
		}

		const list = parseListMarker(line);
		if (list) {
			const parsed = parseList(lines, index, list, depth, budget);
			blocks.push(parsed.block);
			budget.blocks++;
			index = parsed.next;
			continue;
		}

		const table = tryParseTable(lines, index, depth, budget);
		if (table) {
			blocks.push(table.block);
			budget.blocks++;
			index = table.next;
			continue;
		}

		const paragraphLines: string[] = [];
		while (index < lines.length && !isBlank(lines[index]) && !isBlockStart(lines, index)) {
			paragraphLines.push(lines[index].trim());
			index++;
		}
		if (paragraphLines.length === 0) {
			paragraphLines.push(lines[index].trim());
			index++;
		}
		blocks.push({ type: 'paragraph', children: parseInline(paragraphLines.join(' '), depth, budget) });
		budget.blocks++;
	}
	return blocks;
}

function parseList(lines: ReadonlyArray<string>, start: number, first: ListMarker, depth: number, budget: Budget): { block: MarkdownBlock; next: number } {
	const items: string[][] = [];
	let current: string[] = [first.content];
	let contentIndent = first.contentIndent;
	let index = start + 1;

	const flush = () => {
		items.push(current);
	};

	while (index < lines.length) {
		const line = lines[index];
		if (isBlank(line)) {
			let lookahead = index + 1;
			while (lookahead < lines.length && isBlank(lines[lookahead])) {
				lookahead++;
			}
			const nextLine = lines[lookahead];
			if (nextLine === undefined) {
				index = lookahead;
				break;
			}
			const nextIndent = indentOf(nextLine);
			const nextMarker = parseListMarker(nextLine);
			if ((nextMarker && nextMarker.indent === first.indent) || nextIndent >= contentIndent) {
				current.push('');
				index++;
				continue;
			}
			break;
		}
		const marker = parseListMarker(line);
		if (marker && marker.indent === first.indent) {
			flush();
			current = [marker.content];
			contentIndent = marker.contentIndent;
			index++;
			continue;
		}
		if (indentOf(line) >= contentIndent) {
			current.push(stripIndent(line, contentIndent));
			index++;
			continue;
		}
		break;
	}
	flush();

	const itemBlocks = items.map(item => parseBlocks(item, depth + 1, budget));
	return {
		block: { type: 'list', ordered: first.ordered, start: first.start, items: itemBlocks },
		next: index
	};
}

function tryParseTable(lines: ReadonlyArray<string>, index: number, depth: number, budget: Budget): { block: MarkdownBlock; next: number } | undefined {
	if (index + 1 >= lines.length || !lines[index].includes('|')) {
		return undefined;
	}
	const delimiter = isTableDelimiter(lines[index + 1]);
	if (!delimiter) {
		return undefined;
	}
	const headerCells = splitTableRow(lines[index]);
	if (headerCells.length !== delimiter.alignments.length) {
		return undefined;
	}
	const header = headerCells.map(cell => parseInline(cell, depth, budget));
	const rows: MarkdownInline[][][] = [];
	let next = index + 2;
	while (next < lines.length && !isBlank(lines[next]) && lines[next].includes('|')) {
		const cells = splitTableRow(lines[next]);
		if (cells.length !== headerCells.length) {
			break;
		}
		rows.push(cells.map(cell => parseInline(cell, depth, budget)));
		next++;
	}
	return { block: { type: 'table', alignment: delimiter.alignments, header, rows }, next };
}

function countRun(text: string, start: number, char: string): number {
	let length = 0;
	while (start + length < text.length && text[start + length] === char) {
		length++;
	}
	return length;
}

function findRun(text: string, start: number, char: string, length: number): number {
	let index = start;
	while (index < text.length) {
		const found = text.indexOf(char, index);
		if (found === -1) {
			return -1;
		}
		if (countRun(text, found, char) >= length) {
			return found;
		}
		index = found + countRun(text, found, char);
	}
	return -1;
}

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function parseInline(text: string, depth: number, budget: Budget): MarkdownInline[] {
	const nodes: MarkdownInline[] = [];
	if (depth > MAX_DEPTH) {
		budget.truncated = true;
		return [{ type: 'text', text }];
	}
	let index = 0;
	let textStart = 0;

	const pushText = (value: string) => {
		if (value.length > 0) {
			nodes.push({ type: 'text', text: value });
			budget.nodes++;
		}
	};
	const flush = (end: number) => {
		if (end > textStart) {
			pushText(text.slice(textStart, end));
		}
	};

	while (index < text.length) {
		if (budget.nodes >= MAX_INLINE_NODES) {
			budget.truncated = true;
			flush(text.length);
			return nodes;
		}
		const char = text[index];

		if (char === '\\' && index + 1 < text.length) {
			flush(index);
			pushText(text[index + 1]);
			index += 2;
			textStart = index;
			continue;
		}

		if (char === '`') {
			const run = countRun(text, index, '`');
			const close = findRun(text, index + run, '`', run);
			if (close !== -1) {
				flush(index);
				let code = text.slice(index + run, close);
				if (code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) {
					code = code.slice(1, -1);
				}
				nodes.push({ type: 'code', text: code });
				budget.nodes++;
				index = close + run;
				textStart = index;
				continue;
			}
			index += run;
			continue;
		}

		if (char === '!' && text[index + 1] === '[') {
			const image = parseImage(text, index);
			if (image) {
				flush(index);
				nodes.push(image.node);
				budget.nodes++;
				index = image.end;
				textStart = index;
				continue;
			}
			index += 2;
			continue;
		}

		if (char === '[') {
			const link = parseLink(text, index, depth, budget);
			if (link) {
				flush(index);
				nodes.push(link.node);
				budget.nodes++;
				index = link.end;
				textStart = index;
				continue;
			}
			index++;
			continue;
		}

		if (char === '*' || char === '_') {
			const strong = tryEmphasis(text, index, char, true, depth, budget);
			if (strong) {
				flush(index);
				nodes.push(strong.node);
				budget.nodes++;
				index = strong.end;
				textStart = index;
				continue;
			}
			const em = tryEmphasis(text, index, char, false, depth, budget);
			if (em) {
				flush(index);
				nodes.push(em.node);
				budget.nodes++;
				index = em.end;
				textStart = index;
				continue;
			}
			index++;
			continue;
		}

		index++;
	}

	flush(text.length);
	return nodes;
}

function parseImage(text: string, index: number): { node: MarkdownInline; end: number } | undefined {
	const labelEnd = findBracketClose(text, index + 2);
	if (labelEnd === -1 || text[labelEnd + 1] !== '(') {
		return undefined;
	}
	const urlEnd = text.indexOf(')', labelEnd + 2);
	if (urlEnd === -1) {
		return undefined;
	}
	const alt = text.slice(index + 2, labelEnd);
	const src = text.slice(labelEnd + 2, urlEnd).trim();
	if (src.length > MAX_URL_LENGTH) {
		return undefined;
	}
	return { node: { type: 'image', alt, src }, end: urlEnd + 1 };
}

function parseLink(text: string, index: number, depth: number, budget: Budget): { node: MarkdownInline; end: number } | undefined {
	const labelEnd = findBracketClose(text, index + 1);
	if (labelEnd === -1 || text[labelEnd + 1] !== '(') {
		return undefined;
	}
	const urlEnd = text.indexOf(')', labelEnd + 2);
	if (urlEnd === -1) {
		return undefined;
	}
	const label = text.slice(index + 1, labelEnd);
	const url = text.slice(labelEnd + 2, urlEnd).trim();
	const source = text.slice(index, urlEnd + 1);
	if (!isAllowedLink(url)) {
		return { node: { type: 'text', text: source }, end: urlEnd + 1 };
	}
	return { node: { type: 'link', href: url, children: parseInline(label, depth + 1, budget) }, end: urlEnd + 1 };
}

function findBracketClose(text: string, start: number): number {
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (char === '\\') {
			index++;
			continue;
		}
		if (char === '[') {
			depth++;
		} else if (char === ']') {
			if (depth === 0) {
				return index;
			}
			depth--;
		}
	}
	return -1;
}

function tryEmphasis(text: string, index: number, char: string, strong: boolean, depth: number, budget: Budget): { node: MarkdownInline; end: number } | undefined {
	const marker = strong ? char + char : char;
	if (char === '_' && isWordChar(text[index - 1])) {
		return undefined;
	}
	const contentStart = index + marker.length;
	const close = findEmphasisClose(text, contentStart, marker, char);
	if (close === -1) {
		return undefined;
	}
	const inner = text.slice(contentStart, close);
	if (inner.length === 0 || inner.trim().length === 0) {
		return undefined;
	}
	if (/\s/.test(inner[0]) || /\s/.test(inner[inner.length - 1])) {
		return undefined;
	}
	if (char === '_' && isWordChar(text[close + marker.length])) {
		return undefined;
	}
	return {
		node: { type: strong ? 'strong' : 'em', children: parseInline(inner, depth + 1, budget) },
		end: close + marker.length
	};
}

function findEmphasisClose(text: string, start: number, marker: string, char: string): number {
	let index = start;
	while (index < text.length) {
		const found = text.indexOf(marker, index);
		if (found === -1) {
			return -1;
		}
		if (char === '_' && isWordChar(text[found + marker.length])) {
			index = found + marker.length;
			continue;
		}
		return found;
	}
	return -1;
}

interface ValidationCounter {
	nodes: number;
	blocks: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structurally validate an AST received from another context. Enforces depth,
 * block, node, string, and URL caps so the webview never renders a malicious
 * or oversized tree.
 */
export function validateMarkdownBlocks(raw: unknown): MarkdownBlock[] | undefined {
	if (!Array.isArray(raw) || raw.length > MAX_BLOCKS) {
		return undefined;
	}
	const counter: ValidationCounter = { nodes: 0, blocks: 0 };
	const blocks: MarkdownBlock[] = [];
	for (const item of raw) {
		const block = validateBlock(item, 0, counter);
		if (!block) {
			return undefined;
		}
		blocks.push(block);
	}
	return blocks;
}

function validateBlock(raw: unknown, depth: number, counter: ValidationCounter): MarkdownBlock | undefined {
	if (!isRecord(raw) || depth > MAX_DEPTH || counter.blocks++ >= MAX_BLOCKS) {
		return undefined;
	}
	switch (raw.type) {
		case 'heading': {
			if (typeof raw.level !== 'number' || raw.level < 1 || raw.level > 6) {
				return undefined;
			}
			const children = validateInlineList(raw.children, depth + 1, counter);
			return children ? { type: 'heading', level: raw.level, children } : undefined;
		}
		case 'paragraph': {
			const children = validateInlineList(raw.children, depth, counter);
			return children ? { type: 'paragraph', children } : undefined;
		}
		case 'code': {
			if (typeof raw.text !== 'string' || raw.text.length > MAX_MARKDOWN_CHARS) {
				return undefined;
			}
			if (raw.language !== undefined && typeof raw.language !== 'string') {
				return undefined;
			}
			return typeof raw.language === 'string'
				? { type: 'code', language: raw.language, text: raw.text }
				: { type: 'code', text: raw.text };
		}
		case 'list': {
			if (typeof raw.ordered !== 'boolean' || typeof raw.start !== 'number' || !Array.isArray(raw.items)) {
				return undefined;
			}
			const items: MarkdownBlock[][] = [];
			for (const item of raw.items) {
				if (!Array.isArray(item)) {
					return undefined;
				}
				const children: MarkdownBlock[] = [];
				for (const child of item) {
					const block = validateBlock(child, depth + 1, counter);
					if (!block) {
						return undefined;
					}
					children.push(block);
				}
				items.push(children);
			}
			return { type: 'list', ordered: raw.ordered, start: raw.start, items };
		}
		case 'blockquote': {
			if (!Array.isArray(raw.blocks)) {
				return undefined;
			}
			const children: MarkdownBlock[] = [];
			for (const child of raw.blocks) {
				const block = validateBlock(child, depth + 1, counter);
				if (!block) {
					return undefined;
				}
				children.push(block);
			}
			return { type: 'blockquote', blocks: children };
		}
		case 'table': {
			if (!Array.isArray(raw.alignment) || !Array.isArray(raw.header) || !Array.isArray(raw.rows)) {
				return undefined;
			}
			const alignment = raw.alignment.map(value => (value === 'left' || value === 'center' || value === 'right' ? value : undefined));
			const header: MarkdownInline[][] = [];
			for (const cells of raw.header) {
				const validated = validateInlineList(cells, depth + 1, counter);
				if (!validated) {
					return undefined;
				}
				header.push(validated);
			}
			const rows: MarkdownInline[][][] = [];
			for (const row of raw.rows) {
				if (!Array.isArray(row)) {
					return undefined;
				}
				const cells: MarkdownInline[][] = [];
				for (const cell of row) {
					const validated = validateInlineList(cell, depth + 1, counter);
					if (!validated) {
						return undefined;
					}
					cells.push(validated);
				}
				rows.push(cells);
			}
			return { type: 'table', alignment, header, rows };
		}
		case 'hr':
			return { type: 'hr' };
		default:
			return undefined;
	}
}

function validateInlineList(raw: unknown, depth: number, counter: ValidationCounter): MarkdownInline[] | undefined {
	if (!Array.isArray(raw) || depth > MAX_DEPTH) {
		return undefined;
	}
	const nodes: MarkdownInline[] = [];
	for (const item of raw) {
		const node = validateInline(item, depth, counter);
		if (!node) {
			return undefined;
		}
		nodes.push(node);
	}
	return nodes;
}

function validateInline(raw: unknown, depth: number, counter: ValidationCounter): MarkdownInline | undefined {
	if (!isRecord(raw) || depth > MAX_DEPTH || counter.nodes++ >= MAX_INLINE_NODES) {
		return undefined;
	}
	switch (raw.type) {
		case 'text':
		case 'code':
			return typeof raw.text === 'string' && raw.text.length <= MAX_MARKDOWN_CHARS
				? { type: raw.type, text: raw.text }
				: undefined;
		case 'strong':
		case 'em': {
			const children = validateInlineList(raw.children, depth + 1, counter);
			return children ? { type: raw.type, children } : undefined;
		}
		case 'link': {
			if (typeof raw.href !== 'string' || !isAllowedLink(raw.href)) {
				return undefined;
			}
			const children = validateInlineList(raw.children, depth + 1, counter);
			return children ? { type: 'link', href: raw.href, children } : undefined;
		}
		case 'image':
			return typeof raw.alt === 'string' && typeof raw.src === 'string'
				? { type: 'image', alt: raw.alt.slice(0, MAX_MARKDOWN_CHARS), src: raw.src.slice(0, MAX_URL_LENGTH) }
				: undefined;
		case 'break':
			return { type: 'break' };
		default:
			return undefined;
	}
}
