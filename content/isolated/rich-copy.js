// rich-copy.js
// Adds "Copy as Rich Text" buttons next to copy buttons on Claude's content blocks.
// Copies rendered HTML to clipboard so it pastes with formatting into email, Docs, etc.

(function () {
	'use strict';

	const RICH_COPY_CLASS = 'qol-rich-copy-btn';

	const RICH_COPY_SVG = `<div style="width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;"><path d="M12.5 3A1.5 1.5 0 0 1 14 4.5V6h1.5A1.5 1.5 0 0 1 17 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6 15.5V14H4.5A1.5 1.5 0 0 1 3 12.5v-8A1.5 1.5 0 0 1 4.5 3zm1.5 9.5a1.5 1.5 0 0 1-1.5 1.5H7v1.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5H14zM4.5 4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5z"/><rect x="5.5" y="6.5" width="5" height="1" rx="0.5"/><rect x="5.5" y="9" width="5" height="1" rx="0.5"/><rect x="5.5" y="11.5" width="3" height="1" rx="0.5"/></svg></div>`;

	const CHECK_SVG = `<div style="width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;"><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink: 0;"><path d="M15.3 5.3a1 1 0 0 1 1.4 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4L8 12.58l7.3-7.3z"/></svg></div>`;

	function findContentBlockCopyButtons() {
		const results = [];
		const copyButtons = document.querySelectorAll('button[aria-label="Copy message"]');

		for (const btn of copyButtons) {
			if (btn.dataset.testid === 'action-bar-copy') continue;
			if (btn.closest('[role="group"][aria-label="Message actions"]')) continue;

			const actionBar = btn.closest('.justify-end.gap-2');
			if (!actionBar) continue;
			if (actionBar.querySelector('.' + RICH_COPY_CLASS)) continue;

			results.push(btn);
		}

		return results;
	}

	function findContentArea(actionBar) {
		const RENDERED_TAGS = 'p, h1, h2, h3, h4, h5, h6, pre, ol, ul, table, blockquote';
		let container = actionBar.parentElement;
		for (let i = 0; i < 5 && container; i++) {
			for (const child of container.children) {
				if (child === actionBar || child.contains(actionBar)) continue;
				if (child.tagName === 'TEXTAREA' || child.tagName === 'INPUT') continue;
				if (child.querySelector('textarea, input[type="text"]')) continue;
				if (child.querySelector(RENDERED_TAGS) && child.textContent?.trim().length > 20) return child;
			}
			container = container.parentElement;
		}
		return null;
	}

	function cleanHtmlForClipboard(contentEl) {
		const clone = contentEl.cloneNode(true);
		clone.querySelectorAll('button, svg, [role="button"], .' + RICH_COPY_CLASS).forEach(el => el.remove());
		return clone.innerHTML;
	}

	function copyAsRichText(actionBar, button) {
		const contentEl = findContentArea(actionBar);
		if (!contentEl) {
			showClaudeAlert('Error', 'Could not find content to copy.');
			return;
		}

		const html = cleanHtmlForClipboard(contentEl);
		const plainText = contentEl.textContent?.trim() || '';

		if (!plainText) {
			showClaudeAlert('Error', 'No content to copy.');
			return;
		}

		const listener = (e) => {
			e.clipboardData.setData('text/html', html);
			e.clipboardData.setData('text/plain', plainText);
			e.preventDefault();
		};

		document.addEventListener('copy', listener);
		const success = document.execCommand('copy');
		document.removeEventListener('copy', listener);

		if (success) {
			const original = button.innerHTML;
			button.innerHTML = CHECK_SVG;
			setTimeout(() => { button.innerHTML = original; }, 1500);
		} else {
			showClaudeAlert('Error', 'Failed to copy rich text to clipboard.');
		}
	}

	function createRichCopyButton(actionBar) {
		const copyBtnClasses = `inline-flex items-center justify-center relative isolate shrink-0 can-focus select-none disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none disabled:drop-shadow-none border-transparent transition font-base duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] h-8 w-8 rounded-md`;

		const pill = document.createElement('div');
		pill.className = 'flex items-center h-8 bg-bg-000 rounded-lg border-0.5 border-border-300 shadow-sm overflow-hidden ' + RICH_COPY_CLASS;

		const wrapper = document.createElement('div');
		wrapper.className = 'w-fit';

		const btn = document.createElement('button');
		btn.className = copyBtnClasses;
		btn.type = 'button';
		btn.setAttribute('aria-label', 'Copy as rich text');
		btn.innerHTML = RICH_COPY_SVG;

		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			copyAsRichText(actionBar, btn);
		});

		createClaudeTooltip(btn, 'Copy as rich text');

		wrapper.appendChild(btn);
		pill.appendChild(wrapper);
		return pill;
	}

	function injectButtons() {
		const copyButtons = findContentBlockCopyButtons();
		for (const copyBtn of copyButtons) {
			const actionBar = copyBtn.closest('.justify-end.gap-2');
			if (!actionBar) continue;

			const copyPill = copyBtn.closest('.bg-bg-000.rounded-lg');
			if (!copyPill) continue;

			const richBtn = createRichCopyButton(actionBar);
			copyPill.parentElement.insertBefore(richBtn, copyPill.nextSibling);
		}
	}

	function initialize() {
		setInterval(injectButtons, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initialize);
	} else {
		initialize();
	}
})();
