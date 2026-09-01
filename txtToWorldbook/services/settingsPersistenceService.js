export function createSettingsPersistenceService(deps) {
    const { AppState, defaultSettings, updateSettingsUI, updateChapterRegexUI, handleProviderChange } = deps;

    function saveCurrentSettings() {
        AppState.settings.chunkSize = parseInt(document.getElementById('ttw-chunk-size')?.value) || 15000;
        AppState.settings.apiTimeout = (parseInt(document.getElementById('ttw-api-timeout')?.value) || 120) * 1000;

        // ===== 采样参数（界面可调；导入酒馆预设时会被预设值覆盖）=====
        // 温度允许为 0，所以不能用 || 兜底，必须显式判空。
        const tempRaw = document.getElementById('ttw-temperature')?.value;
        if (tempRaw !== undefined && tempRaw !== null && String(tempRaw).trim() !== '') {
            const t = parseFloat(tempRaw);
            if (!isNaN(t)) AppState.settings.presetTemperature = Math.min(2, Math.max(0, t));
        }
        // 最大输出留空表示「用接口默认值」，存为 null 而不是 0。
        const maxTokRaw = document.getElementById('ttw-max-tokens')?.value;
        if (maxTokRaw !== undefined && maxTokRaw !== null) {
            const trimmed = String(maxTokRaw).trim();
            if (trimmed === '') {
                AppState.settings.presetMaxTokens = null;
            } else {
                const mt = parseInt(trimmed, 10);
                AppState.settings.presetMaxTokens = !isNaN(mt) && mt > 0 ? mt : null;
            }
        }
        AppState.processing.incrementalMode = document.getElementById('ttw-incremental-mode')?.checked ?? true;
        AppState.processing.volumeMode = document.getElementById('ttw-volume-mode')?.checked ?? false;
        AppState.settings.useVolumeMode = AppState.processing.volumeMode;
        AppState.settings.enablePlotOutline = document.getElementById('ttw-enable-plot')?.checked ?? false;
        AppState.settings.enableLiteraryStyle = document.getElementById('ttw-enable-style')?.checked ?? false;
        AppState.settings.customWorldbookPrompt = document.getElementById('ttw-worldbook-prompt')?.value || '';
        AppState.settings.customPlotPrompt = document.getElementById('ttw-plot-prompt')?.value || '';
        AppState.settings.customStylePrompt = document.getElementById('ttw-style-prompt')?.value || '';
        AppState.settings.useTavernApi = document.getElementById('ttw-use-tavern-api')?.checked ?? false;
        AppState.settings.parallelEnabled = AppState.config.parallel.enabled;
        AppState.settings.parallelConcurrency = AppState.config.parallel.concurrency;
        AppState.settings.parallelMode = AppState.config.parallel.mode;
        AppState.settings.categoryLightSettings = { ...AppState.config.categoryLight };
        AppState.settings.forceChapterMarker = document.getElementById('ttw-force-chapter-marker')?.checked ?? true;
        AppState.settings.chapterRegexPattern =
            document.getElementById('ttw-chapter-regex')?.value || AppState.config.chapterRegex.pattern;
        AppState.settings.defaultWorldbookEntriesUI = AppState.persistent.defaultEntries;
        AppState.settings.categoryDefaultConfig = AppState.config.categoryDefault;
        AppState.settings.entryPositionConfig = AppState.config.entryPosition;
        AppState.settings.customSuffixPrompt = document.getElementById('ttw-suffix-prompt')?.value || '';
        AppState.settings.customApiProvider = document.getElementById('ttw-api-provider')?.value || 'openai-compatible';
        AppState.settings.customApiKey = document.getElementById('ttw-api-key')?.value || '';
        AppState.settings.customApiEndpoint = document.getElementById('ttw-api-endpoint')?.value || '';

        const modelSelectContainer = document.getElementById('ttw-model-select-container');
        const modelSelect = document.getElementById('ttw-model-select');
        const modelInput = document.getElementById('ttw-api-model');
        if (modelSelectContainer && modelSelectContainer.style.display !== 'none' && modelSelect?.value) {
            AppState.settings.customApiModel = modelSelect.value;
            if (modelInput) modelInput.value = modelSelect.value;
        } else {
            AppState.settings.customApiModel = modelInput?.value || 'gemini-2.5-flash';
        }

        AppState.settings.allowRecursion = document.getElementById('ttw-allow-recursion')?.checked ?? false;
        AppState.settings.filterResponseTags = document.getElementById('ttw-filter-tags')?.value || 'thinking,/think';
        AppState.settings.debugMode = document.getElementById('ttw-debug-mode')?.checked ?? false;
        AppState.settings.plotOutlineExportConfig = AppState.config.plotOutline;

        try {
            localStorage.setItem('txtToWorldbookSettings', JSON.stringify(AppState.settings));
        } catch (e) {
            console.warn('[TTW] 设置保存失败:', e.message);
        }
    }

    function loadSavedSettings() {
        try {
            const saved = localStorage.getItem('txtToWorldbookSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                AppState.settings = { ...defaultSettings, ...parsed };
                AppState.processing.volumeMode = AppState.settings.useVolumeMode || false;
                AppState.config.parallel.enabled =
                    AppState.settings.parallelEnabled !== undefined ? AppState.settings.parallelEnabled : true;
                AppState.config.parallel.concurrency = AppState.settings.parallelConcurrency || 3;
                AppState.config.parallel.mode = AppState.settings.parallelMode || 'independent';

                if (AppState.settings.chapterRegexPattern) {
                    AppState.config.chapterRegex.pattern = AppState.settings.chapterRegexPattern;
                }
                if (AppState.settings.defaultWorldbookEntriesUI) {
                    AppState.persistent.defaultEntries = AppState.settings.defaultWorldbookEntriesUI;
                }
                if (AppState.settings.categoryDefaultConfig) {
                    AppState.config.categoryDefault = AppState.settings.categoryDefaultConfig;
                }
                if (AppState.settings.entryPositionConfig) {
                    AppState.config.entryPosition = AppState.settings.entryPositionConfig;
                }
                if (AppState.settings.plotOutlineExportConfig) {
                    AppState.config.plotOutline = AppState.settings.plotOutlineExportConfig;
                }
            }
        } catch (e) {
            console.warn('[TTW] 设置加载失败，使用默认值:', e.message);
        }

        updateSettingsUI();
        updateChapterRegexUI();
        handleProviderChange();
    }

    return {
        saveCurrentSettings,
        loadSavedSettings,
    };
}
