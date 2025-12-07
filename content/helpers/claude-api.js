// claude_api.js

class ClaudeConversation {
	constructor(orgId, conversationId = null) {
		this.orgId = orgId;
		this.conversationId = conversationId;
		this.created = conversationId ? true : false;
	}

	// Create a new conversation
	async create(name, model = null, projectUuid = null, paprikaMode = false) {
		if (this.conversationId) {
			throw new Error('Conversation already exists');
		}

		this.conversationId = this.generateUuid();
		const bodyJSON = {
			uuid: this.conversationId,
			name: name,
			include_conversation_preferences: true,
			project_uuid: projectUuid,
		};

		if (model) bodyJSON.model = model;
		if (paprikaMode) bodyJSON.paprika_mode = "extended";

		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(bodyJSON)
		});

		if (!response.ok) {
			throw new Error('Failed to create conversation');
		}

		this.created = true;
		return this.conversationId;
	}

	// Send a message and wait for response
	async sendMessageAndWaitForResponse(prompt, options = {}) {
		const {
			model = null,
			parentMessageUuid = '00000000-0000-4000-8000-000000000000',
			attachments = [],
			files = [],
			syncSources = [],
			personalizedStyles = null
		} = options;

		const requestBody = {
			prompt,
			parent_message_uuid: parentMessageUuid,
			attachments,
			files,
			sync_sources: syncSources,
			personalized_styles: personalizedStyles,
			rendering_mode: "messages"
		};

		if (model !== null) {
			requestBody.model = model;
		}

		// Log time BEFORE sending request
		const requestSentTime = new Date().toISOString();

		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}/completion`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody)
		});

		if (!response.ok) {
			console.error(await response.json());
			throw new Error('Failed to send message');
		}

		// Just consume the stream until it's done
		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) break;

				// Decode and check for completion signal
				const chunk = decoder.decode(value, { stream: true });

				if (chunk.includes('event: message_stop')) {
					break;
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Find assistant message created AFTER our request
		let assistantMessage;
		let attempts = 0;
		let messages;
		const maxAttempts = 30;

		while (!assistantMessage && attempts < maxAttempts) {
			if (attempts > 0) {
				console.log(`Assistant message not found or too old, waiting 3 seconds and retrying (attempt ${attempts}/${maxAttempts})...`);
				await new Promise(r => setTimeout(r, 3000));
			}
			messages = await this.getMessages(false, true);
			assistantMessage = messages.find(msg =>
				msg.sender === 'assistant' &&
				msg.created_at > requestSentTime
			);
			attempts++;
		}

		if (!assistantMessage) {
			console.error('Messages after retry:', messages);
			console.error('Request sent at:', requestSentTime);
			throw new Error('Completion finished but no assistant message found after retry');
		}

		return assistantMessage;
	}

	// Lazy load conversation data
	async getData(tree = false, forceRefresh = false) {
		if (!this.conversationData || forceRefresh || (tree && !this.conversationData.chat_messages)) {
			const response = await fetch(
				`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}?tree=${tree}&rendering_mode=messages&render_all_tools=true&skip_uuid_injection=true`
			);
			if (!response.ok) {
				throw new Error('Failed to get conversation data');
			}
			this.conversationData = await response.json();
		}
		return this.conversationData;
	}

	// Get messages (now uses getData)
	async getMessages(tree = false, forceRefresh = false) {
		const data = await this.getData(tree, forceRefresh);
		return data.chat_messages || [];
	}

	// Find longest leaf from a message ID
	findLongestLeaf(startMessageId) {
		const messageMap = new Map();
		for (const msg of this.conversationData.chat_messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Get all children of the message we're starting from
		const children = Array.from(messageMap.values()).filter(
			msg => msg.parent_message_uuid === startMessageId
		);
		// No children -> it's a leaf, just return
		if (children.length === 0) {
			const message = messageMap.get(startMessageId);
			return {
				leafId: startMessageId,
				depth: 0,
				timestamp: new Date(message.created_at).getTime()
			};
		}

		let longestPath = { leafId: null, depth: -1, timestamp: 0 };
		// For each child, find its longest leaf (recursion)
		for (const child of children) {
			const result = this.findLongestLeaf(child.uuid);
			const totalDepth = result.depth + 1;	//Account for the fact we're looking at the parent of this message
			// If this path is longer than the previous longest, or same length but newer, update
			if (totalDepth > longestPath.depth ||
				(totalDepth === longestPath.depth && result.timestamp > longestPath.timestamp)) {
				longestPath = {
					leafId: result.leafId,
					depth: totalDepth,
					timestamp: result.timestamp
				};
			}
		}

		return longestPath;
	}

	// Navigate to a specific leaf
	async setCurrentLeaf(leafId) {
		const url = `/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}/current_leaf_message_uuid`;

		const response = await fetch(url, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ current_leaf_message_uuid: leafId })
		});

		if (!response.ok) {
			throw new Error('Failed to set current leaf');
		}
	}

	// Delete conversation
	async delete() {
		const response = await fetch(`/api/organizations/${this.orgId}/chat_conversations/${this.conversationId}`, {
			method: 'DELETE'
		});

		if (!response.ok) {
			console.error('Failed to delete conversation');
		}
	}

	// Extract text from message content
	static extractMessageText(message) {
		if (!message.content) return '';

		const textPieces = [];

		function extractFromContent(content) {
			if (content.text) {
				textPieces.push(content.text);
			}
			if (content.input) {
				textPieces.push(JSON.stringify(content.input));
			}
			if (content.content) {
				// Handle nested content array
				if (Array.isArray(content.content)) {
					for (const nestedContent of content.content) {
						extractFromContent(nestedContent);
					}
				}
				// Handle single nested content object
				else if (typeof content.content === 'object') {
					extractFromContent(content.content);
				}
			}
		}

		// Process all content items in the message
		for (const content of message.content) {
			extractFromContent(content);
		}

		return textPieces.join('\n');
	}

	generateUuid() {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
			const r = Math.random() * 16 | 0;
			const v = c === 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}
}

// File type constants
const MIME_TYPES = {
	'png': 'image/png',
	'jpg': 'image/jpeg',
	'jpeg': 'image/jpeg',
	'gif': 'image/gif',
	'webp': 'image/webp',
	'svg': 'image/svg+xml',
	'pdf': 'application/pdf',
};

const DIRECT_UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'];

class ClaudeFile {
	constructor(apiData) {
		this.file_uuid = apiData.file_uuid;
		this.file_name = apiData.file_name;
		this.file_kind = apiData.file_kind; // 'image' | 'document'
		this.preview_asset = apiData.preview_asset || null;
		this.document_asset = apiData.document_asset || null;
		this.thumbnail_asset = apiData.thumbnail_asset || null;
		this.preview_url = apiData.preview_url || null;
		this.thumbnail_url = apiData.thumbnail_url || null;
	}

	getDownloadUrl() {
		// Try preview first (images)
		if (this.preview_asset?.url) {
			return this.preview_asset.url;
		}

		// Try document (PDFs, etc.)
		if (this.document_asset?.url) {
			return this.document_asset.url;
		}

		// Try direct URLs
		if (this.preview_url) {
			return this.preview_url;
		}

		// Last resort: thumbnail
		if (this.thumbnail_asset?.url) {
			return this.thumbnail_asset.url;
		}

		if (this.thumbnail_url) {
			return this.thumbnail_url;
		}

		return null;
	}

	async download() {
		const url = this.getDownloadUrl();
		if (!url) {
			return null;
		}

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to download file ${this.file_name}`);
		}

		return await response.blob();
	}

	async reupload(orgId) {
		const blob = await this.download();
		if (!blob) {
			return null;
		}
		return ClaudeFile.upload(orgId, blob, this.file_name);
	}

	toApiFormat() {
		return {
			file_uuid: this.file_uuid,
			file_name: this.file_name,
			file_kind: this.file_kind,
			preview_asset: this.preview_asset,
			document_asset: this.document_asset,
			thumbnail_asset: this.thumbnail_asset,
			preview_url: this.preview_url,
			thumbnail_url: this.thumbnail_url
		};
	}

	static async upload(orgId, blob, fileName) {
		const ext = fileName.toLowerCase().split('.').pop();

		if (DIRECT_UPLOAD_EXTENSIONS.includes(ext)) {
			// Regular file upload
			const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
			const typedBlob = new Blob([blob], { type: mimeType });

			const formData = new FormData();
			formData.append('file', typedBlob, fileName);

			const response = await fetch(`/api/${orgId}/upload`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error(`Failed to upload file ${fileName}`);
			}

			const data = await response.json();
			return new ClaudeFile(data);
		} else {
			// Document conversion -> returns ClaudeAttachment
			const formData = new FormData();
			formData.append('file', blob, fileName);

			const response = await fetch(`/api/${orgId}/convert_document`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error(`Failed to convert document ${fileName}`);
			}

			const data = await response.json();
			return new ClaudeAttachment(data);
		}
	}

	static fromJSON(json) {
		return new ClaudeFile(json);
	}
}

class ClaudeAttachment {
	constructor({ extracted_content, file_name, file_size, file_type }) {
		this.extracted_content = extracted_content;
		this.file_name = file_name;
		this.file_size = file_size;
		this.file_type = file_type;
	}

	toApiFormat() {
		return {
			extracted_content: this.extracted_content,
			file_name: this.file_name,
			file_size: this.file_size,
			file_type: this.file_type
		};
	}

	static fromText(text, fileName, fileType = 'text/plain') {
		return new ClaudeAttachment({
			extracted_content: text,
			file_name: fileName,
			file_size: text.length,
			file_type: fileType
		});
	}

	static fromJSON(json) {
		return new ClaudeAttachment(json);
	}
}

class DownloadedFile {
	constructor({ originalUuid, blob, fileName }) {
		this.originalUuid = originalUuid;
		this.blob = blob;
		this.fileName = fileName;
	}

	async upload(orgId) {
		return ClaudeFile.upload(orgId, this.blob, this.fileName);
	}
}

class ClaudeProject {
	constructor(orgId, projectId) {
		this.orgId = orgId;
		this.projectId = projectId;
		this.projectData = null;
		this.cachedDocs = null;
		this.cachedFiles = null;
	}

	// Get project data
	async getData(forceRefresh = false) {
		if (!this.projectData || forceRefresh) {
			const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}`);
			if (!response.ok) {
				throw new Error('Failed to fetch project data');
			}
			this.projectData = await response.json();
		}
		return this.projectData;
	}

	// Get syncs
	async getSyncs() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/syncs`);
		if (!response.ok) {
			throw new Error('Failed to fetch project syncs');
		}
		return await response.json();
	}

	// Get docs (attachments) - always fetch, but cache result
	async getDocs() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/docs`);
		if (!response.ok) {
			throw new Error('Failed to fetch project docs');
		}
		this.cachedDocs = await response.json();
		return this.cachedDocs;
	}

	// Get files - always fetch, but cache result
	async getFiles() {
		const response = await fetch(`/api/organizations/${this.orgId}/projects/${this.projectId}/files`);
		if (!response.ok) {
			throw new Error('Failed to fetch project files');
		}
		this.cachedFiles = await response.json();
		return this.cachedFiles;
	}

	// Download attachment (doc) - content is already in the docs response
	async downloadAttachment(docId) {
		// Read from cache if available
		if (!this.cachedDocs) {
			await this.getDocs();
		}

		const doc = this.cachedDocs.find(d => d.uuid === docId);

		if (!doc) {
			throw new Error(`Doc ${docId} not found`);
		}

		// Create blob from content
		const blob = new Blob([doc.content], { type: 'text/plain' });

		// Trigger download
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = doc.file_name;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Download file - needs to determine URL based on file type
	async downloadFile(fileId) {
		// Read from cache if available
		if (!this.cachedFiles) {
			await this.getFiles();
		}

		const file = this.cachedFiles.find(f => f.file_uuid === fileId);

		if (!file) {
			throw new Error(`File ${fileId} not found`);
		}

		let downloadUrl;

		// Determine download URL based on file type
		if (file.file_kind === 'document' && file.document_asset) {
			// PDF or document - use document_asset URL
			downloadUrl = file.document_asset.url;
		} else if (file.file_kind === 'image') {
			// Image - prefer preview_url over thumbnail_url
			downloadUrl = file.preview_url || file.thumbnail_url;

			// Or look for original asset if available
			if (file.preview_asset?.file_variant === 'original') {
				downloadUrl = file.preview_asset.url;
			} else if (file.thumbnail_asset?.file_variant === 'original') {
				downloadUrl = file.thumbnail_asset.url;
			}
		} else {
			// Fallback to preview_url if available
			downloadUrl = file.preview_url || file.thumbnail_url;
		}

		if (!downloadUrl) {
			throw new Error(`No download URL found for file ${fileId}`);
		}

		// Fetch the actual file content
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`Failed to download file ${fileId}`);
		}

		const blob = await response.blob();

		// Trigger download
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = file.file_name;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Download all files and attachments as a zip
	async downloadAll() {

		// Fetch project data and file lists
		const [projectData, docs, files] = await Promise.all([
			this.getData(),
			this.getDocs(),
			this.getFiles()
		]);

		const projectName = projectData.name || 'project';

		// Create zip
		const zip = new JSZip();

		// Add docs (content is already available)
		for (const doc of docs) {
			// Add UUID to filename to avoid collisions
			const filename = this._makeUniqueFilename(doc.file_name, doc.uuid);
			zip.file(filename, doc.content);
		}

		// Fetch and add files
		for (const file of files) {
			let downloadUrl;

			// Determine download URL based on file type
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

			if (!downloadUrl) {
				continue;
			}

			try {
				const response = await fetch(downloadUrl);
				if (!response.ok) {
					console.error(`[ClaudeProject] Failed to fetch ${file.file_name}`);
					continue;
				}
				const blob = await response.blob();

				// Add UUID to filename to avoid collisions
				const filename = this._makeUniqueFilename(file.file_name, file.file_uuid);
				zip.file(filename, blob);
			} catch (error) {
				console.error(`[ClaudeProject] Error downloading ${file.file_name}:`, error);
			}
		}

		// Generate zip and trigger download
		const zipBlob = await zip.generateAsync({ type: 'blob' });

		const url = URL.createObjectURL(zipBlob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${projectName}.zip`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	// Helper to make unique filenames
	_makeUniqueFilename(filename, uuid) {
		// Split filename into name and extension
		const lastDot = filename.lastIndexOf('.');
		if (lastDot === -1) {
			// No extension
			return `${filename}-${uuid}`;
		}

		const name = filename.substring(0, lastDot);
		const ext = filename.substring(lastDot);
		return `${name}-${uuid}${ext}`;
	}
}


// Account settings management
async function getAccountSettings() {
	const response = await fetch('/api/account');
	if (!response.ok) {
		throw new Error('Failed to fetch account settings');
	}
	return await response.json();
}

async function updateAccountSettings(settings) {
	const response = await fetch('/api/account', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ settings })
	});
	if (!response.ok) {
		throw new Error('Failed to update account settings');
	}
	return await response.json();
}

// File operations (legacy - consider migrating to ClaudeFile.upload)
async function uploadFile(orgId, file) {
	// Blob types need document conversion, not file upload
	if (file.kind === 'blob') {
		const attachment = await convertDocument(orgId, file);
		return { type: 'attachment', data: attachment };
	}
	console.log(`Uploading file: ${JSON.stringify(file)}`);
	const ext = file.name.toLowerCase().split('.').pop();
	const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
	const typedBlob = new Blob([file.data], { type: mimeType });

	const formData = new FormData();
	formData.append('file', typedBlob, file.name);

	const response = await fetch(`/api/${orgId}/upload`, {
		method: 'POST',
		body: formData
	});

	if (!response.ok) {
		throw new Error(`Failed to upload file ${file.name}`);
	}

	return { type: 'file', data: await response.json() };
}

async function convertDocument(orgId, file) {
	const formData = new FormData();
	formData.append('file', file.data, file.name);

	const response = await fetch(`/api/${orgId}/convert_document`, {
		method: 'POST',
		body: formData
	});

	if (!response.ok) {
		throw new Error(`Failed to convert document ${file.name}`);
	}

	return await response.json();
}


async function downloadFile(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download from ${url}`);
	}
	return await response.blob();
}

async function downloadFiles(files) {
	const downloadedFiles = [];

	for (const file of files) {
		try {
			const blob = await downloadFile(file.url);
			downloadedFiles.push({
				data: blob,
				name: file.name,
				kind: file.kind,
				originalUuid: file.uuid
			});
		} catch (error) {
			console.error(`Failed to download file ${file.name}:`, error);
		}
	}

	return downloadedFiles;
}

// Sync source processing
async function processSyncSource(orgId, syncsource) {
	const response = await fetch(`/api/organizations/${orgId}/sync/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			sync_source_config: syncsource?.config,
			sync_source_type: syncsource?.type
		})
	});

	if (!response.ok) {
		console.error(`Failed to process sync source: ${response.statusText}`);
		return null;
	}

	const result = await response.json();
	return result.uuid;
}

// Check if user is pro/free
async function getUserType(orgId) {
	const response = await fetch(`/api/bootstrap/${orgId}/statsig`, {
		method: 'GET',
		headers: { 'Content-Type': 'application/json' },
	});

	if (!response.ok) {
		console.error('Failed to fetch user type');
		return 'unknown';
	}

	const data = await response.json();
	const orgType = data?.user?.custom?.orgType;
	return orgType === 'claude_free' ? 'free' : 'pro';
}

// UUID generator
function generateUuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

function getOrgId() {
	const cookies = document.cookie.split(';');
	for (const cookie of cookies) {
		const [name, value] = cookie.trim().split('=');
		if (name === 'lastActiveOrg') {
			return value;
		}
	}
	throw new Error('Could not find organization ID');
}

function getConversationId() {
	const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
	return match ? match[1] : null;
}

const CLAUDE_MODELS = [
	{ value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
	{ value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
	{ value: 'claude-opus-4-1-20250805', label: 'Opus 4.1' },
	{ value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
	{ value: 'claude-sonnet-4-20250514', label: 'Sonnet 4' },
	{ value: 'claude-opus-4-20250514', label: 'Opus 4' },
	{ value: 'claude-3-opus-20240229', label: 'Opus 3' },
	{ value: 'claude-3-5-haiku-20241022', label: 'Haiku 3.5' }
]

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const FAST_MODEL = 'claude-haiku-4-5-20251001';

// Formats a message for inclusion in chatlog.txt attachment
// Does NOT do filtering - filter out unwanted content (tool calls, files) beforehand
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