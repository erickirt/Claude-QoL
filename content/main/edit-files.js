// edit-files.js
(function () {
	'use strict';

	//#region Constants and State

	let pendingEditData = null;

	const TEMP_STYLE_NAME = 'advanced_edit_temporary_style';
	const TEMP_STYLE_STORAGE_KEY = 'temp_style_id';

	// Working message for the current edit session
	let editMessage = null;
	// Map DOM elements to file instances for tracking
	const fileElementMap = new Map(); // HTMLElement -> ClaudeFile|ClaudeCodeExecutionFile|ClaudeAttachment
	//#endregion

	//#region Edit Button Interception
	function createAdvancedEditButton() {
		const svgContent = `
            <div class="flex items-center justify-center" style="width: 20px; height: 20px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" class="shrink-0" aria-hidden="true" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" style="color: currentColor;">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9"/>
                    <polyline points="13 2 13 7 18 7"/>
                    <path d="M18.5 8.5a1.5 1.5 0 0 0-2.12 0L10 14.88V18h3.12l6.38-6.38a1.5 1.5 0 0 0 0-2.12z"/>
                </svg>
            </div>
        `;

		const btn = createClaudeButton(svgContent, 'icon-message');
		btn.type = 'button';
		btn.setAttribute('data-state', 'closed');
		btn.setAttribute('aria-label', 'Advanced Edit');
		btn.classList.add('h-8', 'w-8');
		createClaudeTooltip(btn, 'Advanced Edit', true);
		return btn;
	}

	function findExistingMessage(controlsContainer, messages) {
		const { userMessages, assistantMessages } = getUIMessages();
		const userIndex = userMessages.findIndex(msg => findMessageControls(msg) === controlsContainer);
		if (userIndex === -1 || userIndex >= assistantMessages.length) return null;

		let el = assistantMessages[userIndex];
		while (el && !el.hasAttribute('data-message-uuid')) el = el.parentElement;
		const assistantUuid = el?.getAttribute('data-message-uuid');
		if (!assistantUuid) return null;

		const apiAssistant = messages.find(m => m.uuid === assistantUuid);
		if (!apiAssistant) return null;
		return messages.find(m => m.uuid === apiAssistant.parent_message_uuid);
	}

	function insertAdvancedEditButton(button, controlsContainer) {
		// Find the native edit button by its unique SVG path (pencil icon)
		const allButtons = controlsContainer.querySelectorAll('button[type="button"]');
		let editButton = null;

		for (const btn of allButtons) {
			const ariaLabel = btn.getAttribute('aria-label');
			if (ariaLabel === 'Edit') {
				editButton = btn;
				break;
			}

			// Also check for the path as a fallback
			const svgPath = btn.querySelector('svg path');
			if (svgPath && svgPath.getAttribute('d')?.startsWith('M9.728 2.88a1.5')) {
				editButton = btn;
				break;
			}
		}

		if (!editButton) return;

		button.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();

			try {
				const orgId = getOrgId();
				const conversationId = getConversationId();
				const conversation = new ClaudeConversation(orgId, conversationId);
				const messages = await conversation.getMessages(false);

				const existingMessage = findExistingMessage(controlsContainer, messages);
				if (!existingMessage) {
					showClaudeAlert('Error', 'Could not find the message to edit.');
					return;
				}

				const effectiveStyle = await getEffectiveStyle(orgId, conversationId);
				const currentStyleText = effectiveStyle?.prompt || '';

				const result = await createEditModal(orgId, conversationId, existingMessage, currentStyleText);

				pendingEditData = {
					styleText: result.styleText,
					originalStyleText: currentStyleText,
				};
				editButton.click();
				setTimeout(() => autoSubmitEditWithText(editMessage.text), 100);
			} catch (error) {
				if (error.message === 'Edit cancelled by user') {
					console.log('Edit cancelled — no side effects');
				} else {
					console.error('Advanced edit error:', error);
				}
			}
		};

		// Old layout: each button is wrapped in <div class="w-fit">.
		// New layout: buttons are direct children of a flex container (no w-fit wrapper).
		const editButtonWrapper = editButton.closest('div.w-fit');
		if (editButtonWrapper) {
			const wrapper = document.createElement('div');
			wrapper.className = 'w-fit';
			wrapper.setAttribute('data-state', 'closed');
			wrapper.appendChild(button);
			editButtonWrapper.parentElement.insertBefore(wrapper, editButtonWrapper);
		} else {
			editButton.parentElement.insertBefore(button, editButton);
		}
	}

	function autoSubmitEditWithText(newText) {
		if (!pendingEditData) return;

		const saveButton = document.querySelector('button[type="submit"]');
		if (saveButton) {
			const form = saveButton.closest('form');
			if (!form) {
				setTimeout(() => autoSubmitEditWithText(newText), 50);
				return;
			}

			const textarea = form.querySelector('textarea');
			if (!textarea) {
				setTimeout(() => autoSubmitEditWithText(newText), 50);
				return;
			}

			textarea.focus();
			textarea.select();
			// Always append a space to guarantee the UI detects a change — the fetch interceptor overwrites the text anyway
			document.execCommand('insertText', false, newText + ' ');

			setTimeout(() => {
				saveButton.click();
			}, 100);
		} else {
			setTimeout(() => autoSubmitEditWithText(newText), 50);
		}
	}
	//#endregion

	//#region Modal UI Construction
	async function createEditModal(orgId, conversationId, existingMessage, currentStyleText) {
		const conversation = new ClaudeConversation(orgId, conversationId);

		editMessage = new ClaudeMessage(conversation);
		editMessage.text = existingMessage.text.trim();
		editMessage.parent_message_uuid = existingMessage.parent_message_uuid;

		for (const file of existingMessage.files) {
			editMessage.attachFile(file);
		}

		let originalStyleText = currentStyleText;
		if (originalStyleText === 'Normal') originalStyleText = '';

		return new Promise((resolve, reject) => {
			const content = document.createElement('div');
			content.className = 'space-y-4';

			const filesSection = buildFilesSection();
			content.appendChild(filesSection);

			const editorSection = buildEditorSection(editMessage.text, originalStyleText);
			content.appendChild(editorSection);

			const modal = new ClaudeModal('Edit Message', content);

			// Make modal wider
			modal.modal.classList.remove('max-w-md');
			modal.modal.classList.add('max-w-2xl');

			// Add cancel button
			modal.addCancel('Cancel', () => {
				cleanupEditState();
				reject(new Error('Edit cancelled by user'));
			});

			// Add confirm button
			const submitBtn = modal.addConfirm('Submit Edit', async (btn) => {
				const modalData = collectModalData();

				// Pre-validate style if it changed
				if (modalData.styleText !== originalStyleText) {
					const loadingModal = createLoadingModal('Preparing style...');
					loadingModal.show();
					try {
						await ensureTempStyle(orgId, modalData.styleText);
						loadingModal.destroy();
					} catch (error) {
						console.error('Error preparing style:', error);
						loadingModal.destroy();
						showClaudeAlert('Edit Error', error.message || 'Failed to prepare style');
						return false;
					}
				}

				resolve({ styleText: modalData.styleText });
				return true;
			});

			// Store button reference for upload status updates
			modal.backdrop.classList.add('claude-edit-modal');
			modal.backdrop.submitButton = submitBtn;

			modal.show();
		});
	}

	function cleanupEditState() {
		editMessage = null;
		fileElementMap.clear();
	}

	function buildFilesSection() {
		const container = document.createElement('div');
		container.className = 'border border-border-300 rounded-lg p-3';

		// Section header
		const header = document.createElement('h3');
		header.className = 'text-sm font-medium text-text-200 mb-2';
		header.textContent = 'Files & Attachments';
		container.appendChild(header);

		// Files list container - now with scrolling
		const filesList = document.createElement('div');
		filesList.className = CLAUDE_CLASSES.LIST_CONTAINER + ' mb-3';
		filesList.style.maxHeight = '200px';
		filesList.id = 'files-list';

		// Add files from editMessage
		for (const file of editMessage.files) {
			// ClaudeAttachment only in non-code-execution
			// ClaudeFile and ClaudeCodeExecutionFile both go to buildFileItem
			const item = file instanceof ClaudeAttachment
				? buildAttachmentItem(file)
				: buildFileItem(file);
			fileElementMap.set(item, file);
			filesList.appendChild(item);
		}

		container.appendChild(filesList);

		// Add file button
		const addButton = buildAddFileButton();
		container.appendChild(addButton);

		return container;
	}

	function buildEditorSection(promptText, styleText) {
		const container = document.createElement('div');
		container.className = 'border border-border-300 rounded-lg p-3';

		// Toggle header
		const header = document.createElement('div');
		header.className = CLAUDE_CLASSES.FLEX_BETWEEN + ' mb-3';
		const label = document.createElement('span');
		label.className = 'text-sm font-medium text-text-200';
		label.textContent = 'Editing:';
		header.appendChild(label);

		const { container: toggle, input: toggleInput } = createClaudeToggle('', false);
		const promptLabel = document.createElement('span');
		promptLabel.className = 'text-sm text-text-200';
		promptLabel.textContent = 'Prompt';
		const styleLabelEl = document.createElement('span');
		styleLabelEl.className = 'text-sm text-text-200';
		styleLabelEl.textContent = 'Style';
		toggle.insertBefore(promptLabel, toggle.firstChild);
		toggle.appendChild(styleLabelEl);
		header.appendChild(toggle);
		container.appendChild(header);

		// Textareas
		const promptTA = document.createElement('textarea');
		promptTA.id = 'message-text';
		promptTA.className = CLAUDE_CLASSES.INPUT;
		promptTA.value = promptText;
		promptTA.placeholder = 'Enter your message...';
		promptTA.style.resize = 'none';
		promptTA.style.minHeight = '150px';
		promptTA.style.maxHeight = '400px';
		promptTA.style.overflowY = 'auto';
		container.appendChild(promptTA);

		const styleTA = document.createElement('textarea');
		styleTA.id = 'style-text';
		styleTA.className = CLAUDE_CLASSES.INPUT;
		styleTA.value = styleText;
		styleTA.placeholder = 'Enter style instructions...';
		styleTA.style.resize = 'none';
		styleTA.style.minHeight = '150px';
		styleTA.style.maxHeight = '400px';
		styleTA.style.overflowY = 'auto';
		styleTA.style.display = 'none';
		container.appendChild(styleTA);

		// Auto-resize each independently
		const resize = (ta) => {
			const maxHeight = parseInt(getComputedStyle(ta).maxHeight);
			ta.style.height = 'auto';
			ta.style.height = Math.min(ta.scrollHeight, maxHeight) + 'px';
		};
		promptTA.oninput = () => resize(promptTA);
		styleTA.oninput = () => resize(styleTA);

		// Toggle behavior
		toggleInput.onchange = (e) => {
			if (e.target.checked) {
				promptTA.style.display = 'none';
				styleTA.style.display = 'block';
				setTimeout(() => resize(styleTA), 0);
			} else {
				styleTA.style.display = 'none';
				promptTA.style.display = 'block';
				setTimeout(() => resize(promptTA), 0);
			}
		};

		setTimeout(() => resize(promptTA), 0);
		return container;
	}

	//#endregion

	//#region File Item Builders and Handlers
	function truncateFilename(filename, customMaxLength = null) {
		const maxLength = customMaxLength || (window.innerWidth < window.innerHeight ? 20 : 60);

		if (filename.length <= maxLength) return filename;

		// Try to preserve the extension
		const lastDotIndex = filename.lastIndexOf('.');
		if (lastDotIndex > 0) {
			const name = filename.substring(0, lastDotIndex);
			const extension = filename.substring(lastDotIndex);

			// If extension is reasonable length (<=5 chars like .docx)
			if (extension.length <= 5) {
				const availableLength = maxLength - extension.length - 3; // -3 for "..."
				if (availableLength > 0) {
					return name.substring(0, availableLength) + '...' + extension;
				}
			}
		}

		// Fallback: just truncate and add ellipsis
		return filename.substring(0, maxLength - 3) + '...';
	}


	function buildUploadingFileItem(file) {
		const item = document.createElement('div');
		item.className = CLAUDE_CLASSES.LIST_ITEM + " opacity-75" + ' flex items-center gap-2';
		item.dataset.uploading = 'true';
		item.dataset.fileType = 'files_v2';

		// Loading spinner or placeholder icon
		const icon = document.createElement('div');
		icon.className = 'w-8 h-8 bg-bg-300 rounded flex items-center justify-center text-text-400';

		// Add spinning animation
		const spinner = document.createElement('div');
		spinner.className = 'animate-spin h-5 w-5 border-2 border-text-400 border-t-transparent rounded-full';
		icon.appendChild(spinner);
		item.appendChild(icon);

		// File name with uploading indicator
		const name = document.createElement('span');
		name.className = 'flex-1 text-sm text-text-100';
		name.innerHTML = `${truncateFilename(file.name)} <span class="text-text-400 text-xs">(uploading...)</span>`;
		name.title = file.name;
		item.appendChild(name);

		// Remove button (disabled during upload)
		const removeBtn = createClaudeButton('Remove', 'secondary');
		removeBtn.classList.add('!min-w-0', '!px-2', '!h-7', '!text-xs');
		removeBtn.disabled = true;
		removeBtn.style.opacity = '0.5';
		item.appendChild(removeBtn);

		return item;
	}


	function buildFileItem(file) {
		// Accepts ClaudeFile or ClaudeCodeExecutionFile
		const item = document.createElement('div');
		item.className = CLAUDE_CLASSES.LIST_ITEM + ' flex items-center gap-2';

		// File preview/icon
		const icon = document.createElement('div');
		icon.className = 'w-8 h-8 bg-bg-300 rounded overflow-hidden flex items-center justify-center';

		// Only ClaudeFile has thumbnail_asset (ClaudeCodeExecutionFile does not)
		if (file.file_kind === 'image' && file.thumbnail_asset?.url) {
			const img = document.createElement('img');
			img.src = file.thumbnail_asset.url;
			img.className = 'w-full h-full object-cover';
			icon.appendChild(img);
		} else {
			icon.innerHTML = file.file_kind === 'document' ? '📄' : '📎';
		}
		item.appendChild(icon);

		// File name
		const name = document.createElement('span');
		name.className = 'flex-1 text-sm text-text-100';
		name.textContent = truncateFilename(file.file_name);
		name.title = file.file_name;
		item.appendChild(name);

		// Remove button
		const removeBtn = createClaudeButton('Remove', 'secondary');
		removeBtn.classList.add('!min-w-0', '!px-2', '!h-7', '!text-xs');
		removeBtn.onclick = () => handleRemoveFile(item, file);
		item.appendChild(removeBtn);
		return item;
	}

	function handleRemoveFile(element, file) {
		element.remove();
		fileElementMap.delete(element);

		editMessage.removeFile(file);
	}

	function buildAttachmentItem(attachment) {
		// Accepts ClaudeAttachment instance
		const item = document.createElement('div');
		item.className = CLAUDE_CLASSES.LIST_ITEM + ' flex items-center gap-2';

		// Attachment icon
		const icon = document.createElement('div');
		icon.className = 'w-8 h-8 bg-bg-300 rounded flex items-center justify-center text-text-400';
		icon.innerHTML = '📎';
		item.appendChild(icon);

		// Attachment name
		const name = document.createElement('span');
		name.className = 'flex-1 text-sm text-text-100';
		name.textContent = truncateFilename(attachment.file_name);
		name.title = attachment.file_name;
		item.appendChild(name);

		// Remove button
		const removeBtn = createClaudeButton('Remove', 'secondary');
		removeBtn.classList.add('!min-w-0', '!px-2', '!h-7', '!text-xs');
		removeBtn.onclick = () => handleRemoveFile(item, attachment);
		item.appendChild(removeBtn);

		return item;
	}

	function buildAddFileButton() {
		const container = document.createElement('div');
		container.className = 'space-y-2';

		// Buttons container - now with flex-wrap for responsive layout
		const buttonsDiv = document.createElement('div');
		buttonsDiv.className = 'flex gap-2 flex-wrap';

		// Add attachment button (text files) - updated description
		const addAttachmentBtn = createClaudeButton('+ Add Text File (any text format)', 'secondary');
		addAttachmentBtn.style.minWidth = '200px';
		addAttachmentBtn.style.flex = '1';
		addAttachmentBtn.onclick = () => handleAddAttachment();
		buttonsDiv.appendChild(addAttachmentBtn);

		// Add file button (images, PDFs, etc)
		const addFileBtn = createClaudeButton('+ Add File (images, PDFs, docs)', 'secondary');
		addFileBtn.style.minWidth = '200px';
		addFileBtn.style.flex = '1';
		addFileBtn.onclick = () => handleAddFile();
		buttonsDiv.appendChild(addFileBtn);

		container.appendChild(buttonsDiv);

		// Hidden file input for attachments - now accepts ANY text file
		const attachmentInput = document.createElement('input');
		attachmentInput.type = 'file';
		// Accept any text/* MIME type, plus common code/text extensions
		attachmentInput.accept = [
			'text/*',  // Any text MIME type
			'.txt', '.md', '.csv', '.log', '.json', '.xml', '.yaml', '.yml',
			'.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
			'.py', '.pyw', '.ipynb',
			'.java', '.class',
			'.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
			'.cs', '.vb',
			'.php', '.php3', '.php4', '.php5',
			'.rb', '.erb',
			'.go',
			'.rs',
			'.swift',
			'.kt', '.kts',
			'.scala',
			'.r', '.R',
			'.m', '.mm',
			'.pl', '.pm',
			'.lua',
			'.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
			'.sql',
			'.html', '.htm', '.xhtml',
			'.css', '.scss', '.sass', '.less',
			'.vue',
			'.svelte',
			'.dart',
			'.elm',
			'.ex', '.exs',
			'.clj', '.cljs',
			'.lisp', '.lsp',
			'.hs',
			'.ml', '.mli',
			'.fs', '.fsi', '.fsx',
			'.nim',
			'.zig',
			'.v',
			'.tf', '.tfvars',
			'.dockerfile', '.containerfile',
			'.makefile', '.mk',
			'.cmake',
			'.gradle', '.gradle.kts',
			'.ini', '.cfg', '.conf', '.config',
			'.toml',
			'.env',
			'.gitignore', '.dockerignore',
			'.editorconfig',
			'.properties',
			'.plist',
			'.asm', '.s'
		].join(',');
		attachmentInput.multiple = true;
		attachmentInput.style.display = 'none';
		attachmentInput.id = 'attachment-input';
		attachmentInput.onchange = async (e) => {
			// Verify files are actually text before processing
			const files = Array.from(e.target.files);
			const validFiles = [];

			for (const file of files) {
				// Check if it's likely a text file by trying to read first few bytes
				if (await isLikelyTextFile(file)) {
					validFiles.push(file);
				} else {
					console.warn(`Skipping ${file.name} - doesn't appear to be a text file`);
				}
			}

			if (validFiles.length > 0) {
				processSelectedAttachments(validFiles);
			}
		};
		container.appendChild(attachmentInput);

		// Hidden file input for real files
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = 'image/*, .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx';
		fileInput.multiple = true;
		fileInput.style.display = 'none';
		fileInput.id = 'file-input';
		fileInput.onchange = (e) => processSelectedFiles(e.target.files);
		container.appendChild(fileInput);

		return container;
	}

	function handleAddAttachment() {
		document.getElementById('attachment-input').click();
	}

	function handleAddFile() {
		document.getElementById('file-input').click();
	}
	//#endregion

	//#region File Handling
	async function processSelectedFiles(files) {
		const filesList = document.getElementById('files-list');

		const filesArray = Array.from(files);
		if (filesArray.length === 0) return;

		let remainingUploads = filesArray.length;

		// Disable submit button with initial count
		updateSubmitButtonState(true, remainingUploads);

		// Create all uploading items first
		const uploadPromises = filesArray.map(async (file) => {
			// Create an uploading file item with placeholder
			const uploadingItem = buildUploadingFileItem(file);
			filesList.appendChild(uploadingItem);

			try {
				// Use editMessage.addFile() which handles code execution vs non-code-execution
				const result = await editMessage.addFile(file, file.name);

				// Replace uploading item with real file/attachment item
				// result could be ClaudeFile, ClaudeCodeExecutionFile, or ClaudeAttachment
				const itemElement = result instanceof ClaudeAttachment
					? buildAttachmentItem(result)
					: buildFileItem(result);
				fileElementMap.set(itemElement, result);
				uploadingItem.replaceWith(itemElement);

				// Decrement and update button
				remainingUploads--;
				updateSubmitButtonState(remainingUploads > 0, remainingUploads);

				return { success: true, file: file.name };

			} catch (error) {
				console.error(`Failed to upload ${file.name}:`, error);

				// Convert to error state
				const icon = uploadingItem.querySelector('.w-8.h-8');
				icon.innerHTML = '❌';

				const nameSpan = uploadingItem.querySelector('span.text-text-100');
				nameSpan.innerHTML = `${truncateFilename(file.name)} <span class="text-red-600 text-xs">(upload failed)</span>`;
				nameSpan.title = file.name;

				// Make remove button work
				const removeBtn = uploadingItem.querySelector('button');
				removeBtn.disabled = false;
				removeBtn.style.opacity = '1';
				removeBtn.onclick = () => uploadingItem.remove();

				// Decrement and update button even on failure
				remainingUploads--;
				updateSubmitButtonState(remainingUploads > 0, remainingUploads);

				return { success: false, file: file.name, error };
			}
		});

		// Wait for all uploads to complete
		const results = await Promise.allSettled(uploadPromises);

		// Final check to ensure button is enabled
		updateSubmitButtonState(false, 0);

		// Log summary
		const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
		const failed = results.length - succeeded;
		console.log(`Upload complete: ${succeeded} succeeded, ${failed} failed`);
	}

	function updateSubmitButtonState(uploading, count = 0) {
		// Find our specific modal and its submit button
		const modal = document.querySelector('.claude-edit-modal');
		if (!modal || !modal.submitButton) return;

		if (uploading && count > 0) {
			modal.submitButton.disabled = true;
			modal.submitButton.textContent = `Submit Edit (${count} uploading...)`;
			modal.submitButton.style.opacity = '0.5';
			modal.submitButton.style.cursor = 'not-allowed';
		} else {
			modal.submitButton.disabled = false;
			modal.submitButton.textContent = 'Submit Edit';
			modal.submitButton.style.opacity = '1';
			modal.submitButton.style.cursor = 'pointer';
		}
	}

	async function processSelectedAttachments(files) {
		const filesList = document.getElementById('files-list');

		for (const file of files) {
			// Read the text content
			const content = await readTextFile(file);

			// Use editMessage.addFile() with text content
			// In code execution mode: returns ClaudeCodeExecutionFile
			// In non-code-execution mode: returns ClaudeAttachment
			const result = await editMessage.addFile(content, file.name);

			// Build appropriate item based on result type
			const item = result instanceof ClaudeAttachment
				? buildAttachmentItem(result)
				: buildFileItem(result);
			fileElementMap.set(item, result);
			filesList.appendChild(item);
		}
	}

	function collectModalData() {
		// Update editMessage text from textarea
		editMessage.text = document.getElementById('message-text').value;
		// Files are already managed in editMessage._files via addFile/removeFile
		return {
			styleText: document.getElementById('style-text').value
		};
	}

	async function readTextFile(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (e) => resolve(e.target.result);
			reader.onerror = (e) => reject(e);
			reader.readAsText(file);
		});
	}

	async function formatNewRequest(url, config, editData) {
		const originalBody = JSON.parse(config.body);

		// Extract orgId from URL
		const urlParts = url.split('/');
		const orgId = urlParts[urlParts.indexOf('organizations') + 1];

		// Get completion JSON from editMessage
		const completionJson = editMessage.toCompletionJSON();

		const modifiedBody = {
			...originalBody,
			prompt: completionJson.prompt,
			files: completionJson.files,
			attachments: completionJson.attachments
		};

		// Only update style if it changed from what we showed in the modal
		if (editData.styleText !== editData.originalStyleText) {
			const tempStyleId = await ensureTempStyle(orgId, editData.styleText);
			modifiedBody.personalized_styles = [{
				key: tempStyleId,
				uuid: tempStyleId,
				prompt: editData.styleText,
				name: TEMP_STYLE_NAME,
				isDefault: false,
				type: "custom",
				summary: "This is a temporary style created for editing.",
				attributes: [
					{
						"name": "Assertive",
						"percentage": 0.7
					},
					{
						"name": "Direct",
						"percentage": 0.8
					},
					{
						"name": "Uncompromising",
						"percentage": 0.6
					}
				]
			}];
		}

		return {
			url,
			config: {
				...config,
				body: JSON.stringify(modifiedBody)
			}
		};
	}
	//#endregion

	//#region Style injector for temporary style
	function getTempStyleId() {
		return localStorage.getItem(TEMP_STYLE_STORAGE_KEY);
	}

	function setTempStyleId(styleId) {
		localStorage.setItem(TEMP_STYLE_STORAGE_KEY, styleId);
	}

	async function createTempStyle(orgId, text) {
		try {
			const style = await createStyle(orgId, text, TEMP_STYLE_NAME);
			setTempStyleId(style.uuid);
			return style.uuid;
		} catch (error) {
			console.error('Error creating temp style:', error);
			throw error;
		}
	}

	async function updateTempStyle(orgId, styleId, text) {
		return await updateStyle(orgId, styleId, text, TEMP_STYLE_NAME);
	}

	async function ensureTempStyle(orgId, text) {
		let styleId = getTempStyleId();

		if (!styleId) {
			return await createTempStyle(orgId, text);
		}

		try {
			await updateTempStyle(orgId, styleId, text);
			return styleId;
		} catch (error) {
			// Only recreate if style is missing (404), otherwise re-throw
			if (error.status === 404) {
				console.log('Temp style not found, creating new one');
				return await createTempStyle(orgId, text);
			}

			// For any other error (like 400 content filter), throw it
			throw new Error(error.message);
		}
	}
	//#endregion

	//#region Fetch Patching
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

		// Intercept /completion requests when edit data is pending
		if (url && url.includes('/completion') && pendingEditData && config?.method === 'POST') {
			console.log('Intercepting edit completion request');
			const editData = pendingEditData;
			pendingEditData = null;

			try {
				const modifiedRequest = await formatNewRequest(url, config, editData);
				cleanupEditState();
				return originalFetch(modifiedRequest.url, modifiedRequest.config);
			} catch (error) {
				console.error('Error applying edit modifications:', error);
				cleanupEditState();
				return originalFetch(...args);
			}
		}

		return originalFetch(...args);
	};
	//#endregion

	MessageButtonBar.register({
		buttonClass: 'advanced-edit-button',
		target: 'user',
		createFn: createAdvancedEditButton,
		pages: ['chat'],
		insertFn: insertAdvancedEditButton,
	});
})();
