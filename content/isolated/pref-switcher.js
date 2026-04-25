// pref-switcher.js
(function () {
	'use strict';
	const channel = new BroadcastChannel('pref-switcher-updates');

	const PRESET_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>`;

	channel.addEventListener('message', (event) => {
		if (event.data.type === 'preferences-changed') {
			console.log('Preferences changed in another tab, refreshing UI...');
			updateAllUI();
		}
	});

	async function updateAllUI() {
		setTimeout(async () => {
			// Update the header button appearance
			await updatePresetButtonAppearance();

			// Update settings UI if present
			const settingsSelect = document.querySelector('.preset-manager-settings .preset-selector');
			const settingsContent = document.querySelector('.preset-manager-settings .preset-content');
			if (settingsSelect && settingsContent) {
				await updatePresetSelector(settingsSelect, settingsContent);
			}
		}, 500);
	}


	// ======== API FUNCTIONS ========
	async function getCurrentPreferences() {
		try {
			const response = await fetch('https://claude.ai/api/account_profile', {
				method: 'GET'
			});
			const data = await response.json();
			return data.conversation_preferences || '';
		} catch (error) {
			console.error('Failed to fetch preferences:', error);
			return '';
		}
	}

	async function setPreferences(preferencesText) {
		try {
			const response = await fetch('https://claude.ai/api/account_profile?source=preset-manager', {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					conversation_preferences: preferencesText
				})
			});

			if (response.ok) {
				// Manually trigger the UI update since our fetch won't go through the interceptor
				channel.postMessage({ type: 'preferences-changed' });
				// Trigger our own update as well
				updateAllUI();
			}

			return response.ok;
		} catch (error) {
			console.error('Failed to set preferences:', error);
			return false;
		}
	}

	// ======== PRESET MANAGEMENT ========
	async function getStoredPresets() {
		const presets = await settingsRegistry.get(SETTINGS_KEYS.PREF_SWITCHER.PRESETS);
		// Ensure "None" preset always exists
		if (!presets['None']) {
			presets['None'] = {
				name: 'None',
				content: '',
				lastModified: Date.now()
			};
		}
		return presets;
	}

	async function savePreset(name, content) {
		const presets = await getStoredPresets();
		presets[name] = {
			name: name,
			content: content.trim(),
			lastModified: Date.now()
		};
		await settingsRegistry.set(SETTINGS_KEYS.PREF_SWITCHER.PRESETS, presets);
	}

	async function getCurrentPresetName() {
		const currentPrefs = await getCurrentPreferences();
		const presets = await getStoredPresets();

		// Check if current preferences match any stored preset
		for (const [name, preset] of Object.entries(presets)) {
			if (preset.content.trim() === currentPrefs.trim()) {
				return name;
			}
		}

		// If no match and preferences are not empty, return "Unsaved"
		return currentPrefs.trim() ? 'Unsaved' : 'None';
	}

	// ======== HEADER BUTTON ========
	function createPresetButton() {
		const button = createClaudeButton(PRESET_ICON_SVG, 'icon');
		button.classList.add('shrink-0', 'preset-switcher-button');
		button.onclick = async () => {
			await showPresetPickerModal();
		};
		return button;
	}

	async function showPresetPickerModal() {
		const loadingModal = createLoadingModal('Loading presets...');
		loadingModal.show();

		try {
			const presets = await getStoredPresets();
			const currentPresetName = await getCurrentPresetName();

			loadingModal.destroy();

			const contentContainer = document.createElement('div');

			const selectOptions = [];
			if (currentPresetName === 'Unsaved') {
				selectOptions.push({ value: '__unsaved', label: 'Currently unsaved' });
			}
			for (const name of Object.keys(presets)) {
				selectOptions.push({ value: name, label: name });
			}

			const initialValue = currentPresetName === 'Unsaved' ? '__unsaved' : currentPresetName;
			const select = createClaudeSelect(selectOptions, initialValue);
			select.classList.add('mb-4');

			const infoText = document.createElement('div');
			infoText.className = CLAUDE_CLASSES.TEXT_MUTED;
			infoText.textContent = 'Changing preferences will reset the caching status of the conversation.';

			contentContainer.appendChild(select);
			contentContainer.appendChild(infoText);

			const modal = new ClaudeModal('Switch Preferences Preset', contentContainer);
			modal.addCancel();
			modal.addConfirm('Apply', async () => {
				const selected = select.value;
				if (selected === '__unsaved') return;

				const preset = presets[selected];
				if (!preset) return;

				const ok = await setPreferences(preset.content);
				if (!ok) {
					showClaudeAlert('Error', 'Failed to update preferences. Please try again.');
					return;
				}

				await updatePresetButtonAppearance();
			});

			modal.show();
		} catch (error) {
			console.error('Error loading presets:', error);
			loadingModal.destroy();
			showClaudeAlert('Error', 'Failed to load presets. Please try again.');
		}
	}

	async function updatePresetButtonAppearance() {
		const button = document.querySelector('.preset-switcher-button');
		if (!button) return;

		const currentPresetName = await getCurrentPresetName();

		if (currentPresetName === 'None') {
			button.style.color = '';
		} else {
			button.style.color = '#0084ff';
		}
		button.tooltip?.updateText(`Preferences preset: ${currentPresetName}`);
	}

	// ======== SETTINGS PAGE INTEGRATION ========
	async function findSettingsTextarea() {
		const textarea = document.getElementById('conversation-preferences');
		if (!textarea) return null;

		// Find the parent container (div.group.relative)
		const container = textarea.closest('.group.relative');
		if (!container) return null;

		// Check if we've already processed this
		if (container.dataset.presetManagerProcessed) return null;

		return { textarea, container };
	}

	function createSettingsUI() {
		const container = document.createElement('div');
		container.className = 'preset-manager-settings';

		container.innerHTML = `
        <div class="flex flex-col gap-4">
            <!-- Preset selector row -->
            <div class="flex gap-2 items-end">
                <div class="flex-1">
                    <label class="text-text-200 mb-1 block text-sm">Active Preset</label>
                    <div class="relative">
                        <select class="preset-selector text-text-100 transition-colors cursor-pointer appearance-none w-full h-9 px-3 pr-8 rounded-[0.6rem] bg-bg-000 border border-border-300 hover:border-border-200">
                            <option value="__loading">Loading...</option>
                        </select>
                        <div class="pointer-events-none absolute top-0 right-0 flex items-center px-2 text-text-500 h-9">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M14.128 7.16482C14.3126 6.95983 14.6298 6.94336 14.835 7.12771C15.0402 7.31242 15.0567 7.62952 14.8721 7.83477L10.372 12.835L10.2939 12.9053C10.2093 12.9667 10.1063 13 9.99995 13C9.85833 12.9999 9.72264 12.9402 9.62788 12.835L5.12778 7.83477L5.0682 7.75273C4.95072 7.55225 4.98544 7.28926 5.16489 7.12771C5.34445 6.96617 5.60969 6.95939 5.79674 7.09744L5.87193 7.16482L9.99995 11.7519L14.128 7.16482Z"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <button class="new-preset-btn inline-flex items-center justify-center relative shrink-0
                    text-text-000 font-base-bold border-0.5 border-border-200
                    bg-bg-300/0 hover:bg-bg-400 transition duration-100
                    h-9 px-4 py-2 rounded-lg min-w-[5rem]">
                    New Preset
                </button>
            </div>

            <!-- Preset content editor -->
            <div>
                <label class="text-text-200 mb-1 block text-sm">Preset Content</label>
                <div class="grid">
                    <textarea class="preset-content bg-bg-000 border border-border-300 p-3 leading-5 rounded-[0.6rem] transition-colors hover:border-border-200 placeholder:text-text-500 resize-none w-full"
                        rows="6"
                        placeholder="Enter your preferences here..."
                        data-1p-ignore="true"></textarea>
                </div>
            </div>

            <!-- Action buttons -->
            <div class="flex gap-3 justify-end">
                <button class="delete-preset-btn inline-flex items-center justify-center relative shrink-0
                    text-text-000 font-base-bold border-0.5 border-border-200
                    bg-bg-300/0 hover:bg-bg-400 transition duration-100
                    h-9 px-4 py-2 rounded-lg min-w-[5rem]
                    disabled:pointer-events-none disabled:opacity-50">
                    Delete
                </button>
                <button class="save-preset-btn inline-flex items-center justify-center relative shrink-0
                    bg-text-000 text-bg-000 font-base-bold
                    hover:bg-text-100 transition duration-100
                    h-9 px-4 py-2 rounded-lg min-w-[5rem]">
                    Save Changes
                </button>
            </div>
        </div>
    `;

		// Set up event handlers
		setupSettingsEventHandlers(container);

		return container;
	}

	async function setupSettingsEventHandlers(container) {
		const selector = container.querySelector('.preset-selector');
		const contentArea = container.querySelector('.preset-content');
		const saveBtn = container.querySelector('.save-preset-btn');
		const deleteBtn = container.querySelector('.delete-preset-btn');
		const newBtn = container.querySelector('.new-preset-btn');

		// Load presets into selector
		await updatePresetSelector(selector, contentArea);

		// Handle preset selection change
		selector.addEventListener('change', async () => {
			const presetName = selector.value;
			if (presetName === '__unsaved') {
				const currentPrefs = await getCurrentPreferences();
				contentArea.value = currentPrefs;
				deleteBtn.disabled = true;
			} else {
				const presets = await getStoredPresets();
				const preset = presets[presetName];
				if (preset) {
					contentArea.value = preset.content;
					// Disable delete button for "None" preset
					deleteBtn.disabled = (presetName === 'None');

					// Apply the preset immediately (like the sidebar did)
					await setPreferences(preset.content);
				}
			}
		});

		// Save button
		saveBtn.addEventListener('click', async () => {
			const presetName = selector.value;
			const content = contentArea.value;

			if (presetName === '__unsaved') {
				// Prompt for new name
				const name = await showClaudePrompt('Enter a name for this preset:', 'Preset name');
				if (!name) return;

				await savePreset(name, content);
				await updatePresetSelector(selector, contentArea);
				selector.value = name;
			} else {
				// Update existing preset
				await savePreset(presetName, content);
			}

			// Apply the preferences
			await setPreferences(content);

			// Show success feedback
			saveBtn.textContent = 'Saved!';
			saveBtn.style.background = 'rgb(34, 197, 94)'; // Green color
			setTimeout(() => {
				saveBtn.textContent = 'Save Changes';
				saveBtn.style.background = ''; // Reset to default
			}, 2000);
		});

		// Delete button
		deleteBtn.addEventListener('click', async () => {
			const presetName = selector.value;
			if (presetName === 'None' || presetName === '__unsaved') return;

			if (await showClaudeConfirm(`Delete preset "${presetName}"?`)) {
				const presets = await getStoredPresets();
				delete presets[presetName];
				await settingsRegistry.set(SETTINGS_KEYS.PREF_SWITCHER.PRESETS, presets);

				// Switch to None preset
				await setPreferences('');
				await updatePresetSelector(selector, contentArea);
				selector.value = 'None';
				contentArea.value = '';
			}
		});

		// New preset button
		newBtn.addEventListener('click', async () => {
			const name = await showClaudePrompt('Enter a name for the new preset:', 'Preset name');
			if (!name || name === "") return;

			await savePreset(name, '');
			await updatePresetSelector(selector, contentArea);
			selector.value = name;
			contentArea.value = '';
			contentArea.focus();
		});
	}

	async function updatePresetSelector(selector, contentArea) {
		const presets = await getStoredPresets();
		const currentPresetName = await getCurrentPresetName();

		// Clear and rebuild options
		selector.innerHTML = '';

		// Add Unsaved option if needed
		if (currentPresetName === 'Unsaved') {
			const option = document.createElement('option');
			option.value = '__unsaved';
			option.textContent = 'Unsaved';
			selector.appendChild(option);
		}

		// Add all stored presets
		for (const name of Object.keys(presets)) {
			const option = document.createElement('option');
			option.value = name;
			option.textContent = name;
			selector.appendChild(option);
		}

		// Set current selection
		if (currentPresetName === 'Unsaved') {
			selector.value = '__unsaved';
			const currentPrefs = await getCurrentPreferences();
			contentArea.value = currentPrefs;
		} else {
			selector.value = currentPresetName;
			const preset = presets[currentPresetName];
			if (preset) {
				contentArea.value = preset.content;
			}
		}
	}

	async function tryInjectSettingsUI() {
		const elements = await findSettingsTextarea();
		if (!elements) return;

		const { textarea, container } = elements;

		// Hide the original container
		container.style.display = 'none';
		container.dataset.presetManagerProcessed = 'true';

		// Create and insert our UI
		const settingsUI = createSettingsUI();
		container.parentNode.insertBefore(settingsUI, container);

		console.log('Settings UI injected');
	}

	// ======== INITIALIZATION ========
	function initialize() {
		// Register the header button
		ButtonBar.register({
			buttonClass: 'preset-switcher-button',
			createFn: createPresetButton,
			tooltip: 'Preferences preset: None',
			forceDisplayOnMobile: false,
			pages: ['chat', 'home', 'coworkChat', 'coworkHome'],
			onInjected: () => updatePresetButtonAppearance(),
		});

		// Keep the settings-page UI polling
		tryInjectSettingsUI();
		setInterval(tryInjectSettingsUI, 1000);

		// Refresh settings UI on navigation
		let lastPath = window.location.pathname;
		setInterval(() => {
			if (window.location.pathname !== lastPath) {
				lastPath = window.location.pathname;
				setTimeout(() => {
					tryInjectSettingsUI();
					updatePresetButtonAppearance();
				}, 500);
			}
		}, 1000);
	}

	// Start the script
	setTimeout(initialize);
})();
