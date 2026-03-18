// stt-input.js
(function () {
	'use strict';

	// ======== STT PROVIDERS CONFIGURATION ========
	const STT_PROVIDERS = {
		browser: {
			name: 'Browser (Free)',
			requiresApiKey: false,
			class: BrowserSTTProvider
		},
		groq: {
			name: 'Groq (Fast & Cheap)',
			requiresApiKey: true,
			class: GroqSTTProvider
		},
		openai: {
			name: 'OpenAI (Expensive)',
			requiresApiKey: true,
			class: OpenAISTTProvider
		}
	};

	// ======== STATE AND SETTINGS ========
	let sttProvider = null;
	let micButton = null;
	let currentState = 'idle'; // idle, recording, loading

	// ======== SETTINGS MANAGEMENT ========
	const S = SETTINGS_KEYS.STT;

	async function showSettingsModal() {
		// Get available audio devices - request permission if needed
		let audioDevices = [];
		try {
			let devices = await navigator.mediaDevices.enumerateDevices();
			const audioInputs = devices.filter(device => device.kind === 'audioinput');

			const hasPermission = audioInputs.some(device => device.label && device.label.length > 0);

			if (!hasPermission && audioInputs.length > 0) {
				try {
					console.log('Requesting microphone permission for device list...');
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					stream.getTracks().forEach(track => track.stop());
					devices = await navigator.mediaDevices.enumerateDevices();
				} catch (permError) {
					console.error('User denied microphone permission:', permError);
				}
			}

			audioDevices = devices.filter(device => device.kind === 'audioinput');
		} catch (error) {
			console.error('Error enumerating devices:', error);
		}

		// Build device options
		const deviceOptions = [{ value: 'default', label: 'Use default' }];
		audioDevices.forEach(device => {
			if (device.deviceId && device.deviceId !== 'default' && device.label) {
				deviceOptions.push({ value: device.deviceId, label: device.label });
			}
		});
		const needsPermission = deviceOptions.length === 1;

		// Build settings fields
		const enabledField = new SettingsField(S.ENABLED, {
			element: createClaudeToggle('Enable Speech-to-Text', false),
		});

		const providerOptions = Object.entries(STT_PROVIDERS)
			.filter(([key, config]) => config.class.isAvailable())
			.map(([key, config]) => ({ value: key, label: config.name }));
		const providerField = new SettingsField(S.PROVIDER, {
			label: 'STT Provider',
			element: createClaudeSelect(providerOptions, 'browser'),
		});

		const apiKeyField = new SettingsField(S.API_KEY, {
			label: 'API Key',
			element: createClaudeInput({ type: 'password', placeholder: 'Enter API key...' }),
		});

		const baseUrlField = new SettingsField(S.BASE_URL, {
			label: 'Base URL (optional)',
			element: createClaudeInput({ type: 'text', placeholder: 'https://api.openai.com' }),
			hint: 'For OpenAI-compatible APIs (LocalAI, vLLM, etc.)',
			transform: v => v.replace(/\/+$/, ''),  // Strip trailing slashes
		});

		const audioDeviceField = new SettingsField(S.AUDIO_DEVICE, {
			label: 'Audio Input Device',
			element: createClaudeSelect(deviceOptions, 'default'),
		});

		// Add permission message if needed
		if (needsPermission) {
			const permissionNote = document.createElement('div');
			permissionNote.className = CLAUDE_CLASSES.TEXT_MUTED + ' mt-1';
			permissionNote.textContent = 'Grant microphone permission to see available devices';
			audioDeviceField.container.appendChild(permissionNote);

			const requestPermButton = createClaudeButton(
				'Request Microphone Access',
				'secondary',
				async () => {
					try {
						const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
						stream.getTracks().forEach(track => track.stop());
						modal.destroy();
						await showSettingsModal();
					} catch (err) {
						showClaudeAlert('Permission Denied', 'Microphone permission denied. Please allow microphone access in your browser settings.');
					}
				}
			);
			requestPermButton.className += ' mt-2';
			audioDeviceField.container.appendChild(requestPermButton);
		}

		const autoSendField = new SettingsField(S.AUTO_SEND, {
			element: createClaudeToggle('Auto-send after transcription', false),
		});

		// Load all values from storage
		const fields = [enabledField, providerField, apiKeyField, baseUrlField, audioDeviceField, autoSendField];
		await Promise.all(fields.map(f => f.load()));

		// Build modal content
		const contentDiv = document.createElement('div');
		fields.forEach(f => contentDiv.appendChild(f.container));

		// Conditional field visibility based on provider
		function updateFieldVisibility() {
			const providerKey = providerField.value();
			const provider = STT_PROVIDERS[providerKey];
			apiKeyField.container.style.display = provider.requiresApiKey ? 'block' : 'none';
			baseUrlField.container.style.display = providerKey === 'openai' ? 'block' : 'none';
		}
		updateFieldVisibility();
		providerField.element.addEventListener('change', updateFieldVisibility);

		// Create modal
		const modal = new ClaudeModal('STT Settings', contentDiv);
		modal.addCancel('Cancel');
		modal.addConfirm('Save', async (btn, modal) => {
			const provider = STT_PROVIDERS[providerField.value()];

			// Validate API key if provider requires it
			if (provider.requiresApiKey && !apiKeyField.value()) {
				showClaudeAlert('API Key Required', 'Please enter an API key for this provider.');
				return false;
			}
			if (provider.requiresApiKey && apiKeyField.value()) {
				const loadingModal = createLoadingModal('Validating API key...');
				loadingModal.show();

				const isValid = providerField.value() === 'openai'
					? await provider.class.validateApiKey(apiKeyField.value(), baseUrlField.value())
					: await provider.class.validateApiKey(apiKeyField.value());

				if (!isValid) {
					loadingModal.destroy();
					showClaudeAlert('Validation Error', 'Invalid API key');
					return false; // Keep modal open
				}

				loadingModal.destroy();
			}

			await Promise.all(fields.map(f => f.save()));
			return true; // Close modal
		});

		modal.show();
	}

	// ======== RECORDING FUNCTIONS ========
	async function startRecording() {
		try {
			const [providerKey, apiKey, audioDevice, openaiBaseUrl] = await Promise.all([
				settingsRegistry.get(S.PROVIDER),
				settingsRegistry.get(S.API_KEY),
				settingsRegistry.get(S.AUDIO_DEVICE),
				settingsRegistry.get(S.BASE_URL),
			]);

			const providerConfig = STT_PROVIDERS[providerKey];

			if (!providerConfig) {
				throw new Error('Invalid provider');
			}

			// Check if API key is required but missing
			if (providerConfig.requiresApiKey && !apiKey) {
				showClaudeAlert('API Key Required', 'Please set your API key in settings first.');
				return;
			}

			// Instantiate the provider (pass baseUrl for OpenAI)
			sttProvider = providerKey === 'openai'
				? new providerConfig.class(apiKey, openaiBaseUrl)
				: new providerConfig.class(apiKey);

			// Start recording
			await sttProvider.startRecording(audioDevice);
			currentState = 'recording';
			updateMicButton();

		} catch (error) {
			console.error('Error starting recording:', error);
			showClaudeAlert('Microphone Error', 'Failed to access microphone. Please check permissions.');
		}
	}

	async function stopRecording() {
		if (!sttProvider) {
			return;
		}

		try {
			currentState = 'loading';
			updateMicButton();

			const transcription = await sttProvider.stopRecording();

			const autoSend = await settingsRegistry.get(S.AUTO_SEND);
			insertTextAndSend(transcription, autoSend);

			sttProvider = null;
			currentState = 'idle';
			updateMicButton();

		} catch (error) {
			console.error('Transcription error:', error);
			sttProvider = null;
			currentState = 'idle';
			updateMicButton();

			// Show error modal
			showClaudeAlert('Transcription Failed', 'An error occurred during transcription. Please try again.');
		}
	}

	// ======== TEXT INSERTION ========
	function insertTextAndSend(text, autoSend) {
		const simpleTextarea = document.querySelector('.claude-simple-input');
		if (simpleTextarea) {
			simpleTextarea.value = text;
			simpleTextarea.dispatchEvent(new Event('input', { bubbles: true }));

			if (autoSend) {
				const submitButton = document.querySelector('.claude-custom-submit') ||
					document.querySelector('button[aria-label="Send message"]');
				if (submitButton && !submitButton.disabled) {
					submitButton.click();
				}
			}
		} else {
			const proseMirrorDiv = document.querySelector('.ProseMirror');
			if (proseMirrorDiv) {
				proseMirrorDiv.innerHTML = '';
				const lines = text.split('\n');
				lines.forEach(line => {
					const p = document.createElement('p');
					p.textContent = line || '\u00A0';
					proseMirrorDiv.appendChild(p);
				});

				proseMirrorDiv.dispatchEvent(new Event('input', { bubbles: true }));
				proseMirrorDiv.dispatchEvent(new Event('change', { bubbles: true }));

				if (autoSend) {
					setTimeout(() => {
						const submitButton = document.querySelector('button[aria-label="Send message"]');
						if (submitButton && !submitButton.disabled) {
							submitButton.click();
						}
					}, 100);
				}
			}
		}
	}

	// ======== UI CREATION ========
	function createSettingsButton() {
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <line x1="12" y1="19" x2="12" y2="23"></line>
        <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>`;

		const button = createClaudeButton(svgContent, 'icon', showSettingsModal);

		return button;
	}

	function createMicButton() {
		const container = document.createElement('div');
		container.className = 'stt-mic-container inline-flex gap-1';
		container.style.display = 'inline-flex';

		updateMicButton(container);
		return container;
	}

	function updateMicButton(container) {
		if (!container) {
			container = document.querySelector('.stt-mic-container');
			if (!container) return;
		}

		container.innerHTML = '';

		const button = document.createElement('button');
		button.className = `inline-flex items-center justify-center relative shrink-0 
            disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none 
            disabled:drop-shadow-none text-white transition-colors h-8 w-8 rounded-lg active:scale-95`;
		button.style.backgroundColor = '#2c84db';
		button.style.cssText += 'background-color: #2c84db !important;';

		button.onmouseover = () => button.style.backgroundColor = '#2573c4';
		button.onmouseout = () => button.style.backgroundColor = '#2c84db';

		switch (currentState) {
			case 'idle':
				button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                </svg>`;
				button.onclick = startRecording;
				break;

			case 'recording':
				button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                </svg>`;
				button.onclick = stopRecording;
				break;

			case 'loading':
				button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="animate-spin">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                </svg>`;
				button.disabled = true;
				button.onclick = null;
				break;
		}

		container.appendChild(button);
	}

	// ======== BUTTON INSERTION ========
	async function tryAddMicButton() {
		const enabled = await settingsRegistry.get(S.ENABLED);

		if (!enabled) {
			const existing = document.querySelector('.stt-mic-container');
			if (existing) existing.remove();
			return;
		}
		if (window.location.href.includes('claude.ai/code')) return; // Don't show in code web
		if (document.querySelector('.stt-mic-container')) return;

		// Use model-selector-dropdown as a stable landmark to find the input toolbar.
		// This works regardless of whether the send button or voice button is showing.
		const modelSelector = document.querySelector('button[data-testid="model-selector-dropdown"]');
		if (!modelSelector) return;

		// Walk up to the toolbar row (flex items-center container)
		const toolbar = modelSelector.closest('.flex.items-center');
		if (!toolbar) return;

		// Find the model selector's direct child within the toolbar, then insert after it
		let modelSection = modelSelector;
		while (modelSection.parentElement !== toolbar) modelSection = modelSection.parentElement;

		const sendArea = modelSection.nextElementSibling;
		if (!sendArea) return;

		const micContainer = createMicButton();
		toolbar.insertBefore(micContainer, sendArea);
	}

	// ======== INITIALIZATION ========
	async function initialize() {
		if (navigator.userAgent.toLowerCase().includes('electron')) return;
		const style = document.createElement('style');
		style.id = 'stt-spinner-style';
		style.textContent = `
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .animate-spin {
                animation: spin 1s linear infinite;
            }
        `;
		if (!document.querySelector('#stt-spinner-style')) {
			document.head.appendChild(style);
		}

		/*
		// Register shortcut with manager
		await shortcutManager.register('stt-toggle');

		// Listen for shortcut messages
		window.addEventListener('message', (event) => {
			if (event.data.type === 'shortcut' && event.data.action === 'stt-toggle') {
				const button = document.querySelector('.stt-mic-container button');
				if (button) button.click();
			}
		});
		*/

		ButtonBar.register({
			buttonClass: 'stt-settings-button',
			createFn: createSettingsButton,
			tooltip: 'STT Settings',
			pages: ['chat', 'home', 'coworkHome', 'codeHome', 'coworkChat', 'codeChat'],
		});
		setInterval(() => tryAddMicButton(), 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();