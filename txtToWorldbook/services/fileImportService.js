export function createFileImportService(deps = {}) {
    const {
        AppState,
        MemoryHistoryDB,
        Logger,
        ErrorHandler,
        confirmAction,
        fileUtils,
        updateMemoryQueueUI,
        updateStartButtonState,
        showQueueSection,
        showProgressSection,
        showResultSection,
        updateWorldbookPreview,
        applyDefaultWorldbookEntries,
        saveCurrentSettings,
    } = deps;

    async function handleFileSelect(file) {
        if (!file.name.endsWith('.txt')) {
            ErrorHandler.showUserError('请选择TXT文件');
            return;
        }

        const maxFileSize = 100 * 1024 * 1024;
        if (file.size > maxFileSize) {
            ErrorHandler.showUserError(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），最大支持 100 MB`);
            return;
        }

        try {
            const { encoding, content } = await fileUtils.detectBestEncoding(file);
            AppState.file.current = file;

            const newHash = await fileUtils.calculateFileHash(content);
            const savedHash = await MemoryHistoryDB.getSavedFileHash();
            if (savedHash && savedHash !== newHash) {
                const historyList = await MemoryHistoryDB.getAllHistory();
                if (
                    historyList.length > 0 &&
                    (await confirmAction(`检测到新文件，是否清空旧历史？\n当前有 ${historyList.length} 条记录。`, {
                        title: '清空旧历史',
                        danger: true,
                    }))
                ) {
                    await MemoryHistoryDB.clearAllHistory();
                    await MemoryHistoryDB.clearAllRolls();
                    await MemoryHistoryDB.clearState();
                }
            }

            AppState.file.hash = newHash;
            await MemoryHistoryDB.saveFileHash(newHash);

            document.getElementById('ttw-upload-area').style.display = 'none';
            document.getElementById('ttw-file-info').style.display = 'flex';
            document.getElementById('ttw-file-name').textContent = file.name;
            document.getElementById('ttw-file-size').textContent =
                `(${(content.length / 1024).toFixed(1)} KB, ${encoding})`;

            AppState.file.novelName = file.name.replace(/\.[^/.]+$/, '');

            const novelNameInput = document.getElementById('ttw-novel-name-input');
            if (novelNameInput) novelNameInput.value = AppState.file.novelName;
            const novelNameRow = document.getElementById('ttw-novel-name-row');
            if (novelNameRow) novelNameRow.style.display = 'flex';

            splitContentIntoMemory(content);
            showQueueSection(true);
            updateMemoryQueueUI();

            document.getElementById('ttw-start-btn').disabled = false;
            AppState.memory.startIndex = 0;
            AppState.memory.userSelectedIndex = null;

            AppState.worldbook.generated = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
            applyDefaultWorldbookEntries();
            if (Object.keys(AppState.worldbook.generated).length > 0) {
                showResultSection(true);
                updateWorldbookPreview();
            }

            updateStartButtonState(false);
        } catch (error) {
            ErrorHandler.showUserError('文件处理失败: ' + error.message);
        }
    }

    function splitContentIntoMemory(content) {
        const chunkSize = AppState.settings.chunkSize;
        const minChunkSize = Math.max(chunkSize * 0.3, 5000);
        AppState.memory.queue = [];

        const chapterRegex = new RegExp(AppState.config.chapterRegex.pattern, 'g');
        const matches = [];
        const maxTime = 5000;
        const startTime = Date.now();
        let match;
        while ((match = chapterRegex.exec(content)) !== null) {
            matches.push(match);
            if (Date.now() - startTime > maxTime) {
                Logger.warn('FileImport', '章节正则匹配超时(5秒)，已中断');
                break;
            }
            if (match[0].length === 0) chapterRegex.lastIndex++;
        }

        if (matches.length > 0) {
            const chapters = [];

            for (let i = 0; i < matches.length; i++) {
                const startIndex = matches[i].index;
                const endIndex = i < matches.length - 1 ? matches[i + 1].index : content.length;
                let chapterContent = content.slice(startIndex, endIndex);

                if (i === 0 && startIndex > 0) {
                    const preContent = content.slice(0, startIndex);
                    chapterContent = preContent + chapterContent;
                }

                chapters.push({ title: matches[i][0], content: chapterContent });
            }

            const mergedChapters = [];
            let pendingChapter = null;

            for (const chapter of chapters) {
                if (pendingChapter) {
                    if (pendingChapter.content.length + chapter.content.length <= chunkSize) {
                        pendingChapter.content += chapter.content;
                        pendingChapter.title += '+' + chapter.title;
                    } else if (pendingChapter.content.length >= minChunkSize) {
                        mergedChapters.push(pendingChapter);
                        pendingChapter = chapter;
                    } else {
                        pendingChapter.content += chapter.content;
                        pendingChapter.title += '+' + chapter.title;
                    }
                } else {
                    pendingChapter = { ...chapter };
                }
            }

            if (pendingChapter) {
                mergedChapters.push(pendingChapter);
            }

            let currentChunk = '';
            let chunkIndex = 1;

            for (let i = 0; i < mergedChapters.length; i++) {
                const chapter = mergedChapters[i];

                if (chapter.content.length > chunkSize) {
                    if (currentChunk.length > 0) {
                        AppState.memory.queue.push(createMemoryChunk(currentChunk, chunkIndex));
                        currentChunk = '';
                        chunkIndex++;
                    }

                    let remaining = chapter.content;
                    while (remaining.length > 0) {
                        let endPos = Math.min(chunkSize, remaining.length);
                        if (endPos < remaining.length) {
                            const paragraphBreak = remaining.lastIndexOf('\n\n', endPos);
                            if (paragraphBreak > endPos * 0.5) {
                                endPos = paragraphBreak + 2;
                            } else {
                                const sentenceBreak = remaining.lastIndexOf('。', endPos);
                                if (sentenceBreak > endPos * 0.5) {
                                    endPos = sentenceBreak + 1;
                                }
                            }
                        }

                        AppState.memory.queue.push(createMemoryChunk(remaining.slice(0, endPos), chunkIndex));
                        remaining = remaining.slice(endPos);
                        chunkIndex++;
                    }
                    continue;
                }

                if (currentChunk.length + chapter.content.length > chunkSize && currentChunk.length > 0) {
                    AppState.memory.queue.push(createMemoryChunk(currentChunk, chunkIndex));
                    currentChunk = '';
                    chunkIndex++;
                }

                currentChunk += chapter.content;
            }

            if (currentChunk.length > 0) {
                if (currentChunk.length < minChunkSize && AppState.memory.queue.length > 0) {
                    const lastMemory = AppState.memory.queue[AppState.memory.queue.length - 1];
                    if (lastMemory.content.length + currentChunk.length <= chunkSize * 1.2) {
                        lastMemory.content += currentChunk;
                    } else {
                        AppState.memory.queue.push(createMemoryChunk(currentChunk, chunkIndex));
                    }
                } else {
                    AppState.memory.queue.push(createMemoryChunk(currentChunk, chunkIndex));
                }
            }
        } else {
            let i = 0;
            let chunkIndex = 1;

            while (i < content.length) {
                let endIndex = Math.min(i + chunkSize, content.length);
                if (endIndex < content.length) {
                    const paragraphBreak = content.lastIndexOf('\n\n', endIndex);
                    if (paragraphBreak > i + chunkSize * 0.5) {
                        endIndex = paragraphBreak + 2;
                    } else {
                        const sentenceBreak = content.lastIndexOf('。', endIndex);
                        if (sentenceBreak > i + chunkSize * 0.5) {
                            endIndex = sentenceBreak + 1;
                        }
                    }
                }

                AppState.memory.queue.push(createMemoryChunk(content.slice(i, endIndex), chunkIndex));
                i = endIndex;
                chunkIndex++;
            }
        }

        for (let i = AppState.memory.queue.length - 1; i > 0; i--) {
            if (AppState.memory.queue[i].content.length < minChunkSize) {
                const prevMemory = AppState.memory.queue[i - 1];
                if (prevMemory.content.length + AppState.memory.queue[i].content.length <= chunkSize * 1.2) {
                    prevMemory.content += AppState.memory.queue[i].content;
                    AppState.memory.queue.splice(i, 1);
                }
            }
        }

        AppState.memory.queue.forEach((memory, index) => {
            memory.title = `记忆${index + 1}`;
        });
    }

    async function handleClearFile() {
        AppState.file.current = null;
        AppState.file.novelName = '';
        AppState.memory.queue = [];
        AppState.worldbook.generated = {};
        AppState.worldbook.volumes = [];
        AppState.worldbook.currentVolumeIndex = 0;
        AppState.memory.startIndex = 0;
        AppState.memory.userSelectedIndex = null;
        AppState.file.hash = null;
        AppState.ui.isMultiSelectMode = false;
        AppState.ui.selectedIndices.clear();

        try {
            await MemoryHistoryDB.clearAllHistory();
            await MemoryHistoryDB.clearAllRolls();
            await MemoryHistoryDB.clearState();
            await MemoryHistoryDB.clearFileHash();
            Logger.info('History', '已清空所有历史记录');
        } catch (error) {
            Logger.error('History', '清空历史失败:', error);
        }

        document.getElementById('ttw-upload-area').style.display = 'block';
        document.getElementById('ttw-file-info').style.display = 'none';
        document.getElementById('ttw-file-input').value = '';

        const novelNameRow = document.getElementById('ttw-novel-name-row');
        if (novelNameRow) novelNameRow.style.display = 'none';
        const novelNameInput = document.getElementById('ttw-novel-name-input');
        if (novelNameInput) novelNameInput.value = '';

        document.getElementById('ttw-start-btn').disabled = true;
        document.getElementById('ttw-start-btn').textContent = '🚀 开始转换';

        showQueueSection(false);
        showProgressSection(false);
        showResultSection(false);
    }

    async function rechunkMemories() {
        if (AppState.memory.queue.length === 0) {
            ErrorHandler.showUserError('没有可重新分块的内容');
            return;
        }

        const processedCount = AppState.memory.queue.filter((m) => m.processed && !m.failed).length;
        if (processedCount > 0) {
            const confirmMsg = `⚠️ 警告：当前有 ${processedCount} 个已处理的章节。\n\n重新分块将会：\n1. 清除所有已处理状态\n2. 需要重新从头开始转换\n3. 但不会清除已生成的世界书数据\n\n确定要重新分块吗？`;
            if (!(await confirmAction(confirmMsg, { title: '重新分块', danger: true }))) {
                return;
            }
        }

        if (typeof saveCurrentSettings === 'function') {
            saveCurrentSettings();
        }

        const allContent = AppState.memory.queue.map((m) => m.content).join('');
        splitContentIntoMemory(allContent);

        AppState.memory.startIndex = 0;
        AppState.memory.userSelectedIndex = null;

        updateMemoryQueueUI();
        updateStartButtonState(false);

        ErrorHandler.showUserSuccess(`重新分块完成！\n当前共 ${AppState.memory.queue.length} 个章节`);
    }

    function createMemoryChunk(content, chunkIndex) {
        return {
            title: `记忆${chunkIndex}`,
            content,
            processed: false,
            failed: false,
            processing: false,
        };
    }

    /**
     * 按当前分块设置切分一段文本，但不影响现有队列。
     * 借用 splitContentIntoMemory 保证分块规则（章节正则、字数）完全一致。
     *
     * @param {string} content
     * @returns {string[]} 分块后的文本数组
     */
    function splitContentIntoChunks(content) {
        const backup = AppState.memory.queue;
        AppState.memory.queue = [];
        try {
            splitContentIntoMemory(content);
            return AppState.memory.queue.map((m) => m.content);
        } finally {
            AppState.memory.queue = backup;
        }
    }

    /**
     * 导入更新章节。
     *
     * 两种模式都只把新增内容追加到队列末尾，
     * 已处理 / 已整理 / 已合并的世界书条目不会被刷新。
     *
     * @param {'append-only'|'full-file'} mode
     *   append-only: 导入的文件只含新增章节，全部直接追加，不做比对
     *   full-file  : 导入更新后的整本 TXT，自动定位新增部分后追加
     * @returns {Promise<void>}
     */
    async function importUpdateChapters(mode) {
        if (AppState.memory.queue.length === 0) {
            ErrorHandler.showUserError('请先加载原始文件后再导入更新章节');
            return;
        }
        if (mode !== 'append-only' && mode !== 'full-file') {
            ErrorHandler.showUserError('未知的导入模式');
            return;
        }

        const file = await pickTxtFile();
        if (!file) return;

        try {
            const { content } = await fileUtils.detectBestEncoding(file);
            let newPart = '';

            if (mode === 'append-only') {
                newPart = content.replace(/^\s+/, '');
                if (!newPart || newPart.trim().length === 0) {
                    ErrorHandler.showUserError('导入的文件内容为空');
                    return;
                }
            } else {
                const oldContent = AppState.memory.queue.map((m) => m.content).join('');
                const oldLen = oldContent.length;

                if (content.length <= oldLen) {
                    const go = await confirmAction('导入的文件长度不大于当前内容，可能没有新增章节。仍要继续吗？', {
                        title: '导入更新章节',
                    });
                    if (!go) return;
                }

                // 用旧内容末尾一段做锚点定位，比单纯按长度截取更稳。
                //
                // 定位顺序：
                //   1. 先看锚点是否正好落在预期位置（绝大多数「整本追加」属于这种）
                //   2. 否则用 lastIndexOf 找最后一次出现
                //      —— 不能用 indexOf：小说里若存在大段重复文本（诗词、口号、
                //         章节模板），indexOf 会命中靠前的那次，导致把已有内容
                //         当成新增重复导入一遍
                //   3. 都找不到就退化为按长度截取
                const anchorLen = Math.min(2000, oldLen);
                if (anchorLen > 0) {
                    const anchor = oldContent.slice(oldLen - anchorLen);
                    const expectedPos = oldLen - anchorLen;
                    let anchorPos = -1;
                    if (content.startsWith(anchor, expectedPos)) {
                        anchorPos = expectedPos;
                    } else {
                        anchorPos = content.lastIndexOf(anchor);
                    }
                    newPart =
                        anchorPos !== -1 ? content.slice(anchorPos + anchor.length) : content.slice(oldLen);
                } else {
                    newPart = content.slice(oldLen);
                }
                newPart = newPart.replace(/^\s+/, '');

                if (!newPart || newPart.trim().length === 0) {
                    ErrorHandler.showUserError(
                        '未检测到新增章节内容。\n\n如果你导入的是「只含新增部分」的文件，请改用「➕ 仅新增模式」。',
                    );
                    return;
                }
            }

            const modeLabel = mode === 'append-only' ? '仅新增模式' : '完整文件模式';
            const confirmed = await confirmAction(
                `[${modeLabel}] 检测到约 ${(newPart.length / 1000).toFixed(1)}k 字的新增内容。\n\n` +
                    `将分块后追加到章节队列末尾，已处理/已整理/已合并的条目保持不变。\n\n确定导入吗？`,
                { title: '导入更新章节' },
            );
            if (!confirmed) return;

            const prevQueueLen = AppState.memory.queue.length;
            const newChunks = splitContentIntoChunks(newPart);
            if (newChunks.length === 0) {
                ErrorHandler.showUserError('新增内容分块结果为空');
                return;
            }

            for (const chunk of newChunks) {
                AppState.memory.queue.push({
                    title: '',
                    content: chunk,
                    processed: false,
                    failed: false,
                    processing: false,
                });
            }
            AppState.memory.queue.forEach((m, i) => {
                m.title = `记忆${i + 1}`;
            });

            const totalChars = AppState.memory.queue.reduce((sum, m) => sum + m.content.length, 0);
            const sizeEl = document.getElementById('ttw-file-size');
            if (sizeEl) {
                sizeEl.textContent = `(${(totalChars / 1024).toFixed(1)} KB, ${AppState.memory.queue.length}章)`;
            }

            // 起始点落在新增部分的第一章，点「开始」只跑新章节
            AppState.memory.startIndex = prevQueueLen;
            AppState.memory.userSelectedIndex = null;

            updateMemoryQueueUI();
            updateStartButtonState(false);

            try {
                await MemoryHistoryDB.saveState(AppState.memory.queue.filter((m) => m.processed).length);
            } catch (err) {
                Logger.warn('Import', '保存状态失败: ' + err.message);
            }

            ErrorHandler.showUserSuccess(
                `已追加 ${newChunks.length} 个新章节（第${prevQueueLen + 1}~${AppState.memory.queue.length}章）。\n\n` +
                    `点击「开始/继续转换」将只处理新增章节，已整理和别名合并的条目不会被刷新。`,
            );
        } catch (error) {
            Logger.error('Import', '导入更新章节失败: ' + error.message);
            ErrorHandler.showUserError('导入更新章节失败: ' + error.message);
        }
    }

    /**
     * 弹出系统文件选择器，取一个 txt 文件
     * @returns {Promise<File|null>}
     */
    function pickTxtFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.txt';
            input.style.display = 'none';
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                input.remove();
                resolve(value);
            };
            input.onchange = (e) => finish(e.target.files && e.target.files[0] ? e.target.files[0] : null);
            // 用户直接关掉选择器时不会触发 change，靠窗口重新获得焦点兜底
            window.addEventListener(
                'focus',
                () => {
                    setTimeout(() => finish(null), 500);
                },
                { once: true },
            );
            document.body.appendChild(input);
            input.click();
        });
    }

    return {
        handleFileSelect,
        splitContentIntoMemory,
        splitContentIntoChunks,
        handleClearFile,
        rechunkMemories,
        importUpdateChapters,
    };
}
