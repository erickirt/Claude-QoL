// extra-models.js
(function () {
    'use strict';

    const EXTRA_BOOTSTRAP_MODELS = [
        {
            model: 'claude-opus-4-5-20251101',
            name: 'Opus 4.5',
            inactive: true,
            notice_text: 'Opus consumes usage limits faster than other models',
            paprika_modes: ['extended'],
            thinking_modes: [
                {
                    description: 'Think longer for complex tasks',
                    description_key: 'amber_river_echo',
                    id: 'extended',
                    is_default: false,
                    mode: 'extended',
                    paprika_mode_value: 'extended',
                    selection_title: 'Extended',
                    selection_title_key: 'crimson_peak_summit',
                    title: 'Extended thinking',
                    title_key: 'golden_forest_whisper'
                }
            ]
        }
    ];

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const [input] = args;

        let url;
        if (input instanceof URL) {
            url = input.href;
        } else if (typeof input === 'string') {
            url = input;
        } else if (input instanceof Request) {
            url = input.url;
        }

        if (url && url.includes('/edge-api/bootstrap/') && url.includes('/app_start')) {
            const response = await originalFetch(...args);
            if (!response.ok) return response;

            const data = await response.json();

            if (data?.account?.memberships) {
                for (const membership of data.account.memberships) {
                    const config = membership?.organization?.claude_ai_bootstrap_models_config;
                    if (!Array.isArray(config)) continue;

                    for (const extra of EXTRA_BOOTSTRAP_MODELS) {
                        const existing = config.find(entry => entry.model === extra.model);
                        if (existing) {
                            existing.inactive = false;
                        } else {
                            config.push(extra);
                        }
                    }
                }
            }

            return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }

        return originalFetch(...args);
    };
})();
