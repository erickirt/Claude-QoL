// image-extractor.js — Auto-expands tool result blocks that contain generated images.
// ISOLATED world: uses ButtonBar for toggle + chrome.storage for persistence.
// No DOM node injection — works with React by clicking existing expand buttons + CSS overrides.
// Two-mode approach: discovery (expand all, find images, mark, collapse all) then steady-state (keep marked expanded).
'use strict';

(function () {
	const LOG_PREFIX = '[ImageExtractor]';
	const _AUTO_EXPAND = SETTINGS_KEYS.IMAGE_EXTRACTOR.AUTO_EXPAND;
	const ATTR_HAS_IMAGE = 'data-toolbox-has-image';

	// --- Styles ---

	function injectStyles() {
		const style = document.createElement('style');
		style.textContent = `
			[data-message-uuid] div.overflow-y-auto:has(img[alt="Tool result"]) {
				max-height: none !important;
				overflow: visible !important;
			}
			[data-message-uuid] img[alt="Tool result"] {
				max-width: 600px !important;
				max-height: none !important;
				width: 100% !important;
				border-radius: 8px;
			}
		`;
		document.head.appendChild(style);
	}

	// --- State ---

	const imageMessageUUIDs = new Set();
	let currentConversationId = null;
	let knownDomUUIDs = new Set();
	let pendingTimer = null;
	let fetchInProgress = false;
	let autoExpandEnabled = false;

	// --- Data Layer ---

	function extractImagesFromData(data) {
		imageMessageUUIDs.clear();
		const messages = data?.chat_messages;
		if (!messages) {
			console.log(LOG_PREFIX, 'No chat_messages in data');
			return;
		}

		for (const msg of messages) {
			if (msg.sender !== 'assistant') continue;
			if (msg.files?.some(f => f.file_kind === 'image')) {
				imageMessageUUIDs.add(msg.uuid);
			}
		}
		console.log(LOG_PREFIX, `extractImagesFromData: ${imageMessageUUIDs.size} messages with images`);
	}

	async function loadConversationImages() {
		const convId = getConversationId();
		if (!convId) {
			if (imageMessageUUIDs.size > 0) {
				imageMessageUUIDs.clear();
				currentConversationId = null;
				knownDomUUIDs.clear();
			}
			return;
		}

		if (fetchInProgress) return;

		const conversationChanged = convId !== currentConversationId;
		if (conversationChanged) {
			console.log(LOG_PREFIX, `Conversation changed: ${currentConversationId} -> ${convId}`);
			imageMessageUUIDs.clear();
			knownDomUUIDs.clear();
			currentConversationId = convId;
		}

		const orgId = getOrgId();
		if (!orgId) return;

		fetchInProgress = true;
		try {
			console.log(LOG_PREFIX, `Loading conversation data for ${convId}...`);
			const conversation = new ClaudeConversation(orgId, convId);
			const data = await conversation.getData();
			extractImagesFromData(data);
		} catch (e) {
			console.error(LOG_PREFIX, 'Failed to load conversation data:', e);
		} finally {
			fetchInProgress = false;
		}
	}

	// --- Helpers ---

	/** Walk up from a group/row button to find the top-level expand button in the py-1.5 container */
	function findExpandButton(groupRowBtn) {
		let container = groupRowBtn.parentElement;
		while (container && !container.classList.contains('py-1.5')) {
			container = container.parentElement;
		}
		return container?.querySelector('button[aria-expanded]') || null;
	}

	/** Click the Result sibling of a group/row button if it hasn't been opened yet */
	function clickResultForGroupRow(toolNameBtn) {
		const toolNameRow = toolNameBtn.parentElement?.parentElement;
		const resultRow = toolNameRow?.nextElementSibling;
		if (!resultRow) return;
		const resultBtn = resultRow.querySelector('button');
		if (resultBtn) {
			resultBtn.click();
		}
	}

	// --- Two modes ---

	function processMessage(messageEl) {
		// Check for marks on expand buttons (not group/row — those get destroyed on collapse)
		const markedExpandButtons = messageEl.querySelectorAll(`button[aria-expanded][${ATTR_HAS_IMAGE}="true"]`);

		if (markedExpandButtons.length > 0) {
			console.log(LOG_PREFIX, `processMessage: ${markedExpandButtons.length} marked expand buttons found → steady-state`);
			steadyState(markedExpandButtons);
		} else {
			console.log(LOG_PREFIX, 'processMessage: no marks found → discovery');
			discovery(messageEl);
		}
	}

	// --- Steady-state: keep marked blocks expanded, ensure Results are open ---

	function steadyState(markedExpandButtons) {
		for (const expandBtn of markedExpandButtons) {
			if (expandBtn.getAttribute('aria-expanded') === 'false') {
				console.log(LOG_PREFIX, 'steadyState: expanding marked block');
				expandBtn.click();
				// After content renders, click Result buttons inside
				setTimeout(() => openResultsInBlock(expandBtn), 350);
			} else {
				// Already expanded — ensure Results are open
				openResultsInBlock(expandBtn);
			}
		}
	}

	/** Click all Result buttons inside an expanded block (the ones that are still collapsed) */
	function openResultsInBlock(expandBtn) {
		// The expand button is inside a py-1.5 container. The collapsible content is a sibling grid.
		let container = expandBtn;
		while (container && !container.classList.contains('py-1.5')) {
			container = container.parentElement;
		}
		if (!container) return;

		const groupRowButtons = container.querySelectorAll('button[class*="group/row"]');
		for (const toolNameBtn of groupRowButtons) {
			clickResultForGroupRow(toolNameBtn);
		}
	}

	// --- Discovery: expand all, find images, mark expand buttons, collapse all ---

	function discovery(messageEl) {
		const collapsedButtons = messageEl.querySelectorAll('button[aria-expanded="false"]');
		if (collapsedButtons.length > 0) {
			console.log(LOG_PREFIX, `discovery: expanding ${collapsedButtons.length} collapsed blocks`);
			for (const btn of collapsedButtons) {
				btn.click();
			}
			setTimeout(() => discoveryClickResults(messageEl), 350);
			return;
		}

		discoveryClickResults(messageEl);
	}

	function discoveryClickResults(messageEl) {
		const toolNameButtons = messageEl.querySelectorAll('button[class*="group/row"]');
		console.log(LOG_PREFIX, `discoveryClickResults: found ${toolNameButtons.length} group/row buttons`);

		let clickedAny = false;
		for (const toolNameBtn of toolNameButtons) {
			const toolNameRow = toolNameBtn.parentElement?.parentElement;
			const resultRow = toolNameRow?.nextElementSibling;
			if (!resultRow) continue;

			const resultBtn = resultRow.querySelector('button');
			if (resultBtn) {
				console.log(LOG_PREFIX, `discoveryClickResults: clicking Result for "${toolNameBtn.querySelector('.truncate')?.textContent?.trim()}"`);
				resultBtn.click();
				clickedAny = true;
			}
		}

		if (clickedAny) {
			setTimeout(() => discoveryMarkAndCollapse(messageEl), 350);
		} else {
			discoveryMarkAndCollapse(messageEl);
		}
	}

	function discoveryMarkAndCollapse(messageEl) {
		const toolNameButtons = messageEl.querySelectorAll('button[class*="group/row"]');
		let foundAny = false;

		for (const toolNameBtn of toolNameButtons) {
			const toolNameRow = toolNameBtn.parentElement?.parentElement;
			const resultRow = toolNameRow?.nextElementSibling;
			if (!resultRow) continue;

			if (resultRow.querySelector('img[alt="Tool result"]')) {
				const toolName = toolNameBtn.querySelector('.truncate')?.textContent?.trim() || '(unknown)';
				console.log(LOG_PREFIX, `discoveryMarkAndCollapse: found image for "${toolName}"`);

				// Mark the TOP-LEVEL EXPAND BUTTON (persists through collapse, unlike group/row)
				const expandBtn = findExpandButton(toolNameBtn);
				if (expandBtn) {
					console.log(LOG_PREFIX, `discoveryMarkAndCollapse: marking expand button`);
					expandBtn.setAttribute(ATTR_HAS_IMAGE, 'true');
					foundAny = true;
				}
			}
		}

		// Collapse ALL — steady-state will reopen just the marked ones on next tick
		if (foundAny) {
			console.log(LOG_PREFIX, 'discoveryMarkAndCollapse: collapsing all blocks');
			const expandedButtons = messageEl.querySelectorAll('button[aria-expanded="true"]');
			for (const btn of expandedButtons) {
				btn.click();
			}
		} else {
			console.log(LOG_PREFIX, 'discoveryMarkAndCollapse: no images found in any result');
		}
	}

	// --- Main processing loop ---

	async function processAll() {
		if (!window.location.pathname.includes('/chat/')) {
			if (imageMessageUUIDs.size > 0) {
				imageMessageUUIDs.clear();
				currentConversationId = null;
				knownDomUUIDs.clear();
			}
			return;
		}

		if (!autoExpandEnabled) return;

		const domUUIDs = new Set();
		for (const el of document.querySelectorAll('[data-message-uuid]')) {
			domUUIDs.add(el.getAttribute('data-message-uuid'));
		}

		const hasNewUUIDs = [...domUUIDs].some(uuid => !knownDomUUIDs.has(uuid));
		const needsInitialLoad = currentConversationId !== getConversationId();

		if (needsInitialLoad || hasNewUUIDs) {
			console.log(LOG_PREFIX, `processAll: loading data (initialLoad=${needsInitialLoad}, newUUIDs=${hasNewUUIDs})`);
			await loadConversationImages();
		}

		knownDomUUIDs = domUUIDs;
		if (imageMessageUUIDs.size === 0) return;

		for (const messageUuid of imageMessageUUIDs) {
			const messageEls = document.querySelectorAll(`[data-message-uuid="${messageUuid}"]`);
			for (const el of messageEls) {
				processMessage(el);
			}
		}
	}

	function scheduleProcess() {
		if (pendingTimer !== null) return;
		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			processAll();
		}, 200);
	}

	// --- Button ---

	function createImageExpandButton() {
		const button = createClaudeButton(
			`<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true"><path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h12A1.5 1.5 0 0 1 17.5 4v12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16V4ZM4 3.5a.5.5 0 0 0-.5.5v8.793l3.146-3.147a.5.5 0 0 1 .708 0L10.5 12.793l2.146-2.147a.5.5 0 0 1 .708 0L16.5 13.793V4a.5.5 0 0 0-.5-.5H4Zm12.5 11.707-3.5-3.5-2.146 2.147a.5.5 0 0 1-.708 0L7 10.707l-3.5 3.5V16a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5v-.793ZM13 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>`,
			'icon'
		);

		button.classList.add('shrink-0', 'image-expand-button');
		button.onclick = async () => {
			autoExpandEnabled = !autoExpandEnabled;
			await settingsRegistry.set(_AUTO_EXPAND, autoExpandEnabled);
			window.location.reload();
		};

		return button;
	}

	async function updateButtonAppearance() {
		const button = document.querySelector('.image-expand-button');
		if (!button) return;

		autoExpandEnabled = await settingsRegistry.get(_AUTO_EXPAND);

		if (autoExpandEnabled) {
			button.style.color = '#0084ff';
			button.tooltip?.updateText('Auto-expand images: ON');
		} else {
			button.style.color = '';
			button.tooltip?.updateText('Auto-expand images: OFF');
		}
	}

	// --- Init ---

	function init() {
		console.log(LOG_PREFIX, 'Initializing');
		injectStyles();

		ButtonBar.register({
			buttonClass: 'image-expand-button',
			createFn: createImageExpandButton,
			tooltip: 'Auto-expand images: OFF',
			pages: ['chat'],
			onInjected: () => updateButtonAppearance(),
		});

		new MutationObserver(() => {
			scheduleProcess();
		}).observe(document.body, { childList: true, subtree: true });

		settingsRegistry.get(_AUTO_EXPAND).then(val => {
			autoExpandEnabled = val;
			console.log(LOG_PREFIX, `Initial autoExpandEnabled: ${autoExpandEnabled}`);
			updateButtonAppearance();
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
