// image-extractor.js — Displays generated images inline instead of hidden in tool result blocks
'use strict';

(function () {
	const LOG_PREFIX = '[ImageExtractor]';
	const ATTR_MARKER = 'data-extracted-image';
	const ATTR_MSG = 'data-extracted-for-message';

	// --- Styles ---

	function injectStyles() {
		const style = document.createElement('style');
		style.textContent = `
			.extracted-image-container {
				max-width: 600px;
				margin-bottom: 12px;
				padding-left: 8px;
			}
			.extracted-image-container img {
				width: 100%;
				border-radius: 8px;
			}
		`;
		document.head.appendChild(style);
	}

	// --- State ---

	/** @type {Map<string, {fileUuid: string, previewUrl: string}[]>} */
	const imageMap = new Map();
	let currentConversationId = null;
	/** Set of message UUIDs present in DOM at last check */
	let knownDomUUIDs = new Set();
	let pendingTimer = null;
	let fetchInProgress = false;

	// --- Data Layer ---

	function extractImagesFromData(data) {
		imageMap.clear();
		const messages = data?.chat_messages;
		if (!messages) return;

		for (const msg of messages) {
			if (msg.sender !== 'assistant') continue;

			const imageFiles = msg.files?.filter(f => f.file_kind === 'image');
			if (!imageFiles?.length) continue;

			imageMap.set(msg.uuid, imageFiles.map(f => ({
				fileUuid: f.file_uuid,
				previewUrl: f.preview_asset?.url || f.preview_url,
			})));
		}

		if (imageMap.size > 0) {
			//console.log(LOG_PREFIX, `Tracking images for ${imageMap.size} message(s)`);
		}
	}

	async function loadConversationImages() {
		const convId = getConversationId();
		if (!convId) {
			if (imageMap.size > 0) {
				imageMap.clear();
				currentConversationId = null;
				knownDomUUIDs.clear();
			}
			return;
		}

		if (fetchInProgress) return;

		const conversationChanged = convId !== currentConversationId;
		if (conversationChanged) {
			imageMap.clear();
			knownDomUUIDs.clear();
			currentConversationId = convId;
		}

		const orgId = getOrgId();
		if (!orgId) return;

		fetchInProgress = true;
		try {
			const conversation = new ClaudeConversation(orgId, convId);
			const data = await conversation.getData();
			extractImagesFromData(data);
		} catch (e) {
			console.error(LOG_PREFIX, 'Failed to load conversation data:', e);
		} finally {
			fetchInProgress = false;
		}
	}

	// --- DOM Injection ---

	function createImageElement(fileUuid, imgSrc, messageUuid) {
		const container = document.createElement('div');
		container.className = 'extracted-image-container';
		container.setAttribute(ATTR_MARKER, fileUuid);
		container.setAttribute(ATTR_MSG, messageUuid);

		const img = document.createElement('img');
		img.src = imgSrc;
		img.loading = 'lazy';
		container.appendChild(img);

		return container;
	}

	function removeStaleImages(messageEl, messageUuid) {
		for (const el of messageEl.querySelectorAll(`[${ATTR_MSG}]`)) {
			if (el.getAttribute(ATTR_MSG) !== messageUuid) {
				el.remove();
			}
		}
	}

	function injectImagesForMessage(messageEl, messageUuid, images, orgId) {
		removeStaleImages(messageEl, messageUuid);

		const markdownBlocks = messageEl.querySelectorAll('.standard-markdown');
		const targetBlock = markdownBlocks[markdownBlocks.length - 1];
		if (!targetBlock) return;

		if (images.every(({ fileUuid }) => targetBlock.querySelector(`[${ATTR_MARKER}="${fileUuid}"]`))) return;

		for (let i = images.length - 1; i >= 0; i--) {
			const { fileUuid, previewUrl } = images[i];
			if (targetBlock.querySelector(`[${ATTR_MARKER}="${fileUuid}"]`)) continue;

			const imgSrc = previewUrl || `/api/${orgId}/files/${fileUuid}/preview`;
			targetBlock.insertBefore(
				createImageElement(fileUuid, imgSrc, messageUuid),
				targetBlock.firstChild
			);
			//console.log(LOG_PREFIX, `Injected image ${fileUuid} into message ${messageUuid}`);
		}
	}

	// --- Scheduling ---

	async function injectAll() {
		if (!window.location.pathname.includes('/chat/')) {
			if (imageMap.size > 0) {
				imageMap.clear();
				currentConversationId = null;
				knownDomUUIDs.clear();
			}
			return;
		}

		// Check if there are new message UUIDs in the DOM we haven't seen
		const domUUIDs = new Set();
		for (const el of document.querySelectorAll('[data-message-uuid]')) {
			domUUIDs.add(el.getAttribute('data-message-uuid'));
		}

		const hasNewUUIDs = [...domUUIDs].some(uuid => !knownDomUUIDs.has(uuid));
		const needsInitialLoad = currentConversationId !== getConversationId();

		if (needsInitialLoad || hasNewUUIDs) {
			await loadConversationImages();
		}

		knownDomUUIDs = domUUIDs;

		if (imageMap.size === 0) return;

		const orgId = getOrgId();
		if (!orgId) return;

		for (const [messageUuid, images] of imageMap) {
			for (const el of document.querySelectorAll(`[data-message-uuid="${messageUuid}"]`)) {
				injectImagesForMessage(el, messageUuid, images, orgId);
			}
		}
	}

	function scheduleInjection() {
		if (pendingTimer !== null) return;
		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			injectAll();
		}, 200);
	}

	// --- Init ---

	function initDOM() {
		injectStyles();

		new MutationObserver(() => {
			scheduleInjection();
		}).observe(document.body, { childList: true, subtree: true });

		//console.log(LOG_PREFIX, 'Initialized');
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initDOM);
	} else {
		initDOM();
	}
})();
