// tts-interceptor.js
(function () {
	'use strict';

	// Override clipboard API
	const originalWrite = navigator.clipboard.write;
	navigator.clipboard.write = async (data) => {
		// Extract text from clipboard data
		let capturedText = null;
		try {
			const item = data[0];
			if (item && item.types.includes('text/plain')) {
				const blob = await item.getType('text/plain');
				capturedText = await blob.text();

				// Strip phantom/UUID markers
				capturedText = capturedText.replace(/====PHANTOM_MESSAGE====/g, '');
				capturedText = capturedText.replace(/====UUID:[a-f0-9-]+====/gi, '');
				capturedText = capturedText.replace(/\n{3,}/g, '\n\n').trim();
			}
		} catch (error) {
			console.error('Error extracting clipboard text:', error);
		}

		if (capturedText) {
			// Ask ISOLATED script if we should intercept this copy
			const shouldIntercept = await new Promise((resolve) => {
				const requestId = Math.random().toString(36).substr(2, 9);

				const listener = (event) => {
					if (event.data.type === 'tts-clipboard-response' &&
						event.data.requestId === requestId) {
						window.removeEventListener('message', listener);
						resolve(event.data.shouldIntercept);
					}
				};

				window.addEventListener('message', listener);

				window.postMessage({
					type: 'tts-clipboard-request',
					text: capturedText,
					requestId: requestId
				}, '*');

				// Timeout after 50ms - default to allowing copy
				setTimeout(() => {
					window.removeEventListener('message', listener);
					resolve(false);
				}, 50);
			});

			if (shouldIntercept) {
				// Intercept - don't actually copy to clipboard
				return Promise.resolve();
			}
		}

		// Normal copy operation
		return originalWrite.call(navigator.clipboard, data);
	};

	// Helper to fetch conversation and find new assistant message
	async function findNewAssistantMessage(orgId, conversationId, requestSentTime, maxRetries = 2) {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				console.log(`Assistant message not found, retrying (${attempt}/${maxRetries})...`);
				await new Promise(r => setTimeout(r, 1000));
			}

			try {
				const response = await fetch(
					`/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`
				);

				if (!response.ok) {
					console.error('Failed to fetch conversation:', response.status);
					continue;
				}

				const data = await response.json();
				const messages = data.chat_messages || [];

				const assistantMessage = messages.find(msg =>
					msg.sender === 'assistant' &&
					msg.created_at > requestSentTime
				);

				if (assistantMessage) {
					return assistantMessage;
				}
			} catch (error) {
				console.error('Error fetching conversation:', error);
			}
		}

		return null;
	}

	const originalFetch = window.fetch;
	window.fetch = async (...args) => {
		const [input, config] = args;

		let url = undefined;
		if (input instanceof URL) {
			url = input.href;
		} else if (typeof input === 'string') {
			url = input;
		} else if (input instanceof Request) {
			url = input.url;
		}

		// Intercept completion requests
		if (url && (url.includes('/completion') || url.includes('/retry_completion')) && config?.method === 'POST') {
			console.log('Intercepted completion request for TTS handling:', url);
			const requestSentTime = new Date().toISOString();

			// Extract org ID and conversation ID from URL
			const urlParts = url.split('/');
			const orgIndex = urlParts.indexOf('organizations');
			const convIndex = urlParts.indexOf('chat_conversations');

			const orgId = orgIndex !== -1 ? urlParts[orgIndex + 1] : null;
			const conversationId = convIndex !== -1 ? urlParts[convIndex + 1] : null;

			if (!orgId || !conversationId) {
				return originalFetch(...args);
			}

			// Make the original request
			const response = await originalFetch(...args);

			// Clone the response so we can consume the stream without affecting Claude's UI
			const clonedResponse = response.clone();

			// Consume the cloned stream in the background
			(async () => {
				try {
					const reader = clonedResponse.body.getReader();
					const decoder = new TextDecoder();

					// Consume until done
					while (true) {
						const { done, value } = await reader.read();

						if (done) break;

						// Decode and check for completion signal
						const chunk = decoder.decode(value, { stream: true });
						console.log('Received chunk from completion stream:', chunk);
						console.log('Are we done?', done);
						// Look for the message_stop event (or whatever Claude uses)
						if (chunk.includes('event: message_stop') || chunk.includes('"type":"message_stop"')) {
							console.log('Stream completion detected');
							reader.releaseLock();
							break;
						}
					}

					reader.releaseLock();
					console.log('Completed reading completion response stream for TTS handling');
					// Now fetch the conversation to find the new message
					const assistantMessage = await findNewAssistantMessage(orgId, conversationId, requestSentTime);
					console.log('Found assistant message for TTS:', assistantMessage);
					if (assistantMessage) {
						window.postMessage({
							type: 'tts-auto-speak',
							messageUuid: assistantMessage.uuid
						}, '*');
					} else {
						console.log('No new assistant message found after retries');
					}
				} catch (error) {
					console.error('Error processing completion stream:', error);
				}
			})();

			return response;
		}

		return originalFetch(...args);
	};

	// Handle dialogue analysis requests from ISOLATED world
	window.addEventListener('message', async (event) => {
		if (event.data.type === 'tts-analyze-dialogue-request') {
			const { prompt, requestId } = event.data;

			try {
				const orgId = getOrgId();
				const conversation = new ClaudeConversation(orgId);

				await conversation.create('TTS Actor Analysis', FAST_MODEL, null, false);

				const response = await conversation.sendMessageAndWaitForResponse(prompt);

				let responseText = ClaudeConversation.extractMessageText(response);

				// Strip markdown code blocks if present
				responseText = responseText.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();

				await conversation.delete();

				window.postMessage({
					type: 'tts-analyze-dialogue-response',
					requestId: requestId,
					success: true,
					data: responseText
				}, '*');

			} catch (error) {
				console.error('Dialogue analysis failed:', error);
				window.postMessage({
					type: 'tts-analyze-dialogue-response',
					requestId: requestId,
					success: false,
					error: error.message
				}, '*');
			}
		}
	});
})();