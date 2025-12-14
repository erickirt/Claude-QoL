// claude-search-global.js
(function () {
	'use strict';

	const { searchDB } = window.ClaudeSearchShared;

	// ======== STATE ========
	let isFirstSyncOnRecents = true;
	let syncCancelled = false;
	// Poll for navigation away from /recents
	setInterval(() => {
		if (!window.location.pathname.includes('/recents')) {
			isFirstSyncOnRecents = true; // Reset when not on /recents
			sessionStorage.setItem('text_search_enabled', 'false'); // Disable text search when leaving
		}
	}, 500);

	// ======== SYNC LOGIC ========
	async function getConversationsToUpdate() {
		const orgId = getOrgId();

		const response = await fetch(`/api/organizations/${orgId}/chat_conversations`);
		if (!response.ok) {
			throw new Error('Failed to fetch conversations');
		}

		const allConversations = await response.json();
		console.log(`Found ${allConversations.length} total conversations`);

		const storedMetadata = await searchDB.getAllMetadata();
		const storedMap = new Map(storedMetadata.map(m => [m.uuid, m]));

		const toUpdate = [];
		for (const conv of allConversations) {
			const stored = storedMap.get(conv.uuid);

			if (!stored) {
				toUpdate.push(conv);
			} else {
				// Check if messages exist
				const messages = await searchDB.getMessages(conv.uuid);

				if (!messages) {
					// Metadata exists but no messages - needs update
					toUpdate.push(conv);
				} else if (new Date(conv.updated_at) > new Date(stored.updated_at)) {
					// Timestamp changed - needs update
					toUpdate.push(conv);
				}
			}
		}

		console.log(`Need to update ${toUpdate.length} conversations`);
		return toUpdate;
	}

	async function syncConversationsIndividually(progressCallback, toUpdate) {
		const orgId = getOrgId();

		if (toUpdate.length === 0) {
			progressCallback('All conversations up to date!');
			return;
		}

		// Split into 2 chunks for parallel processing
		const chunk1 = toUpdate.filter((_, i) => i % 2 === 0);
		const chunk2 = toUpdate.filter((_, i) => i % 2 === 1);

		let completed = 0;
		const delayMs = Math.min(1000, 100 + toUpdate.length); // Dynamic delay based on count
		console.log(`Using ${delayMs}ms delay for ${toUpdate.length} conversations`);

		async function processChunk(chunk) {
			for (let i = 0; i < chunk.length; i++) {
				if (syncCancelled) return; // Early exit on cancel

				const conv = chunk[i];

				try {
					const conversation = new ClaudeConversation(orgId, conv.uuid);
					const messages = await conversation.getMessages(true);
					await searchDB.setMessages(conv.uuid, messages);

					completed++;
					progressCallback(`Updating ${completed} of ${toUpdate.length} conversations...`);

					console.log(`Updated conversation: ${conv.name} (${messages.length} messages)`);
				} catch (error) {
					console.error(`Failed to update conversation ${conv.uuid}:`, error);
					completed++;
				}

				// Rate limit between requests
				if (i < chunk.length - 1) {
					await new Promise(resolve => setTimeout(resolve, delayMs));
				}
			}
		}

		await Promise.all([
			processChunk(chunk1),
			processChunk(chunk2)
		]);

		progressCallback('Sync complete!');
	}

	async function triggerSync() {
		syncCancelled = false; // Reset cancellation state
		const loadingModal = createLoadingModal('Initializing sync...');
		if (isFirstSyncOnRecents) {
			loadingModal.show(); // Show only on first sync when on /recents
			isFirstSyncOnRecents = false;
		}
		const toUpdate = await getConversationsToUpdate();

		for (const conv of toUpdate) {
			await searchDB.setMetadata(conv);
		}

		try {
			// Check conversation count
			loadingModal.setContent(createLoadingContent('Checking what needs syncing...'));

			if (toUpdate.length >= 300) {
				// Use GDPR export for efficiency
				loadingModal.setContent(createLoadingContent(`Preparing to sync ${toUpdate.length} conversations...`));
				await new Promise(resolve => setTimeout(resolve, 2000)); // Let them read it

				while (true) {
					try {
						await syncConversationsViaExport(loadingModal);
						break; // Success, exit loop
					} catch (error) {
						// Handle direct retry from check-in modal (skip showing failure modal)
						if (error.message === 'GDPR_RETRY') {
							loadingModal.setContent(createLoadingContent('Retrying export...'));
							continue;
						}

						console.error('GDPR export failed:', error);
						loadingModal.destroy();

						// Ask user what they want to do with three options
						let errorMessage = error.message;
						if (errorMessage == "USER_CANCEL") errorMessage = undefined
						const choice = await showClaudeThreeOption(
							'Export Failed',
							`The bulk data export failed${errorMessage ? `: ${errorMessage}` : '. '}\n\nWhat would you like to do?`,
							{
								left: { text: 'Cancel' },
								middle: { text: 'Slow Sync' },
								right: { text: 'Retry' }
							}
						);

						if (choice === 'right') { // Retry
							// Show loading modal again and retry
							loadingModal.show();
							loadingModal.setContent(createLoadingContent('Retrying export...'));
							continue;
						} else if (choice === 'middle') { // Use Standard
							const newLoadingModal = createLoadingModal('Starting standard sync...');
							// Add cancel button for fallback sync
							newLoadingModal.addCancel('Cancel', () => {
								syncCancelled = true;
								sessionStorage.setItem('text_search_enabled', 'false');
								newLoadingModal.destroy();
								window.location.reload();
							});
							newLoadingModal.show();

							await syncConversationsIndividually((status) => {
								newLoadingModal.setContent(createLoadingContent(status));
							}, toUpdate);

							newLoadingModal.destroy();
							break; // Done with standard sync
						} else {
							// User cancelled. Reload page and set text search off
							sessionStorage.setItem('text_search_enabled', 'false');
							window.location.reload();
							return;
						}
					}
				}
			} else {
				// Use incremental sync for small amounts of conversations
				// Add cancel button for individual sync
				loadingModal.addCancel('Cancel', () => {
					syncCancelled = true;
					sessionStorage.setItem('text_search_enabled', 'false');
					loadingModal.destroy();
					window.location.reload();
				});

				await syncConversationsIndividually((status) => {
					loadingModal.setContent(createLoadingContent(status));
				}, toUpdate);
			}

		} catch (error) {
			console.error('Sync failed:', error);
			showClaudeAlert('Sync Failed', `An error occurred during sync: ${error.message}`);
			throw error;
		} finally {
			loadingModal.destroy();
		}
	}

	// ======== GDPR EXPORT ========
	let gdprLoadingModal = null;
	let gdprTotalConversations = 0;
	let gdprProcessedConversations = 0;
	let gdprBatchQueue = [];
	let gdprProcessing = false;

	chrome.runtime.onMessage.addListener(async (message) => {
		if (message.type === 'GDPR_BATCH') {
			// Add to queue
			gdprBatchQueue.push(message);
			gdprTotalConversations = message.total;

			// Start processing if not already
			if (!gdprProcessing) {
				processBatchQueue();
			}
		}
	});

	async function processBatchQueue() {
		gdprProcessing = true;

		while (gdprBatchQueue.length > 0) {
			const message = gdprBatchQueue.shift();

			for (const conv of message.batch) {
				try {
					const metadata = await searchDB.getMetadata(conv.uuid);
					if (metadata) {
						await searchDB.setMessages(conv.uuid, conv.chat_messages);
					}

					gdprProcessedConversations++;
				} catch (error) {
					console.error(`[GDPR Export] Failed to load conversation ${conv.uuid}:`, error);
					gdprProcessedConversations++;
				}
			}

			console.log(`[GDPR Export] Processed batch of ${message.batch.length}, total processed: ${gdprProcessedConversations}/${gdprTotalConversations}`);

			if (gdprLoadingModal) {
				gdprLoadingModal.setContent(createLoadingContent(
					`Loading ${gdprProcessedConversations} of ${gdprTotalConversations} conversations...`
				));
			}

			if (gdprProcessedConversations >= gdprTotalConversations) {
				console.log('[GDPR Export] All conversations processed');
				if (gdprLoadingModal) {
					gdprLoadingModal.destroy();
					gdprLoadingModal = null;
				}
				gdprProcessedConversations = 0;
				gdprTotalConversations = 0;
			}
		}

		gdprProcessing = false;
	}

	async function syncConversationsViaExport(loadingModal) {
		const orgId = getOrgId();

		console.log('[GDPR Export] Starting export sync for conversations');

		// Phase 1: Request export
		loadingModal.setContent(createLoadingContent(
			'Requesting data export...'
		));

		console.log('[GDPR Export] Requesting export from API...');
		const exportResponse = await fetch(`/api/organizations/${orgId}/export_data`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' }
		});

		if (!exportResponse.ok) {
			const errorText = await exportResponse.text();
			console.error('[GDPR Export] Export request failed:', exportResponse.status, errorText);
			throw new Error(`Export request failed: ${exportResponse.status}`);
		}

		const exportData = await exportResponse.json();
		const nonce = exportData.nonce;
		console.log('[GDPR Export] Export requested, nonce:', nonce);

		// Phase 2: Poll for completion
		const POLL_INTERVAL_MS = 30000; // 30 seconds
		const CHECK_IN_INTERVAL_MS = 180000; // 3 minutes

		let storageUrl = null;
		let lastCheckInTime = Date.now();

		while (true) {
			const msUntilCheckIn = CHECK_IN_INTERVAL_MS - (Date.now() - lastCheckInTime);
			const mins = Math.floor(msUntilCheckIn / 60000);
			const secs = Math.floor((msUntilCheckIn % 60000) / 1000);
			loadingModal.setContent(createLoadingContent(
				`Waiting for export to complete...\nChecking in in ${mins}m ${secs}s...`
			));

			const downloadPageUrl = `https://claude.ai/export/${orgId}/download/${nonce}`;

			try {
				const pollResponse = await fetch(downloadPageUrl);

				if (pollResponse.status === 200) {
					const html = await pollResponse.text();

					// Extract storage URL from the HTML
					const urlMatch = html.match(/https:\/\/storage\.googleapis\.com\/user-data-export-production\/[^"]+/);

					if (urlMatch) {
						storageUrl = urlMatch[0].replace(/\\u0026/g, '&');
						console.log('[GDPR Export] Found storage URL');
						break;
					}
				}
			} catch (error) {
				console.warn(`[GDPR Export] Poll failed:`, error.message);
			}

			// Wait before next attempt
			await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

			// Check if it's time for a check-in
			if (Date.now() - lastCheckInTime >= CHECK_IN_INTERVAL_MS) {
				lastCheckInTime = Date.now();
				const choice = await showClaudeThreeOption(
					'Export In Progress',
					'The data export is taking a while. Would you like to keep waiting?\n\nIf you received an email from Anthropic stating the export failed, retry or cancel.',
					{
						left: { text: 'Cancel' },
						middle: { text: 'Retry', variant: 'primary' },
						right: { text: 'Keep Waiting', variant: 'primary' }
					}
				);
				if (choice === 'left') throw new Error('USER_CANCEL');
				if (choice === 'middle') throw new Error('GDPR_RETRY');
			}
		}

		// Phase 3: Request download from background
		console.log('[GDPR Export] Requesting download from background script...');
		loadingModal.setContent(createLoadingContent('Downloading and processing export...'));

		gdprLoadingModal = createLoadingModal('Importing...');
		const downloadResult = await new Promise((resolve) => {
			chrome.runtime.sendMessage({
				type: 'DOWNLOAD_GDPR_EXPORT',
				url: storageUrl
			}, resolve);
		});

		if (!downloadResult.success) {
			gdprLoadingModal = null;
			gdprLoadingModal.destroy();
			throw new Error(`Download failed: ${downloadResult.error}`);
		}

		console.log('[GDPR Export] Processing', downloadResult.totalCount, 'conversations...');
		gdprLoadingModal.show();
	}

	function transformGDPRToMetadata(gdprConv) {
		return {
			uuid: gdprConv.uuid,
			name: gdprConv.name,
			created_at: gdprConv.created_at,
			updated_at: gdprConv.updated_at,
			summary: gdprConv.summary || "",
			model: null,
			settings: {},
			is_starred: false,
			is_temporary: false,
			project_uuid: null,
			current_leaf_message_uuid: null,
			user_uuid: null,
			project: null
		};
	}

	// ======== SEARCH INTERCEPT HANDLER ========
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		if (event.data.type !== 'SEARCH_INTERCEPT') return;

		const { messageId, query, url } = event.data;
		//console.log('[Search Handler] Received intercept request:', query);

		// If text search is not enabled, don't intercept

		if (sessionStorage.getItem('text_search_enabled') != 'true') {
			//console.log('[Search Handler] Text search disabled, not intercepting');
			window.postMessage({
				type: 'SEARCH_RESPONSE',
				messageId,
				intercept: false
			}, '*');
			return;
		}

		try {
			// Search all conversations
			const results = await searchAllConversations(query);

			//console.log('[Search Handler] Found', results.length, 'matching conversations');

			window.postMessage({
				type: 'SEARCH_RESPONSE',
				messageId,
				intercept: true,
				results: results
			}, '*');

		} catch (error) {
			console.error('[Search Handler] Search failed:', error);
			window.postMessage({
				type: 'SEARCH_RESPONSE',
				messageId,
				intercept: false
			}, '*');
		}
	});

	// ======== SEARCH FUNCTION (NEW) ========
	async function searchAllConversations(query) {
		if (!query || query.trim() === '') {
			return [];
		}

		const totalStart = performance.now();
		console.log('========================================');
		console.log('[Search] Query:', query);

		const lowerQuery = query.toLowerCase();

		// Load everything
		const loadStart = performance.now();
		const [allMetadata, allMessages] = await Promise.all([
			searchDB.getAllMetadata(),
			searchDB.getAllMessages()
		]);
		const loadTime = performance.now() - loadStart;
		console.log(`[Search] Loaded ${allMessages.length} conversations in ${loadTime.toFixed(0)}ms`);

		// Search through plain text
		const searchStart = performance.now();
		const matches = [];

		for (const entry of allMessages) {
			const lowerText = entry.searchableText.toLowerCase();
			const matchCount = (lowerText.match(new RegExp(lowerQuery, 'gi')) || []).length;

			if (matchCount > 0) {
				matches.push({ uuid: entry.uuid, matchCount });
			}
		}
		const searchTime = performance.now() - searchStart;

		// Look up metadata
		const results = matches.map(match => {
			const metadata = allMetadata.find(m => m.uuid === match.uuid);
			return {
				...metadata,
				name: `${metadata.name} (${match.matchCount} match${match.matchCount > 1 ? 'es' : ''})`,
				matchCount: match.matchCount
			};
		});

		// Sort
		results.sort((a, b) =>
			new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
		);

		const totalTime = performance.now() - totalStart;

		console.log(`[Search] Results:`);
		console.log(`  - Load: ${loadTime.toFixed(0)}ms`);
		console.log(`  - Search: ${searchTime.toFixed(0)}ms`);
		console.log(`  - TOTAL: ${totalTime.toFixed(0)}ms`);
		console.log(`  - Found: ${results.length} matches`);
		console.log('========================================');

		return results;
	}

	// ======== GLOBAL SEARCH TOGGLE ========
	function addGlobalSearchToggle() {
		// Only on recents page
		if (!window.location.pathname.includes('/recents')) {
			return;
		}

		// Check if toggle already exists anywhere on page
		if (document.querySelector('.global-search-toggle')) {
			return;
		}

		// Find the container with "X chats with Claude"
		const containers = document.querySelectorAll('.flex.items-center.z-header.h-12');
		let targetContainer = null;

		for (const container of containers) {
			if (container.textContent.includes('chats with Claude')) {
				targetContainer = container;
				break;
			}
		}

		if (!targetContainer) return;

		// Create toggle container - use ml-auto to push to right without affecting other elements
		const toggleContainer = document.createElement('div');
		toggleContainer.className = 'flex items-center gap-2 global-search-toggle ml-auto shrink-0';

		// Labels
		const titleLabel = document.createElement('span');
		titleLabel.className = 'text-text-500 text-sm select-none';
		titleLabel.textContent = 'Title Search';

		const textLabel = document.createElement('span');
		textLabel.className = 'text-text-500 text-sm select-none';
		textLabel.textContent = 'Text Search';

		// Create toggle (always defaults to false = title search)
		const isTextSearch = sessionStorage.getItem('text_search_enabled') === 'true';
		const toggle = createClaudeToggle('', isTextSearch);

		if (isTextSearch) {
			triggerSync();
		}

		// Update state on change
		toggle.input.addEventListener('change', (e) => {
			const mode = e.target.checked ? 'text' : 'title';
			console.log('Search mode changed to:', mode);

			if (mode === 'text') {
				sessionStorage.setItem('text_search_enabled', 'true');
			} else {
				sessionStorage.removeItem('text_search_enabled');
			}
			window.location.reload();
		});

		// Assemble
		toggleContainer.appendChild(titleLabel);
		toggleContainer.appendChild(toggle.container);
		toggleContainer.appendChild(textLabel);

		// Add to page - DON'T modify parent's classes
		targetContainer.appendChild(toggleContainer);
	}

	// ======== INITIALIZATION ========
	function initialize() {
		// Add global search toggle on recents page
		setInterval(() => {
			addGlobalSearchToggle();
		}, 1000);
	}

	// Wait for DOM to be ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();