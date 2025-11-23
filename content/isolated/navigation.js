// navigation.js
(function () {
	'use strict';

	const STORAGE_KEY = 'navigation_bookmarks';

	// #region  STORAGE MANAGEMENT 
	function getBookmarks(conversationId) {
		const allBookmarks = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		return allBookmarks[conversationId] || {};
	}

	function saveBookmarks(conversationId, bookmarks) {
		const allBookmarks = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		allBookmarks[conversationId] = bookmarks;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(allBookmarks));
	}

	function addBookmark(conversationId, name, leafUuid) {
		const bookmarks = getBookmarks(conversationId);
		bookmarks[name] = leafUuid;
		saveBookmarks(conversationId, bookmarks);
	}

	function deleteBookmark(conversationId, name) {
		const bookmarks = getBookmarks(conversationId);
		delete bookmarks[name];
		saveBookmarks(conversationId, bookmarks);
	}

	// #endregion
	// #region  API HELPERS 
	async function getConversation() {
		const conversationId = getConversationId();
		if (!conversationId) {
			throw new Error('Not in a conversation');
		}

		const orgId = getOrgId();
		return new ClaudeConversation(orgId, conversationId);
	}

	// #endregion
	// #region  NAME INPUT MODAL 
	async function showNameInputModal(conversationId, currentLeafId) {
		const name = await showClaudePrompt(
			'Add Bookmark',
			'Bookmark Name:',
			'Enter bookmark name...',
			'',
			(value) => {
				if (!value) {
					return 'Please enter a bookmark name';
				}

				// Check for duplicate names
				const bookmarks = getBookmarks(conversationId);
				if (bookmarks[value]) {
					return 'A bookmark with this name already exists';
				}

				return true;
			}
		);

		addBookmark(conversationId, name, currentLeafId);
		return name;
	}

	// #endregion
	// #region  BOOKMARK ITEM 
	function createBookmarkItem(name, bookmarkUuid, conversationId, conversation, onUpdate) {
		const item = document.createElement('div');
		item.className = CLAUDE_CLASSES.LIST_ITEM + ' flex items-center gap-2';

		// Icon
		const icon = document.createElement('span');
		icon.className = 'text-lg';
		icon.textContent = '📍';
		item.appendChild(icon);

		// Name (clickable area)
		const nameDiv = document.createElement('div');
		nameDiv.className = 'flex-1 text-sm text-text-100 cursor-pointer';
		nameDiv.textContent = name;
		nameDiv.onclick = async () => {
			try {
				// Navigate to the bookmarked leaf
				const longestLeaf = conversation.findLongestLeaf(bookmarkUuid);
				await conversation.setCurrentLeaf(longestLeaf.leafId);
				sessionStorage.setItem('message_uuid_to_find', bookmarkUuid);
				window.location.reload();
			} catch (error) {
				console.error('Navigation failed:', error);
				showClaudeAlert('Navigation Error', 'Failed to navigate. The bookmark may be invalid.');
			}
		};
		item.appendChild(nameDiv);

		// Delete button
		const deleteBtn = createClaudeButton('×', 'icon');
		deleteBtn.classList.remove('h-9', 'w-9');
		deleteBtn.classList.add('h-7', 'w-7', 'text-lg');
		deleteBtn.onclick = async (e) => {
			e.stopPropagation(); // Prevent triggering navigation
			const confirmed = await showClaudeConfirm('Delete Bookmark', `Are you sure you want to delete the bookmark "${name}"?`);
			if (confirmed) {
				deleteBookmark(conversationId, name);
				item.remove();
				onUpdate();
			}
		};
		item.appendChild(deleteBtn);

		return item;
	}

	//#region TREE VIEW MODAL
	function buildBookmarkTree(conversationId, conversation) {
		const ROOT_UUID = "00000000-0000-4000-8000-000000000000";
		const conversationData = conversation.conversationData;

		// Build message map
		const messageMap = new Map();
		for (const msg of conversationData.chat_messages) {
			messageMap.set(msg.uuid, msg);
		}

		// Get all bookmarks
		const bookmarks = getBookmarks(conversationId);
		const bookmarkUuids = Object.values(bookmarks);

		// Build tree structure
		const tree = new Map();
		tree.set(ROOT_UUID, []);

		// For each bookmark, find its parent bookmark
		for (const [name, bookmarkUuid] of Object.entries(bookmarks)) {
			let parentBookmarkUuid = ROOT_UUID;
			let tempId = messageMap.get(bookmarkUuid)?.parent_message_uuid;

			// Walk up until we find another bookmark or hit root
			while (tempId && tempId !== ROOT_UUID) {
				if (bookmarkUuids.includes(tempId)) {
					parentBookmarkUuid = tempId;
					break;
				}
				const parentMsg = messageMap.get(tempId);
				tempId = parentMsg?.parent_message_uuid;
			}

			// Add to tree
			if (!tree.has(parentBookmarkUuid)) {
				tree.set(parentBookmarkUuid, []);
			}
			tree.get(parentBookmarkUuid).push({
				name,
				uuid: bookmarkUuid
			});
		}

		// Calculate depth for each bookmark
		const bookmarkDepths = new Map();
		for (const [name, bookmarkUuid] of Object.entries(bookmarks)) {
			let depth = 0;
			let tempId = bookmarkUuid;
			while (tempId && tempId !== ROOT_UUID) {
				depth++;
				const msg = messageMap.get(tempId);
				tempId = msg?.parent_message_uuid;
			}
			bookmarkDepths.set(bookmarkUuid, depth);
		}

		return { tree, bookmarks, bookmarkDepths };
	}

	function renderBookmarkTree(tree, parentUuid, conversation, onNavigate, bookmarkDepths) {
		const children = tree.get(parentUuid) || [];
		if (children.length === 0) return null;

		// Sort children by depth from root
		children.sort((a, b) => bookmarkDepths.get(a.uuid) - bookmarkDepths.get(b.uuid));

		const container = document.createElement('div');
		container.className = 'bookmark-tree-children';

		for (let i = 0; i < children.length; i++) {
			const bookmark = children[i];
			const isLastChild = i === children.length - 1;

			// Wrapper for each bookmark + its children
			const bookmarkWrapper = document.createElement('div');
			bookmarkWrapper.className = 'bookmark-tree-node bookmark-tree-branch';
			if (isLastChild) {
				bookmarkWrapper.classList.add('last-child');
			}


			// Create bookmark item
			const item = document.createElement('div');
			item.className = 'inline-block py-2 px-3 bg-bg-200 border border-border-300 hover:bg-bg-300 rounded cursor-pointer transition-colors';

			// Check if this bookmark has children (is a branch)
			const hasChildren = tree.has(bookmark.uuid) && tree.get(bookmark.uuid).length > 0;
			const icon = hasChildren ? '📍' : '📍';

			// Create content
			const content = document.createElement('div');
			content.className = 'flex items-center gap-2 whitespace-nowrap';

			const iconSpan = document.createElement('span');
			iconSpan.textContent = icon;
			content.appendChild(iconSpan);

			const nameSpan = document.createElement('span');
			nameSpan.className = 'text-sm text-text-100';
			nameSpan.textContent = bookmark.name;
			content.appendChild(nameSpan);

			item.appendChild(content);

			// Click handler
			item.onclick = async () => {
				try {
					const longestLeaf = conversation.findLongestLeaf(bookmark.uuid);
					await conversation.setCurrentLeaf(longestLeaf.leafId);
					sessionStorage.setItem('message_uuid_to_find', bookmark.uuid);
					window.location.reload();
				} catch (error) {
					console.error('Navigation failed:', error);
					showClaudeAlert('Navigation Error', 'Failed to navigate. The bookmark may be invalid.');
				}
			};

			bookmarkWrapper.appendChild(item);

			// Recursively render children
			const childTree = renderBookmarkTree(tree, bookmark.uuid, conversation, onNavigate, bookmarkDepths);
			if (childTree) {
				bookmarkWrapper.appendChild(childTree);
			}

			container.appendChild(bookmarkWrapper);
		}

		return container;
	}

	async function showBookmarkTreeModal(conversationId, conversation) {
		const { tree, bookmarks, bookmarkDepths } = buildBookmarkTree(conversationId, conversation);

		// Check if there are any bookmarks
		if (Object.keys(bookmarks).length === 0) {
			showClaudeAlert('No Bookmarks', 'You haven\'t created any bookmarks yet.');
			return;
		}

		const contentDiv = document.createElement('div');

		// Create root node (unclickable)
		const rootNode = document.createElement('div');
		rootNode.className = 'inline-block py-2 px-3 bg-bg-300 border border-border-300 rounded opacity-60';
		rootNode.style.cursor = 'default';

		const rootContent = document.createElement('div');
		rootContent.className = 'flex items-center gap-2 whitespace-nowrap';

		const rootIcon = document.createElement('span');
		rootIcon.textContent = '🌳';
		rootContent.appendChild(rootIcon);

		const rootLabel = document.createElement('span');
		rootLabel.className = 'text-sm text-text-200';
		rootLabel.textContent = 'Root';
		rootContent.appendChild(rootLabel);

		rootNode.appendChild(rootContent);
		contentDiv.appendChild(rootNode);

		// Render tree starting from root
		const ROOT_UUID = "00000000-0000-4000-8000-000000000000";
		const treeContainer = renderBookmarkTree(tree, ROOT_UUID, conversation, null, bookmarkDepths);

		if (treeContainer) {
			// Wrap in scrollable container
			const scrollContainer = document.createElement('div');
			scrollContainer.className = 'max-h-[60vh] overflow-y-auto';
			scrollContainer.appendChild(treeContainer);
			contentDiv.appendChild(scrollContainer);
		} else {
			const emptyMsg = document.createElement('div');
			emptyMsg.className = 'text-center text-text-400 py-8';
			emptyMsg.textContent = 'No bookmarks to display.';
			contentDiv.appendChild(emptyMsg);
		}

		// Create and show modal
		const modal = new ClaudeModal('Bookmark Tree View (Sorted by depth)', contentDiv);
		modal.addCancel('Close');

		// Make modal a bit wider
		modal.modal.classList.remove('max-w-md');
		modal.modal.classList.add('max-w-2xl');

		modal.show();
	}
	// #endregion

	//#region MAIN NAVIGATION MODAL
	async function showNavigationModal() {
		const loading = createLoadingModal('Loading conversation data...');
		loading.show();

		let conversation;
		let conversationData;
		try {
			conversation = await getConversation();
			conversationData = await conversation.getData(true);
		} catch (error) {
			console.error('Failed to fetch conversation:', error);
			loading.setTitle('Error');
			loading.setContent('Failed to load conversation data. Please try again.');
			loading.addConfirm('OK');
			return;
		}

		// Close loading modal
		loading.destroy();

		const conversationId = getConversationId();
		const contentDiv = document.createElement('div');

		// Top buttons row
		const topButtonsRow = document.createElement('div');
		topButtonsRow.className = CLAUDE_CLASSES.FLEX_GAP_2 + ' mb-4';

		const latestBtn = createClaudeButton('Go to Latest', 'secondary', async () => {
			let latestMessage = null;
			let latestTimestamp = 0;

			for (const msg of conversationData.chat_messages) {
				const timestamp = new Date(msg.created_at).getTime();
				if (timestamp > latestTimestamp) {
					latestTimestamp = timestamp;
					latestMessage = msg;
				}
			}

			if (latestMessage) {
				await conversation.setCurrentLeaf(latestMessage.uuid);
				window.location.reload();
			}
		});

		const longestBtn = createClaudeButton('Go to Longest', 'secondary', async () => {
			const rootId = "00000000-0000-4000-8000-000000000000";
			const longestLeaf = conversation.findLongestLeaf(rootId);
			await conversation.setCurrentLeaf(longestLeaf.leafId);
			window.location.reload();
		});
		latestBtn.classList.add('w-full');
		longestBtn.classList.add('w-full');

		topButtonsRow.appendChild(latestBtn);
		topButtonsRow.appendChild(longestBtn);
		contentDiv.appendChild(topButtonsRow);

		// Bookmarks list container
		const bookmarksList = document.createElement('div');
		bookmarksList.className = CLAUDE_CLASSES.LIST_CONTAINER;
		bookmarksList.style.maxHeight = '20rem';

		// Function to update the list
		const updateBookmarksList = () => {
			bookmarksList.innerHTML = '';
			const bookmarks = getBookmarks(conversationId);
			const entries = Object.entries(bookmarks);

			if (entries.length === 0) {
				const emptyMsg = document.createElement('div');
				emptyMsg.className = 'text-center text-text-400 py-8';
				emptyMsg.textContent = 'No bookmarks yet. Add your first bookmark below.';
				bookmarksList.appendChild(emptyMsg);
			} else {
				entries.forEach(([name, bookmarkUuid]) => {
					const item = createBookmarkItem(name, bookmarkUuid, conversationId, conversation, updateBookmarksList);
					bookmarksList.appendChild(item);
				});
			}
		};

		updateBookmarksList();
		contentDiv.appendChild(bookmarksList);

		// Bottom buttons row
		const bottomButtonsRow = document.createElement('div');
		bottomButtonsRow.className = CLAUDE_CLASSES.FLEX_GAP_2 + ' mt-4';

		const addBtn = createClaudeButton('+ Add Current Position', 'secondary');
		addBtn.classList.add('w-full');
		addBtn.onclick = async () => {
			try {
				const currentLeafId = conversationData.current_leaf_message_uuid;
				await showNameInputModal(conversationId, currentLeafId);
				updateBookmarksList();
			} catch (error) {
				// User cancelled, do nothing
			}
		};

		const treeBtn = createClaudeButton('🌳 View Tree', 'secondary');
		treeBtn.classList.add('w-full');
		treeBtn.onclick = () => showBookmarkTreeModal(conversationId, conversation);

		bottomButtonsRow.appendChild(addBtn);
		bottomButtonsRow.appendChild(treeBtn);
		contentDiv.appendChild(bottomButtonsRow);

		// Create and show modal
		const modal = new ClaudeModal('Navigation', contentDiv);
		modal.addCancel('Close');
		modal.show();
	}
	// #endregion

	// #endregion
	// #region  BUTTON CREATION 
	function createNavigationButton() {
		const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
		</svg>`;

		const button = createClaudeButton(svgContent, 'icon', showNavigationModal);

		return button;
	}

	// #endregion
	// #region  USER NAVIGATION 
	const UP_ARROW_SVG = `<div class="flex items-center justify-center" style="width: 14px; height: 14px;">
  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true">
    <path d="M3.16011 13.8662C2.98312 13.7018 2.95129 13.4389 3.07221 13.2402L3.13374 13.1602L9.63377 6.16016C9.72836 6.05829 9.86101 6 9.99999 6C10.1043 6 10.2053 6.03247 10.289 6.0918L10.3662 6.16016L16.8662 13.1602C17.054 13.3625 17.0421 13.6783 16.8399 13.8662C16.6375 14.054 16.3217 14.0422 16.1338 13.8399L9.99999 7.2334L3.86616 13.8399L3.78999 13.9072C3.60085 14.0422 3.33709 14.0305 3.16011 13.8662Z"/>
  </svg>
</div>`;

	const DOWN_ARROW_SVG = `<div class="flex items-center justify-center" style="width: 14px; height: 14px;">
  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true">
    <path d="M3.16011 6.13378C2.98312 6.29824 2.95129 6.5611 3.07221 6.75976L3.13374 6.83984L9.63377 13.8398C9.72836 13.9417 9.86101 14 9.99999 14C10.1043 14 10.2053 13.9675 10.289 13.9082L10.3662 13.8398L16.8662 6.83984C17.054 6.6375 17.0421 6.32166 16.8399 6.13378C16.6375 5.94599 16.3217 5.95783 16.1338 6.16015L9.99999 12.7666L3.86616 6.16015L3.78999 6.09277C3.60085 5.95776 3.33709 5.96954 3.16011 6.13378Z"/>
  </svg>
</div>`;

	function addUserNavigationButtons() {
		// Check if portrait mode (mobile)
		if (window.innerHeight > window.innerWidth) {
			// Remove any existing buttons
			document.querySelectorAll('[user-nav-buttons]').forEach(btn => btn.remove());
			return;
		}

		const { userMessages: messages } = getUIMessages();

		messages.forEach((message) => {
			// Find the parent row
			const messageRow = message?.parentElement?.parentElement;
			if (!messageRow) return;

			// Skip if buttons already added
			if (messageRow.querySelector('[user-nav-buttons]')) return;

			// Make the parent row relative for absolute positioning
			messageRow.style.position = 'relative';

			// Create button container
			const navContainer = document.createElement('div');
			navContainer.setAttribute('user-nav-buttons', 'true');
			navContainer.className = 'flex flex-col items-center bg-bg-100/80 border-border-300 border-0.5';
			navContainer.style.position = 'absolute';
			navContainer.style.left = '-50px';
			navContainer.style.top = '50%';
			navContainer.style.transform = 'translateY(-50%)';
			navContainer.style.borderRadius = '6px';
			navContainer.style.opacity = '0';
			navContainer.style.transition = 'opacity 0.2s ease';
			navContainer.style.pointerEvents = 'auto';

			// Create up button
			const upBtn = createClaudeButton(UP_ARROW_SVG, 'icon', () => {
				const { userMessages: allMessages } = getUIMessages();
				const currentIndex = Array.from(allMessages).indexOf(message);
				if (currentIndex > 0) {
					allMessages[currentIndex - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
			});

			// Create down button
			const downBtn = createClaudeButton(DOWN_ARROW_SVG, 'icon', () => {
				const { userMessages: allMessages } = getUIMessages();
				const currentIndex = Array.from(allMessages).indexOf(message);
				if (currentIndex < allMessages.length - 1) {
					allMessages[currentIndex + 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
			});

			navContainer.appendChild(upBtn);
			navContainer.appendChild(downBtn);
			messageRow.appendChild(navContainer);

			// Show on hover
			let hideTimeout;

			messageRow.addEventListener('mouseenter', () => {
				clearTimeout(hideTimeout);
				navContainer.style.opacity = '1';
			});

			messageRow.addEventListener('mouseleave', () => {
				hideTimeout = setTimeout(() => {
					navContainer.style.opacity = '0';
				}, 100); // Small delay
			});
		});
	}
	// #endregion

	// #region MESSAGE BOOKMARK
	function createBookmarkButton() {
		const svgContent = `
        <div class="flex items-center justify-center" style="width: 16px; height: 16px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
        </div>
    `;

		const button = createClaudeButton(svgContent, 'icon');
		button.type = 'button';
		button.setAttribute('data-state', 'closed');
		button.setAttribute('aria-label', 'Bookmark this message');

		button.classList.remove('h-9', 'w-9');
		button.classList.add('h-8', 'w-8');

		createClaudeTooltip(button, 'Bookmark this message');

		button.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();

			// Get the message UUID from the message element
			const messageContainer = e.target.closest('[data-message-uuid]');
			const messageUuid = messageContainer?.dataset.messageUuid;

			if (!messageUuid) {
				showClaudeAlert('Error', 'Could not find message UUID');
				return;
			}

			const conversationId = getConversationId();

			try {
				await showNameInputModal(conversationId, messageUuid);
				showClaudeAlert('Success', 'Bookmark added!');
			} catch (error) {
				// User cancelled, do nothing
			}
		};

		return button;
	}
	// #endregion

	// #region  INITIALIZATION
	// ======== INJECT CSS ========
	function injectTreeStyles() {
		// Check if already injected
		if (document.getElementById('bookmark-tree-styles')) return;

		const style = document.createElement('style');
		style.id = 'bookmark-tree-styles';
		style.textContent = `
		/* Tree structure */
		.bookmark-tree-children {
			display: flex;
			flex-direction: column;
			margin-left: 2rem;
			margin-top: 1rem;  /* Add space between parent and children */
			gap: 0.5rem;
		}

		.bookmark-tree-branch {
			position: relative;
			padding-left: 2rem;
		}

		/* Vertical line */
		.bookmark-tree-branch::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 2px;
			background: var(--text-text-300, #ffffff);
		}

		/* Horizontal line */
		.bookmark-tree-branch::after {
			content: '';
			position: absolute;
			left: 0;
			top: 1.25rem;
			width: 1.5rem;
			height: 2px;
			background: var(--text-text-300, #ffffff);
		}

		/* Last child - stop vertical line at this node */
		.bookmark-tree-branch.last-child::before {
			bottom: auto;
			height: 1.25rem;
		}
	`;

		document.head.appendChild(style);
	}

	function initialize() {
		injectTreeStyles();
		// Add navigation button to top right
		setInterval(() => {
			tryAddTopRightButton("navigation-button", createNavigationButton, 'Navigation');
			addMessageButtonWithPriority(createBookmarkButton, 'bookmark-button');
		}, 1000);

		setInterval(addUserNavigationButtons, 1000);
	}

	// Wait for DOM to be ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();