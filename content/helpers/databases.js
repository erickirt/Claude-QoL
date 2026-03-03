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
	const ENCRYPTION_KEY_PREFIX = 'QOL_ENCRYPT_NODELETE_';
	let _encryptionKeyPromise = null;
	let _keyHash = null; // first 8 hex chars of SHA-256 of the raw key

	function getEncryptionKey() {
		if (!_encryptionKeyPromise) {
			_encryptionKeyPromise = _initEncryptionKey();
		}
		return _encryptionKeyPromise;
	}

	async function _computeKeyHash(rawKey) {
		const hash = await crypto.subtle.digest('SHA-256', rawKey);
		const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
		return hex.substring(0, 8);
	}

	// Encrypt: returns { v: 1, keyHash, data: base64(iv + ciphertext) }
	async function encryptData(data) {
		const key = await getEncryptionKey();
		if (!key) return data; // plaintext passthrough

		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encoded = new TextEncoder().encode(JSON.stringify(data));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv }, key, encoded
		);
		const combined = new Uint8Array(iv.length + ciphertext.byteLength);
		combined.set(iv);
		combined.set(new Uint8Array(ciphertext), iv.length);
		let binary = '';
		for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
		return { v: 1, keyHash: _keyHash, data: btoa(binary) };
	}

	// Decrypt: detects per-item format
	async function decryptData(item) {
		// Plaintext passthrough — not an encrypted wrapper
		if (!item || typeof item !== 'object' || !item.v || !item.keyHash) {
			return item;
		}

		const key = await getEncryptionKey();

		// Key mismatch or no key available — item is unrecoverable
		if (!key || item.keyHash !== _keyHash) {
			throw new Error(`Key mismatch: item encrypted with ${item.keyHash}, current key is ${_keyHash || 'none'}`);
		}

		const combined = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
		const iv = combined.slice(0, 12);
		const ciphertext = combined.slice(12);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv }, key, ciphertext
		);
		return JSON.parse(new TextDecoder().decode(decrypted));
	}

	async function _initEncryptionKey() {
		let stylesData;
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				stylesData = await listStyles(getOrgId());
				break;
			} catch (e) {
				if (attempt < 9) {
					console.warn(`[Encryption] Failed to fetch styles (attempt ${attempt + 1}/10), retrying...`);
					await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
					continue;
				}
				console.warn('[Encryption] Failed to fetch styles after 10 attempts, operating in plaintext mode:', e.message);
				return null;
			}
		}

		// Search styles for our key
		const allStyles = [
			...(stylesData.defaultStyles || []),
			...(stylesData.customStyles || [])
		];
		const keyStyle = allStyles.find(s => s.name && s.name.startsWith(ENCRYPTION_KEY_PREFIX));

		if (keyStyle) {
			const base64Key = keyStyle.name.substring(ENCRYPTION_KEY_PREFIX.length);
			const rawKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
			_keyHash = await _computeKeyHash(rawKey);
			const key = await crypto.subtle.importKey(
				'raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
			);
			_bulkEncryptAll(); // fire-and-forget
			return key;
		}

		// No key in styles — try to create one
		const rawKey = crypto.getRandomValues(new Uint8Array(16)); // 128-bit
		const base64Key = btoa(String.fromCharCode(...rawKey)).replace(/=+$/, '');
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				await createStyle(getOrgId(), 'Encryption key for Claude QoL cache', ENCRYPTION_KEY_PREFIX + base64Key);
				_keyHash = await _computeKeyHash(rawKey);
				const key = await crypto.subtle.importKey(
					'raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
				);
				_bulkEncryptAll(); // fire-and-forget
				return key;
			} catch (e) {
				if (attempt < 9) {
					console.warn(`[Encryption] Failed to create key style (attempt ${attempt + 1}/10), retrying...`);
					await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
					continue;
				}
				console.warn('[Encryption] Failed to create key style after 10 attempts, operating in plaintext mode:', e.message);
				return null;
			}
		}
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
				const raw = result.searchableText;
				const decrypted = await decryptData(raw);
				// Encrypt-on-read: if stored as plaintext and we have a key, re-encrypt
				if (!raw?.v && _keyHash) {
					const encrypted = await encryptData(decrypted);
					await db.messages.put({ uuid: conversationId, searchableText: encrypted });
				}
				return decrypted;
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
					const raw = entry.searchableText;
					const decrypted = await decryptData(raw);
					// Encrypt-on-read
					if (!raw?.v && _keyHash) {
						const encrypted = await encryptData(decrypted);
						await db.messages.put({ uuid: entry.uuid, searchableText: encrypted });
					}
					results.push({ uuid: entry.uuid, searchableText: decrypted });
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
				const raw = entry.data;
				const decryptedData = await decryptData(raw);
				// Encrypt-on-read
				if (!raw?.v && _keyHash) {
					const encrypted = await encryptData(decryptedData);
					await cacheDB.conversations.put({ uuid: entry.uuid, updated_at: entry.updated_at, data: encrypted });
				}
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
			const raw = result.encryptedData;
			const decrypted = await decryptData(raw);
			// Encrypt-on-read
			if (!raw?.v && _keyHash) {
				const encrypted = await encryptData(decrypted);
				await phantomDB.phantomMessages.put({ conversationId, encryptedData: encrypted });
			}
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

	async function _bulkEncryptAll() {
		try {
			// Encrypt all plaintext messages
			const allMessages = await db.messages.toArray();
			for (const row of allMessages) {
				if (!row.searchableText?.v && _keyHash) {
					const encrypted = await encryptData(row.searchableText);
					await db.messages.put({ uuid: row.uuid, searchableText: encrypted });
				}
			}
			// Encrypt all plaintext conversation cache entries
			const allConvos = await cacheDB.conversations.toArray();
			for (const row of allConvos) {
				if (!row.data?.v && _keyHash) {
					const encrypted = await encryptData(row.data);
					await cacheDB.conversations.put({ uuid: row.uuid, updated_at: row.updated_at, data: encrypted });
				}
			}
			// Encrypt all plaintext phantom messages
			const allPhantom = await phantomDB.phantomMessages.toArray();
			for (const row of allPhantom) {
				if (!row.encryptedData?.v && _keyHash) {
					const encrypted = await encryptData(row.encryptedData);
					await phantomDB.phantomMessages.put({ conversationId: row.conversationId, encryptedData: encrypted });
				}
			}
			console.log('[Encryption] Bulk migration complete.');
		} catch (e) {
			console.warn('[Encryption] Bulk migration error:', e.message);
		}
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