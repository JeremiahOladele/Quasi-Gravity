(function () {
	const vscode = acquireVsCodeApi();

	const messagesEl = document.getElementById('messages');
	const activeEl = document.getElementById('active');
	const inputEl = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const stopBtn = document.getElementById('stop');
	const newChatBtn = document.getElementById('newChat');
	const errorBox = document.getElementById('error');
	const errorText = document.getElementById('errorText');
	const errorAction = document.getElementById('errorAction');

	let streaming = false;
	let errorActionKind = null;
	let lastToolEl = null;
	let rafHandle = 0;
	let renderEpoch = 0;
	let pendingMarkdown = null;
	let approvalCards = new Map();
	let assistantContainers = new Map();

	const MD_MAX_DEPTH = 8;
	const MD_MAX_NODES = 20000;
	const MD_MAX_BLOCKS = 5000;

	function isInlineList(list, depth, counter) {
		return Array.isArray(list) && list.every(function (node) {
			return isInlineNode(node, depth, counter);
		});
	}

	function isInlineNode(node, depth, counter) {
		if (!node || typeof node !== 'object' || depth > MD_MAX_DEPTH || counter.nodes++ >= MD_MAX_NODES) {
			return false;
		}
		switch (node.type) {
			case 'text':
			case 'code':
				return typeof node.text === 'string';
			case 'strong':
			case 'em':
				return isInlineList(node.children, depth + 1, counter);
			case 'link':
				return typeof node.href === 'string' && /^https?:\/\//i.test(node.href) && isInlineList(node.children, depth + 1, counter);
			case 'image':
				return typeof node.alt === 'string' && typeof node.src === 'string';
			case 'break':
				return true;
			default:
				return false;
		}
	}

	function isBlockNode(node, depth, counter) {
		if (!node || typeof node !== 'object' || depth > MD_MAX_DEPTH || counter.blocks++ >= MD_MAX_BLOCKS) {
			return false;
		}
		switch (node.type) {
			case 'heading':
				return typeof node.level === 'number' && node.level >= 1 && node.level <= 6 && isInlineList(node.children, depth + 1, counter);
			case 'paragraph':
				return isInlineList(node.children, depth, counter);
			case 'code':
				return typeof node.text === 'string';
			case 'list':
				return typeof node.ordered === 'boolean' && typeof node.start === 'number'
					&& Array.isArray(node.items)
					&& node.items.every(function (item) {
						return Array.isArray(item) && item.every(function (child) {
							return isBlockNode(child, depth + 1, counter);
						});
					});
			case 'blockquote':
				return Array.isArray(node.blocks) && node.blocks.every(function (child) {
					return isBlockNode(child, depth + 1, counter);
				});
			case 'table':
				return Array.isArray(node.header) && Array.isArray(node.rows)
					&& node.header.every(function (cell) { return isInlineList(cell, depth + 1, counter); })
					&& node.rows.every(function (row) {
						return Array.isArray(row) && row.every(function (cell) {
							return isInlineList(cell, depth + 1, counter);
						});
					});
			case 'hr':
				return true;
			default:
				return false;
		}
	}

	function isMarkdownBlocks(blocks) {
		const counter = { nodes: 0, blocks: 0 };
		return Array.isArray(blocks) && blocks.length <= MD_MAX_BLOCKS && blocks.every(function (block) {
			return isBlockNode(block, 0, counter);
		});
	}

	function isHostFrame(message) {
		if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
			return false;
		}
		switch (message.type) {
			case 'history':
				return Array.isArray(message.entries);
			case 'state':
				return typeof message.streaming === 'boolean';
			case 'assistantMarkdown':
				return typeof message.messageId === 'string' && message.messageId.length > 0 && isMarkdownBlocks(message.blocks);
			case 'assistantDone':
				return true;
			case 'assistantError':
				return typeof message.kind === 'string' && typeof message.message === 'string';
			case 'toolCall':
				return typeof message.name === 'string' && typeof message.arguments === 'string';
			case 'toolResult':
				return typeof message.name === 'string' && typeof message.summary === 'string' && typeof message.isError === 'boolean';
			case 'approvalRequest':
				return typeof message.id === 'string' && typeof message.toolName === 'string' && typeof message.detail === 'string' && (message.reason === 'sensitive-file' || message.reason === 'outside-workspace');
			case 'approvalResolved':
				return typeof message.id === 'string' && typeof message.approved === 'boolean';
			case 'notice':
				return typeof message.text === 'string';
			case 'cleared':
				return true;
			case 'busy':
				return typeof message.value === 'boolean';
			default:
				return false;
		}
	}

	function el(tag, className) {
		const element = document.createElement(tag);
		if (className) {
			element.className = className;
		}
		return element;
	}

	function text(value) {
		return document.createTextNode(value);
	}

	function createEntry(kind, value) {
		const entry = el('div', 'entry ' + kind);
		const body = el('div', 'text');
		body.textContent = value;
		entry.appendChild(body);
		return entry;
	}

	function createToolEntry(name, args, summary, isError) {
		const details = el('details', 'entry tool' + (isError ? ' tool-error' : ''));
		const summaryEl = el('summary');
		summaryEl.textContent = 'Tool: ' + name;
		details.appendChild(summaryEl);
		const argsEl = el('pre');
		argsEl.textContent = args;
		details.appendChild(argsEl);
		const result = el('div', 'tool-result');
		result.textContent = summary;
		details.appendChild(result);
		return details;
	}

	function isNearBottom() {
		return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
	}

	function scrollToBottom() {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderInline(nodes, parent, messageId) {
		if (!Array.isArray(nodes)) {
			return;
		}
		for (const node of nodes) {
			if (!node || typeof node.type !== 'string') {
				continue;
			}
			switch (node.type) {
				case 'text':
					parent.appendChild(text(String(node.text || '')));
					break;
				case 'code': {
					const code = el('code');
					code.textContent = String(node.text || '');
					parent.appendChild(code);
					break;
				}
				case 'strong': {
					const strong = el('strong');
					renderInline(node.children, strong, messageId);
					parent.appendChild(strong);
					break;
				}
				case 'em': {
					const em = el('em');
					renderInline(node.children, em, messageId);
					parent.appendChild(em);
					break;
				}
				case 'link': {
					const href = String(node.href || '');
					const link = el('span', 'md-link');
					link.setAttribute('role', 'link');
					link.tabIndex = 0;
					link.title = href;
					renderInline(node.children, link, messageId);
					link.appendChild(text(' (' + href + ')'));
					const open = function () {
						vscode.postMessage({ type: 'openLink', url: href });
					};
					link.addEventListener('click', open);
					link.addEventListener('keydown', function (event) {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							open();
						}
					});
					parent.appendChild(link);
					break;
				}
				case 'image': {
					const image = el('span', 'md-image');
					image.textContent = '[image: ' + String(node.alt || '') + ' — ' + String(node.src || '') + ']';
					parent.appendChild(image);
					break;
				}
				case 'break':
					parent.appendChild(el('br'));
					break;
			}
		}
	}

	function renderBlocks(blocks, parent, messageId) {
		if (!Array.isArray(blocks)) {
			return;
		}
		blocks.forEach(function (block, index) {
			if (!block || typeof block.type !== 'string') {
				return;
			}
			switch (block.type) {
				case 'heading': {
					const level = Math.min(6, Math.max(1, Number(block.level) || 1));
					const heading = el('h' + level);
					renderInline(block.children, heading, messageId);
					parent.appendChild(heading);
					break;
				}
				case 'paragraph': {
					const paragraph = el('p');
					renderInline(block.children, paragraph, messageId);
					parent.appendChild(paragraph);
					break;
				}
				case 'code': {
					const wrapper = el('div', 'md-code');
					const header = el('div', 'md-code-header');
					const language = el('span', 'md-code-lang');
					language.textContent = String(block.language || 'code');
					header.appendChild(language);
					const copy = el('button', 'md-copy');
					copy.type = 'button';
					copy.textContent = 'Copy';
					copy.addEventListener('click', function () {
						vscode.postMessage({ type: 'copy', messageId: messageId, blockIndex: index });
					});
					header.appendChild(copy);
					const pre = el('pre');
					const code = el('code');
					code.textContent = String(block.text || '');
					pre.appendChild(code);
					wrapper.appendChild(header);
					wrapper.appendChild(pre);
					parent.appendChild(wrapper);
					break;
				}
				case 'list': {
					const list = el(block.ordered ? 'ol' : 'ul');
					if (block.ordered && Number(block.start) > 1) {
						list.setAttribute('start', String(block.start));
					}
					for (const item of (block.items || [])) {
						const li = el('li');
						const itemBlocks = Array.isArray(item) ? item : [];
						if (itemBlocks.length === 1 && itemBlocks[0] && itemBlocks[0].type === 'paragraph') {
							renderInline(itemBlocks[0].children, li, messageId);
						} else {
							renderBlocks(itemBlocks, li, messageId);
						}
						list.appendChild(li);
					}
					parent.appendChild(list);
					break;
				}
				case 'blockquote': {
					const quote = el('blockquote');
					renderBlocks(block.blocks, quote, messageId);
					parent.appendChild(quote);
					break;
				}
				case 'table': {
					const table = el('table');
					const thead = el('thead');
					const headerRow = el('tr');
					(block.header || []).forEach(function (cell, cellIndex) {
						const th = el('th');
						if (block.alignment && block.alignment[cellIndex]) {
							th.style.textAlign = block.alignment[cellIndex];
						}
						renderInline(cell, th, messageId);
						headerRow.appendChild(th);
					});
					thead.appendChild(headerRow);
					table.appendChild(thead);
					const tbody = el('tbody');
					for (const row of (block.rows || [])) {
						const tr = el('tr');
						(row || []).forEach(function (cell, cellIndex) {
							const td = el('td');
							if (block.alignment && block.alignment[cellIndex]) {
								td.style.textAlign = block.alignment[cellIndex];
							}
							renderInline(cell, td, messageId);
							tr.appendChild(td);
						});
						tbody.appendChild(tr);
					}
					table.appendChild(tbody);
					parent.appendChild(table);
					break;
				}
				case 'hr':
					parent.appendChild(el('hr'));
					break;
			}
		});
	}

	function getAssistantContainer(messageId) {
		let container = assistantContainers.get(messageId);
		if (!container) {
			container = el('div', 'entry assistant markdown');
			messagesEl.appendChild(container);
			assistantContainers.set(messageId, container);
		}
		return container;
	}

	function scheduleMarkdown(messageId, blocks) {
		pendingMarkdown = { messageId: messageId, blocks: blocks };
		if (rafHandle !== 0) {
			return;
		}
		const epoch = renderEpoch;
		rafHandle = window.requestAnimationFrame(function () {
			rafHandle = 0;
			const pending = pendingMarkdown;
			pendingMarkdown = null;
			if (!pending || epoch !== renderEpoch) {
				return;
			}
			const atBottom = isNearBottom();
			const container = getAssistantContainer(pending.messageId);
			container.textContent = '';
			renderBlocks(pending.blocks, container, pending.messageId);
			if (atBottom) {
				scrollToBottom();
			}
		});
	}

	function renderHistory(entries) {
		renderEpoch++;
		pendingMarkdown = null;
		if (rafHandle !== 0) {
			window.cancelAnimationFrame(rafHandle);
			rafHandle = 0;
		}
		messagesEl.textContent = '';
		approvalCards = new Map();
		assistantContainers = new Map();
		lastToolEl = null;
		for (const item of entries) {
			if (!item || typeof item.kind !== 'string') {
				continue;
			}
			if (item.kind === 'tool') {
				messagesEl.appendChild(createToolEntry(String(item.name || ''), String(item.args || ''), String(item.summary || ''), !!item.isError));
			} else if (item.kind === 'assistant' && typeof item.id === 'string' && item.id.length > 0 && isMarkdownBlocks(item.blocks)) {
				const container = getAssistantContainer(item.id);
				renderBlocks(item.blocks, container, item.id);
			} else if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'notice') {
				messagesEl.appendChild(createEntry(item.kind, String(item.text || '')));
			}
		}
		scrollToBottom();
	}

	function showToolCall(name, args) {
		lastToolEl = createToolEntry(name, args, 'running…', false);
		messagesEl.appendChild(lastToolEl);
		scrollToBottom();
	}

	function showToolResult(name, summary, isError) {
		if (lastToolEl) {
			lastToolEl.classList.toggle('tool-error', !!isError);
			const result = lastToolEl.querySelector('.tool-result');
			if (result) {
				result.textContent = summary;
			}
			lastToolEl = null;
		} else {
			messagesEl.appendChild(createToolEntry(name, '', summary, !!isError));
		}
		scrollToBottom();
	}

	function showNotice(value) {
		messagesEl.appendChild(createEntry('notice', value));
		scrollToBottom();
	}

	function showApproval(request) {
		const card = el('div', 'entry approval');
		const title = el('div', 'approval-title');
		title.textContent = request.reason === 'sensitive-file' ? 'Approval required: sensitive file' : 'Approval required: outside the workspace';
		card.appendChild(title);
		const detail = el('pre', 'approval-detail');
		detail.textContent = request.detail + '\nTool: ' + request.toolName;
		card.appendChild(detail);
		const actions = el('div', 'approval-actions');
		const allow = el('button');
		allow.type = 'button';
		allow.textContent = 'Allow';
		const deny = el('button');
		deny.type = 'button';
		deny.textContent = 'Deny';
		let resolved = false;
		const finish = function (approved) {
			if (resolved) {
				return;
			}
			resolved = true;
			allow.disabled = true;
			deny.disabled = true;
			card.classList.add(approved ? 'approved' : 'denied');
			const status = el('div', 'approval-status');
			status.textContent = approved ? 'Allowed' : 'Denied';
			card.appendChild(status);
		};
		allow.addEventListener('click', function () {
			vscode.postMessage({ type: 'approvalResponse', id: request.id, approved: true });
			finish(true);
		});
		deny.addEventListener('click', function () {
			vscode.postMessage({ type: 'approvalResponse', id: request.id, approved: false });
			finish(false);
		});
		actions.appendChild(allow);
		actions.appendChild(deny);
		card.appendChild(actions);
		messagesEl.appendChild(card);
		approvalCards.set(request.id, finish);
		scrollToBottom();
	}

	function resolveApproval(id, approved) {
		const finish = approvalCards.get(id);
		if (finish) {
			finish(approved);
			approvalCards.delete(id);
		}
	}

	function setStreaming(value) {
		streaming = value;
		stopBtn.disabled = !value;
		sendBtn.disabled = value;
	}

	function setActive(active) {
		if (active && typeof active.providerName === 'string' && typeof active.model === 'string') {
			activeEl.textContent = active.providerName + ' · ' + active.model;
		} else {
			activeEl.textContent = 'No model';
		}
	}

	function clearError() {
		errorBox.hidden = true;
		errorText.textContent = '';
		errorAction.hidden = true;
		errorActionKind = null;
	}

	function showError(kind, message) {
		errorBox.hidden = false;
		errorText.textContent = message;
		if (kind === 'no-model') {
			errorActionKind = 'addProvider';
			errorAction.textContent = 'Add provider';
			errorAction.hidden = false;
		} else if (kind === 'key-rejected') {
			errorActionKind = 'setApiKey';
			errorAction.textContent = 'Set API Key';
			errorAction.hidden = false;
		} else {
			errorActionKind = null;
			errorAction.hidden = true;
		}
	}

	function handleFrame(message) {
		switch (message.type) {
			case 'history':
				renderHistory(message.entries);
				break;
			case 'state':
				setActive(message.active);
				setStreaming(message.streaming);
				break;
			case 'assistantMarkdown':
				scheduleMarkdown(message.messageId, message.blocks);
				break;
			case 'assistantDone':
				setStreaming(false);
				break;
			case 'assistantError':
				showError(message.kind, message.message);
				setStreaming(false);
				break;
			case 'toolCall':
				showToolCall(message.name, message.arguments);
				break;
			case 'toolResult':
				showToolResult(message.name, message.summary, message.isError);
				break;
			case 'approvalRequest':
				showApproval(message);
				break;
			case 'approvalResolved':
				resolveApproval(message.id, message.approved);
				break;
			case 'notice':
				showNotice(message.text);
				break;
			case 'cleared':
				renderEpoch++;
				pendingMarkdown = null;
				if (rafHandle !== 0) {
					window.cancelAnimationFrame(rafHandle);
					rafHandle = 0;
				}
				messagesEl.textContent = '';
				approvalCards = new Map();
				assistantContainers = new Map();
				lastToolEl = null;
				clearError();
				break;
			case 'busy':
				setStreaming(message.value);
				break;
		}
	}

	window.addEventListener('message', function (event) {
		const message = event.data;
		if (!isHostFrame(message)) {
			return;
		}
		handleFrame(message);
	});

	function submit() {
		if (streaming) {
			return;
		}
		const value = inputEl.value.trim();
		if (!value) {
			return;
		}
		clearError();
		vscode.postMessage({ type: 'send', text: value });
		inputEl.value = '';
	}

	sendBtn.addEventListener('click', submit);
	inputEl.addEventListener('keydown', function (event) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	});
	stopBtn.addEventListener('click', function () {
		vscode.postMessage({ type: 'stop' });
	});
	newChatBtn.addEventListener('click', function () {
		vscode.postMessage({ type: 'newChat' });
	});
	errorAction.addEventListener('click', function () {
		if (errorActionKind) {
			vscode.postMessage({ type: errorActionKind });
		}
	});

	setStreaming(false);
	vscode.postMessage({ type: 'ready' });
})();
