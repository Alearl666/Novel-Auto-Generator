export function bindActionEvents(deps = {}) {
    const {
        AppState,
        handleStartConversion,
        handleStopProcessing,
        handleRepairFailedMemories,
        showStartFromSelector,
        showProcessedResults,
        toggleMultiSelectMode,
        deleteSelectedMemories,
        updateMemoryQueueUI,
        showSearchModal,
        showReplaceModal,
        showWorldbookView,
        showHistoryView,
        showConsolidateCategorySelector,
        showCleanTagsModal,
        showManualMergeUI,
        showAliasMergeUI,
        updateWorldbookPreview,
    } = deps;

    document.getElementById('ttw-start-btn').addEventListener('click', handleStartConversion);
    document.getElementById('ttw-stop-btn').addEventListener('click', handleStopProcessing);
    document.getElementById('ttw-repair-btn').addEventListener('click', handleRepairFailedMemories);
    document.getElementById('ttw-select-start').addEventListener('click', showStartFromSelector);
    document.getElementById('ttw-view-processed').addEventListener('click', showProcessedResults);

    document.getElementById('ttw-multi-delete-btn').addEventListener('click', toggleMultiSelectMode);
    document.getElementById('ttw-confirm-multi-delete').addEventListener('click', deleteSelectedMemories);
    document.getElementById('ttw-cancel-multi-select').addEventListener('click', () => {
        AppState.ui.isMultiSelectMode = false;
        AppState.ui.selectedIndices.clear();
        updateMemoryQueueUI();
    });

    document.getElementById('ttw-search-btn').addEventListener('click', showSearchModal);
    document.getElementById('ttw-replace-btn').addEventListener('click', showReplaceModal);
    document.getElementById('ttw-view-worldbook').addEventListener('click', showWorldbookView);
    document.getElementById('ttw-view-history').addEventListener('click', showHistoryView);
    document.getElementById('ttw-consolidate-entries').addEventListener('click', showConsolidateCategorySelector);
    document.getElementById('ttw-clean-tags').addEventListener('click', showCleanTagsModal);
    document.getElementById('ttw-manual-merge').addEventListener('click', () => {
        showManualMergeUI(() => {
            if (typeof updateWorldbookPreview === 'function') updateWorldbookPreview();
        });
    });
    document.getElementById('ttw-alias-merge').addEventListener('click', showAliasMergeUI);
}

export function bindExportEvents(deps = {}) {
    const {
        AppState,
        showPromptPreview,
        showPlotOutlineConfigModal,
        importAndMergeWorldbook,
        loadTaskState,
        saveTaskState,
        exportSettings,
        importSettings,
        exportCharacterCard,
        exportVolumes,
        exportToSillyTavern,
        exportChangedEntries,
        showMemoryContentModal,
    } = deps;

    document.getElementById('ttw-preview-prompt').addEventListener('click', showPromptPreview);
    document.getElementById('ttw-plot-export-config').addEventListener('click', showPlotOutlineConfigModal);
    document.getElementById('ttw-import-json').addEventListener('click', importAndMergeWorldbook);
    document.getElementById('ttw-import-task').addEventListener('click', loadTaskState);
    document.getElementById('ttw-export-task').addEventListener('click', saveTaskState);
    document.getElementById('ttw-export-settings').addEventListener('click', exportSettings);
    document.getElementById('ttw-import-settings').addEventListener('click', importSettings);
    document.getElementById('ttw-export-json').addEventListener('click', exportCharacterCard);
    document.getElementById('ttw-export-volumes').addEventListener('click', exportVolumes);
    document.getElementById('ttw-export-st').addEventListener('click', exportToSillyTavern);
    const exportChangedBtn = document.getElementById('ttw-export-changed');
    if (exportChangedBtn && typeof exportChangedEntries === 'function') {
        exportChangedBtn.addEventListener('click', exportChangedEntries);
    }
    document.querySelector('[data-section="settings"]').addEventListener('click', () => {
        document.querySelector('.ttw-settings-section').classList.toggle('collapsed');
    });

    const memoryQueueContainer = document.getElementById('ttw-memory-queue');
    if (memoryQueueContainer) {
        memoryQueueContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.ttw-memory-item');
            if (!item) return;

            const index = parseInt(item.dataset.index, 10);
            if (isNaN(index)) return;

            if (AppState.ui.isMultiSelectMode) {
                const checkbox = item.querySelector('.ttw-memory-checkbox');
                if (e.target.type !== 'checkbox' && checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            } else {
                showMemoryContentModal(index);
            }
        });

        memoryQueueContainer.addEventListener('change', (e) => {
            if (!e.target.classList.contains('ttw-memory-checkbox')) return;

            const item = e.target.closest('.ttw-memory-item');
            const index = parseInt(item?.dataset.index, 10);
            if (isNaN(index)) return;

            if (e.target.checked) {
                AppState.ui.selectedIndices.add(index);
                item.classList.add('selected-for-delete');
            } else {
                AppState.ui.selectedIndices.delete(index);
                item.classList.remove('selected-for-delete');
            }

            const selectedCountEl = document.getElementById('ttw-selected-count');
            if (selectedCountEl) {
                selectedCountEl.textContent = `已选: ${AppState.ui.selectedIndices.size}`;
            }
        });
    }
}

/**
 * 弹出「导入更新章节」的模式选择，返回用户选中的模式。
 *
 * @param {Function} confirmAction ModalFactory 确认弹窗
 * @returns {Promise<'append-only'|'full-file'|null>}
 */
function askUpdateImportMode() {
    return new Promise((resolve) => {
        const existing = document.getElementById('ttw-update-mode-modal');
        if (existing) existing.remove();

        const m = document.createElement('div');
        m.id = 'ttw-update-mode-modal';
        m.className = 'ttw-modal-container';
        m.innerHTML = `
            <div class="ttw-modal" style="max-width:500px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📗 导入更新章节 - 选择模式</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:12px;padding:10px;background:rgba(52,152,219,0.15);border-radius:6px;font-size:12px;color:#3498db;">
                        两种模式都<strong>只把新章节追加到队列末尾</strong>，已处理/已整理/已合并的条目不会被刷新。
                    </div>
                    <label class="ttw-merge-option" style="margin-bottom:10px;">
                        <input type="radio" name="ttw-update-mode" value="append-only" checked>
                        <div>
                            <div style="font-weight:bold;color:#27ae60;">➕ 仅新增模式（推荐）</div>
                            <div style="font-size:11px;color:#888;">导入的文件<strong>只包含新增章节</strong>，全部直接追加到末尾。不做对比，最省事，适合每次只导更新部分。</div>
                        </div>
                    </label>
                    <label class="ttw-merge-option">
                        <input type="radio" name="ttw-update-mode" value="full-file">
                        <div>
                            <div style="font-weight:bold;color:#3498db;">📖 完整文件模式</div>
                            <div style="font-size:11px;color:#888;">导入<strong>更新后的整本TXT</strong>（含原有全部内容），自动识别新增部分并去重追加。</div>
                        </div>
                    </label>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-update-mode-cancel">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-update-mode-confirm">下一步 · 选择文件</button>
                </div>
            </div>
        `;
        document.body.appendChild(m);

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            m.remove();
            resolve(value);
        };

        m.querySelector('.ttw-modal-close').addEventListener('click', () => finish(null));
        m.querySelector('#ttw-update-mode-cancel').addEventListener('click', () => finish(null));
        m.querySelector('#ttw-update-mode-confirm').addEventListener('click', () => {
            const picked = m.querySelector('input[name="ttw-update-mode"]:checked');
            finish(picked ? picked.value : null);
        });
        m.addEventListener('click', (e) => {
            if (e.target === m) finish(null);
        });
    });
}

export function bindFileEvents(deps = {}) {
    const { AppState, handleFileSelect, handleClearFile, importUpdateChapters } = deps;

    const uploadArea = document.getElementById('ttw-upload-area');
    const fileInput = document.getElementById('ttw-file-input');

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#e67e22';
        uploadArea.style.background = 'rgba(230,126,34,0.1)';
    });
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.style.borderColor = '#555';
        uploadArea.style.background = 'transparent';
    });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#555';
        uploadArea.style.background = 'transparent';
        if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
    });

    document.getElementById('ttw-clear-file').addEventListener('click', handleClearFile);
    document.getElementById('ttw-novel-name-input').addEventListener('input', (e) => {
        AppState.file.novelName = e.target.value.trim();
    });

    // ===== 导入更新章节 =====
    const updateBtn = document.getElementById('ttw-import-update-chapters');
    if (updateBtn && typeof importUpdateChapters === 'function') {
        updateBtn.addEventListener('click', async () => {
            const mode = await askUpdateImportMode();
            if (!mode) return;
            await importUpdateChapters(mode);
        });
    }
}

export function bindStreamEvents(deps = {}) {
    const { updateStreamContent, AppState } = deps;

    // 监听用户手动滚动：往上翻就停止跟随，滚回底部自动恢复
    const streamEl = document.getElementById('ttw-stream-content');
    if (streamEl && AppState) {
        streamEl.addEventListener('scroll', () => {
            const atBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight <= 40;
            AppState.ui.streamAutoScroll = atBottom;
            const hint = document.getElementById('ttw-stream-scroll-hint');
            if (hint && atBottom) hint.style.display = 'none';
        });
    }

    document.getElementById('ttw-toggle-stream').addEventListener('click', () => {
        const container = document.getElementById('ttw-stream-container');
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('ttw-clear-stream').addEventListener('click', () => updateStreamContent('', true));

    document.getElementById('ttw-copy-stream').addEventListener('click', () => {
        const streamEl = document.getElementById('ttw-stream-content');
        if (streamEl && streamEl.textContent) {
            navigator.clipboard
                .writeText(streamEl.textContent)
                .then(() => {
                    const btn = document.getElementById('ttw-copy-stream');
                    const orig = btn.textContent;
                    btn.textContent = '✅ 已复制';
                    setTimeout(() => {
                        btn.textContent = orig;
                    }, 1500);
                })
                .catch(() => {
                    const ta = document.createElement('textarea');
                    ta.value = streamEl.textContent;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    const btn = document.getElementById('ttw-copy-stream');
                    btn.textContent = '✅ 已复制';
                    setTimeout(() => {
                        btn.textContent = '📋 复制全部';
                    }, 1500);
                });
        }
    });

    document.getElementById('ttw-debug-mode').addEventListener('change', (e) => {
        const copyBtn = document.getElementById('ttw-copy-stream');
        if (copyBtn) copyBtn.style.display = e.target.checked ? 'inline-block' : 'none';
    });
}

export function bindSettingEvents(deps = {}) {
    const {
        EventDelegate,
        modalContainer,
        AppState,
        saveCurrentSettings,
        handleUseTavernApiChange,
        handleProviderChange,
        handleFetchModels,
        handleQuickTest,
        rechunkMemories,
        showAddCategoryModal,
        confirmAction,
        resetToDefaultCategories,
        renderCategoriesList,
        showAddDefaultEntryModal,
        saveDefaultWorldbookEntriesUI,
        applyDefaultWorldbookEntries,
        showResultSection,
        updateWorldbookPreview,
        ErrorHandler,
        testChapterRegex,
    } = deps;

    EventDelegate.batchOn(modalContainer, {
        '#ttw-use-tavern-api': {
            change: () => {
                handleUseTavernApiChange();
                saveCurrentSettings();
            },
        },
        '#ttw-api-provider': {
            change: () => {
                handleProviderChange();
                saveCurrentSettings();
            },
        },
        '#ttw-model-select': {
            change: (e) => {
                if (e.target.value) {
                    document.getElementById('ttw-api-model').value = e.target.value;
                    saveCurrentSettings();
                }
            },
        },
        '#ttw-fetch-models': { click: handleFetchModels },
        '#ttw-quick-test': { click: handleQuickTest },
        '#ttw-parallel-enabled': {
            change: (e) => {
                AppState.config.parallel.enabled = e.target.checked;
                saveCurrentSettings();
            },
        },
        '#ttw-parallel-concurrency': {
            change: (e) => {
                AppState.config.parallel.concurrency = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3));
                e.target.value = AppState.config.parallel.concurrency;
                saveCurrentSettings();
            },
        },
        '#ttw-parallel-mode': {
            change: (e) => {
                AppState.config.parallel.mode = e.target.value;
                saveCurrentSettings();
            },
        },
        '#ttw-volume-mode': {
            change: (e) => {
                AppState.processing.volumeMode = e.target.checked;
                const indicator = document.getElementById('ttw-volume-indicator');
                if (indicator) indicator.style.display = AppState.processing.volumeMode ? 'block' : 'none';
            },
        },
        '#ttw-rechunk-btn': { click: rechunkMemories },
        '#ttw-add-category': { click: showAddCategoryModal },
        '#ttw-reset-categories': {
            click: async () => {
                if (
                    await confirmAction('确定重置为默认分类配置吗？这将清除所有自定义分类。', {
                        title: '重置分类',
                        danger: true,
                    })
                ) {
                    await resetToDefaultCategories();
                    renderCategoriesList();
                }
            },
        },
        '#ttw-add-default-entry': { click: showAddDefaultEntryModal },
        '#ttw-apply-default-entries': {
            click: () => {
                saveDefaultWorldbookEntriesUI();
                const applied = applyDefaultWorldbookEntries();
                if (applied) {
                    showResultSection(true);
                    updateWorldbookPreview();
                    ErrorHandler.showUserSuccess('默认世界书条目已应用！');
                } else {
                    ErrorHandler.showUserError('没有默认世界书条目');
                }
            },
        },
        '#ttw-chapter-regex': {
            change: (e) => {
                AppState.config.chapterRegex.pattern = e.target.value;
                saveCurrentSettings();
            },
        },
        '#ttw-test-chapter-regex': { click: testChapterRegex },
        '.ttw-chapter-preset': {
            click: (e, btn) => {
                const regex = btn.dataset.regex;
                document.getElementById('ttw-chapter-regex').value = regex;
                AppState.config.chapterRegex.pattern = regex;
                saveCurrentSettings();
            },
        },
        '.ttw-reset-prompt': {
            click: (e, btn) => {
                const type = btn.getAttribute('data-type');
                const textarea = document.getElementById(`ttw-${type}-prompt`);
                if (textarea) {
                    textarea.value = '';
                    saveCurrentSettings();
                }
            },
        },
    });

    [
        'ttw-api-key',
        'ttw-api-endpoint',
        'ttw-api-model',
        'ttw-chunk-size',
        'ttw-api-timeout',
        'ttw-temperature',
        'ttw-max-tokens',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveCurrentSettings);
    });

    [
        'ttw-incremental-mode',
        'ttw-volume-mode',
        'ttw-enable-plot',
        'ttw-enable-style',
        'ttw-force-chapter-marker',
        'ttw-allow-recursion',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveCurrentSettings);
    });
}

export function bindPromptEvents(deps = {}) {
    const { saveCurrentSettings } = deps;

    ['ttw-worldbook-prompt', 'ttw-plot-prompt', 'ttw-style-prompt', 'ttw-suffix-prompt'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', saveCurrentSettings);
    });
}

export function bindMessageChainEvents(deps = {}) {
    const {
        AppState,
        renderMessageChainUI,
        saveCurrentSettings,
        confirmAction,
        alertAction,
        presetImportService,
        restoreSettingsToUI,
    } = deps;

    renderMessageChainUI();
    document.getElementById('ttw-add-chain-msg').addEventListener('click', () => {
        if (!AppState.settings.promptMessageChain) AppState.settings.promptMessageChain = [];
        AppState.settings.promptMessageChain.push({ role: 'user', content: '', enabled: true });
        renderMessageChainUI();
        saveCurrentSettings();
    });
    document.getElementById('ttw-reset-chain').addEventListener('click', async () => {
        if (await confirmAction('确定恢复默认消息链？', { title: '恢复默认消息链' })) {
            AppState.settings.promptMessageChain = [{ role: 'user', content: '{PROMPT}', enabled: true }];
            if (presetImportService) presetImportService.clearImportedPreset();
            renderMessageChainUI();
            saveCurrentSettings();
            if (typeof restoreSettingsToUI === 'function') restoreSettingsToUI();
        }
    });

    // ===== 导入酒馆对话补全预设 =====
    const importBtn = document.getElementById('ttw-import-st-preset');
    const fileInput = document.getElementById('ttw-st-preset-file');
    if (importBtn && fileInput && presetImportService) {
        importBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            e.target.value = ''; // 允许重复导入同一个文件

            try {
                const text = await file.text();
                const json = JSON.parse(text);
                const parsed = presetImportService.parseTavernPreset(json);
                const name = file.name.replace(/\.json$/i, '');

                const summary = presetImportService.buildPresetSummary(name, parsed);
                if (!(await confirmAction(summary, { title: '导入酒馆预设' }))) return;

                presetImportService.applyTavernPreset(parsed, name);
                renderMessageChainUI();
                if (typeof restoreSettingsToUI === 'function') restoreSettingsToUI();

                let msg = `✅ 预设「${name}」已导入`;
                if (AppState.settings.useTavernApi) {
                    msg +=
                        '\n\n⚠️ 当前是酒馆API模式，system/assistant 角色会被压平成纯文本，' +
                        '预设排布不会真正生效。请在上方切换到自定义API模式。';
                }
                if (typeof alertAction === 'function') {
                    await alertAction(msg, { title: '导入完成' });
                }
            } catch (err) {
                if (typeof alertAction === 'function') {
                    await alertAction('预设导入失败：' + err.message, { title: '导入失败' });
                }
            }
        });
    }
}

function toggleCollapsePanel(contentId, header) {
    const content = document.getElementById(contentId);
    const icon = header.querySelector('.ttw-collapse-icon');
    if (content.style.display === 'none' || !content.style.display) {
        content.style.display = 'block';
        icon.textContent = '▼';
    } else {
        content.style.display = 'none';
        icon.textContent = '▶';
    }
}

export function bindCollapsePanelEvents() {
    const categoriesHeader = document.querySelector('[data-target="ttw-categories-content"]');
    if (categoriesHeader) {
        categoriesHeader.addEventListener('click', () =>
            toggleCollapsePanel('ttw-categories-content', categoriesHeader),
        );
    }

    const defaultEntriesHeader = document.querySelector('[data-target="ttw-default-entries-content"]');
    if (defaultEntriesHeader) {
        defaultEntriesHeader.addEventListener('click', () =>
            toggleCollapsePanel('ttw-default-entries-content', defaultEntriesHeader),
        );
    }

    document.querySelectorAll('.ttw-prompt-header[data-target]').forEach((header) => {
        header.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            const targetId = header.getAttribute('data-target');
            if (targetId === 'ttw-default-entries-content' || targetId === 'ttw-categories-content') return;
            toggleCollapsePanel(targetId, header);
        });
    });
}

export function bindModalBasicEvents(deps = {}) {
    const { modalContainer, closeModal, showHelpModal, handleEscKey } = deps;

    const modal = modalContainer.querySelector('.ttw-modal');
    if (!modal) return;

    // Prevent bubbling to SillyTavern extension bar (collapse side effect).
    const stopPropagationHandler = (e) => e.stopPropagation();
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((eventName) => {
        modalContainer.addEventListener(eventName, stopPropagationHandler);
    });

    modalContainer.querySelector('.ttw-modal-close').addEventListener('click', closeModal);
    modalContainer.querySelector('.ttw-help-btn').addEventListener('click', showHelpModal);
    document.addEventListener('keydown', handleEscKey, true);
}
