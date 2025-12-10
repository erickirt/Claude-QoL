// phantom-messages.js
'use strict';

const PHANTOM_PREFIX = 'phantom_messages_';
const OLD_FORK_PREFIX = 'fork_history_';
const PHANTOM_MARKER = '====PHANTOM_MESSAGE====';
const UUID_MARKER_PREFIX = '====UUID:';
const UUID_MARKER_SUFFIX = '====';

// ==== STORAGE FUNCTIONS (async, use IndexedDB via messages) ====
async function storePhantomMessages(conversationId, messages) {
	console.log(`[Phantom Messages] Storing ${messages.length} messages for conversation ${conversationId} in IndexedDB`);
	return new Promise((resolve) => {
		const handler = (event) => {
			if (event.data.type === 'PHANTOM_MESSAGES_STORED' &&
				event.data.conversationId === conversationId) {
				window.removeEventListener('message', handler);
				console.log(`[Phantom Messages] Stored messages for conversation ${conversationId} successfully`);

				window.postMessage({
					type: 'PHANTOM_MESSAGES_STORED_CONFIRMED',
					conversationId
				}, '*');

				resolve();
			}
		};

		window.addEventListener('message', handler);

		window.postMessage({
			type: 'STORE_PHANTOM_MESSAGES_IDB',
			conversationId,
			phantomMessages: messages
		}, '*');
	});
}

async function getPhantomMessages(conversationId) {
	// Check localStorage first and migrate if found
	const oldKey = `${OLD_FORK_PREFIX}${conversationId}`;
	const newKey = `${PHANTOM_PREFIX}${conversationId}`;

	const orgId = getOrgId();
	const conversation = new ClaudeConversation(orgId, conversationId);

	const localData = localStorage.getItem(newKey) || localStorage.getItem(oldKey);
	if (localData) {
		console.log(`[Migration] Migrating ${conversationId} to IndexedDB`);
		const messagesJson = JSON.parse(localData);
		const messages = messagesJson.map(json => new ClaudeMessage(conversation, json));
		await storePhantomMessages(conversationId, messages);
		localStorage.removeItem(newKey);
		localStorage.removeItem(oldKey);
		return messages;
	}

	// Get from IndexedDB
	return new Promise((resolve) => {
		const handler = (event) => {
			if (event.data.type === 'PHANTOM_MESSAGES_RESPONSE' &&
				event.data.conversationId === conversationId) {
				window.removeEventListener('message', handler);
				const messagesJson = event.data.messages;
				if (messagesJson) {
					resolve(messagesJson.map(json => new ClaudeMessage(conversation, json)));
				} else {
					resolve(null);
				}
			}
		};

		window.addEventListener('message', handler);
		window.postMessage({
			type: 'GET_PHANTOM_MESSAGES_IDB',
			conversationId
		}, '*');

		setTimeout(() => {
			window.removeEventListener('message', handler);
			resolve(null);
		}, 5000);
	});
}

// Currently unused. But could be relevant later.
async function clearPhantomMessages(conversationId) {
	localStorage.removeItem(`${PHANTOM_PREFIX}${conversationId}`);
	localStorage.removeItem(`${OLD_FORK_PREFIX}${conversationId}`);

	return new Promise((resolve) => {
		const handler = (event) => {
			if (event.data.type === 'PHANTOM_MESSAGES_CLEARED' &&
				event.data.conversationId === conversationId) {
				window.removeEventListener('message', handler);
				resolve();
			}
		};

		window.addEventListener('message', handler);
		window.postMessage({
			type: 'CLEAR_PHANTOM_MESSAGES_IDB',
			conversationId
		}, '*');
	});
}

// ==== FETCH INTERCEPTOR ====
const originalFetch = window.fetch;
window.fetch = async (...args) => {
	const [input, config] = args;

	let url;
	if (input instanceof URL) {
		url = input.href;
	} else if (typeof input === 'string') {
		url = input;
	} else if (input instanceof Request) {
		url = input.url;
	}

	if (url && url.includes('skip_uuid_injection=true')) {
		return originalFetch(...args);
	}

	// Check if this is a conversation data request
	if (url &&
		url.includes('/chat_conversations/') &&
		url.includes('rendering_mode=messages') &&
		(!config || config.method === 'GET' || !config.method)) {

		const urlParts = url.split('/');
		const conversationIdIndex = urlParts.findIndex(part => part === 'chat_conversations') + 1;
		const conversationId = urlParts[conversationIdIndex]?.split('?')[0];

		if (conversationId) {
			const response = await originalFetch(...args);
			const conversationData = await response.json();

			const phantomMessages = await getPhantomMessages(conversationId);

			if (phantomMessages && phantomMessages.length > 0) {
				injectPhantomMessages(conversationData, phantomMessages);
			}

			injectUUIDMarkers(conversationData);

			return new Response(JSON.stringify(conversationData), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}
	}

	// Check if this is a completion request
	if (url && url.includes('/completion') && config && config.method === 'POST') {
		const urlParts = url.split('/');
		const conversationIdIndex = urlParts.findIndex(part => part === 'chat_conversations') + 1;
		const conversationId = urlParts[conversationIdIndex]?.split('?')[0];

		if (conversationId) {
			const phantomMessages = await getPhantomMessages(conversationId);

			if (phantomMessages && phantomMessages.length > 0) {
				const lastPhantomUuid = phantomMessages[phantomMessages.length - 1].uuid;

				let body;
				try {
					body = JSON.parse(config.body);
				} catch (e) {
					return originalFetch(...args);
				}

				if (body.parent_message_uuid === lastPhantomUuid) {
					console.log('Fixing parent_message_uuid from phantom to root for completion request');
					body.parent_message_uuid = "00000000-0000-4000-8000-000000000000";

					const newConfig = {
						...config,
						body: JSON.stringify(body)
					};

					return originalFetch(input, newConfig);
				}
			}
		}
	}

	return originalFetch(...args);
};

function reorderKeys(obj, referenceObj) {
	const orderedObj = {};
	// First, add keys in the order they appear in referenceObj
	// If key is missing from obj, use the value from referenceObj
	for (const key of Object.keys(referenceObj)) {
		orderedObj[key] = key in obj ? obj[key] : referenceObj[key];
	}
	// Then add any remaining keys from obj that weren't in referenceObj
	for (const key of Object.keys(obj)) {
		if (!(key in orderedObj)) {
			orderedObj[key] = obj[key];
		}
	}
	return orderedObj;
}

function injectPhantomMessages(data, phantomMessages) {
	const timestamp = new Date().toISOString();
	const referenceMsg = data.chat_messages[0];

	// Add phantom marker to each message's content
	for (const msg of phantomMessages) {
		if (!msg.created_at) msg.created_at = timestamp;
		if (!msg.updated_at) msg.updated_at = timestamp;

		for (const item of msg.content) {
			if (!item.start_timestamp) item.start_timestamp = timestamp;
			if (!item.stop_timestamp) item.stop_timestamp = timestamp;
			if (!item.citations) item.citations = [];
			if (item.text !== undefined) {
				item.text = item.text + '\n\n' + PHANTOM_MARKER;
			}
		}
	}

	// If last phantom is human, add an ack message
	let lastPhantom = phantomMessages[phantomMessages.length - 1];
	if (lastPhantom && lastPhantom.sender === 'human') {
		const orgId = getOrgId();
		const conversation = new ClaudeConversation(orgId, null);
		const ackMessage = new ClaudeMessage(conversation);
		ackMessage.uuid = crypto.randomUUID();
		ackMessage.parent_message_uuid = lastPhantom.uuid;
		ackMessage.sender = 'assistant';
		ackMessage.created_at = timestamp;
		ackMessage.updated_at = timestamp;
		ackMessage.content = [{
			start_timestamp: timestamp,
			stop_timestamp: timestamp,
			type: "text",
			text: "Acknowledged - end of previous conversation.\n\n" + PHANTOM_MARKER,
			citations: []
		}];
		phantomMessages.push(ackMessage);
		lastPhantom = ackMessage;
	}

	console.log(`Injecting ${phantomMessages.length} phantom messages into conversation`);

	// Convert to JSON for injection
	let phantomJson = phantomMessages.map(msg => msg.toHistoryJSON());

	// Reorder keys to match reference message format
	if (referenceMsg) {
		phantomJson = phantomJson.map(msg => reorderKeys(msg, referenceMsg));
	}

	// Update root messages to point to last phantom
	const rootMessages = data.chat_messages.filter(
		msg => msg.parent_message_uuid === "00000000-0000-4000-8000-000000000000"
	);

	if (rootMessages.length > 0 && lastPhantom) {
		rootMessages.forEach(msg => {
			msg.parent_message_uuid = lastPhantom.uuid;
		});
	}

	data.chat_messages = [...phantomJson, ...data.chat_messages];
	// Set correct index values
	data.chat_messages.forEach((msg, idx) => {
		msg.index = idx;
	});

	console.log('Updated chat messages with phantom messages:', data.chat_messages);
}

function injectUUIDMarkers(data) {
	const assistantMessages = data.chat_messages.filter(msg => msg.sender !== 'human');

	assistantMessages.forEach(msg => {

		// Find the LAST text item instead of first
		let lastTextIndex = -1;
		for (let i = msg.content.length - 1; i >= 0; i--) {
			if (msg.content[i].text !== undefined) {
				lastTextIndex = i;
				break;
			}
		}

		if (lastTextIndex !== -1) {
			const item = msg.content[lastTextIndex];
			const uuidMarker = UUID_MARKER_PREFIX + msg.uuid + UUID_MARKER_SUFFIX;
			item.text = item.text + '\n\n' + uuidMarker;
		}
	});
}


// Listen for messages from ISOLATED world
window.addEventListener('message', (event) => {
	if (event.source !== window) return;

	if (event.data.type === 'STORE_PHANTOM_MESSAGES') {
		const { conversationId, phantomMessages } = event.data;
		storePhantomMessages(conversationId, phantomMessages);
	}
});

// Style phantom messages in the DOM
function stylePhantomMessages() {
	const { allMessages, userMessages } = getUIMessages();
	const userMessageSet = new Set(userMessages);

	allMessages.forEach(container => {
		const textContent = container.textContent || '';
		const hasMarker = textContent.includes(PHANTOM_MARKER);
		const isMarkedPhantom = container.hasAttribute('data-phantom-styled');

		if (hasMarker) {
			container.setAttribute('data-phantom-styled', 'true');
			removePhantomMarkerFromElement(container);
		}

		if (hasMarker || isMarkedPhantom) {
			if (container.parentElement && container.parentElement.parentElement) {
				container.parentElement.parentElement.style.filter = 'brightness(0.70)';
			}

			const controls = findMessageControls(container);
			if (controls) {
				controls.style.display = 'none';
			}
		}
	});
}

function removePhantomMarkerFromElement(element) {
	const paragraphs = element.querySelectorAll('p');

	paragraphs.forEach(p => {
		if (p.textContent.includes(PHANTOM_MARKER)) {
			p.textContent = p.textContent.replace(PHANTOM_MARKER, '');

			if (p.textContent.trim() === '') {
				p.style.display = 'none';
			}
		}
	});
}

// Add new function to extract and store UUIDs
function extractAndStoreUUIDs() {
	const { allMessages } = getUIMessages();
	allMessages.forEach(container => {
		const textContent = container.textContent || '';

		// Look for UUID marker using lastIndexOf
		const markerStart = textContent.lastIndexOf(UUID_MARKER_PREFIX);
		if (markerStart !== -1) {
			const uuidStart = markerStart + UUID_MARKER_PREFIX.length;
			const uuidEnd = textContent.indexOf(UUID_MARKER_SUFFIX, uuidStart);

			if (uuidEnd !== -1) {
				const uuid = textContent.substring(uuidStart, uuidEnd);

				// Put UUID on parent container instead of the message element itself
				const parentContainer = container?.parentElement?.parentElement;
				if (parentContainer) {
					parentContainer.setAttribute('data-message-uuid', uuid);
				}

				// Remove the marker from DOM
				removeUUIDMarkerFromElement(container);
			}
		}
	});
}

function removeUUIDMarkerFromElement(element) {
	const paragraphs = element.querySelectorAll('p');

	paragraphs.forEach((p, index) => {
		const text = p.textContent;
		if (text.includes(UUID_MARKER_PREFIX)) {
			// Use lastIndexOf to get the LAST occurrence (the actual injected marker)
			const markerStart = text.lastIndexOf(UUID_MARKER_PREFIX);
			// Search for suffix AFTER the prefix
			const searchFrom = markerStart + UUID_MARKER_PREFIX.length;
			const markerEnd = text.indexOf(UUID_MARKER_SUFFIX, searchFrom);

			if (markerEnd !== -1) {
				const beforeMarker = text.substring(0, markerStart);
				const afterMarker = text.substring(markerEnd + UUID_MARKER_SUFFIX.length);
				const newText = beforeMarker + afterMarker;
				p.textContent = newText;
				if (p.textContent.trim() === '') {
					p.style.display = 'none';
				}
			}
		}
	});
}


// ==== CLIPBOARD CLEANUP - Strip markers before copying ====
const originalClipboardWrite = navigator.clipboard.write;
navigator.clipboard.write = async (data) => {
	try {
		const item = data[0];
		if (!item) return originalClipboardWrite.call(navigator.clipboard, data);

		const types = {};

		for (const type of item.types) {
			const blob = await item.getType(type);

			if (type === 'text/plain' || type === 'text/html') {
				let text = await blob.text();

				// Strip phantom markers
				text = text.replace(/====PHANTOM_MESSAGE====/g, '');

				// Strip UUID markers
				text = text.replace(/====UUID:[a-f0-9-]+====/gi, '');

				// Clean up extra newlines/whitespace from removal
				if (type === 'text/plain') {
					text = text.replace(/\n{3,}/g, '\n\n').trim();
				} else {
					// For HTML, clean up empty paragraphs that might result
					text = text.replace(/<p[^>]*>\s*<\/p>/gi, '');
				}

				types[type] = new Blob([text], { type });
			} else {
				// Preserve other types as-is
				types[type] = blob;
			}
		}

		return originalClipboardWrite.call(navigator.clipboard, [new ClipboardItem(types)]);
	} catch (error) {
		console.error('[Phantom Messages] Error cleaning clipboard text:', error);
		return originalClipboardWrite.call(navigator.clipboard, data);
	}
};

setInterval(() => {
	stylePhantomMessages();
	extractAndStoreUUIDs();
}, 300);