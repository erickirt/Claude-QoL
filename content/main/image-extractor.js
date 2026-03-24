// image-extractor.js — Auto-expands tool result blocks that contain generated images.
// MAIN world: intercepts fetch to mark image-containing tool results, uses ButtonBar for toggle.
// Two-mode approach: discovery (expand all, find images, mark, collapse all) then steady-state (keep marked expanded).
'use strict';

// ==== FETCH INTERCEPTION — inject test markers into tool_use/thinking near image results ====
const _imageExtractorOriginalFetch = window.fetch;
window.fetch = async (...args) => {
	const [input, config] = args;

	let url;
	if (input instanceof URL) url = input.href;
	else if (typeof input === 'string') url = input;
	else if (input instanceof Request) url = input.url;

	if (url &&
		url.includes('/chat_conversations/') &&
		url.includes('rendering_mode=messages') &&
		(!config || config.method === 'GET' || !config.method)) {

		const response = await _imageExtractorOriginalFetch(...args);
		const data = await response.json();

		if (data?.chat_messages) {
			for (const msg of data.chat_messages) {
				if (msg.sender === 'human') continue;
				const content = msg.content;
				if (!content || !msg.files) continue;

				// Build file lookup map
				const fileMap = new Map();
				for (const f of msg.files) {
					fileMap.set(f.file_uuid || f.uuid, f);
				}

				// Collect galleries to insert (process backwards to avoid index shift)
				const insertions = []; // { afterIndex, toolUse, toolResult }

				for (let i = 0; i < content.length; i++) {
					const item = content[i];
					if (item.type !== 'tool_result') continue;
					if (!item.content?.some(c => c.type === 'image')) continue;

					// Collect all image items from this tool_result
					const galleryImages = [];
					for (const c of item.content) {
						if (c.type !== 'image') continue;
						const file = fileMap.get(c.file_uuid);
						if (!file) continue;

						const imageUrl = file.preview_url || file.thumbnail_url;
						if (!imageUrl) continue;

						const asset = file.preview_asset || file.thumbnail_asset || {};
						// Scale dimensions up so the gallery renders at full width
						const realW = asset.image_width || 1024;
						const realH = asset.image_height || 1024;
						const scale = 3840 / realW;
						const scaledW = Math.round(realW * scale);
						const scaledH = Math.round(realH * scale);

						galleryImages.push({
							id: c.file_uuid,
							url: imageUrl,
							thumbnail_url: imageUrl,
							title: "",
							source: "",
							page_url: imageUrl,
							width: scaledW,
							height: scaledH,
							thumbnail_width: scaledW,
							thumbnail_height: scaledH
						});
					}

					if (galleryImages.length === 0) continue;

					// Get prompt from preceding tool_use if available
					let prompt = "";
					const precedingToolUse = i > 0 && content[i - 1].type === 'tool_use' ? content[i - 1] : null;
					if (precedingToolUse?.input?.prompt) {
						prompt = precedingToolUse.input.prompt;
						galleryImages.forEach(img => img.title = "Generated: " + prompt.substring(0, 100));
					}

					const toolUseId = "toolu_gallery_" + crypto.randomUUID().replace(/-/g, '').substring(0, 20);
					const timestamp = new Date().toISOString();

					const galleryToolUse = {
						start_timestamp: timestamp,
						stop_timestamp: timestamp,
						type: "tool_use",
						id: toolUseId,
						name: "image_search",
						input: {},
						message: "Generated image" + (galleryImages.length > 1 ? "s" : "")
					};

					const galleryToolResult = {
						type: "tool_result",
						tool_use_id: toolUseId,
						name: "image_search",
						content: [
							{
								type: "text",
								text: prompt ? "Generated image for: " + prompt : "Generated image",
								uuid: crypto.randomUUID()
							},
							{
								type: "image_gallery",
								images: galleryImages,
								uuid: crypto.randomUUID(),
								is_expired: false
							}
						],
						is_error: false
					};

					insertions.push({ afterIndex: i, toolUse: galleryToolUse, toolResult: galleryToolResult });
				}

				// Apply insertions from end to start to preserve indices
				for (let j = insertions.length - 1; j >= 0; j--) {
					const { afterIndex, toolUse, toolResult } = insertions[j];

					// Find first text item after the tool_result
					let insertAt = -1;
					for (let k = afterIndex + 1; k < content.length; k++) {
						if (content[k].type === 'text') {
							insertAt = k;
							break;
						}
					}

					if (insertAt !== -1) {
						content.splice(insertAt, 0, toolUse, toolResult);
					} else {
						content.push(toolUse, toolResult);
					}
				}

				if (insertions.length > 0) {
					console.log('[ImageExtractor] Final content array for message', msg.uuid, JSON.parse(JSON.stringify(content)));
				}
			}
		}

		return new Response(JSON.stringify(data), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}

	return _imageExtractorOriginalFetch(...args);
};

// Inject styles for tool result images displayed inside expanded blocks
(function () {
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
		/* Make injected inline image galleries full width */
		div.my-2 > button:has(> img[src*="/files/"][src$="/preview"]) {
			width: 85% !important;
			height: auto !important;
		}
		div.my-2 > button > img[src*="/files/"][src$="/preview"] {
			height: auto !important;
			object-fit: contain !important;
		}
	`;
	function appendStyle() {
		if (document.head) {
			document.head.appendChild(style);
			console.log('[ImageExtractor] Injected custom styles for tool result images.');
		} else {
			document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
		}
	}
	appendStyle();
})();
