// skill-interceptor.js
// Hides the encryption key skill from the skills list.
(function() {
	'use strict';

	const HIDDEN_SKILL_NAME = 'qol-encryptionkey-do-not-delete';

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

		// Filter our skill from the skills list
		if (url && url.includes('/skills/list-skills') && (!config?.method || config.method === 'GET')) {
			const response = await originalFetch(...args);
			if (!response.ok) return response;

			try {
				const data = await response.clone().json();
				if (data.skills && Array.isArray(data.skills)) {
					const before = data.skills.length;
					data.skills = data.skills.filter(s => s.name !== HIDDEN_SKILL_NAME);
					if (data.skills.length !== before) {
						console.log('[QOL-SkillInterceptor] Filtered encryption key skill from skills list');
					}
					return new Response(JSON.stringify(data), {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers
					});
				}
			} catch (e) {
				console.warn('[QOL-SkillInterceptor] Failed to parse skills response:', e.message);
			}
			return response;
		}

		return originalFetch(input, config);
	};
})();
