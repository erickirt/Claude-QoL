// databases.js
(function () {
	'use strict';

	// ======== HELPERS ========
	window.ClaudeSearchShared = window.ClaudeSearchShared || {};

	window.ClaudeSearchShared.getRelativeTime = function (timestamp) {
		const now = Date.now();
		const messageTime = new Date(timestamp).getTime();
		const diff = now - messageTime;

		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		const weeks = Math.floor(days / 7);
		const months = Math.floor(days / 30);
		const years = Math.floor(days / 365);

		if (years > 0) return `${years}y ago`;
		if (months > 0) return `${months}mo ago`;
		if (weeks > 0) return `${weeks}w ago`;
		if (days > 0) return `${days}d ago`;
		if (hours > 0) return `${hours}h ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return 'just now';
	};

	window.ClaudeSearchShared.simplifyText = function (text) {
		return text
			.toLowerCase()
			.replace(/[*_`~\[\]()]/g, '')  // Remove markdown chars
			.replace(/\s+/g, ' ')           // Normalize whitespace
			.replace(/[""'']/g, '"')        // Normalize quotes
			.trim();
	};

	window.ClaudeSearchShared.fuzzyMatch = function (searchText, targetText) {
		// Get words from search text (ignore very short words)
		const searchWords = searchText
			.toLowerCase()
			.split(/\s+/)
			.filter(word => word.length > 2);

		const targetLower = targetText.toLowerCase();

		// Count how many search words appear in target
		const matchedWords = searchWords.filter(word => targetLower.includes(word));

		const matchRatio = matchedWords.length / searchWords.length;
		return matchRatio >= 0.85;
	};

	// ======== ENCRYPTION ========
	const ENCRYPTION_KEY_PREFIX = 'QOL_ENCRYPTION_KEY_DO_NOT_DELETE_';
	let _encryptionKeyPromise = null;

	function getEncryptionKey() {
		if (!_encryptionKeyPromise) {
			_encryptionKeyPromise = _initEncryptionKey();
		}
		return _encryptionKeyPromise;
	}

	async function _initEncryptionKey() {
		let stylesData;
		try {
			stylesData = await listStyles(getOrgId());
		} catch (e) {
			_encryptionKeyPromise = null; // allow retry on next call
			throw new Error('Failed to fetch styles for encryption key: ' + e.message);
		}

		// Search custom styles for our key
		const allStyles = [
			...(stylesData.defaultStyles || []),
			...(stylesData.customStyles || [])
		];
		const keyStyle = allStyles.find(s => s.name && s.name.startsWith(ENCRYPTION_KEY_PREFIX));

		if (keyStyle) {
			const base64Key = keyStyle.name.substring(ENCRYPTION_KEY_PREFIX.length);
			const rawKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
			return await crypto.subtle.importKey(
				'raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
			);
		}

		// Key not found but API succeeded — clear all databases and create new key
		console.log('[Encryption] No encryption key found, clearing databases and generating new key');
		await Promise.allSettled([
			Dexie.delete('ClaudeSearchDB'),
			Dexie.delete('ClaudeExportDB'),
			Dexie.delete('ClaudePhantomMessagesDB')
		]);

		const rawKey = crypto.getRandomValues(new Uint8Array(16)); // 128-bit
		const base64Key = btoa(String.fromCharCode(...rawKey)).replace(/=+$/, '');
		const styleName = ENCRYPTION_KEY_PREFIX + base64Key;

		await createStyle(getOrgId(), 'Encryption key for Claude Toolbox cache', styleName);

		return await crypto.subtle.importKey(
			'raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
		);
	}

	async function encryptData(data) {
		const key = await getEncryptionKey();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv }, key, encoded
		);
		const result = new Uint8Array(iv.length + ciphertext.byteLength);
		result.set(iv);
		result.set(new Uint8Array(ciphertext), iv.length);
		return result.buffer;
	}

	async function decryptData(buffer) {
		const key = await getEncryptionKey();
		const arr = new Uint8Array(buffer);
		const iv = arr.slice(0, 12);
		const ciphertext = arr.slice(12);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv }, key, ciphertext
		);
		return JSON.parse(new TextDecoder().decode(decrypted));
	}

	// Expose for use by other scripts
	window.ClaudeSearchShared.encryptData = encryptData;
	window.ClaudeSearchShared.decryptData = decryptData;

	// ======== INDEXEDDB MANAGEMENT ========
	const db = new Dexie('ClaudeSearchDB');

	db.version(1).stores({
		metadata: 'uuid',
		messages: 'uuid'
	});

	// One-time migration: delete old databases
	async function deleteOldDatabases() {
		try {
			await Dexie.delete('claudeSearchIndex');
			console.log('[DB] Deleted old database: claudeSearchIndex');
		} catch (e) {
			// Doesn't exist, that's fine
		}
	}

	deleteOldDatabases();

	class SearchDatabase {
		constructor() {
			// No initialization needed! Dexie handles it.
		}

		async setMetadata(conversationObj) {
			await db.metadata.put(conversationObj);
		}

		async getMetadata(conversationId) {
			return await db.metadata.get(conversationId);
		}

		async getAllMetadata() {
			return await db.metadata.toArray();
		}

		async setMessages(conversationId, messages) {
			// Extract searchable text only
			const searchableText = messages
				.map(m => ClaudeConversation.extractMessageText(m))
				.join('\n');

			const encrypted = await encryptData(searchableText);
			await db.messages.put({
				uuid: conversationId,
				searchableText: encrypted
			});
		}

		async getMessages(conversationId) {
			const result = await db.messages.get(conversationId);
			if (!result || !result.searchableText) return null;

			try {
				return await decryptData(result.searchableText);
			} catch (e) {
				console.warn(`[Encryption] Decryption failed for messages ${conversationId}, deleting entry`);
				await db.messages.delete(conversationId);
				return null;
			}
		}

		async getAllMessages() {
			const all = await db.messages.toArray();
			const results = [];
			for (const entry of all) {
				try {
					const searchableText = await decryptData(entry.searchableText);
					results.push({ uuid: entry.uuid, searchableText });
				} catch (e) {
					console.warn(`[Encryption] Decryption failed for messages ${entry.uuid}, deleting entry`);
					await db.messages.delete(entry.uuid);
				}
			}
			return results;
		}

		async deleteConversation(conversationId) {
			await Promise.all([
				db.metadata.delete(conversationId),
				db.messages.delete(conversationId)
			]);
		}
	}



	// Global database instance
	window.ClaudeSearchShared.searchDB = new SearchDatabase();

	// ======== CONVERSATION CACHE DB ========
	const cacheDB = new Dexie('ClaudeExportDB'); // keep DB name for migration
	cacheDB.version(1).stores({
		conversations: 'uuid'  // stores { uuid, updated_at, data }
	});

	class ConversationCache {
		async get(conversationId) {
			const entry = await cacheDB.conversations.get(conversationId);
			if (!entry || !entry.data) return null;

			try {
				const decryptedData = await decryptData(entry.data);
				return { uuid: entry.uuid, updated_at: entry.updated_at, data: decryptedData };
			} catch (e) {
				console.warn(`[Encryption] Decryption failed for cache ${conversationId}, deleting entry`);
				await cacheDB.conversations.delete(conversationId);
				return null;
			}
		}

		async put(conversationId, updatedAt, data) {
			const encrypted = await encryptData(data);
			await cacheDB.conversations.put({ uuid: conversationId, updated_at: updatedAt, data: encrypted });
		}

		async delete(conversationId) {
			await cacheDB.conversations.delete(conversationId);
		}
	}

	const conversationCache = new ConversationCache();
	window.ClaudeSearchShared.conversationCache = conversationCache;

	// ======== PHANTOM MESSAGES DB ========
	const phantomDB = new Dexie('ClaudePhantomMessagesDB');
	phantomDB.version(1).stores({
		phantomMessages: 'conversationId'
	});

	async function storePhantomMessagesDB(conversationId, messages) {
		const encrypted = await encryptData({ messages, timestamp: Date.now() });
		await phantomDB.phantomMessages.put({ conversationId, encryptedData: encrypted });
	}

	async function getPhantomMessagesDB(conversationId) {
		const result = await phantomDB.phantomMessages.get(conversationId);
		if (!result || !result.encryptedData) return null;

		try {
			const decrypted = await decryptData(result.encryptedData);
			return decrypted.messages;
		} catch (e) {
			console.warn(`[Encryption] Decryption failed for phantom ${conversationId}, deleting entry`);
			await phantomDB.phantomMessages.delete(conversationId);
			return null;
		}
	}

	async function clearPhantomMessagesDB(conversationId) {
		await phantomDB.phantomMessages.delete(conversationId);
	}

	// Expose for direct use in isolated world
	window.ClaudeSearchShared.storePhantomMessages = storePhantomMessagesDB;
	window.ClaudeSearchShared.getPhantomMessages = getPhantomMessagesDB;
	window.ClaudeSearchShared.clearPhantomMessages = clearPhantomMessagesDB;

	// ======== PostMessage bridge for MAIN world access ========
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;

		try {
			switch (event.data.type) {
				case 'CONV_CACHE_GET': {
					const entry = await conversationCache.get(event.data.uuid);
					window.postMessage({
						type: 'CONV_CACHE_RESULT',
						messageId: event.data.messageId,
						entry: entry || null
					}, '*');
					break;
				}
				case 'CONV_CACHE_PUT': {
					await conversationCache.put(event.data.uuid, event.data.updatedAt, event.data.data);
					window.postMessage({
						type: 'CONV_CACHE_STORED',
						messageId: event.data.messageId
					}, '*');
					break;
				}
				case 'PHANTOM_GET': {
					const messages = await getPhantomMessagesDB(event.data.conversationId);
					window.postMessage({
						type: 'PHANTOM_RESULT',
						messageId: event.data.messageId,
						messages: messages
					}, '*');
					break;
				}
				case 'PHANTOM_STORE': {
					await storePhantomMessagesDB(event.data.conversationId, event.data.messages);
					window.postMessage({
						type: 'PHANTOM_STORED',
						messageId: event.data.messageId,
						conversationId: event.data.conversationId
					}, '*');
					break;
				}
				case 'PHANTOM_CLEAR': {
					await clearPhantomMessagesDB(event.data.conversationId);
					window.postMessage({
						type: 'PHANTOM_CLEARED',
						messageId: event.data.messageId
					}, '*');
					break;
				}
			}
		} catch (error) {
			window.postMessage({
				type: 'BRIDGE_ERROR',
				messageId: event.data.messageId,
				error: error.message
			}, '*');
		}
	});
})();