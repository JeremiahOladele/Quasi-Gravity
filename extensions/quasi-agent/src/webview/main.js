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
	let currentAssistantEl = null;
	let lastToolEl = null;
	const approvalCards = new Map();

	function isHostFrame(message) {
		if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
			return false;
		}
		switch (message.type) {
			case 'history':
				return Array.isArray(message.entries);
			case 'state':
				return typeof message.streaming === 'boolean';
			case 'assistantDelta':
				return typeof message.text === 'string';
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

	function createEntry(kind, text) {
		const entry = document.createElement('div');
		entry.className = 'entry ' + kind;
		const body = document.createElement('div');
		body.className = 'text';
		body.textContent = text;
		entry.appendChild(body);
		return entry;
	}

	function createToolEntry(name, args, summary, isError) {
		const details = document.createElement('details');
		details.className = 'entry tool' + (isError ? ' tool-error' : '');
		const summaryEl = document.createElement('summary');
		summaryEl.textContent = 'Tool: ' + name;
		details.appendChild(summaryEl);
		const argsEl = document.createElement('pre');
		argsEl.textContent = args;
		details.appendChild(argsEl);
		const result = document.createElement('div');
		result.className = 'tool-result';
		result.textContent = summary;
		details.appendChild(result);
		return details;
	}

	function scrollToBottom() {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function resetPointers() {
		currentAssistantEl = null;
		lastToolEl = null;
	}

	function renderHistory(entries) {
		messagesEl.textContent = '';
		approvalCards.clear();
		resetPointers();
		for (const item of entries) {
			if (!item || typeof item.kind !== 'string') {
				continue;
			}
			if (item.kind === 'tool') {
				messagesEl.appendChild(createToolEntry(String(item.name || ''), String(item.args || ''), String(item.summary || ''), !!item.isError));
			} else if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'notice') {
				messagesEl.appendChild(createEntry(item.kind, String(item.text || '')));
			}
		}
		scrollToBottom();
	}

	function appendDelta(text) {
		if (!currentAssistantEl) {
			currentAssistantEl = createEntry('assistant', '');
			messagesEl.appendChild(currentAssistantEl);
		}
		const body = currentAssistantEl.querySelector('.text');
		if (body) {
			body.textContent += text;
		}
		scrollToBottom();
	}

	function showToolCall(name, args) {
		currentAssistantEl = null;
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

	function showNotice(text) {
		resetPointers();
		messagesEl.appendChild(createEntry('notice', text));
		scrollToBottom();
	}

	function showApproval(request) {
		resetPointers();
		const card = document.createElement('div');
		card.className = 'entry approval';
		const title = document.createElement('div');
		title.className = 'approval-title';
		title.textContent = request.reason === 'sensitive-file' ? 'Approval required: sensitive file' : 'Approval required: outside the workspace';
		card.appendChild(title);
		const detail = document.createElement('pre');
		detail.className = 'approval-detail';
		detail.textContent = request.detail + '\nTool: ' + request.toolName;
		card.appendChild(detail);
		const actions = document.createElement('div');
		actions.className = 'approval-actions';
		const allow = document.createElement('button');
		allow.type = 'button';
		allow.textContent = 'Allow';
		const deny = document.createElement('button');
		deny.type = 'button';
		deny.textContent = 'Deny';
		let resolved = false;
		const finish = approved => {
			if (resolved) {
				return;
			}
			resolved = true;
			allow.disabled = true;
			deny.disabled = true;
			card.classList.add(approved ? 'approved' : 'denied');
			const status = document.createElement('div');
			status.className = 'approval-status';
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
			case 'assistantDelta':
				appendDelta(message.text);
				break;
			case 'assistantDone':
				setStreaming(false);
				currentAssistantEl = null;
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
				messagesEl.textContent = '';
				clearError();
				approvalCards.clear();
				resetPointers();
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
		const text = inputEl.value.trim();
		if (!text) {
			return;
		}
		clearError();
		vscode.postMessage({ type: 'send', text: text });
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
