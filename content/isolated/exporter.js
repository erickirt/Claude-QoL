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

	let bulkExportCancelled = false;

	function makeUniqueFilename(filename, uuid) {
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) return `${filename}-${uuid}`;
		return `${filename.substring(0, lastDot)}-${uuid}${filename.substring(lastDot)}`;
	}

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

	function formatMdExport(conversationData, messages, conversationId, includeThinking = true) {
		let output = `# ${conversationData.name}\n\n`;

		for (const message of messages) {
			const role = message.sender === ROLES.USER.apiName ? 'User' : 'Assistant';
			output += `### ${role}\n\n`;

			for (const content of message.content) {
				if (content.type === 'thinking') {
					if (!includeThinking) continue;
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
				createdAt: msg.created_at,
				text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
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

	function formatRawExport(conversationData, messages, conversationId) {
		// Filter chat_messages to only include messages present in the export set
		const messageUuids = new Set(messages.map(m => m.uuid));
		const filtered = {
			...conversationData,
			chat_messages: conversationData.chat_messages.filter(m => messageUuids.has(m.uuid))
		};
		return JSON.stringify(filtered, null, 2);
	}


	//#region HTML export
	// HTML export stuff
	const EXPORT_SCAFFOLD = `
	<!DOCTYPE html>
	<html lang="en">
	<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>{{TITLE}}</title>
	<style>{{STYLESHEET}}</style>
	</head>
	<body data-default-leaf="{{DEFAULT_LEAF}}">
	{{MESSAGES}}
	<button id="theme-toggle"></button>
	<script id="conversation-tree" type="application/json">{{TREE_JSON}}</script>
	<script id="conversation-raw" type="text/plain">{{RAW_TXT}}</script>
	<script>{{SCRIPT}}</script>
	</body>
	</html>`.replace(/^\t{1}/gm, '').trim();

	let _templateCache = null;

	async function extractFontDataUris() {
		const FONT_KEYS = {
			'anthropicsans/normal': '{{FONT_SANS_NORMAL}}',
			'anthropicsans/italic': '{{FONT_SANS_ITALIC}}',
			'anthropicserif/normal': '{{FONT_SERIF_NORMAL}}',
			'anthropicserif/italic': '{{FONT_SERIF_ITALIC}}',
			'jetbrains/normal': '{{FONT_MONO}}'
		};

		const result = new Map();
		const fontFaceRegex = /@font-face\s*\{[^}]*\}/g;
		const familyRegex = /font-family:\s*["']?([^;"'\n]+)/;
		const styleRegex = /font-style:\s*(\w+)/;
		const urlRegex = /url\(["']?([^"')]+\.woff2)["']?\)/;

		// Gather all stylesheet URLs
		const sheetUrls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
			.map(link => link.href)
			.filter(Boolean);

		for (const sheetUrl of sheetUrls) {
			try {
				const cssText = await fetch(sheetUrl).then(r => r.text());
				const blocks = cssText.match(fontFaceRegex) || [];

				for (const block of blocks) {
					const familyMatch = block.match(familyRegex);
					const styleMatch = block.match(styleRegex);
					const urlMatch = block.match(urlRegex);
					if (!familyMatch || !urlMatch) continue;

					const family = familyMatch[1].trim().toLowerCase();
					const style = (styleMatch && styleMatch[1]) || 'normal';
					const key = family + '/' + style;
					const placeholder = FONT_KEYS[key];
					if (!placeholder || result.has(placeholder)) continue;

					const response = await fetch(urlMatch[1]);
					const blob = await response.blob();
					const dataUri = await new Promise(resolve => {
						const reader = new FileReader();
						reader.onloadend = () => resolve(reader.result);
						reader.readAsDataURL(blob);
					});
					result.set(placeholder, dataUri);
				}
			} catch (e) {
				console.warn('Failed to process stylesheet:', sheetUrl, e);
			}
		}

		return result;
	}

	async function getExportTemplate() {
		if (_templateCache) return _templateCache;

		const base = chrome.runtime.getURL('html_template/');
		const [css, js] = await Promise.all([
			fetch(base + 'export-template.css').then(r => r.text()),
			fetch(base + 'export-template.js').then(r => r.text()),
		]);

		// Embed fonts as data URIs
		const fontMap = await extractFontDataUris();
		let processedCss = css;
		for (const [originalUrl, dataUri] of fontMap) {
			processedCss = processedCss.replaceAll(originalUrl, dataUri);
		}

		_templateCache = EXPORT_SCAFFOLD
			.replace('{{STYLESHEET}}', processedCss)
			.replace('{{SCRIPT}}', js);

		return _templateCache;
	}

	const _escEl = document.createElement('span');
	function esc(str) {
		_escEl.textContent = str;
		return _escEl.innerHTML;
	}

	function safeEmbed(str) {
		return str.replace(/<\//g, '<\\/');
	}

	async function formatHtmlExport(conversationData, messages, conversationId) {
		// Configure marked to use highlight.js for code blocks
		marked.use({
			renderer: {
				code({ text, lang }) {
					let highlighted;
					if (lang && hljs.getLanguage(lang)) {
						highlighted = hljs.highlight(text, { language: lang }).value;
					} else {
						highlighted = hljs.highlightAuto(text).value;
					}
					return `<pre><code class="hljs">${highlighted}</code></pre>`;
				}
			}
		});

		// Extract current branch for the raw txt embed (re-import)
		const messageMap = new Map(messages.map(m => [m.uuid, m]));
		const ROOT = '00000000-0000-4000-8000-000000000000';
		const defaultLeaf = conversationData.current_leaf_message_uuid;
		const linearBranch = [];
		let walkId = defaultLeaf;
		while (walkId && walkId !== ROOT && messageMap.has(walkId)) {
			linearBranch.push(messageMap.get(walkId));
			walkId = messageMap.get(walkId).parent_message_uuid;
		}
		linearBranch.reverse();

		const rawTxt = formatTxtExport(conversationData, linearBranch, conversationId);
		const title = conversationData.name || 'Untitled Conversation';

		// Build tree JSON for navigation
		const treeJson = messages.map(m => ({
			id: m.uuid,
			parent: m.parent_message_uuid,
			sender: m.sender
		}));

		// Render ALL messages as hidden divs
		let messagesHtml = '';
		for (const message of messages) {
			const isUser = message.sender === ROLES.USER.apiName;
			const role = isUser ? 'User' : 'Assistant';
			const roleClass = isUser ? 'msg-user' : 'msg-assistant';

			let contentHtml = '';
			for (const content of message.content) {
				if (content.type === 'thinking') {
					let summaryText = 'Thinking';
					if (content.summaries && content.summaries.length > 0) {
						summaryText = content.summaries[content.summaries.length - 1].summary;
					}
					contentHtml += `<details class="thinking-block"><summary>${esc(summaryText)}</summary><pre class="thinking-content">${esc(content.thinking || '')}</pre></details>`;
				} else if (content.type === 'text') {
					contentHtml += `<div class="text-content">${marked.parse(content.text || '')}</div>`;
				}
			}

			// Download all files for this message in parallel
			const fileResults = await Promise.all(message.files.map(async (file) => {
				if (file instanceof ClaudeAttachment) {
					const b64 = btoa(unescape(encodeURIComponent(file.extracted_content || '')));
					const mimeType = mime.getType(file.file_name) || 'text/plain';
					return `<a class="file-pill" href="data:${mimeType};base64,${b64}" download="${esc(file.file_name)}">File: ${esc(file.file_name)}</a>`;
				}

				try {
					const blob = await file.download();
					if (!blob) return `<span class="file-pill">File: ${esc(file.file_name)}</span>`;

					const dataUri = await new Promise(resolve => {
						const reader = new FileReader();
						reader.onloadend = () => resolve(reader.result);
						reader.readAsDataURL(blob);
					});

					if (file.file_kind === 'image') {
						return `<img src="${dataUri}" alt="${esc(file.file_name)}">`;
					}
					return `<a class="file-pill" href="${dataUri}" download="${esc(file.file_name)}">File: ${esc(file.file_name)}</a>`;
				} catch (e) {
					return `<span class="file-pill">File: ${esc(file.file_name)}</span>`;
				}
			}));

			contentHtml += fileResults.join('');
			messagesHtml += `<div class="msg ${roleClass}" id="msg-${message.uuid}" style="display:none"><div class="msg-header">${role}</div><div class="msg-body">${contentHtml}</div></div>\n`;
		}

		// Assemble from template
		const template = await getExportTemplate();
		const templateResult = template
			.replace('{{TITLE}}', esc(title))
			.replace('{{DEFAULT_LEAF}}', defaultLeaf)
			.replace('{{MESSAGES}}', messagesHtml)
			.replace('{{TREE_JSON}}', safeEmbed(JSON.stringify(treeJson)))
			.replace('{{RAW_TXT}}', safeEmbed(rawTxt));
		// console.log(templateResult);
		return templateResult;
	}
	// #endregion

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

		// Generate the html content (contains raw txt for re-import)
		const htmlContent = await formatHtmlExport(conversationData, messages, conversationId);
		await addToZip(zip, 'conversation.html', htmlContent);

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
			await addToZip(zip, file.name, file.data);
		}

		// Add text attachments (content is inline, no download needed)
		for (const attachment of attachments) {
			const filename = `files/${buildAttachmentZipFilename(attachment.file_name)}`;
			await addToZip(zip, filename, attachment.extracted_content);
		}

		return await zip.generateAsync({ type: 'blob' });
	}
	//#endregion

	async function formatExport(conversationData, messages, format, conversationId, loadingModal, options = {}) {
		switch (format) {
			case 'txt':
				return formatTxtExport(conversationData, messages, conversationId);
			case 'md':
				return formatMdExport(conversationData, messages, conversationId, options.includeThinking);
			case 'jsonl':
				return formatJsonlExport(conversationData, messages, conversationId);
			case 'librechat':
				return formatLibrechatExport(conversationData, messages, conversationId);
			case 'raw':
				return formatRawExport(conversationData, messages, conversationId);
			case 'html':
				return formatHtmlExport(conversationData, messages, conversationId);
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

		// Find and read conversation data (html or legacy txt)
		const htmlFile = zip.file('conversation.html');
		const txtFile = zip.file('conversation.txt');
		let txtContent;
		if (htmlFile) {
			const html = await htmlFile.async('string');
			const match = html.match(/<script id="conversation-raw"[^>]*>([\s\S]*?)<\/script>/);
			if (!match) throw new Error('Invalid zip: conversation.html missing raw data');
			txtContent = match[1].replace(/<\\\//g, '</');
		} else if (txtFile) {
			txtContent = await txtFile.async('string');
		} else {
			throw new Error('Invalid zip: missing conversation.html or conversation.txt');
		}

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
		await storePhantomMessages(conversationId, messages.map(m => m.toHistoryJSON()));
	}

	async function finalizeImport(name, messages, model, zipFiles = null, loadingModal = null, settings = null) {
		const accountFeatureSettings = await promptForSettingsMismatch(settings);

		const conversation = new ClaudeConversation(getOrgId());
		conversation.prepareNew(name, model, null, accountFeatureSettings);

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
		for (const msg of messages) {
			const filesToReplace = msg.files.filter(f => f instanceof ClaudeFile || f instanceof ClaudeCodeExecutionFile);
			for (const f of filesToReplace) {
				msg.removeFile(f);
				const newFile = fileMap.get(f);
				if (newFile) msg.attachFile(newFile);
			}
		}

		// Build chatlog content from messages
		const { text: cleanedContent } = ClaudeConversation.buildChatlog(messages, { includeHeader: true });

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
	function extractEmbeddedAttachments(text) {
		const attachments = [];
		const attachmentPattern = /\n*=====ATTACHMENT_BEGIN: (.+?)=====\n([\s\S]*?)\n=====ATTACHMENT_END=====/g;

		let match;
		while ((match = attachmentPattern.exec(text)) !== null) {
			const fileName = match[1];
			const content = match[2];

			attachments.push({
				file_name: fileName,
				extracted_content: content,
				file_size: content.length,
				file_type: 'text/plain'
			});
		}

		return attachments;
	}

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
			const attachmentsToAdd = [];

			// First, check files array
			if (raw.files && Array.isArray(raw.files) && raw.files.length > 0) {
				for (const file of raw.files) {
					if (file.text) {
						attachmentsToAdd.push({
							extracted_content: file.text,
							file_name: file.name || 'unknown',
							file_size: file.bytes || file.text.length,
							file_type: file.type || 'text/plain'
						});
					}
				}
			} else {
				// If no files in array, check for embedded attachments in text
				const textContent = raw.text || '';
				const embeddedAttachments = extractEmbeddedAttachments(textContent);
				attachmentsToAdd.push(...embeddedAttachments);

				// Also check content array
				if (raw.content && Array.isArray(raw.content)) {
					for (const block of raw.content) {
						if (block.type === 'text' && block.text) {
							const embedded = extractEmbeddedAttachments(block.text);
							attachmentsToAdd.push(...embedded);
						}
					}
				}
			}

			// Add all attachments to message
			for (const attData of attachmentsToAdd) {
				msg.attachFile(parseFileFromAPI(attData, conversation));
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
		fileInput.accept = '.txt,.json,.zip,.html';

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
				await addToZip(zip, 'conversation.txt', fileContent);
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
		fileInput.accept = '.txt,.json,.zip,.html';

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

	async function exportSingleConversation(orgId, conversationId, format, extension, exportTree, exportOptions, loadingModal) {
		const conversation = new ClaudeConversation(orgId, conversationId);
		const conversationData = await conversation.getData();
		const wasCached = conversation.lastGetDataFromCache;
		const messages = await conversation.getMessages(format === 'html' || format === 'zip' || exportTree);
		const safeName = (conversationData.name || 'untitled').replace(/[<>:"/\\|?*]/g, '_');
		const filename = `Claude_export_${safeName}_${conversationId}.${extension}`;
		const exportContent = await formatExport(conversationData, messages, format, conversationId, loadingModal, exportOptions);
		const blob = exportContent instanceof Blob
			? exportContent
			: new Blob([exportContent], { type: 'text/plain' });
		return { filename, blob, wasCached };
	}

	async function handleBulkExport(formatSelectValue, exportOptions, modal, projectId = null, exportTree = false, afterDate = null) {
		bulkExportCancelled = false;

		const loadingModal = createLoadingModal('Fetching conversation list...');
		loadingModal.addCancel('Cancel', () => {
			bulkExportCancelled = true;
		});
		loadingModal.show();

		try {
			localStorage.setItem('lastExportFormat', formatSelectValue);

			const parts = formatSelectValue.split("_");
			const format = parts[0];
			const extension = parts[1];
			const orgId = getOrgId();

			// Fetch conversations (project-scoped or all)
			const apiUrl = projectId
				? `/api/organizations/${orgId}/projects/${projectId}/conversations`
				: `/api/organizations/${orgId}/chat_conversations`;
			const response = await fetch(apiUrl);
			if (!response.ok) throw new Error('Failed to fetch conversations');
			let conversations = await response.json();
			// Keep only the last 10 conversations (THIS IS FOR TESTING - REMOVE IN RELEASE)
			//conversations = conversations.slice(0, 10);

			// Filter by date if specified
			if (afterDate) {
				conversations = conversations.filter(c => new Date(c.updated_at) >= afterDate);
			}

			if (bulkExportCancelled) {
				loadingModal.destroy();
				return;
			}

			if (!conversations.length) {
				loadingModal.destroy();
				showClaudeAlert('Bulk Export', 'No conversations found.');
				return;
			}

			const masterZip = new JSZip();
			let completed = 0;
			const total = conversations.length;
			const delayMs = Math.min(2000, 100 + total);

			// Split into 2 chunks for parallel processing
			const chunk1 = conversations.filter((_, i) => i % 2 === 0);
			const chunk2 = conversations.filter((_, i) => i % 2 === 1);

			async function processChunk(chunk) {
				const results = [];
				for (let i = 0; i < chunk.length; i++) {
					if (bulkExportCancelled) return results;

					const conv = chunk[i];
					try {
						const { filename, blob, wasCached } = await exportSingleConversation(
							orgId, conv.uuid, format, extension, exportTree, exportOptions, loadingModal
						);
						results.push({ filename, blob });

						// Only delay on cache miss (API call) to avoid rate limiting
						if (!wasCached && i < chunk.length - 1) {
							await new Promise(resolve => setTimeout(resolve, delayMs));
						}
					} catch (error) {
						console.error(`Failed to export conversation ${conv.uuid}:`, error);
					}

					completed++;
					loadingModal.setContent(createLoadingContent(`Exporting ${completed} of ${total} conversations...`));
				}
				return results;
			}

			const [results1, results2] = await Promise.all([
				processChunk(chunk1),
				processChunk(chunk2)
			]);

			// Add to zip sequentially
			const allResults = [...results1, ...results2];
			for (const { filename, blob } of allResults) {
				await addToZip(masterZip, filename, blob);
			}

			// Download project files if exporting a project (skip if cancelled)
			let projectName = 'untitled';
			if (projectId && !bulkExportCancelled) {
				loadingModal.setContent(createLoadingContent('Downloading project files...'));
				const project = new ClaudeProject(orgId, projectId);
				const [projectData, docs, files] = await Promise.all([project.getData(), project.getDocs(), project.getFiles()]);
				projectName = (projectData.name || 'untitled').replace(/[<>:"/\\|?*]/g, '_');

				// Save project instructions if present
				if (projectData.prompt_template && typeof projectData.prompt_template === 'string') {
					await addToZip(masterZip, 'project_instructions.txt', projectData.prompt_template);
				}

				for (const doc of docs) {
					const filename = makeUniqueFilename(doc.file_name, doc.uuid);
					await addToZip(masterZip, `project_files/${filename}`, doc.content);
				}

				for (const file of files) {
					if (bulkExportCancelled) break;

					let downloadUrl;
					if (file.file_kind === 'document' && file.document_asset) {
						downloadUrl = file.document_asset.url;
					} else if (file.file_kind === 'image') {
						downloadUrl = file.preview_url || file.thumbnail_url;
						if (file.preview_asset?.file_variant === 'original') {
							downloadUrl = file.preview_asset.url;
						} else if (file.thumbnail_asset?.file_variant === 'original') {
							downloadUrl = file.thumbnail_asset.url;
						}
					} else {
						downloadUrl = file.preview_url || file.thumbnail_url;
					}

					if (!downloadUrl) continue;

					try {
						const response = await fetch(downloadUrl);
						if (!response.ok) {
							console.error(`Failed to fetch project file ${file.file_name}`);
							continue;
						}
						const blob = await response.blob();
						const filename = makeUniqueFilename(file.file_name, file.file_uuid);

						await addToZip(masterZip, `project_files/${filename}`, blob);
					} catch (error) {
						console.error(`Error downloading project file ${file.file_name}:`, error);
					}
				}
			}

			// Always proceed to zip generation if there are results
			if (allResults.length === 0) {
				loadingModal.destroy();
				return;
			}

			loadingModal.setContent(createLoadingContent(bulkExportCancelled ? 'Generating partial zip file...' : 'Generating zip file...'));
			const masterBlob = await masterZip.generateAsync({ type: 'blob' });

			const url = URL.createObjectURL(masterBlob);
			const link = document.createElement('a');
			link.href = url;
			if (projectId) {
				link.download = `Claude_project_export_${projectName}_${projectId}.zip`;
			} else {
				link.download = `Claude_bulk_export_${new Date().toISOString().slice(0, 10)}.zip`;
			}
			link.click();
			URL.revokeObjectURL(url);

			loadingModal.destroy();
			modal.hide();
		} catch (error) {
			console.error('Bulk export failed:', error);
			loadingModal.destroy();
			if (!bulkExportCancelled) {
				showClaudeAlert('Export Error', error.message || 'Failed to bulk export conversations');
			}
		}
	}

	async function showExportImportModal() {
		const conversationId = getConversationId();
		const projectId = getProjectId();
		const isInConversation = Boolean(conversationId);
		const isOnProjectPage = Boolean(projectId);

		// Get last used format from localStorage (default to zip for full fidelity)
		const lastFormat = localStorage.getItem('lastExportFormat') || 'html_html';

		// Build the modal content
		const content = document.createElement('div');

		// Variables to hold references (may not be created)
		let formatSelect, toggleInput, thinkingToggleInput, dateInput;

		//#region Export section (always shown, context-aware)
		{
			// Format label
			const formatLabel = document.createElement('label');
			formatLabel.className = CLAUDE_CLASSES.LABEL;
			formatLabel.textContent = 'Export Format';
			content.appendChild(formatLabel);

			const exportContainer = document.createElement('div');
			exportContainer.className = 'mb-4 flex gap-2';

			// Format select
			formatSelect = createClaudeSelect([
				{ value: 'html_html', label: 'HTML (.html)' },
				{ value: 'zip_zip', label: 'Zip (.zip)' },
				{ value: 'txt_txt', label: 'Text (.txt)' },
				{ value: 'md_md', label: 'Markdown (.md)' },
				{ value: 'jsonl_jsonl', label: 'JSONL (.jsonl)' },
				{ value: 'librechat_json', label: 'Librechat (.json)' },
				{ value: 'raw_json', label: 'Raw JSON (.json)' }
			], lastFormat);
			formatSelect.style.flex = '1';
			exportContainer.appendChild(formatSelect);

			// Export button - label depends on context
			const exportLabel = isInConversation ? 'Export' : (isOnProjectPage ? 'Export Project' : 'Export All');
			const exportButton = createClaudeButton(exportLabel, 'primary');
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

			// Thinking option container (for markdown export)
			const thinkingOption = document.createElement('div');
			thinkingOption.id = 'thinkingOption';
			thinkingOption.className = 'mb-4 hidden';

			const { container: thinkingToggleContainer, input: thinkingInput } = createClaudeToggle('Include thinking', false);
			thinkingToggleInput = thinkingInput;
			thinkingOption.appendChild(thinkingToggleContainer);
			content.appendChild(thinkingOption);

			// Date filter option (bulk export only)
			const dateOption = document.createElement('div');
			dateOption.className = 'mb-4' + (isInConversation ? ' hidden' : '');

			const dateLabel = document.createElement('label');
			dateLabel.className = CLAUDE_CLASSES.LABEL;
			dateLabel.textContent = 'Export conversations updated after:';
			dateOption.appendChild(dateLabel);

			dateInput = createClaudeInput({ type: 'date' });
			dateOption.appendChild(dateInput);
			content.appendChild(dateOption);

			// Show/hide options based on initial value
			const initialFormat = lastFormat.split('_')[0];
			treeOption.classList.toggle('hidden', !['librechat', 'raw'].includes(initialFormat));
			thinkingOption.classList.toggle('hidden', initialFormat !== 'md');

			// Update option visibility on select change
			formatSelect.onchange = () => {
				const format = formatSelect.value.split('_')[0];
				treeOption.classList.toggle('hidden', !['librechat', 'raw'].includes(format));
				thinkingOption.classList.toggle('hidden', format !== 'md');
			};

			// Export button handler
			exportButton.onclick = async () => {
				const exportOptions = {
					includeThinking: thinkingToggleInput?.checked ?? true
				};

				if (isInConversation) {
					// Single conversation export
					const loadingModal = createLoadingModal('Exporting...');
					loadingModal.show();

					try {
						localStorage.setItem('lastExportFormat', formatSelect.value);

						const parts = formatSelect.value.split("_");
						const format = parts[0];
						const extension = parts[1];
						const exportTree = toggleInput.checked;
						const orgId = getOrgId();

						const { filename, blob } = await exportSingleConversation(
							orgId, conversationId, format, extension, exportTree, exportOptions, loadingModal
						);

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
				} else {
					// Bulk export (all conversations or project-scoped)
					const afterDate = dateInput?.value ? new Date(dateInput.value) : null;
					await handleBulkExport(formatSelect.value, exportOptions, modal, projectId, toggleInput.checked, afterDate);
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
		note.textContent = 'Imports zip (from this modal) and LibreChat JSON.';
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
		const modalTitle = 'Export & Import';
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
		ButtonBar.register({
			buttonClass: 'export-button',
			createFn: createExportButton,
			tooltip: 'Export/Import chat',
			pages: ['chat', 'home', 'project'],
		});
	}

	// Wait for dependencies to be available
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();