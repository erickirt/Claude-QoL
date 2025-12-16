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
	function formatTxtExport(conversationData, messages, conversationId) {
		let output = `Settings: ${JSON.stringify(conversationData.settings || {})}\n`;
		output += `Title: ${conversationData.name}\nDate: ${conversationData.updated_at}\n\n`;

		for (const message of messages) {
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

			// Files - split into files_v2 (ClaudeFile/ClaudeCodeExecutionFile) and attachments (ClaudeAttachment)
			const files_v2 = message.files
				.filter(f => !(f instanceof ClaudeAttachment))
				.map(f => f.toApiFormat());
			const attachments = message.files
				.filter(f => f instanceof ClaudeAttachment)
				.map(f => f.toApiFormat());

			if (files_v2.length > 0) {
				output += `[${EXPORT_TAG_PREFIX}files_v2]\n${JSON.stringify(files_v2)}\n\n`;
			}

			if (attachments.length > 0) {
				output += `[${EXPORT_TAG_PREFIX}attachments]\n${JSON.stringify(attachments)}\n\n`;
			}
		}

		return output;
	}

	function formatMdExport(conversationData, messages, conversationId) {
		let output = `# ${conversationData.name}\n\n`;

		for (const message of messages) {
			const role = message.sender === ROLES.USER.apiName ? 'User' : 'Assistant';
			output += `### ${role}\n\n`;

			for (const content of message.content) {
				if (content.type === 'thinking') {
					// Use last summary if available, fallback to "Thinking"
					let summaryText = 'Thinking';
					if (content.summaries && content.summaries.length > 0) {
						summaryText = content.summaries[content.summaries.length - 1].summary;
					}
					output += `<details>\n<summary>${summaryText}</summary>\n\n${content.thinking}\n\n</details>\n\n<br>\n\n`;
				} else if (content.type === 'text') {
					output += `${content.text}\n\n`;
				}
				// Skip all other content types (tool_use, tool_result, etc.)
			}

			output += `---\n\n`;
		}

		return output;
	}

	function formatJsonlExport(conversationData, messages, conversationId) {
		// Simple JSONL - just role and text
		return messages.map(msg => {
			return JSON.stringify({
				role: msg.sender === ROLES.USER.apiName ? ROLES.USER.jsonlName : ROLES.ASSISTANT.jsonlName,
				content: ClaudeConversation.extractMessageText(msg)
			});
		}).join('\n');
	}

	function formatLibrechatExport(conversationData, messages, conversationId) {
		const processedMessages = messages.map((msg) => {
			// Convert attachments to LibreChat file format
			const files = [];
			let attachmentText = '';

			// Get attachments from message.files (filter for ClaudeAttachment instances)
			const attachments = msg.files.filter(f => f instanceof ClaudeAttachment);
			for (const attachment of attachments) {
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
				if (text) {
					attachmentText += `\n=====ATTACHMENT_BEGIN: ${attachment.file_name || 'unknown'}=====\n`;
					attachmentText += text;
					attachmentText += `\n=====ATTACHMENT_END=====\n\n`;
				}
			}

			// Build content array with only think and text types
			const content = [];

			for (const item of msg.content) {
				if (item.type === 'thinking') {
					content.push({
						type: 'think',
						think: item.thinking || ''
					});
				} else if (item.type === 'text') {
					content.push({
						type: 'text',
						text: item.text || ''
					});
				}
				// Skip all other types (tool_use, tool_result, etc.)
			}

			// Prepend attachment text to first text block (for user messages)
			if (attachmentText) {
				const firstTextIndex = content.findIndex(c => c.type === 'text');
				if (firstTextIndex !== -1) {
					content[firstTextIndex].text = attachmentText + content[firstTextIndex].text;
				} else {
					// No text block found, create one at the start
					content.unshift({ type: 'text', text: attachmentText.trim() });
				}
			}

			const message = {
				messageId: msg.uuid,
				parentMessageId: msg.parent_message_uuid === "00000000-0000-4000-8000-000000000000"
					? null
					: msg.parent_message_uuid,
				content: content,
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

	function buildZipFilename(uuid, filename) {
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) {
			return `${filename}-${uuid}`;
		}
		const name = filename.substring(0, lastDot);
		const ext = filename.substring(lastDot);
		return `${name}-${uuid}${ext}`;
	}

	function buildAttachmentZipFilename(filename) {
		const uuid = crypto.randomUUID();
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) {
			return `${filename}-${uuid}_NOEXTRACT`;
		}
		const name = filename.substring(0, lastDot);
		const ext = filename.substring(lastDot);
		return `${name}-${uuid}_NOEXTRACT${ext}`;
	}

	async function formatZipExport(conversationData, messages, conversationId, loadingModal) {
		const zip = new JSZip();

		// Generate the txt content
		const txtContent = formatTxtExport(conversationData, messages, conversationId);
		zip.file('conversation.txt', txtContent);

		// Collect all downloadable files (ClaudeFile and ClaudeCodeExecutionFile)
		const allFiles = messages.flatMap(msg =>
			msg.files.filter(f =>
				(f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile) &&
				f.getDownloadUrl()
			)
		);

		// Collect text attachments (ClaudeAttachment - content is inline, no download needed)
		const attachments = messages.flatMap(msg =>
			msg.files.filter(f => f instanceof ClaudeAttachment)
		);

		// Phase 1: Download all files first
		const filesToZipUp = [];
		for (let i = 0; i < allFiles.length; i++) {
			const file = allFiles[i];

			if (loadingModal) {
				loadingModal.setContent(createLoadingContent(`Downloading file ${i + 1}/${allFiles.length}: ${file.file_name}`));
			}

			try {
				const blob = await file.download();
				if (!blob) {
					console.log(`No download URL for ${file.file_name}, skipping`);
					continue;
				}
				const base64 = await new Promise((resolve) => {
					const reader = new FileReader();
					reader.onloadend = () => resolve(reader.result.split(',')[1]);
					reader.readAsDataURL(blob);
				});
				filesToZipUp.push({
					name: `files/${buildZipFilename(file.file_uuid, file.file_name)}`,
					data: base64
				});
			} catch (error) {
				console.log(`Failed to download ${file.file_name}:`, error);
			}
		}

		// Phase 2: Add all files to zip
		if (loadingModal) {
			loadingModal.setContent(createLoadingContent('Creating zip file...'));
		}

		for (const file of filesToZipUp) {
			zip.file(file.name, file.data, { base64: true });
		}

		// Add text attachments (content is inline, no download needed)
		for (const attachment of attachments) {
			const filename = `files/${buildAttachmentZipFilename(attachment.file_name)}`;
			zip.file(filename, attachment.extracted_content);
		}

		return await zip.generateAsync({ type: 'blob' });
	}
	//#endregion

	async function formatExport(conversationData, messages, format, conversationId, loadingModal) {
		switch (format) {
			case 'txt':
				return formatTxtExport(conversationData, messages, conversationId);
			case 'md':
				return formatMdExport(conversationData, messages, conversationId);
			case 'jsonl':
				return formatJsonlExport(conversationData, messages, conversationId);
			case 'librechat':
				return formatLibrechatExport(conversationData, messages, conversationId);
			case 'raw':
				return formatRawExport(conversationData, conversationId);
			case 'zip':
				return formatZipExport(conversationData, messages, conversationId, loadingModal);
			default:
				throw new Error(`Unsupported format: ${format}`);
		}
	}

	//#region Import functionality
	async function promptForFile(fileName) {
		return new Promise((resolve) => {
			const content = document.createElement('div');
			const text = document.createElement('p');
			text.className = CLAUDE_CLASSES.TEXT;
			text.textContent = `Failed to get "${fileName}" from zip. Please select it from your computer:`;
			content.appendChild(text);

			const modal = new ClaudeModal('File Missing', content, false);

			modal.addCancel('Skip File', () => {
				resolve(null);
			});

			modal.addConfirm('Select File', async () => {
				const fileInput = document.createElement('input');
				fileInput.type = 'file';

				const file = await new Promise(res => {
					fileInput.onchange = e => res(e.target.files[0]);
					fileInput.click();
				});

				if (file) {
					resolve(file);
				} else {
					resolve(null);
				}
			});

			modal.show();
		});
	}

	function parseAndValidateText(text) {
		const warnings = [];

		// Parse header
		const settingsMatch = text.match(/^Settings: (.+)/m);
		let settings = null;
		if (settingsMatch) {
			try {
				settings = JSON.parse(settingsMatch[1]);
			} catch (e) {
				warnings.push('Failed to parse settings from export header');
			}
		}

		const titleMatch = text.match(/^Title: (.+)/m);
		const title = titleMatch ? titleMatch[1].trim() : 'Imported Conversation';

		// Remove header
		const contentStart = text.search(/\n\[(.+)\]\n/);
		if (contentStart === -1) {
			throw new Error('No messages found in file');
		}

		const lines = text.slice(contentStart).split('\n');

		// First pass: parse into raw message data
		const rawMessages = [];
		let currentRaw = null;
		let currentTag = null;
		let textBuffer = '';

		function flushTextBuffer() {
			if (!textBuffer || !currentTag) return;
			if (currentTag.startsWith('content-')) {
				// Content block
				const contentType = currentTag.substring(8); // Remove "content-" prefix

				if (contentType === 'text') {
					currentRaw.content.push({
						type: 'text',
						text: textBuffer.trim()
					});
				} else {
					// Parse as JSON
					try {
						const jsonData = JSON.parse(textBuffer.trim());
						if (!jsonData.type) jsonData.type = contentType;
						currentRaw.content.push(jsonData);
					} catch (error) {
						warnings.push(`Failed to parse [content-${contentType}] block: ${error.message}`);
					}
				}
			} else {
				// Message property (files_v2, attachments)
				try {
					const jsonData = JSON.parse(textBuffer.trim());
					currentRaw[currentTag] = jsonData;
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
					if (currentRaw && currentRaw.sender === role) {
						throw new Error(`Consecutive [${marker}] blocks not allowed`);
					}

					// Push previous message
					if (currentRaw) rawMessages.push(currentRaw);

					// Start new raw message
					currentRaw = {
						sender: role,
						content: [],
						files_v2: [],
						attachments: [],
						created_at: timestampStr ? new Date(parseInt(timestampStr)).toISOString() : null
					};

					currentTag = null;
				} else {
					// Content or property tag
					if (!currentRaw) {
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
		if (currentRaw) rawMessages.push(currentRaw);

		// Validation
		if (rawMessages.length === 0) {
			throw new Error('No messages found in file');
		}
		if (rawMessages[0].sender !== ROLES.USER.apiName) {
			throw new Error(`Conversation must start with a ${ROLES.USER.exportDelimiter} message`);
		}

		// Convert to ClaudeMessage instances
		const conversation = new ClaudeConversation(getOrgId(), null);
		const messages = rawMessages.map(raw => {
			const msg = new ClaudeMessage(conversation);
			msg.sender = raw.sender;
			msg.content = raw.content;
			msg.created_at = raw.created_at;

			// Parse files_v2 into file instances
			for (const f of raw.files_v2 || []) {
				msg.attachFile(parseFileFromAPI(f, conversation));
			}

			// Parse attachments
			for (const a of raw.attachments || []) {
				msg.attachFile(parseFileFromAPI(a, conversation));
			}

			return msg;
		});

		return { name: title, messages, warnings, settings };
	}

	async function parseZipImport(fileOrZip, loadingModal, includeFiles) {
		let zip;

		// Check if already a JSZip instance (has .file method) or needs loading
		if (fileOrZip.file && typeof fileOrZip.file === 'function') {
			zip = fileOrZip;
		} else {
			// It's a File - load it
			if (loadingModal) {
				loadingModal.setContent(createLoadingContent('Reading zip file...'));
			}

			const base64 = await new Promise((resolve) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result.split(',')[1]);
				reader.readAsDataURL(fileOrZip);
			});

			zip = await JSZip.loadAsync(base64, { base64: true });
		}

		// Find and read the txt file
		const txtFile = zip.file('conversation.txt');
		if (!txtFile) {
			throw new Error('Invalid zip: missing conversation.txt');
		}

		const txtContent = await txtFile.async('string');
		const parsedData = parseAndValidateText(txtContent);

		// Extract files from zip if requested
		const zipFiles = [];
		if (includeFiles) {
			// Build a map of available files in the zip (uuid -> zipEntry)
			const filesInZip = new Map();
			zip.folder('files').forEach((relativePath, zipEntry) => {
				// Skip files marked as no-extract (text attachments for archival only)
				if (relativePath.includes('_NOEXTRACT')) {
					return;
				}

				// UUID is 36 chars, positioned before extension (format: {name}-{uuid}.{ext})
				const lastDot = relativePath.lastIndexOf('.');
				const baseName = lastDot === -1 ? relativePath : relativePath.substring(0, lastDot);

				// UUID is last 36 characters, preceded by a dash
				if (baseName.length > 37 && baseName[baseName.length - 37] === '-') {
					const uuid = baseName.substring(baseName.length - 36);
					filesInZip.set(uuid, zipEntry);
				}
			});

			// Get all downloadable files from messages (keep actual file objects for direct mapping)
			const allFiles = parsedData.messages.flatMap(msg =>
				msg.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile)
			);

			for (let i = 0; i < allFiles.length; i++) {
				const originalFile = allFiles[i];
				const zipEntry = filesInZip.get(originalFile.file_uuid);

				if (loadingModal) {
					loadingModal.setContent(createLoadingContent(`Extracting file ${i + 1}/${allFiles.length}: ${originalFile.file_name}`));
				}

				if (zipEntry) {
					const blob = await zipEntry.async('blob');
					zipFiles.push({ originalFile, blob });
				} else {
					// File not in zip - prompt user
					const userBlob = await promptForFile(originalFile.file_name);
					if (userBlob) {
						zipFiles.push({ originalFile, blob: userBlob });
					}
					// If skipped, file just won't be in zipFiles
				}
			}
		}

		return {
			...parsedData,
			zipFiles
		};
	}

	function convertToPhantomMessages(messages) {
		// Takes ClaudeMessage[], sets UUIDs and parent links, returns same instances
		let parentId = "00000000-0000-4000-8000-000000000000";

		for (const message of messages) {
			const timestamp = message.created_at || new Date().toISOString();

			message.uuid = crypto.randomUUID();
			message.parent_message_uuid = parentId;

			// Ensure timestamps on content items
			for (const contentItem of message.content) {
				if (!contentItem.start_timestamp) contentItem.start_timestamp = timestamp;
				if (!contentItem.stop_timestamp) contentItem.stop_timestamp = timestamp;
				if (!contentItem.citations) contentItem.citations = [];
			}

			if (!message.created_at) message.created_at = timestamp;

			parentId = message.uuid;
		}

		return messages;
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

	async function finalizeImport(name, messages, model, zipFiles = null, loadingModal = null, settings = null) {
		// Create the conversation first (needed for correct file upload routing)
		let conversation = new ClaudeConversation(getOrgId());
		await conversation.create(name, model);

		// Ensure settings match source (defaults to OFF for old exports without settings)
		const { conversation: conv, restoreSettings } = await ensureSettingsState(conversation, settings);
		conversation = conv;

		// Build import message tied to real conversation
		const importMessage = new ClaudeMessage(conversation);
		importMessage.text = "This conversation is imported from the attached chatlog.txt\nSimply say 'Acknowledged' and wait for user input.";
		importMessage.sender = 'human';
		if (model) importMessage.model = model;

		const fileMap = new Map(); // originalFile -> newFile
		// Upload zip files and remap references in phantom messages
		if (zipFiles && zipFiles.length > 0) {
			for (let i = 0; i < zipFiles.length; i++) {
				const { originalFile, blob } = zipFiles[i];

				if (loadingModal) {
					loadingModal.setContent(createLoadingContent(`Uploading file ${i + 1}/${zipFiles.length}: ${originalFile.file_name}`));
				}

				const newFile = await importMessage.addFile(blob, originalFile.file_name);
				fileMap.set(originalFile, newFile);
			}
		}
		// Replace file references in messages (for phantom storage)
		// Only replace ClaudeFile/ClaudeCodeExecutionFile - ClaudeAttachment is handled separately
		for (const msg of tmessages) {
			const filesToReplace = msg.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile);
			for (const f of filesToReplace) {
				msg.removeFile(f);
				const newFile = fileMap.get(f);
				if (newFile) msg.attachFile(newFile);
			}
		}

		// Build chatlog content from messages
		const cleanedContent = messages
			.map(msg => msg.toChatlogString())
			.join('\n\n');

		// Remove ClaudeAttachments from importMessage - they're inline in chatlog
		for (const f of [...importMessage.files]) {
			if (f instanceof ClaudeAttachment) {
				importMessage.removeFile(f);
			}
		}

		// Add chatlog (conversation metadata - force inline)
		await importMessage.addFile(cleanedContent, "chatlog.txt", true);

		if (loadingModal) {
			loadingModal.setContent(createLoadingContent('Sending import message...'));
		}

		// Send initial message
		await conversation.sendMessageAndWaitForResponse(importMessage);
		await restoreSettings();

		// Convert and store phantom messages
		const phantomMessages = convertToPhantomMessages(messages);
		await storePhantomMessagesAndWait(conversation.conversationId, phantomMessages);

		// Navigate to new conversation
		window.location.href = `/chat/${conversation.conversationId}`;
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
	//#region Raw JSON import
	function parseRawClaudeJson(jsonText) {
		const data = JSON.parse(jsonText);
		const warnings = [];

		if (!data.chat_messages || !Array.isArray(data.chat_messages)) {
			throw new Error('Invalid Claude JSON format: missing chat_messages array');
		}

		if (!data.current_leaf_message_uuid) {
			throw new Error('Invalid Claude JSON format: missing current_leaf_message_uuid');
		}

		// Build lookup map
		const messageMap = new Map();
		for (const msg of data.chat_messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Walk backward from leaf to root
		const branch = [];
		let current = messageMap.get(data.current_leaf_message_uuid);

		while (current) {
			branch.unshift(current);

			const parentId = current.parent_message_uuid;
			if (!parentId || parentId === '00000000-0000-4000-8000-000000000000') {
				break;
			}

			current = messageMap.get(parentId);
		}

		if (branch.length === 0) {
			throw new Error('Could not reconstruct message branch');
		}

		// Check for branches
		const parentCounts = new Map();
		for (const msg of data.chat_messages) {
			const parentId = msg.parent_message_uuid || 'root';
			parentCounts.set(parentId, (parentCounts.get(parentId) || 0) + 1);
		}
		const hasBranches = Array.from(parentCounts.values()).some(count => count > 1);

		if (hasBranches) {
			warnings.push('Multiple branches detected. Importing the current active branch.');
		}

		// Convert to ClaudeMessage instances
		const conversation = new ClaudeConversation(getOrgId(), null);
		const messages = branch.map(raw => {
			const msg = new ClaudeMessage(conversation);
			msg.sender = raw.sender;
			msg.content = raw.content || [];
			msg.created_at = raw.created_at;

			// Parse files_v2 into file instances
			for (const f of raw.files_v2 || []) {
				msg.attachFile(parseFileFromAPI(f, conversation));
			}

			// Parse attachments
			for (const a of raw.attachments || []) {
				msg.attachFile(parseFileFromAPI(a, conversation));
			}

			return msg;
		});

		return {
			name: data.name || 'Imported Conversation',
			messages,
			warnings
		};
	}
	//#endregion

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

		let rawMessages;

		if (data.recursive) {
			// Recursive format - nested children
			rawMessages = flattenRecursiveTree(data.messages);
		} else {
			// Sequential format - flat with parentMessageId
			rawMessages = extractLinearBranch(data.messages);
		}

		if (rawMessages.length === 0) {
			throw new Error('No messages found in file');
		}

		// Create conversation for ClaudeMessage instances
		const conversation = new ClaudeConversation(getOrgId(), null);

		// Convert to ClaudeMessage instances
		const messages = rawMessages.map(raw => {
			const msg = new ClaudeMessage(conversation);
			msg.sender = raw.isCreatedByUser ? ROLES.USER.apiName : ROLES.ASSISTANT.apiName;
			msg.content = extractLibrechatContent(raw);
			msg.created_at = raw.createdAt;

			// Convert files to attachments (text-based files only)
			if (raw.files && Array.isArray(raw.files)) {
				for (const file of raw.files) {
					if (file.text) {
						// Transform LibreChat format to attachment API format
						const attData = {
							extracted_content: file.text,
							file_name: file.name || 'unknown',
							file_size: file.bytes || file.text.length,
							file_type: file.type || 'text/plain'
						};
						msg.attachFile(parseFileFromAPI(attData, conversation));
					}
				}
			}

			return msg;
		});

		// Ensure conversation starts with user message
		if (messages.length > 0 && messages[0].sender !== ROLES.USER.apiName) {
			warnings.push('Conversation did not start with a user message. A placeholder was added.');
			const placeholder = new ClaudeMessage(conversation);
			placeholder.sender = ROLES.USER.apiName;
			placeholder.content = [{ type: 'text', text: '[Conversation imported from LibreChat]' }];
			placeholder.created_at = messages[0].created_at;
			messages.unshift(placeholder);
		}

		return {
			name: data.title || 'Imported Conversation',
			messages,
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

		// Last message in array -> walk backward to root
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
		fileInput.accept = '.txt,.json,.zip';

		const file = await new Promise(resolve => {
			fileInput.onchange = e => resolve(e.target.files[0]);
			fileInput.click();
		});

		if (!file) return;

		// Show loading modal
		const loadingModal = createLoadingModal('Importing...');
		loadingModal.show();

		// Parse and validate
		const fileContent = await file.text();
		let parsedData;

		try {
			if (file.name.endsWith('.zip')) {
				// Zip import - includes files
				parsedData = await parseZipImport(file, loadingModal, includeFiles);
			} else if (file.name.endsWith('.txt')) {
				// TXT import - wrap in virtual zip for unified handling
				const zip = new JSZip();
				zip.file('conversation.txt', fileContent);
				parsedData = await parseZipImport(zip, loadingModal, false); // No files in TXT
			} else if (file.name.endsWith('.json')) {
				const jsonData = JSON.parse(fileContent);

				if (jsonData.chat_messages && jsonData.current_leaf_message_uuid) {
					// Raw Claude JSON
					parsedData = parseRawClaudeJson(fileContent);
				} else if (jsonData.messages) {
					// LibreChat JSON
					parsedData = parseLibrechatJson(fileContent);
				} else {
					throw new Error('Unrecognized JSON format');
				}
			} else {
				throw new Error('Unsupported file type');
			}
		} catch (error) {
			// Show error
			showClaudeAlert('Import Error', error.message);
			loadingModal.destroy();
			return;
		}

		let { messages, warnings, name, zipFiles, settings } = parsedData;

		// Filter based on toggles using ClaudeMessage methods
		if (!includeFiles) {
			for (const msg of messages) {
				msg.clearFiles();
			}
			zipFiles = null;
		}

		if (!includeToolCalls) {
			for (const msg of messages) {
				msg.removeToolCalls();
			}
		}

		// Remove token_budget content items
		for (const msg of messages) {
			msg.content = msg.content.filter(item => item.type !== 'token_budget');
		}

		// Show warnings modal if needed
		if (warnings.length > 0) {
			const proceed = await showWarningsModal(warnings);
			if (!proceed) {
				loadingModal.destroy();
				return;
			}
		}

		console.log('Parsed import data:', { name, messages, zipFiles });
		try {
			await finalizeImport(name, messages, model, zipFiles, loadingModal, settings);
			// Navigation happens in finalizeImport, loading modal cleaned up automatically
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
		fileInput.accept = '.txt,.json,.zip';

		const file = await new Promise(resolve => {
			fileInput.onchange = e => resolve(e.target.files[0]);
			fileInput.click();
		});

		if (!file) return;

		// Show loading modal
		const loadingModal = createLoadingModal('Replacing phantom messages...');
		loadingModal.show();

		// Parse and validate
		let parsedData;

		try {
			if (file.name.endsWith('.zip')) {
				parsedData = await parseZipImport(file, loadingModal, false);
			} else if (file.name.endsWith('.json')) {
				const fileContent = await file.text();
				parsedData = parseLibrechatJson(fileContent);
			} else {
				const fileContent = await file.text();
				parsedData = parseAndValidateText(fileContent);
			}
		} catch (error) {
			showClaudeAlert('Replace Error', error.message || 'Invalid format');
			loadingModal.destroy();
			return;
		}

		// Show warnings modal if needed
		if (parsedData.warnings.length > 0) {
			const proceed = await showWarningsModal(parsedData.warnings);
			if (!proceed) {
				loadingModal.destroy();
				return;
			}
		}

		try {
			// Convert and store phantom messages (parsedData.messages is ClaudeMessage[])
			const phantomMessages = convertToPhantomMessages(parsedData.messages);
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

		// Get last used format from localStorage (default to zip for full fidelity)
		const lastFormat = localStorage.getItem('lastExportFormat') || 'zip_zip';

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

			// Format select (TXT is internal only, used inside ZIP)
			formatSelect = createClaudeSelect([
				{ value: 'zip_zip', label: 'Zip (.zip)' },
				{ value: 'md_md', label: 'Markdown (.md)' },
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
					const messages = await conversation.getMessages(exportTree);

					const filename = `Claude_export_${conversationData.name}_${conversationId}.${extension}`;
					const exportContent = await formatExport(conversationData, messages, format, conversationId, loadingModal);

					// Handle blob vs string content
					const blob = exportContent instanceof Blob
						? exportContent
						: new Blob([exportContent], { type: 'text/plain' });

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
		const importFilesToggle = createClaudeToggle('Import files/attachments', true);
		importFilesToggle.container.classList.add('mb-2', 'mt-2');
		content.appendChild(importFilesToggle.container);

		const importToolCallsToggle = createClaudeToggle('Import tool calls', false);
		importToolCallsToggle.container.classList.add('mb-4');
		content.appendChild(importToolCallsToggle.container);

		// Import note
		const note = document.createElement('p');
		note.className = CLAUDE_CLASSES.TEXT_SM + ' text-text-400';
		note.textContent = 'Imports txt/zip/JSON (from this modal) and LibreChat JSON.';
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