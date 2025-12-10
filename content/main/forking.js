// forking.js
(function () {
	'use strict';
	const defaultSummaryPrompt =
		`I've attached a chatlog from a previous conversation. Please create a complete, detailed summary of the conversation that covers all important points, questions, and responses. This summary will be used to continue the conversation in a new chat, so make sure it provides enough context to understand the full discussion. Be thorough, and think things through. Make it lengthy.
If this is a technical discussion, include any relevant technical details, code snippets, or explanations that were part of the conversation, maintaining information concerning only the latest version of any code discussed.
If this is a writing or creative discussion, include sections for characters, plot points, setting info, etcetera. Avoid overusing bulletpoints - prose is preferred.`;

	let pendingFork = {
		model: null,
		includeAttachments: true,
		rawTextPercentage: 100,
		summaryPrompt: defaultSummaryPrompt,
		originalSettings: null
	};
	const LAST_CHUNK_SIZE = 15000;     // Reserved for end (guaranteed recency bias)
	const MAIN_TARGET_CHUNK = 30000;   // Target for front chunks
	// Implicit MAX = 1.5x MAIN_TARGET due to rounding in chunking


	//#region UI elements creation
	function createBranchButton() {
		const svgContent = `
		<div class="relative text-text-500 group-hover/btn:text-text-100">
			<div class="flex items-center justify-center transition-all" style="width: 20px; height: 20px;">
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 22 22" class="shrink-0" aria-hidden="true">
					<path d="M7 5C7 3.89543 7.89543 3 9 3C10.1046 3 11 3.89543 11 5C11 5.74028 10.5978 6.38663 10 6.73244V14.0396H11.7915C12.8961 14.0396 13.7915 13.1441 13.7915 12.0396V10.7838C13.1823 10.4411 12.7708 9.78837 12.7708 9.03955C12.7708 7.93498 13.6662 7.03955 14.7708 7.03955C15.8753 7.03955 16.7708 7.93498 16.7708 9.03955C16.7708 9.77123 16.3778 10.4111 15.7915 10.7598V12.0396C15.7915 14.2487 14.0006 16.0396 11.7915 16.0396H10V17.2676C10.5978 17.6134 11 18.2597 11 19C11 20.1046 10.1046 21 9 21C7.89543 21 7 20.1046 7 19C7 18.2597 7.4022 17.6134 8 17.2676V6.73244C7.4022 6.38663 7 5.74028 7 5Z"/>
				</svg>
			</div>
		</div>
	`;

		const button = createClaudeButton(svgContent, 'icon-message');
		button.type = 'button';
		button.setAttribute('data-state', 'closed');
		button.setAttribute('aria-label', 'Fork from here');

		createClaudeTooltip(button, 'Fork from here');

		button.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();

			const messageContainer = e.target.closest('[data-message-uuid]');
			const messageUuid = messageContainer?.dataset.messageUuid;

			if (!messageUuid) {
				showClaudeAlert('Error', 'Could not find message UUID - try reloading the page.');
				return;
			}

			const modal = await createConfigModal(messageUuid);
			modal.show();
		};

		return button;
	}

	async function createConfigModal(messageUuid) {
		const content = document.createElement('div');

		// Model select
		const selectOptions = CLAUDE_MODELS;
		const modelSelect = createClaudeSelect(selectOptions, selectOptions[0].value);
		modelSelect.classList.add('mb-4');
		content.appendChild(modelSelect);

		// Raw text slider section
		const rawTextContainer = document.createElement('div');
		rawTextContainer.className = 'mb-4 space-y-2 border border-border-300 rounded p-3';

		const rawTextSlider = createClaudeSlider('Preserve X% of recent messages verbatim:', 25, {
			leftLabel: 'Summarize all',
			rightLabel: 'Summarize none'
		});
		rawTextSlider.input.id = 'rawTextPercentage';
		rawTextContainer.appendChild(rawTextSlider.container);

		// Summary prompt input (initially hidden)
		const summaryPromptContainer = document.createElement('div');
		summaryPromptContainer.id = 'summaryPromptContainer';
		summaryPromptContainer.style.display = rawTextSlider.input.value < 100 ? 'block' : 'none';
		summaryPromptContainer.className = 'mt-2';

		const promptLabel = document.createElement('label');
		promptLabel.className = CLAUDE_CLASSES.LABEL;
		promptLabel.textContent = 'Summary Prompt:';
		summaryPromptContainer.appendChild(promptLabel);

		const promptInput = document.createElement('textarea');
		promptInput.className = CLAUDE_CLASSES.INPUT;
		promptInput.placeholder = 'Enter custom summary prompt...';
		promptInput.value = defaultSummaryPrompt;
		promptInput.rows = 10;
		promptInput.style.resize = 'vertical';
		promptInput.id = 'summaryPrompt';
		summaryPromptContainer.appendChild(promptInput);

		rawTextContainer.appendChild(summaryPromptContainer);
		content.appendChild(rawTextContainer);

		// Include files toggle
		const includeFilesContainer = document.createElement('div');
		includeFilesContainer.className = 'mb-4';
		includeFilesContainer.id = 'includeFilesContainer';
		const includeFilesToggle = createClaudeToggle('Forward files', true);
		includeFilesToggle.input.id = 'includeFiles';
		includeFilesContainer.appendChild(includeFilesToggle.container);


		const keepFilesFromSummarizedToggle = createClaudeToggle('Forward files from summarized section', false);
		keepFilesFromSummarizedToggle.container.classList.add('pl-4');
		keepFilesFromSummarizedToggle.container.style.display = 'none';
		keepFilesFromSummarizedToggle.input.id = 'keepFilesFromSummarized';
		includeFilesContainer.appendChild(keepFilesFromSummarizedToggle.container);
		content.appendChild(includeFilesContainer);


		const includeToolCallsContainer = document.createElement('div');
		includeToolCallsContainer.className = 'mb-4';
		includeToolCallsContainer.id = 'includeToolCallsContainer';
		const includeToolCallsToggle = createClaudeToggle('Forward tool calls', false); // Default OFF
		includeToolCallsToggle.input.id = 'includeToolCalls';
		includeToolCallsContainer.appendChild(includeToolCallsToggle.container);

		const keepToolCallsFromSummarizedToggle = createClaudeToggle('Forward tool calls from summarized section', false);
		keepToolCallsFromSummarizedToggle.container.classList.add('pl-4');
		keepToolCallsFromSummarizedToggle.container.style.display = 'none';
		keepToolCallsFromSummarizedToggle.input.id = 'keepToolCallsFromSummarized';
		includeToolCallsContainer.appendChild(keepToolCallsFromSummarizedToggle.container);
		content.appendChild(includeToolCallsContainer);

		// Show/hide sub-toggles based on conditions
		function updateSubToggleVisibility() {
			const isSummarizing = rawTextSlider.input.value < 100;
			summaryPromptContainer.style.display = isSummarizing ? 'block' : 'none';

			keepFilesFromSummarizedToggle.container.style.display =
				(includeFilesToggle.input.checked && isSummarizing) ? 'flex' : 'none';

			keepToolCallsFromSummarizedToggle.container.style.display =
				(includeToolCallsToggle.input.checked && isSummarizing) ? 'flex' : 'none';
		}

		// Attach listeners
		rawTextSlider.input.addEventListener('change', updateSubToggleVisibility);
		includeFilesToggle.input.addEventListener('change', updateSubToggleVisibility);
		includeToolCallsToggle.input.addEventListener('change', updateSubToggleVisibility);

		// Initial state
		updateSubToggleVisibility();


		// Create modal
		const modal = new ClaudeModal('Choose Model for Fork', content);

		// Wider modal
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-lg');

		modal.addCancel();
		modal.addConfirm('Fork Chat', async () => {
			pendingFork.model = modelSelect.value;
			pendingFork.rawTextPercentage = parseInt(rawTextSlider.input.value);
			pendingFork.summaryPrompt = promptInput.value;
			pendingFork.includeAttachments = includeFilesToggle.input.checked;
			pendingFork.includeToolCalls = includeToolCallsToggle.input.checked;
			pendingFork.keepFilesFromSummarized = keepFilesFromSummarizedToggle.input.checked;
			pendingFork.keepToolCallsFromSummarized = keepToolCallsFromSummarizedToggle.input.checked;

			modal.destroy();
			await forkConversationClicked(messageUuid); // Pass UUID directly

			return false;
		});

		// Fetch account settings
		try {
			const accountData = await getAccountSettings();
			pendingFork.originalSettings = accountData.settings;
		} catch (error) {
			console.error('Failed to fetch account settings:', error);
		}

		return modal;
	}

	function addBranchButtons() {
		try {
			addAssistantMessageButtonWithPriority(createBranchButton, 'fork-button');
		} catch (error) {
			console.error('Error adding branch buttons:', error);
		}
	}
	//#endregion

	async function forkConversationClicked(messageUuid) {
		const loadingModal = createLoadingModal('Preparing to fork conversation...');
		loadingModal.show();
		pendingFork.loadingModal = loadingModal;

		try {
			const conversationId = getConversationId();
			const orgId = getOrgId();

			console.log('Forking conversation', conversationId, 'from message', messageUuid, 'with model', pendingFork.model);

			loadingModal.setContent(createLoadingContent('Getting conversation messages...'));

			let { conversation, conversationData, messages } =
				await getConversationMessages(orgId, conversationId, messageUuid);

			const chatName = conversationData.name;
			const projectUuid = conversationData.project?.uuid || null;

			// Fetch existing phantom messages for this conversation
			const existingPhantoms = await getPhantomMessagesFromMain(conversationId);
			const phantomTokens = existingPhantoms.length > 0 ? estimateTokens(existingPhantoms) : 0;

			let forkAttachments = [];
			let phantomsToCarryOver = [];

			// Apply summary if needed
			if (pendingFork.rawTextPercentage < 100) {
				loadingModal.setContent(createLoadingContent('Generating conversation summary...'));

				// Normalize FIRST - break up oversized messages
				messages = normalizeOversizedMessages(messages);
				console.log('Messages after normalization:', messages);

				// NOW token-based splitting works at the right granularity
				const totalTokens = estimateTokens(messages);
				const targetKeepTokens = Math.ceil(totalTokens * pendingFork.rawTextPercentage / 100);

				let keepCount = takeMessagesFromEnd(messages, targetKeepTokens, true);
				let splitIndex = messages.length - keepCount;

				// Adjust to ensure we cut before a user message
				while (splitIndex < messages.length && messages[splitIndex].sender !== 'human') {
					splitIndex++;
				}

				if (splitIndex >= messages.length) {
					splitIndex = 0;
				}

				const toSummarize = messages.slice(0, splitIndex);
				let toKeep = messages.slice(splitIndex);

				// Filter toKeep based on toggles (affects both chatlog and phantom messages)
				toKeep = filterMessagesForChatlog(toKeep, pendingFork.includeAttachments, pendingFork.includeToolCalls);

				// Calculate which phantoms to carry over
				if (existingPhantoms.length > 0) {
					const tokensToSummarize = estimateTokens(toSummarize);

					if (tokensToSummarize < phantomTokens) {
						// Split lands inside phantom range - some carry over
						const phantomTokensToKeep = phantomTokens - tokensToSummarize;
						const phantomKeepCount = takeMessagesFromEnd(existingPhantoms, phantomTokensToKeep, true);
						phantomsToCarryOver = existingPhantoms.slice(-phantomKeepCount);
						console.log(`Carrying over ${phantomsToCarryOver.length} phantom messages (${phantomTokensToKeep} tokens)`);
					} else {
						console.log('All phantom messages fall within summarized range, none carried over');
					}
				}

				if (toSummarize.length > 0) {
					const summaryMsgs = await chunkAndSummarize(orgId, toSummarize);

					// Extract summary texts from user messages (every other, starting at 0)
					const summaryTexts = summaryMsgs
						.filter((_, i) => i % 2 === 0)
						.map(m => m.content[0].text);

					forkAttachments = summaryTexts.map((text, i) => ({
						text: text,
						filename: `summary_chunk_${i + 1}.txt`
					}));

					// Fix parent chains based on whether we have phantoms to carry over
					if (phantomsToCarryOver.length > 0) {
						// First carried-over phantom points to last summary message (modify ClaudeMessage directly)
						phantomsToCarryOver[0].parent_message_uuid = summaryMsgs.at(-1).uuid;

						if (toKeep.length > 0) {
							// First toKeep message points to last carried-over phantom
							toKeep[0].parent_message_uuid = phantomsToCarryOver.at(-1).uuid;

							forkAttachments.push(getChatlogFromMessages(toKeep, false));
						}
					} else if (toKeep.length > 0) {
						// Original behavior when no phantoms to carry over
						toKeep[0].parent_message_uuid = summaryMsgs.at(-1).uuid;
						forkAttachments.push(getChatlogFromMessages(toKeep, false));
					}

					// Build final message array: summaries -> carried phantoms -> kept real messages
					messages = [...summaryMsgs, ...phantomsToCarryOver, ...toKeep];
				}
			} else {
				// No summarization - full chatlog
				// Filter messages based on toggles (affects both chatlog and phantom messages)
				messages = filterMessagesForChatlog(messages, pendingFork.includeAttachments, pendingFork.includeToolCalls);
				forkAttachments = [getChatlogFromMessages(messages, false)];

				// 100% verbatim: carry over ALL existing phantoms
				if (existingPhantoms.length > 0) {
					console.log(`Carrying over all ${existingPhantoms.length} phantom messages (100% verbatim)`);

					// First real message points to last existing phantom
					if (messages.length > 0) {
						messages[0].parent_message_uuid = existingPhantoms.at(-1).uuid;
					}
					messages = [...existingPhantoms, ...messages];
				}
			}

			loadingModal.setContent(createLoadingContent('Creating forked conversation...'));

			// Clean up messages based on toggles
			if (!pendingFork.includeAttachments) {
				for (const msg of messages) {
					// Keep chatlog-related attachments
					const chatlogFiles = msg.files.filter(f =>
						f instanceof ClaudeAttachment &&
						(f.file_name === 'chatlog.txt' ||
							f.file_name?.startsWith('chatlog_part') ||
							f.file_name?.startsWith('summary_chunk_'))
					);
					msg.clearFiles();
					for (const f of chatlogFiles) {
						msg.attachFile(f);
					}
				}
			}

			if (!pendingFork.includeToolCalls) {
				for (const msg of messages) {
					msg.removeToolCalls();
				}
			}

			const newConversationId = await createFork(
				orgId,
				messages,
				chatName,
				projectUuid,
				forkAttachments
			);

			loadingModal.setContent(createLoadingContent('Fork complete! Redirecting...'));
			console.log('Forked conversation created:', newConversationId);

			setTimeout(() => {
				if (newConversationId) window.location.href = `/chat/${newConversationId}`;
			}, 100);

		} catch (error) {
			if (error.message === 'USER_CANCELLED') {
				loadingModal.destroy();
				return;
			}
			console.error('Failed to fork conversation:', error);
			loadingModal.setTitle('Error');
			loadingModal.setContent(`Failed to fork conversation: ${error.message}`);
			loadingModal.clearButtons();
			loadingModal.addConfirm('OK');
		} finally {
			if (pendingFork.originalSettings) {
				await updateAccountSettings(pendingFork.originalSettings);
			}
			pendingFork = {
				model: null,
				includeAttachments: true,
				rawTextPercentage: 100,
				summaryPrompt: defaultSummaryPrompt,
				originalSettings: null,
				loadingModal: null
			};
		}
	}

	//#region Convo extraction & Other API
	async function getConversationMessages(orgId, conversationId, targetUUID) {
		const conversation = new ClaudeConversation(orgId, conversationId);
		const conversationData = await conversation.getData(false);
		const allMessages = await conversation.getMessages(false);

		// Extract up to targetUUID as ClaudeMessage[]
		const messages = [];
		for (const message of allMessages) {
			messages.push(message);
			if (message.uuid === targetUUID) {
				break;
			}
		}

		return {
			conversation,      // The ClaudeConversation instance
			conversationData,  // Raw data with name, projectUuid, etc.
			messages          // ClaudeMessage[] array
		};
	}

	function cleanupMessages(messages, conversation) {
		// Takes ClaudeMessage[], creates ClaudeMessage instances for filler messages
		const cleaned = [...messages];

		// Step 1: Remove synthetic normalization pairs
		let i = 0;
		while (i < cleaned.length) {
			const msg = cleaned[i];
			const text = msg.content?.[0]?.text || '';

			if (text === '[Continued attachments from previous message]') {
				const expectedAckSender = msg.sender === 'human' ? 'assistant' : 'human';
				const prevMsg = cleaned[i - 1];
				const prevText = prevMsg?.content?.[0]?.text || '';

				const hasPrevAck = i > 0 &&
					prevMsg.sender === expectedAckSender &&
					prevText === 'Acknowledged.';

				if (hasPrevAck) {
					cleaned.splice(i - 1, 2);
					i--;
				} else {
					cleaned.splice(i, 1);
				}
			} else {
				i++;
			}
		}

		// Step 2: Fix consecutive same-sender messages
		i = 0;
		while (i < cleaned.length - 1) {
			const current = cleaned[i];
			const next = cleaned[i + 1];

			if (current.sender === next.sender) {
				const fillerSender = current.sender === 'human' ? 'assistant' : 'human';
				const fillerText = fillerSender === 'assistant' ? 'Acknowledged.' : 'Continue.';

				// Create ClaudeMessage instance for filler
				const fillerMessage = new ClaudeMessage(conversation);
				fillerMessage.uuid = crypto.randomUUID();
				fillerMessage.parent_message_uuid = current.uuid;
				fillerMessage.sender = fillerSender;
				fillerMessage.text = fillerText;
				fillerMessage.created_at = current.created_at || new Date().toISOString();

				// Fix next message's parent to point to filler
				next.parent_message_uuid = fillerMessage.uuid;

				cleaned.splice(i + 1, 0, fillerMessage);
				i += 2;
			} else {
				i++;
			}
		}

		return cleaned;
	}

	function filterMessagesForChatlog(messages, includeFiles, includeToolCalls) {
		// Use ClaudeMessage methods in-place
		for (const msg of messages) {
			if (!includeFiles) {
				msg.clearFiles();
			}
			if (!includeToolCalls) {
				msg.removeToolCalls();
			}
		}
		return messages;
	}

	function getChatlogFromMessages(messages, includeRoleLabels = true, conversation = null) {
		// Create temporary conversation if not provided (for filler messages)
		const conv = conversation || new ClaudeConversation(getOrgId(), null);
		const cleaned = cleanupMessages(messages, conv);

		const chatlogText = cleaned.map(msg => {
			const role = msg.sender === 'human' ? '[User]' : '[Assistant]';
			const text = msg.toChatlogString();
			return includeRoleLabels ? `${role}\n${text}` : text;
		}).join('\n\n');

		// Return simple {text, filename} - callers should use addFile() to create proper file type
		return {
			text: chatlogText,
			filename: "chatlog.txt"
		};
	}

	async function getPhantomMessagesFromMain(conversationId) {
		return new Promise((resolve) => {
			const handler = (event) => {
				if (event.data.type === 'PHANTOM_MESSAGES_RESPONSE' &&
					event.data.conversationId === conversationId) {
					window.removeEventListener('message', handler);
					const messagesJson = event.data.messages || [];
					// Convert raw JSON to ClaudeMessage instances
					const conversation = new ClaudeConversation(getOrgId(), conversationId);
					const messages = messagesJson.map(json =>
						ClaudeMessage.fromHistoryJSON(conversation, json)
					);
					resolve(messages);
				}
			};

			window.addEventListener('message', handler);
			window.postMessage({
				type: 'GET_PHANTOM_MESSAGES_IDB',
				conversationId
			}, '*');

			// Timeout fallback
			setTimeout(() => {
				window.removeEventListener('message', handler);
				resolve([]);
			}, 5000);
		});
	}
	//#endregion

	//#region Fork creation
	function deduplicateByFilename(items) {
		const seen = new Map();
		// Iterate in reverse so newer items (later in array) win
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			const name = item.file_name || item.name;
			if (name && !seen.has(name)) {
				seen.set(name, item);
			}
		}
		return Array.from(seen.values()).reverse();
	}

	async function storePhantomMessagesAndWait(conversationId, messages) {
		// Takes ClaudeMessage[], serializes via toHistoryJSON() for storage
		return new Promise((resolve) => {
			const handler = (event) => {
				if (event.data.type === 'PHANTOM_MESSAGES_STORED_CONFIRMED' &&
					event.data.conversationId === conversationId) {
					window.removeEventListener('message', handler);
					resolve();
				}
			};

			window.addEventListener('message', handler);

			window.postMessage({
				type: 'STORE_PHANTOM_MESSAGES',
				conversationId,
				phantomMessages: messages.map(m => m.toHistoryJSON())
			}, '*');
		});
	}

	async function createFork(orgId, messages, chatName, projectUuid, forkAttachments) {
		if (!chatName || chatName.trim() === '') chatName = "Untitled";
		const newName = `Fork of ${chatName}`;
		const model = pendingFork.model;

		const conversation = new ClaudeConversation(orgId);
		const newUuid = await conversation.create(newName, model, projectUuid);
		await storePhantomMessagesAndWait(newUuid, cleanupMessages(messages, conversation));

		// Build the message to send
		const forkMessage = new ClaudeMessage(conversation);
		forkMessage.text = "This conversation is forked from the attached chatlog.txt. Simply say 'Acknowledged' and wait for user input.";
		forkMessage.sender = 'human';
		if (model) forkMessage.model = model;

		// Add chatlog/summary attachments (conversation metadata - force inline)
		for (const att of forkAttachments) {
			await forkMessage.addFile(att.text, att.filename, true);
		}

		// Collect and deduplicate files from messages (excludes ClaudeAttachments which are inline)
		const allFiles = messages.flatMap(m =>
			m.files.filter(f => !(f instanceof ClaudeAttachment))
		);
		const dedupedFiles = deduplicateByFilename(allFiles);

		// Re-upload files using addFile() which handles all file types
		for (const f of dedupedFiles) {
			await forkMessage.addFile(f);
		}

		// Figure out why we get redirected before the message is visible
		// Despite waiting for assistant completion. For now, idk. Maybe add a delay? TODO: Test more.
		await conversation.sendMessageAndWaitForResponse(forkMessage);

		await new Promise(r => setTimeout(r, 5000));

		return newUuid;
	}

	function buildSummaryPrompt(priorSummaryCount, includeAttachments) {
		let fullPrompt = pendingFork.summaryPrompt;

		// Always add prior summary warning if there are any
		if (priorSummaryCount > 0) {
			fullPrompt += `\n\nIMPORTANT: I've attached ${priorSummaryCount} previous summary files (summary_chunk_1.txt, summary_chunk_2.txt, etc.) for context. These contain summaries of earlier parts of the conversation. DO NOT re-summarize these summaries - they are only for your understanding of what came before. Only summarize the NEW conversation in chatlog.txt.`;
		}

		// Add file handling instruction based on settings
		if (includeAttachments) {
			fullPrompt += "\n\nOther attached files will be forwarded to the new chat - don't summarize them, only the conversation itself.";
		} else {
			fullPrompt += "\n\nFiles will NOT be forwarded, so include summaries of relevant file contents in your summary.";
		}

		return fullPrompt;
	}

	function estimateTokens(messages) {
		let totalChars = 0;

		for (const msg of messages) {
			// Use ClaudeConversation.extractMessageText which works with both raw JSON and ClaudeMessage
			totalChars += ClaudeConversation.extractMessageText(msg).length;

			// Add attachment content from files getter (ClaudeAttachments have extracted_content)
			for (const file of msg.files) {
				if (file instanceof ClaudeAttachment) {
					totalChars += file.extracted_content?.length || 0;
				}
			}
		}

		return Math.ceil(totalChars / 4);
	}

	function takeMessagesUpToTokens(messages, maxTokens, greedy = false) {
		let totalTokens = 0;
		let splitIndex = 0;

		for (let i = 0; i < messages.length; i++) {
			const msgTokens = estimateTokens([messages[i]]);

			if (totalTokens + msgTokens > maxTokens && splitIndex > 0) {
				if (!greedy) {
					break;  // Conservative: stop before exceeding
				}
				// Greedy: take this message anyway and stop
				totalTokens += msgTokens;
				splitIndex = i + 1;
				break;
			}

			totalTokens += msgTokens;
			splitIndex = i + 1;
		}

		// Always take at least one message
		if (splitIndex === 0) {
			splitIndex = 1;
		}

		return splitIndex;
	}

	function takeMessagesFromEnd(messages, maxTokens, greedy = true) {
		const reversed = messages.slice().reverse();
		return takeMessagesUpToTokens(reversed, maxTokens, greedy);
	}

	async function generateSummaryForChunk(tempConversation, messages, priorSummaryTexts) {
		console.log("Generating summary for chunk with", messages.length, "messages");
		const includeAttachments = pendingFork.includeAttachments && pendingFork.keepFilesFromSummarized;

		// Extract from messages using files getter with instanceof filters
		const files = messages.flatMap(m =>
			m.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile)
		);
		const attachments = messages.flatMap(m =>
			m.files.filter(f => f instanceof ClaudeAttachment)
		);
		const syncSources = messages.flatMap(m => m.sync_sources || []);

		// Build message for summary generation
		const summaryMessage = new ClaudeMessage(tempConversation);
		summaryMessage.text = buildSummaryPrompt(priorSummaryTexts.length, includeAttachments);
		summaryMessage.sender = 'human';

		// Add prior summary attachments (conversation metadata - force inline)
		for (let i = 0; i < priorSummaryTexts.length; i++) {
			await summaryMessage.addFile(priorSummaryTexts[i], `summary_chunk_${i + 1}.txt`, true);
		}

		// Add existing attachments from messages
		for (const a of attachments) {
			summaryMessage.attachFile(a);
		}

		// Add chatlog (conversation metadata - force inline)
		const chatlogAtt = getChatlogFromMessages(messages, true);
		await summaryMessage.addFile(chatlogAtt.text, chatlogAtt.filename, true);

		// Re-upload files using addFile()
		for (const f of files) {
			await summaryMessage.addFile(f);
		}

		// Get summary using the passed conversation
		const assistantMessage = await tempConversation.sendMessageAndWaitForResponse(summaryMessage);

		return ClaudeConversation.extractMessageText(assistantMessage);
	}

	// Splits oversized attachments into multiple attachments
	function splitOversizedAttachment(attachment) {
		const content = attachment.extracted_content || '';
		const maxChars = LAST_CHUNK_SIZE * 4; // Reverse token estimation

		console.log(`splitOversizedAttachment: "${attachment.file_name}", content length: ${content.length}, maxChars: ${maxChars}`);

		if (content.length <= maxChars) {
			console.log(`  -> No split needed, under limit`);
			return [attachment];
		}

		console.log(`  -> Splitting attachment into parts...`);

		const parts = [];
		let remaining = content;
		let partNum = 1;

		// Parse original filename
		const originalName = attachment.file_name || 'attachment.txt';
		const dotIndex = originalName.lastIndexOf('.');
		const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
		const extension = dotIndex > 0 ? originalName.slice(dotIndex) : '.txt';

		while (remaining.length > 0) {
			let chunkEnd = Math.min(remaining.length, maxChars);

			// Try to split at newline for cleaner breaks
			if (chunkEnd < remaining.length) {
				const lastNewline = remaining.lastIndexOf('\n', chunkEnd);
				if (lastNewline > maxChars * 0.5) {
					chunkEnd = lastNewline + 1;
				}
			}

			const chunkText = remaining.slice(0, chunkEnd);
			remaining = remaining.slice(chunkEnd);

			parts.push({
				id: crypto.randomUUID(),
				file_name: `${baseName}_part${partNum}${extension}`,
				file_size: chunkText.length,
				file_type: attachment.file_type || "text/plain",
				extracted_content: chunkText,
				created_at: new Date().toISOString()
			});

			partNum++;
		}

		console.log(`  -> Split into ${parts.length} parts`);
		return parts;
	}

	// Splits messages with too many attachments into multiple messages
	function normalizeOversizedMessages(messages, conversation = null) {
		// Create temporary conversation if not provided
		const conv = conversation || new ClaudeConversation(getOrgId(), null);
		const normalized = [];

		for (const msg of messages) {
			const msgTokens = estimateTokens([msg]);

			// Get attachments from files getter
			const msgAttachments = msg.files.filter(f => f instanceof ClaudeAttachment);
			const msgNonAttachments = msg.files.filter(f => !(f instanceof ClaudeAttachment));

			if (msgTokens <= LAST_CHUNK_SIZE || !msgAttachments.length) {
				// Keep as-is: normal size, or can't split further
				normalized.push(msg);
				continue;
			}

			// Pre-split any oversized attachments (returns raw attachment objects)
			const processedAttachments = msgAttachments.flatMap(att =>
				splitOversizedAttachment(att.toApiFormat())
			);

			// Split attachments into chunks
			const attachmentChunks = [];
			let currentChunk = [];
			let currentTokens = 0;

			for (const attachment of processedAttachments) {
				const attTokens = Math.ceil((attachment.extracted_content?.length || 0) / 4);

				// This should never happen after splitOversizedAttachment,
				// but keep as a safety fallback
				if (attTokens > LAST_CHUNK_SIZE) {
					console.warn('Single attachment still exceeds max chunk size after splitting - this should not happen:', attachment.file_name);
					if (currentChunk.length > 0) {
						attachmentChunks.push(currentChunk);
						currentChunk = [];
						currentTokens = 0;
					}
					attachmentChunks.push([attachment]);
				} else if (currentTokens + attTokens > LAST_CHUNK_SIZE) {
					// Would exceed, start new chunk
					console.log('Current chunk full, starting new chunk for attachment:', attachment.file_name);
					attachmentChunks.push(currentChunk);
					currentChunk = [attachment];
					currentTokens = attTokens;
				} else {
					console.log('Adding attachment to current chunk:', attachment.file_name);
					currentChunk.push(attachment);
					currentTokens += attTokens;
				}
			}

			if (currentChunk.length > 0) {
				attachmentChunks.push(currentChunk);
			}

			// Create synthetic messages - split into multiple pairs
			console.log(`Splitting message ${msg.uuid} into ${attachmentChunks.length} chunks.`);

			const originalSender = msg.sender;
			const alternateSender = originalSender === 'human' ? 'assistant' : 'human';

			let previousUuid = msg.parent_message_uuid;

			for (let i = 0; i < attachmentChunks.length; i++) {
				const isLast = i === attachmentChunks.length - 1;

				// Create ClaudeMessage for this chunk
				const chunkMsg = new ClaudeMessage(conv);
				chunkMsg.uuid = isLast ? msg.uuid : crypto.randomUUID();
				chunkMsg.parent_message_uuid = previousUuid;
				chunkMsg.sender = originalSender;
				chunkMsg.created_at = msg.created_at;

				// First chunk gets original content and non-attachment files
				if (i === 0) {
					chunkMsg.content = [...msg.content];
					for (const f of msgNonAttachments) {
						chunkMsg.attachFile(f);
					}
				} else {
					chunkMsg.content = [{ type: 'text', text: '[Continued attachments from previous message]' }];
				}

				// Add this chunk's attachments as ClaudeAttachment instances
				for (const attJson of attachmentChunks[i]) {
					chunkMsg.attachFile(ClaudeAttachment.fromJSON(attJson));
				}

				normalized.push(chunkMsg);
				previousUuid = chunkMsg.uuid;

				// Add acknowledgment (except after last chunk)
				if (!isLast) {
					const ackMsg = new ClaudeMessage(conv);
					ackMsg.uuid = crypto.randomUUID();
					ackMsg.parent_message_uuid = chunkMsg.uuid;
					ackMsg.sender = alternateSender;
					ackMsg.text = 'Acknowledged.';
					ackMsg.created_at = msg.created_at;

					normalized.push(ackMsg);
					previousUuid = ackMsg.uuid;
				}
			}

			console.log(`Message ${msg.uuid} split into ${attachmentChunks.length} chunks with acknowledgments.`);
		}

		return normalized;
	}

	async function chunkAndSummarize(orgId, messages) {
		// Collect ALL files/attachments/toolCalls from entire summarized section upfront using files getter
		const allFiles = messages.flatMap(m =>
			m.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile)
		);
		const allAttachments = messages.flatMap(m =>
			m.files.filter(f => f instanceof ClaudeAttachment)
		);
		const allToolCalls = messages.flatMap(m =>
			m.content.filter(item => item.type === 'tool_use' || item.type === 'tool_result')
		);

		const totalTokens = estimateTokens(messages);

		// Initial modal state
		if (pendingFork.loadingModal) {
			pendingFork.loadingModal.setContent(
				createLoadingContent(`Summarizing conversation...\nCurrent progress: 0 / ${totalTokens.toLocaleString()} tokens`)
			);
		}

		// Create temp conversation
		const summaryConvoName = `Temp_Summary_${Date.now()}`;
		const tempConversation = new ClaudeConversation(orgId);
		await tempConversation.create(summaryConvoName, FAST_MODEL, null);

		try {
			// ===== PHASE 1: Calculate chunk boundaries (work backwards) =====
			const chunks = calculateChunkBoundaries(messages);

			// ===== PHASE 2: Generate summaries (work forwards) =====
			const summaryTexts = [];
			let processedTokens = 0;

			for (const chunk of chunks) {
				processedTokens += estimateTokens(chunk);
				const summaryText = await generateSummaryForChunk(
					tempConversation,
					chunk,
					summaryTexts
				);

				if (pendingFork.loadingModal) {
					pendingFork.loadingModal.setContent(
						createLoadingContent(`Summarizing conversation...\nCurrent progress: ${processedTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tokens`)
					);
				}

				summaryTexts.push(summaryText);
			}

			// ===== PHASE 2.5: User review/edit summaries =====
			const editedSummaryTexts = await showSummaryEditModal(summaryTexts, chunks, tempConversation);

			// ===== PHASE 3: Create synthetic ClaudeMessage pairs =====
			const syntheticMessages = [];
			const timestamp = new Date().toISOString();

			for (let i = 0; i < editedSummaryTexts.length; i++) {
				const summaryText = editedSummaryTexts[i];
				const isFirstPair = i === 0;
				const isLastPair = i === editedSummaryTexts.length - 1;

				const parentUuid = syntheticMessages.at(-1)?.uuid ?? "00000000-0000-4000-8000-000000000000";

				// Create user message as ClaudeMessage
				const userMessage = new ClaudeMessage(tempConversation);
				userMessage.uuid = crypto.randomUUID();
				userMessage.parent_message_uuid = parentUuid;
				userMessage.sender = 'human';
				userMessage.text = summaryText;
				userMessage.created_at = timestamp;

				// Add files to first user message only
				if (isFirstPair && pendingFork.includeAttachments && pendingFork.keepFilesFromSummarized) {
					for (const f of allFiles) {
						userMessage.attachFile(f);
					}
					for (const a of allAttachments) {
						userMessage.attachFile(a);
					}
				}

				// Create assistant message as ClaudeMessage
				const assistantMessage = new ClaudeMessage(tempConversation);
				assistantMessage.uuid = crypto.randomUUID();
				assistantMessage.parent_message_uuid = userMessage.uuid;
				assistantMessage.sender = 'assistant';
				assistantMessage.content = [
					{ type: 'text', text: 'Acknowledged. I understand the context from the summary and am ready to continue our conversation.' }
				];
				assistantMessage.created_at = timestamp;

				if (isLastPair && pendingFork.includeToolCalls && pendingFork.keepToolCallsFromSummarized) {
					assistantMessage.content.push(...allToolCalls);
				}

				syntheticMessages.push(userMessage, assistantMessage);
			}

			console.log('Generated synthetic summary messages:', syntheticMessages.map(m => m.toHistoryJSON()));
			return syntheticMessages;
		} finally {
			await tempConversation.delete();
		}
	}

	function calculateChunkBoundaries(messages) {
		const totalTokens = estimateTokens(messages);

		// Single chunk case
		if (totalTokens < 2 * LAST_CHUNK_SIZE) {
			return [messages];
		}

		let remaining = messages;

		// Reserve last chunk (greedy, work from end)
		let lastChunkCount = takeMessagesFromEnd(remaining, LAST_CHUNK_SIZE, true);

		// Adjust to start on user message
		while (lastChunkCount < remaining.length &&
			remaining[remaining.length - lastChunkCount].sender !== 'human') {
			lastChunkCount++;
		}

		if (lastChunkCount >= remaining.length) {
			return [messages];  // Everything became last chunk
		}

		const lastChunk = remaining.slice(-lastChunkCount);
		remaining = remaining.slice(0, -lastChunkCount);

		// Calculate front chunks (work backwards through remaining)
		const remainingTokens = estimateTokens(remaining);
		const numFrontChunks = Math.max(1, Math.round(remainingTokens / MAIN_TARGET_CHUNK));
		const targetPerChunk = Math.ceil(remainingTokens / numFrontChunks);

		// Build chunks from end to beginning
		const frontChunks = [];
		for (let i = 0; i < numFrontChunks; i++) {
			if (remaining.length === 0) break;

			const takeCount = i === numFrontChunks - 1
				? remaining.length  // Last front chunk takes everything left
				: takeMessagesFromEnd(remaining, targetPerChunk, false);

			// Adjust to start on user message (working backwards)
			let adjustedTakeCount = takeCount;
			while (adjustedTakeCount < remaining.length &&
				remaining[remaining.length - adjustedTakeCount].sender !== 'human') {
				adjustedTakeCount++;
			}

			if (adjustedTakeCount >= remaining.length) {
				adjustedTakeCount = remaining.length;
			}

			const chunk = remaining.slice(-adjustedTakeCount);
			remaining = remaining.slice(0, -adjustedTakeCount);

			frontChunks.unshift(chunk);  // Add to beginning since we're working backwards
		}

		//console.log(`Calculated ${frontChunks.length} front chunks and 1 last chunk for summarization.`);
		//console.log("Chunks:", [...frontChunks, lastChunk]);
		return [...frontChunks, lastChunk];
	}

	async function showSummaryEditModal(summaryTexts, chunks, tempConversation) {
		return new Promise((resolve, reject) => {
			const content = document.createElement('div');

			// Indicator text - larger and more visible
			const indicator = document.createElement('div');
			indicator.className = 'mb-1 text-text-200 text-center text-lg font-semibold';
			indicator.textContent = `Summary 1 of ${summaryTexts.length}`;
			content.appendChild(indicator);

			// Token counter
			const tokenCounter = document.createElement('div');
			tokenCounter.className = 'mb-3 text-text-300 text-center text-sm';
			content.appendChild(tokenCounter);

			function updateTokenCount(text) {
				const tokens = Math.ceil(text.length / 4);
				tokenCounter.textContent = `~${tokens.toLocaleString()} tokens`;
			}

			// Create all textareas (only first visible)
			const textareas = summaryTexts.map((text, i) => {
				const textarea = document.createElement('textarea');
				textarea.className = CLAUDE_CLASSES.INPUT;
				textarea.value = text;
				textarea.rows = 18;
				textarea.style.resize = 'vertical';
				textarea.style.display = i === 0 ? 'block' : 'none';
				textarea.addEventListener('input', () => {
					if (i === currentIndex) {
						updateTokenCount(textarea.value);
					}
				});
				content.appendChild(textarea);
				return textarea;
			});

			// Initialize token count
			updateTokenCount(textareas[0].value);

			let currentIndex = 0;

			// Navigation container
			const navContainer = document.createElement('div');
			navContainer.className = 'flex items-center justify-between mt-3';

			const leftBtn = createClaudeButton('← Previous', 'secondary');
			leftBtn.disabled = true;
			leftBtn.style.opacity = '0.5';
			leftBtn.style.cursor = 'not-allowed';

			const editWithClaudeBtn = createClaudeButton('Edit with Claude', 'secondary');

			// Style it orange
			editWithClaudeBtn.style.backgroundColor = 'hsl(var(--accent-main-100))';
			editWithClaudeBtn.style.color = 'hsl(var(--oncolor-100))';
			editWithClaudeBtn.style.borderColor = 'hsl(var(--accent-main-100))';

			editWithClaudeBtn.addEventListener('pointerenter', () => {
				editWithClaudeBtn.style.backgroundColor = 'hsl(var(--accent-main-200))';
			});
			editWithClaudeBtn.addEventListener('pointerleave', () => {
				editWithClaudeBtn.style.backgroundColor = 'hsl(var(--accent-main-100))';
			});

			const rightBtn = createClaudeButton('Next →', 'secondary');
			if (summaryTexts.length <= 1) {
				rightBtn.disabled = true;
				rightBtn.style.opacity = '0.5';
				rightBtn.style.cursor = 'not-allowed';
			}

			function updateNavigation() {
				indicator.textContent = `Summary ${currentIndex + 1} of ${summaryTexts.length}`;
				updateTokenCount(textareas[currentIndex].value);

				leftBtn.disabled = currentIndex === 0;
				leftBtn.style.opacity = leftBtn.disabled ? '0.5' : '1';
				leftBtn.style.cursor = leftBtn.disabled ? 'not-allowed' : 'pointer';

				rightBtn.disabled = currentIndex === summaryTexts.length - 1;
				rightBtn.style.opacity = rightBtn.disabled ? '0.5' : '1';
				rightBtn.style.cursor = rightBtn.disabled ? 'not-allowed' : 'pointer';
			}

			function showTextarea(index) {
				textareas[currentIndex].style.display = 'none';
				currentIndex = index;
				textareas[currentIndex].style.display = 'block';
				updateNavigation();
			}

			leftBtn.onclick = () => {
				if (currentIndex > 0) showTextarea(currentIndex - 1);
			};

			rightBtn.onclick = () => {
				if (currentIndex < summaryTexts.length - 1) showTextarea(currentIndex + 1);
			};

			editWithClaudeBtn.onclick = async () => {
				let editPrompt;
				try {
					editPrompt = await showClaudePrompt('How should Claude edit this summary?', '');
				} catch (e) {
					return; // User cancelled
				}
				if (!editPrompt) return;

				const loadingModal = createLoadingModal('Rewriting summary with Claude...');
				loadingModal.show();

				try {
					const currentSummary = textareas[currentIndex].value;

					// Previous summaries from textareas (includes user edits)
					const previousSummaryAttachments = [];
					for (let i = 0; i < currentIndex; i++) {
						previousSummaryAttachments.push(
							ClaudeAttachment.fromText(textareas[i].value, `summary_chunk_${i + 1}.txt`).toApiFormat()
						);
					}

					// Get chunk for current summary
					const chunk = chunks[currentIndex];

					// Collect files from chunk using unified files getter
					const files = chunk.flatMap(m =>
						m.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile)
					);
					const attachments = chunk.flatMap(m =>
						m.files.filter(f => f instanceof ClaudeAttachment)
					);

					// Build message for rewrite
					const rewriteMessage = new ClaudeMessage(tempConversation);
					rewriteMessage.text = `\`\`\`
${currentSummary}
\`\`\`

The above is the summary to rewrite. Please make the following changes:

\`\`\`
${editPrompt}
\`\`\`

Provide the complete rewritten summary.`;
					rewriteMessage.sender = 'human';

					// Add previous summary attachments (conversation metadata - force inline)
					for (const att of previousSummaryAttachments) {
						await rewriteMessage.addFile(att.extracted_content, att.file_name, true);
					}

					// Add attachments from chunk
					for (const a of attachments) {
						rewriteMessage.attachFile(a);
					}

					// Add chatlog (conversation metadata - force inline)
					const chatlogAtt = getChatlogFromMessages(chunk, true);
					await rewriteMessage.addFile(chatlogAtt.text, chatlogAtt.filename, true);

					// Re-upload files using addFile()
					for (const f of files) {
						await rewriteMessage.addFile(f);
					}

					const assistantMessage = await tempConversation.sendMessageAndWaitForResponse(rewriteMessage);

					const newSummary = ClaudeConversation.extractMessageText(assistantMessage);
					textareas[currentIndex].value = newSummary;

					loadingModal.destroy();
				} catch (error) {
					loadingModal.destroy();
					showClaudeAlert('Error', `Failed to rewrite summary: ${error.message}`);
				}
			};

			navContainer.appendChild(leftBtn);
			navContainer.appendChild(editWithClaudeBtn);
			navContainer.appendChild(rightBtn);
			content.appendChild(navContainer);

			// Create modal
			const modal = new ClaudeModal('Review Summaries', content);
			modal.modal.classList.remove('max-w-md');
			modal.modal.classList.add('max-w-2xl');

			modal.addCancel('Cancel', () => {
				reject(new Error('USER_CANCELLED'));
			});

			modal.addConfirm('Submit', () => {
				const editedTexts = textareas.map(ta => ta.value);
				resolve(editedTexts);
				return true;
			});

			modal.show();
		});
	}

	//#endregion

	setInterval(addBranchButtons, 3000);
})();