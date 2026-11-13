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

	function scrollToBottom() {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderHistory(entries) {
		messagesEl.textContent = '';
		for (const item of entries) {
			if (!item || typeof item.text !== 'string') {
				continue;
			}
			const kind = item.kind === 'assistant' || item.kind === 'notice' ? item.kind : 'user';
			messagesEl.appendChild(createEntry(kind, item.text));
		}
		scrollToBottom();
	}

	function appendDelta(text) {
		let target = null;
		for (let index = messagesEl.children.length - 1; index >= 0; index--) {
			const child = messagesEl.children[index];
			if (child.classList && child.classList.contains('assistant')) {
				target = child;
				break;
			}
		}
		if (!target) {
			target = createEntry('assistant', '');
			messagesEl.appendChild(target);
		}
		const body = target.querySelector('.text');
		if (body) {
			body.textContent += text;
		}
		scrollToBottom();
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
				break;
			case 'assistantError':
				showError(message.kind, message.message);
				setStreaming(false);
				break;
			case 'cleared':
				messagesEl.textContent = '';
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
