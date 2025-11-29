// exporter.js
// Chat export and import functionality for Claude.ai
// Depends on: claude-styles.js, phantom-messages.js, claude-api.js

(function () {
	'use strict';

	// Global role configuration
	const ROLES = {
		USER: {
			apiName: "human",
			exportDelimiter: "User",
			librechatName: "User",
			jsonlName: "user"
		},
		ASSISTANT: {
			apiName: "assistant",
			exportDelimiter: "Assistant",
			librechatName: "Claude",
			jsonlName: "assistant"
		}
	};
	const EXPORT_TAG_PREFIX = 'CLEXP:';
	const TAG_REGEX = new RegExp(`^\\[${EXPORT_TAG_PREFIX}([\\da-zA-Z_-]+)(?::(\\d+))?\\]$`);
	const ATTACHMENT_DELIMITER_REGEX = /\n*=====ATTACHMENT_BEGIN: .+?=====\n[\s\S]*?\n=====ATTACHMENT_END=====/g;

	//#region Export format handlers
	function formatTxtExport(conversationData, conversationId) {
		let output = `Title: ${conversationData.name}\nDate: ${conversationData.updated_at}\n\n`;

		for (const message of conversationData.chat_messages) {
			// Message boundary
			const roleDelimiter = message.sender === ROLES.USER.apiName ? ROLES.USER.exportDelimiter : ROLES.ASSISTANT.exportDelimiter;
			const isoTimestamp = message.created_at || message.updated_at;
			const timestamp = isoTimestamp ? new Date(isoTimestamp).getTime() : '';
			const timestampSuffix = timestamp ? `:${timestamp}` : '';
			output += `[${EXPORT_TAG_PREFIX}${roleDelimiter}${timestampSuffix}]\n`;

			// Content blocks
			for (const content of message.content) {
				if (content.type === 'text') {
					output += `[${EXPORT_TAG_PREFIX}content-text]\n${content.text}\n\n`;
				} else {
					// All other content types as JSON
					output += `[${EXPORT_TAG_PREFIX}content-${content.type}]\n${JSON.stringify(content)}\n\n`;
				}
			}

			// Files/attachments (user messages only)
			if (message.sender === ROLES.USER.apiName) {
				if (message.files_v2 && message.files_v2.length > 0) {
					output += `[${EXPORT_TAG_PREFIX}files_v2]\n${JSON.stringify(message.files_v2)}\n\n`;
				}

				if (message.attachments && message.attachments.length > 0) {
					output += `[${EXPORT_TAG_PREFIX}attachments]\n${JSON.stringify(message.attachments)}\n\n`;
				}
			}
		}

		return output;
	}

	function formatJsonlExport(conversationData, conversationId) {
		// Simple JSONL - just role and text
		return conversationData.chat_messages.map(msg => {
			return JSON.stringify({
				role: msg.sender === ROLES.USER.apiName ? ROLES.USER.jsonlName : ROLES.ASSISTANT.jsonlName,
				content: ClaudeConversation.extractMessageText(msg)
			});
		}).join('\n');
	}

	function formatLibrechatExport(conversationData, conversationId) {
		const processedMessages = conversationData.chat_messages.map((msg) => {
			let contentText = "";

			// Convert attachments to LibreChat file format AND embed inline
			const files = [];

			if (msg.attachments && msg.attachments.length > 0) {
				for (const attachment of msg.attachments) {
					const text = attachment.extracted_content || '';

					// Add to files array (survives re-export, we can read it back)
					files.push({
						file_id: crypto.randomUUID(),
						bytes: attachment.file_size || text.length || 0,
						context: 'message_attachment',
						filename: attachment.file_name || 'unknown',
						object: 'file',
						source: 'text',
						text: text,
						type: attachment.file_type || 'text/plain'
					});

					// Also embed inline (so LibreChat's AI can see it)
					if (text && msg.sender === ROLES.USER.apiName) {
						contentText += `\n=====ATTACHMENT_BEGIN: ${attachment.file_name || 'unknown'}=====\n`;
						contentText += text;
						contentText += `\n=====ATTACHMENT_END=====\n\n`;
					}
				}
			}
			contentText += ClaudeConversation.extractMessageText(msg);

			const message = {
				messageId: msg.uuid,
				parentMessageId: msg.parent_message_uuid === "00000000-0000-4000-8000-000000000000"
					? null
					: msg.parent_message_uuid,
				text: contentText,
				sender: msg.sender === ROLES.ASSISTANT.apiName ? ROLES.ASSISTANT.librechatName : ROLES.USER.librechatName,
				isCreatedByUser: msg.sender === ROLES.USER.apiName,
				createdAt: msg.created_at
			};

			if (files.length > 0) {
				message.files = files;
			}

			return message;
		});

		return JSON.stringify({
			title: conversationData.name,
			endpoint: "anthropic",
			conversationId: conversationId,
			options: {
				model: conversationData.model ?? DEFAULT_CLAUDE_MODEL
			},
			messages: processedMessages
		}, null, 2);
	}

	function formatRawExport(conversationData, conversationId) {
		return JSON.stringify(conversationData, null, 2);
	}
	//#endregion

	async function formatExport(conversationData, format, conversationId) {
		switch (format) {
			case 'txt':
				return formatTxtExport(conversationData, conversationId);
			case 'jsonl':
				return formatJsonlExport(conversationData, conversationId);
			case 'librechat':
				return formatLibrechatExport(conversationData, conversationId);
			case 'raw':
				return formatRawExport(conversationData, conversationId);
			default:
				throw new Error(`Unsupported format: ${format}`);
		}
	}

	//#region File handling for import
	function getFileDownloadUrl(file) {
		// Try preview first (images)
		if (file.preview_asset?.url) {
			return file.preview_asset.url;
		}

		// Try document (PDFs, etc.)
		if (file.document_asset?.url) {
			return file.document_asset.url;
		}

		// Find any asset that isn't thumbnail
		const assetKeys = Object.keys(file).filter(k => k.endsWith('_asset') && k !== 'thumbnail_asset');
		for (const key of assetKeys) {
			if (file[key]?.url) {
				return file[key].url;
			}
		}

		// Last resort: thumbnail
		if (file.thumbnail_asset?.url) {
			return file.thumbnail_asset.url;
		}

		throw new Error(`Could not find download URL for file: ${file.file_name}`);
	}

	async function promptForFile(fileName) {
		return new Promise((resolve, reject) => {
			const content = document.createElement('div');
			const text = document.createElement('p');
			text.className = CLAUDE_CLASSES.TEXT;
			text.textContent = `Failed to download "${fileName}". Please select it from your computer:`;
			content.appendChild(text);

			const modal = new ClaudeModal('File Download Failed', content);

			modal.addCancel('Skip File', () => {
				resolve(null); // Skip this file
			});

			modal.addConfirm('Select File', async () => {
				const fileInput = document.createElement('input');
				fileInput.type = 'file';

				const file = await new Promise(res => {
					fileInput.onchange = e => res(e.target.files[0]);
					fileInput.click();
				});

				if (file) {
					resolve({
						data: file,
						name: file.name,
						kind: file.type.startsWith('image/') ? 'image' : 'document'
					});
				} else {
					resolve(null);
				}
			});

			modal.show();
		});
	}

	async function downloadAndReuploadFiles(messages, loadingModal) {
		const orgId = getOrgId();
		const allFiles = messages.flatMap(msg =>
			(msg.files_v2 || []).map(f => ({
				uuid: f.file_uuid,
				url: getFileDownloadUrl(f),
				kind: f.file_kind,
				name: f.file_name
			}))
		);

		if (allFiles.length === 0) return messages;

		// Download files with fallback
		const downloadedFiles = [];
		for (let i = 0; i < allFiles.length; i++) {
			const file = allFiles[i];

			if (loadingModal) {
				loadingModal.setContent(createLoadingContent(`Downloading file ${i + 1}/${allFiles.length}: ${file.name}`));
			}

			try {
				const blob = await downloadFile(file.url);
				downloadedFiles.push({
					data: blob,
					name: file.name,
					kind: file.kind,
					originalUuid: file.uuid
				});
			} catch (error) {
				console.log(`Failed to download ${file.name}:`, error);
				const userFile = await promptForFile(file.name);
				if (userFile) {
					downloadedFiles.push({
						...userFile,
						originalUuid: file.uuid
					});
				} else {
					downloadedFiles.push(null);
				}
			}
		}

		// Upload files
		if (loadingModal) {
			loadingModal.setContent(createLoadingContent(`Uploading ${downloadedFiles.filter(Boolean).length} files...`));
		}

		const uploadedFiles = await Promise.all(
			downloadedFiles.map(file =>
				file ? uploadFile(orgId, file) : Promise.resolve(null)
			)
		);

		// Build UUID mapping
		const uuidMap = new Map();
		allFiles.forEach((oldFile, index) => {
			if (uploadedFiles[index]) {
				uuidMap.set(oldFile.uuid, uploadedFiles[index]);
			}
		});

		// Replace files_v2 in messages
		return messages.map(msg => ({
			...msg,
			files_v2: (msg.files_v2 || [])
				.map(f => uuidMap.get(f.file_uuid))
				.filter(Boolean),
			files: (msg.files_v2 || [])
				.map(f => {
					const newFile = uuidMap.get(f.file_uuid);
					return newFile ? newFile.file_uuid : null;
				})
				.filter(Boolean)
		}));
	}
	//#endregion

	//#region Import functionality
	function parseAndValidateText(text) {
		const warnings = [];

		// Parse header
		const titleMatch = text.match(/^Title: (.+)/m);
		const title = titleMatch ? titleMatch[1].trim() : 'Imported Conversation';

		// Remove header
		const contentStart = text.search(/\n\[(.+)\]\n/);
		if (contentStart === -1) {
			throw new Error('No messages found in file');
		}

		const lines = text.slice(contentStart).split('\n');

		const messages = [];
		let currentMessage = null;
		let currentTag = null;
		let textBuffer = '';

		function flushTextBuffer() {
			if (!textBuffer || !currentTag) return;
			if (currentTag.startsWith('content-')) {
				// Content block
				const contentType = currentTag.substring(8); // Remove "content-" prefix

				if (contentType === 'text') {
					currentMessage.content.push({
						type: 'text',
						text: textBuffer.trim()
					});
				} else {
					// Parse as JSON
					try {
						const jsonData = JSON.parse(textBuffer.trim());
						if (!jsonData.type) jsonData.type = contentType;
						currentMessage.content.push(jsonData);
					} catch (error) {
						warnings.push(`Failed to parse [content-${contentType}] block: ${error.message}`);
					}
				}
			} else {
				// Message property
				try {
					const jsonData = JSON.parse(textBuffer.trim());
					currentMessage[currentTag] = jsonData;

					// Duplicate files_v2 to files (array of UUIDs)
					if (currentTag === 'files_v2') {
						currentMessage.files = jsonData.map(f => f.file_uuid);
					}
				} catch (error) {
					warnings.push(`Failed to parse [${currentTag}] block: ${error.message}`);
				}
			}

			textBuffer = '';
		}

		for (const line of lines) {
			const markerMatch = line.match(TAG_REGEX);
			if (markerMatch) {
				const marker = markerMatch[1];
				const timestampStr = markerMatch[2]; // Unix timestamp in milliseconds (if present)

				// Flush previous content
				flushTextBuffer();

				if (marker === ROLES.USER.exportDelimiter || marker === ROLES.ASSISTANT.exportDelimiter) {
					// Role marker - start new message
					const role = marker === ROLES.USER.exportDelimiter ? ROLES.USER.apiName : ROLES.ASSISTANT.apiName;

					// Check for consecutive messages of same role
					if (currentMessage && currentMessage.sender === role) {
						throw new Error(`Consecutive [${marker}] blocks not allowed`);
					}

					// Push previous message
					if (currentMessage) messages.push(currentMessage);

					// Start new message
					currentMessage = {
						sender: role,
						content: [],
						files_v2: [],
						files: [],
						attachments: [],
						sync_sources: []
					};

					// Store timestamp if present
					if (timestampStr) {
						currentMessage.created_at = new Date(parseInt(timestampStr)).toISOString();
					}

					currentTag = null;
				} else {
					// Content or property tag
					if (!currentMessage) {
						throw new Error(`Found [${marker}] before any message role`);
					}
					currentTag = marker;
				}
			} else {
				// Regular line - add to buffer
				if (textBuffer) textBuffer += '\n';
				textBuffer += line;
			}
		}

		// Flush final content
		flushTextBuffer();
		if (currentMessage) messages.push(currentMessage);

		// Validation
		if (messages.length === 0) {
			throw new Error('No messages found in file');
		}
		if (messages[0].sender !== ROLES.USER.apiName) {
			throw new Error(`Conversation must start with a ${ROLES.USER.exportDelimiter} message`);
		}

		return { name: title, chat_messages: messages, warnings };
	}

	function convertToPhantomMessages(chat_messages) {
		const phantomMessages = [];
		let parentId = "00000000-0000-4000-8000-000000000000";

		for (const message of chat_messages) {
			const messageId = crypto.randomUUID();
			const timestamp = message.created_at || new Date().toISOString();

			// Build content array - add timestamps to each content item
			const content = message.content.map(contentItem => {
				const item = { ...contentItem };
				if (!item.start_timestamp) item.start_timestamp = timestamp;
				if (!item.stop_timestamp) item.stop_timestamp = timestamp;
				if (!item.citations) item.citations = [];
				return item;
			});

			phantomMessages.push({
				uuid: messageId,
				parent_message_uuid: parentId,
				sender: message.sender,
				content: content,
				created_at: timestamp,
				files_v2: message.files_v2 || [],
				files: message.files || [],
				attachments: message.attachments || [],
				sync_sources: []
			});
			parentId = messageId;
		}

		return phantomMessages;
	}

	function formatMessageForChatlog(message) {
		const parts = [];

		// Whitelist of content types to include
		const allowedContentTypes = ['text', 'tool_use', 'tool_result'];

		// Format content
		for (const item of message.content) {
			if (!allowedContentTypes.includes(item.type)) {
				continue; // Skip thinking, etc.
			}

			if (item.type === 'text') {
				parts.push(item.text);
			} else {
				parts.push(JSON.stringify(item));
			}
		}

		// Dump files_v2 as JSON
		if (message.files_v2 && message.files_v2.length > 0) {
			parts.push(JSON.stringify(message.files_v2));
		}

		// Dump attachments as JSON
		if (message.attachments && message.attachments.length > 0) {
			parts.push(JSON.stringify(message.attachments));
		}

		return parts.join('\n\n');
	}

	async function storePhantomMessagesAndWait(conversationId, messages) {
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
				phantomMessages: messages
			}, '*');
		});
	}

	async function createNewConversation(name, chat_messages, model) {
		const orgId = getOrgId();

		// Create new conversation with parsed name
		const conversation = new ClaudeConversation(orgId);
		const newConvoId = await conversation.create(name, model);

		// Build chatlog attachment
		const cleanedContent = chat_messages
			.map(msg => formatMessageForChatlog(msg))
			.join('\n\n');

		const chatlogAttachment = {
			extracted_content: cleanedContent,
			file_name: "chatlog.txt",
			file_size: cleanedContent.length,
			file_type: "text/plain"
		};

		// Collect all files from messages (attachments are inlined in chatlog)
		const allFiles = chat_messages.flatMap(msg => msg.files || []);

		// Send initial message
		await conversation.sendMessageAndWaitForResponse(
			"This conversation is imported from the attached chatlog.txt\nYou are Assistant. Simply say 'Acknowledged' and wait for user input.",
			{
				model: model,
				attachments: [chatlogAttachment],
				files: allFiles,
				syncSources: []
			}
		);

		// Convert and store phantom messages
		const phantomMessages = convertToPhantomMessages(chat_messages);
		await storePhantomMessagesAndWait(newConvoId, phantomMessages);

		// Navigate to new conversation
		window.location.href = `/chat/${newConvoId}`;
	}

	function showWarningsModal(warnings) {
		const warningList = document.createElement('ul');
		warningList.className = 'list-disc pl-5 space-y-1';
		warnings.forEach(warning => {
			const li = document.createElement('li');
			li.textContent = warning;
			warningList.appendChild(li);
		});

		return new Promise((resolve) => {
			const modal = new ClaudeModal('Import Warnings', warningList);
			modal.addCancel('Cancel', () => resolve(false));
			modal.addConfirm('Import Anyway', () => resolve(true));
			modal.show();
		});
	}

	//#region LibreChat JSON import
	function parseLibrechatJson(jsonText) {
		const data = JSON.parse(jsonText);
		const warnings = [];

		if (!data.messages || !Array.isArray(data.messages) || data.messages.length === 0) {
			throw new Error('Invalid LibreChat format: missing or empty messages array');
		}

		// Warn about branches upfront
		if (data.branches) {
			warnings.push('Multiple branches detected. Importing rightmost branch.');
		}

		let messages;

		if (data.recursive) {
			// Recursive format - nested children
			messages = flattenRecursiveTree(data.messages);
		} else {
			// Sequential format - flat with parentMessageId
			messages = extractLinearBranch(data.messages);
		}

		if (messages.length === 0) {
			throw new Error('No messages found in file');
		}

		// Convert to internal format
		const chat_messages = messages.map(msg => {
			// Convert files to attachments (text-based files only)
			const attachments = [];
			if (msg.files && Array.isArray(msg.files)) {
				for (const file of msg.files) {
					if (file.text) {
						attachments.push({
							extracted_content: file.text,
							file_name: file.filename || 'unknown',
							file_size: file.bytes || file.text.length,
							file_type: file.type || 'text/plain'
						});
					}
				}
			}

			return {
				sender: msg.isCreatedByUser ? ROLES.USER.apiName : ROLES.ASSISTANT.apiName,
				content: extractLibrechatContent(msg),
				created_at: msg.createdAt,
				files_v2: [],
				files: [],
				attachments: attachments,
				sync_sources: []
			};
		});

		// Ensure conversation starts with user message
		if (chat_messages.length > 0 && chat_messages[0].sender !== ROLES.USER.apiName) {
			warnings.push('Conversation did not start with a user message. A placeholder was added.');
			chat_messages.unshift({
				sender: ROLES.USER.apiName,
				content: [{ type: 'text', text: '[Conversation imported from LibreChat]' }],
				created_at: chat_messages[0].created_at,
				files_v2: [],
				files: [],
				attachments: [],
				sync_sources: []
			});
		}

		return {
			name: data.title || 'Imported Conversation',
			chat_messages,
			warnings
		};
	}

	function extractLibrechatContent(msg) {
		if (msg.content && Array.isArray(msg.content) && msg.content.length > 0) {
			return msg.content.map(block => {
				if (block.type === 'think') {
					return {
						type: 'thinking',
						thinking: block.think || ''
					};
				} else if (block.type === 'text') {
					return {
						type: 'text',
						text: (block.text || '').replace(ATTACHMENT_DELIMITER_REGEX, '').trim()
					};
				} else {
					return block;
				}
			});
		}

		return [{
			type: 'text',
			text: (msg.text || '').replace(ATTACHMENT_DELIMITER_REGEX, '').trim()
		}];
	}

	function extractLinearBranch(messages) {
		const messageMap = new Map();
		for (const msg of messages) {
			messageMap.set(msg.messageId, msg);
		}

		// Last message in array → walk backward to root
		const lastMessage = messages[messages.length - 1];
		const branch = [];
		let current = lastMessage;

		while (current) {
			branch.unshift(current);

			const parentId = current.parentMessageId;
			if (!parentId || parentId === '00000000-0000-0000-0000-000000000000') {
				break;
			}

			current = messageMap.get(parentId);
		}

		return branch;
	}

	function flattenRecursiveTree(messages) {
		// Start from last root, follow last child at each level
		const branch = [];
		let current = messages[messages.length - 1];

		while (current) {
			branch.push(current);

			if (current.children && current.children.length > 0) {
				current = current.children[current.children.length - 1];
			} else {
				current = null;
			}
		}

		return branch;
	}
	//#endregion

	async function handleImport(model, includeFiles, includeToolCalls) {
		// Trigger file picker
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = '.txt,.json';

		const file = await new Promise(resolve => {
			fileInput.onchange = e => resolve(e.target.files[0]);
			fileInput.click();
		});

		if (!file) return;

		// Parse and validate
		const fileContent = await file.text();
		let parsedData;

		// Show loading modal
		const loadingModal = createLoadingModal('Importing...');
		loadingModal.show();

		try {
			if (file.name.endsWith('.json')) {
				parsedData = parseLibrechatJson(fileContent);
			} else {
				parsedData = parseAndValidateText(fileContent);
			}
		} catch (error) {
			// Show error
			showClaudeAlert('Import Error', error.message);
			loadingModal.destroy();
			return;
		}

		let { chat_messages, warnings, name } = parsedData

		// Filter based on toggles
		if (!includeFiles) {
			chat_messages = chat_messages.map(msg => ({
				...msg,
				files_v2: [],
				files: [],
				attachments: []
			}));
		}

		if (!includeToolCalls) {
			chat_messages = chat_messages.map(msg => ({
				...msg,
				content: msg.content.filter(item =>
					item.type !== 'tool_use' && item.type !== 'tool_result'
				)
			}));
		}

		// Show warnings modal if needed
		if (warnings.length > 0) {
			const proceed = await showWarningsModal(warnings);
			if (!proceed) return;
		}

		try {
			chat_messages = await downloadAndReuploadFiles(chat_messages, loadingModal);
			await createNewConversation(name, chat_messages, model);
			// Navigation happens in createNewConversation, loading modal cleaned up automatically
		} catch (error) {
			console.error('Import failed:', error);
			loadingModal.destroy();
			showClaudeAlert('Import Error', error.message || 'Failed to import conversation');
		}
	}

	async function handleReplacePhantom(replaceButton) {
		const conversationId = getConversationId();
		if (!conversationId) {
			showClaudeAlert('Replace Error', 'Not in a conversation');
			return;
		}

		// Trigger file picker
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = '.txt,.json';

		const file = await new Promise(resolve => {
			fileInput.onchange = e => resolve(e.target.files[0]);
			fileInput.click();
		});

		if (!file) return;

		// Parse and validate
		const fileContent = await file.text();
		let parsedData;

		// Show loading modal
		const loadingModal = createLoadingModal('Replacing phantom messages...');
		loadingModal.show();

		try {
			if (file.name.endsWith('.json')) {
				parsedData = parseLibrechatJson(fileContent);
			} else {
				parsedData = parseAndValidateText(fileContent);
			}
			parsedData.chat_messages = await downloadAndReuploadFiles(parsedData.chat_messages, loadingModal);
		} catch (error) {
			showClaudeAlert('Replace Error', error.message || 'Invalid format');
			loadingModal.destroy();
			return;
		}

		// Show warnings modal if needed
		if (parsedData.warnings.length > 0) {
			const proceed = await showWarningsModal(parsedData.warnings);
			if (!proceed) return;
		}



		try {
			// Convert and store phantom messages
			const phantomMessages = convertToPhantomMessages(parsedData.chat_messages);
			await storePhantomMessagesAndWait(conversationId, phantomMessages);

			// Reload to show changes
			window.location.reload();
		} catch (error) {
			console.error('Replace failed:', error);
			loadingModal.destroy();
			showClaudeAlert('Replace Error', error.message || 'Failed to replace phantom messages');
		}
	}
	//#endregion

	async function showExportImportModal() {
		const conversationId = getConversationId();
		const isInConversation = Boolean(conversationId);

		// Get last used format from localStorage
		const lastFormat = localStorage.getItem('lastExportFormat') || 'txt_txt';

		// Build the modal content
		const content = document.createElement('div');

		// Variables to hold references (may not be created)
		let formatSelect, toggleInput;

		//#region Export section (only if in conversation)
		if (isInConversation) {
			// Format label
			const formatLabel = document.createElement('label');
			formatLabel.className = CLAUDE_CLASSES.LABEL;
			formatLabel.textContent = 'Export Format';
			content.appendChild(formatLabel);

			const exportContainer = document.createElement('div');
			exportContainer.className = 'mb-4 flex gap-2';

			// Format select
			formatSelect = createClaudeSelect([
				{ value: 'txt_txt', label: 'Text (.txt)' },
				{ value: 'jsonl_jsonl', label: 'JSONL (.jsonl)' },
				{ value: 'librechat_json', label: 'Librechat (.json)' },
				{ value: 'raw_json', label: 'Raw JSON (.json)' }
			], lastFormat);
			formatSelect.style.flex = '1';
			exportContainer.appendChild(formatSelect);

			// Export button
			const exportButton = createClaudeButton('Export', 'primary');
			exportButton.style.minWidth = '80px';
			exportContainer.appendChild(exportButton);

			content.appendChild(exportContainer);

			// Tree option container
			const treeOption = document.createElement('div');
			treeOption.id = 'treeOption';
			treeOption.className = 'mb-4 hidden';

			const { container: toggleContainer, input: treeToggleInput } = createClaudeToggle('Export entire tree', false);
			toggleInput = treeToggleInput;
			treeOption.appendChild(toggleContainer);
			content.appendChild(treeOption);

			// Show/hide tree option based on initial value
			const initialFormat = lastFormat.split('_')[0];
			treeOption.classList.toggle('hidden', !['librechat', 'raw'].includes(initialFormat));

			// Update tree option visibility on select change
			formatSelect.onchange = () => {
				const format = formatSelect.value.split('_')[0];
				treeOption.classList.toggle('hidden', !['librechat', 'raw'].includes(format));
			};

			// Export button handler
			exportButton.onclick = async () => {
				const loadingModal = createLoadingModal('Exporting...');
				loadingModal.show();

				try {
					localStorage.setItem('lastExportFormat', formatSelect.value);

					const parts = formatSelect.value.split("_");
					const format = parts[0];
					const extension = parts[1];
					const exportTree = toggleInput.checked;

					const orgId = getOrgId();
					const conversation = new ClaudeConversation(orgId, conversationId);
					const conversationData = await conversation.getData(exportTree);

					const filename = `Claude_export_${conversationData.name}_${conversationId}.${extension}`;
					const exportContent = await formatExport(conversationData, format, conversationId);

					const blob = new Blob([exportContent], { type: 'text/plain' });
					const url = URL.createObjectURL(blob);
					const link = document.createElement('a');
					link.href = url;
					link.download = filename;
					link.click();
					URL.revokeObjectURL(url);

					loadingModal.destroy();
					modal.hide();
				} catch (error) {
					console.error('Export failed:', error);
					loadingModal.destroy();
					showClaudeAlert('Export Error', error.message || 'Failed to export conversation');
				}
			};

			// Divider
			const divider = document.createElement('hr');
			divider.className = 'my-4 border-border-300';
			content.appendChild(divider);
		}
		//#endregion

		//#region Import section (always shown)
		// Model label
		const modelLabel = document.createElement('label');
		modelLabel.className = CLAUDE_CLASSES.LABEL;
		modelLabel.textContent = 'Imported Conversation Model';
		content.appendChild(modelLabel);

		const importContainer = document.createElement('div');
		importContainer.className = 'mb-2 flex gap-2';

		// Model select
		const modelList = CLAUDE_MODELS;
		const modelSelect = createClaudeSelect(modelList, modelList[0].value);
		modelSelect.style.flex = '1';
		importContainer.appendChild(modelSelect);

		// Import button
		const importButton = createClaudeButton('Import', 'primary');
		importButton.style.minWidth = '80px';
		importContainer.appendChild(importButton);

		content.appendChild(importContainer);

		// Add toggles
		const importFilesToggle = createClaudeToggle('Import files/attachments (txt only)', true);
		importFilesToggle.container.classList.add('mb-2', 'mt-2');
		content.appendChild(importFilesToggle.container);

		const importToolCallsToggle = createClaudeToggle('Import tool calls (txt only)', false);
		importToolCallsToggle.container.classList.add('mb-4');
		content.appendChild(importToolCallsToggle.container);

		// Import note
		const note = document.createElement('p');
		note.className = CLAUDE_CLASSES.TEXT_SM + ' text-text-400';
		note.textContent = 'Imports txt (from this modal) and LibreChat JSON formats.';
		content.appendChild(note);

		// Import button handler
		importButton.onclick = () =>
			handleImport(
				modelSelect.value,
				importFilesToggle.input.checked,
				importToolCallsToggle.input.checked
			);
		//#endregion

		//#region Replace phantom section (only if in conversation)
		if (isInConversation) {
			// Divider
			const divider2 = document.createElement('hr');
			divider2.className = 'my-4 border-border-300';
			content.appendChild(divider2);

			// Replace phantom messages section
			const replaceLabel = document.createElement('label');
			replaceLabel.className = CLAUDE_CLASSES.LABEL;
			replaceLabel.textContent = 'Replace Phantom Messages';
			content.appendChild(replaceLabel);

			const replaceNote = document.createElement('p');
			replaceNote.className = CLAUDE_CLASSES.TEXT_SM + ' text-text-400';
			replaceNote.textContent = `Replaces the "fake" message history for this conversation.`;
			content.appendChild(replaceNote);

			const replaceButton = createClaudeButton('Replace from File', 'secondary');
			replaceButton.className += ' mb-2';
			content.appendChild(replaceButton);
			replaceButton.onclick = () => handleReplacePhantom(replaceButton);

			// Warning note
			const warningNote = document.createElement('p');
			warningNote.className = CLAUDE_CLASSES.TEXT_SM;
			warningNote.style.color = '#de2929';
			warningNote.innerHTML = '⚠️ <strong>Visual change only:</strong> This replaces what you see in the chat history. The AI\'s context (what it can actually read) remains unchanged.';
			warningNote.className += ' mb-3';
			content.appendChild(warningNote);
		}
		//#endregion

		// Create modal with appropriate title
		const modalTitle = isInConversation ? 'Export & Import' : 'Import Conversation';
		const modal = new ClaudeModal(modalTitle, content);

		// Override max width
		modal.modal.style.maxWidth = '28rem';

		modal.show();
	}

	function createExportButton() {
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 16 16">
        <path d="M8 12V2m0 10 5-5m-5 5L3 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
        <path opacity="0.4" d="M2 15h12v-3H2v3Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>`;

		const button = createClaudeButton(svgContent, 'icon');

		button.onclick = showExportImportModal;

		return button;
	}

	function initialize() {
		tryAddTopRightButton("export-button", createExportButton, "Export/Import chat", false, true);
		setInterval(() => tryAddTopRightButton('export-button', createExportButton, "Export/Import chat", false, true), 1000);
	}

	// Wait for dependencies to be available
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();