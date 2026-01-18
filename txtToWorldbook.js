/**
 * TXT转世界书独立模块 v2.4.1
 * 修复: CSRF错误、重Roll按钮、新增JSON导入合并功能
 */

(function() {
    'use strict';

    // ========== 全局状态 ==========
    let generatedWorldbook = {};
    let worldbookVolumes = [];
    let currentVolumeIndex = 0;
    let memoryQueue = [];
    let failedMemoryQueue = [];
    let currentFile = null;
    let currentFileHash = null;
    let isProcessingStopped = false;
    let isRepairingMemories = false;
    let currentProcessingIndex = 0;
    let incrementalOutputMode = true;
    let useVolumeMode = false;
    let currentStreamContent = '';
    let startFromIndex = 0;
    let userSelectedStartIndex = null;

    // ========== 重Roll功能：存储每个记忆的多次生成结果 ==========
    let memoryRollHistory = {};

    // ========== 并行处理配置 ==========
    let parallelConfig = {
        enabled: true,
        concurrency: 3,
        mode: 'independent'
    };

    // ========== 并行处理活跃任务追踪 ==========
    let activeParallelTasks = new Set();

    // ========== 默认设置 ==========
    const defaultWorldbookPrompt = `你是专业的小说世界书生成专家。请仔细阅读提供的小说内容，提取其中的关键信息，生成高质量的世界书条目。

## 重要要求
1. **必须基于提供的具体小说内容**，不要生成通用模板
2. **只提取文中明确出现的角色、地点、组织等信息**
3. **关键词必须是文中实际出现的名称**，用逗号分隔
4. **内容必须基于原文描述**，不要添加原文没有的信息
5. **内容使用markdown格式**，可以层层嵌套或使用序号标题

## 📤 输出格式
请生成标准JSON格式，确保能被JavaScript正确解析：

\`\`\`json
{
"角色": {
"角色真实姓名": {
"关键词": ["真实姓名", "称呼1", "称呼2", "绰号"],
"内容": "基于原文的角色描述"
}
},
"地点": {
"地点真实名称": {
"关键词": ["地点名", "别称"],
"内容": "基于原文的地点描述"
}
},
"组织": {
"组织真实名称": {
"关键词": ["组织名", "简称"],
"内容": "基于原文的组织描述"
}
}
}
\`\`\`

直接输出JSON，不要包含代码块标记。`;

    const defaultPlotPrompt = `"剧情大纲": {
"主线剧情": {
"关键词": ["主线", "核心剧情"],
"内容": "故事主线描述"
}
}`;

    const defaultStylePrompt = `"文风配置": {
"作品文风": {
"关键词": ["文风", "写作风格"],
"内容": "文风描述"
}
}`;

    // 【新增】世界书合并默认提示词
    const defaultMergePrompt = `你是专业的世界书整理专家。请合并以下两个世界书条目，它们描述的是同一个对象。

## 合并规则
1. **保留所有有价值的信息**，不要丢失任何重要内容
2. **去除重复信息**，相同的描述只保留一份
3. **整合矛盾信息**，如果有冲突，以更详细或更新的为准
4. **关键词合并**，将两边的关键词去重合并
5. **内容整合**，将描述整合成连贯的文本

## 输入格式
我会提供两个JSON对象：条目A和条目B

## 输出格式
请输出合并后的单个JSON对象：
{
"关键词": ["合并后的关键词列表"],
"内容": "合并整合后的完整描述"
}

直接输出JSON，不要包含其他内容。`;

    const defaultSettings = {
        chunkSize: 15000,
        enablePlotOutline: false,
        enableLiteraryStyle: false,
        language: 'zh',
        customWorldbookPrompt: '',
        customPlotPrompt: '',
        customStylePrompt: '',
        useVolumeMode: false,
        apiTimeout: 120000,
        parallelEnabled: true,
        parallelConcurrency: 3,
        parallelMode: 'independent',
        useTavernPreset: true,
        customMergePrompt: ''
    };

    let settings = { ...defaultSettings };

    // ========== 信号量类 ==========
    class Semaphore {
        constructor(max) {
            this.max = max;
            this.current = 0;
            this.queue = [];
            this.aborted = false;
        }

        async acquire() {
            if (this.aborted) {
                throw new Error('ABORTED');
            }
            if (this.current < this.max) {
                this.current++;
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                this.queue.push({ resolve, reject });
            });
        }

        release() {
            this.current--;
            if (this.queue.length > 0 && !this.aborted) {
                this.current++;
                const next = this.queue.shift();
                next.resolve();
            }
        }

        abort() {
            this.aborted = true;
            while (this.queue.length > 0) {
                const item = this.queue.shift();
                item.reject(new Error('ABORTED'));
            }
        }

        reset() {
            this.aborted = false;
            this.current = 0;
            this.queue = [];
        }
    }

    let globalSemaphore = null;

    // ========== IndexedDB ==========
    const MemoryHistoryDB = {
        dbName: 'TxtToWorldbookDB',
        storeName: 'history',
        metaStoreName: 'meta',
        stateStoreName: 'state',
        rollStoreName: 'rolls',
        db: null,

        async openDB() {
            if (this.db) return this.db;
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 4);
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        const store = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                        store.createIndex('memoryIndex', 'memoryIndex', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(this.metaStoreName)) {
                        db.createObjectStore(this.metaStoreName, { keyPath: 'key' });
                    }
                    if (!db.objectStoreNames.contains(this.stateStoreName)) {
                        db.createObjectStore(this.stateStoreName, { keyPath: 'key' });
                    }
                    if (!db.objectStoreNames.contains(this.rollStoreName)) {
                        const rollStore = db.createObjectStore(this.rollStoreName, { keyPath: 'id', autoIncrement: true });
                        rollStore.createIndex('memoryIndex', 'memoryIndex', { unique: false });
                    }
                };
                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve(this.db);
                };
                request.onerror = (event) => reject(event.target.error);
            });
        },

        async saveHistory(memoryIndex, memoryTitle, previousWorldbook, newWorldbook, changedEntries) {
            const db = await this.openDB();
            const allowedDuplicates = ['记忆-优化', '记忆-演变总结'];
            if (!allowedDuplicates.includes(memoryTitle)) {
                try {
                    const allHistory = await this.getAllHistory();
                    const duplicates = allHistory.filter(h => h.memoryTitle === memoryTitle);
                    if (duplicates.length > 0) {
                        const deleteTransaction = db.transaction([this.storeName], 'readwrite');
                        const deleteStore = deleteTransaction.objectStore(this.storeName);
                        for (const dup of duplicates) {
                            deleteStore.delete(dup.id);
                        }
                        await new Promise((resolve, reject) => {
                            deleteTransaction.oncomplete = () => resolve();
                            deleteTransaction.onerror = () => reject(deleteTransaction.error);
                        });
                    }
                } catch (error) {
                    console.error('删除重复历史记录失败:', error);
                }
            }
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const record = {
                    timestamp: Date.now(),
                    memoryIndex: memoryIndex,
                    memoryTitle: memoryTitle,
                    previousWorldbook: JSON.parse(JSON.stringify(previousWorldbook || {})),
                    newWorldbook: JSON.parse(JSON.stringify(newWorldbook || {})),
                    changedEntries: changedEntries || [],
                    fileHash: currentFileHash || null,
                    volumeIndex: currentVolumeIndex
                };
                const request = store.add(record);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async getAllHistory() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        },

        async getHistoryById(id) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(id);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async clearAllHistory() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async saveFileHash(hash) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.metaStoreName], 'readwrite');
                const store = transaction.objectStore(this.metaStoreName);
                const request = store.put({ key: 'currentFileHash', value: hash });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async getSavedFileHash() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.metaStoreName], 'readonly');
                const store = transaction.objectStore(this.metaStoreName);
                const request = store.get('currentFileHash');
                request.onsuccess = () => resolve(request.result?.value || null);
                request.onerror = () => reject(request.error);
            });
        },

        async saveState(processedIndex) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.stateStoreName], 'readwrite');
                const store = transaction.objectStore(this.stateStoreName);
                const state = {
                    key: 'currentState',
                    processedIndex: processedIndex,
                    memoryQueue: JSON.parse(JSON.stringify(memoryQueue)),
                    generatedWorldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                    worldbookVolumes: JSON.parse(JSON.stringify(worldbookVolumes)),
                    currentVolumeIndex: currentVolumeIndex,
                    fileHash: currentFileHash,
                    timestamp: Date.now()
                };
                const request = store.put(state);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async loadState() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.stateStoreName], 'readonly');
                const store = transaction.objectStore(this.stateStoreName);
                const request = store.get('currentState');
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error);
            });
        },

        async clearState() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.stateStoreName], 'readwrite');
                const store = transaction.objectStore(this.stateStoreName);
                const request = store.delete('currentState');
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async saveRollResult(memoryIndex, result) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.rollStoreName], 'readwrite');
                const store = transaction.objectStore(this.rollStoreName);
                const record = {
                    memoryIndex: memoryIndex,
                    result: JSON.parse(JSON.stringify(result)),
                    timestamp: Date.now()
                };
                const request = store.add(record);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async getRollResults(memoryIndex) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.rollStoreName], 'readonly');
                const store = transaction.objectStore(this.rollStoreName);
                const index = store.index('memoryIndex');
                const request = index.getAll(memoryIndex);
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        },

        async clearRollResults(memoryIndex) {
            const db = await this.openDB();
            const results = await this.getRollResults(memoryIndex);
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.rollStoreName], 'readwrite');
                const store = transaction.objectStore(this.rollStoreName);
                for (const r of results) {
                    store.delete(r.id);
                }
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        },

        async rollbackToHistory(historyId) {
            const history = await this.getHistoryById(historyId);
            if (!history) throw new Error('找不到指定的历史记录');
            generatedWorldbook = JSON.parse(JSON.stringify(history.previousWorldbook));
            const db = await this.openDB();
            const allHistory = await this.getAllHistory();
            const toDelete = allHistory.filter(h => h.id >= historyId);
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            for (const h of toDelete) {
                store.delete(h.id);
            }
            return history;
        },

        async cleanDuplicateHistory() {
            const db = await this.openDB();
            const allHistory = await this.getAllHistory();
            const allowedDuplicates = ['记忆-优化', '记忆-演变总结'];
            const groupedByTitle = {};
            for (const record of allHistory) {
                const title = record.memoryTitle;
                if (!groupedByTitle[title]) groupedByTitle[title] = [];
                groupedByTitle[title].push(record);
            }
            const toDelete = [];
            for (const title in groupedByTitle) {
                if (allowedDuplicates.includes(title)) continue;
                const records = groupedByTitle[title];
                if (records.length > 1) {
                    records.sort((a, b) => b.timestamp - a.timestamp);
                    toDelete.push(...records.slice(1));
                }
            }
            if (toDelete.length > 0) {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                for (const record of toDelete) {
                    store.delete(record.id);
                }
                await new Promise((resolve, reject) => {
                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error);
                });
                return toDelete.length;
            }
            return 0;
        }
    };

    // ========== 工具函数 ==========
    async function calculateFileHash(content) {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function getLanguagePrefix() {
        return settings.language === 'zh' ? '请用中文回复。\n\n' : '';
    }

    function isTokenLimitError(errorMsg) {
        if (!errorMsg) return false;
        const msg = errorMsg.toLowerCase();
        const patterns = [
            /prompt is too long/i, /tokens? >\s*\d+\s*maximum/i, /max_prompt_tokens/i,
            /exceeded/i, /input tokens/i, /context_length/i, /too many tokens/i,
            /token limit/i, /maximum.*tokens/i, /20015.*limit/i, /INVALID_ARGUMENT/i
        ];
        return patterns.some(pattern => pattern.test(msg));
    }

    async function detectBestEncoding(file) {
        const encodings = ['UTF-8', 'GBK', 'GB2312', 'GB18030', 'Big5'];
        for (const encoding of encodings) {
            try {
                const content = await readFileWithEncoding(file, encoding);
                if (!content.includes('�') && !content.includes('\uFFFD')) {
                    return { encoding, content };
                }
            } catch (e) { continue; }
        }
        const content = await readFileWithEncoding(file, 'UTF-8');
        return { encoding: 'UTF-8', content };
    }

    function readFileWithEncoding(file, encoding) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file, encoding);
        });
    }

    function updateStreamContent(content, clear = false) {
        if (clear) {
            currentStreamContent = '';
        } else {
            currentStreamContent += content;
        }
        const streamEl = document.getElementById('ttw-stream-content');
        if (streamEl) {
            streamEl.textContent = currentStreamContent;
            streamEl.scrollTop = streamEl.scrollHeight;
        }
    }

    // ========== 【修复】API调用 - 使用SillyTavern的generateRaw ==========
    async function callAPI(prompt, taskId = null) {
        const timeout = settings.apiTimeout || 120000;

        if (taskId !== null) {
            updateStreamContent(`\n📤 [任务${taskId}] 发送请求...\n`);
        } else {
            updateStreamContent(`\n📤 发送请求...\n`);
        }

        try {
            // 【修复】始终使用SillyTavern的generateRaw，它会自动使用当前配置的API
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const context = SillyTavern.getContext();

                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`API请求超时 (${timeout/1000}秒)`)), timeout);
                });

                // generateRaw会使用当前选择的API和设置
                // 第一个参数是prompt，第二个参数是空字符串（不需要），第三个参数false表示不流式
                const apiPromise = context.generateRaw(prompt, '', false);

                const result = await Promise.race([apiPromise, timeoutPromise]);

                if (taskId !== null) {
                    updateStreamContent(`📥 [任务${taskId}] 收到响应 (${result.length}字符)\n`);
                } else {
                    updateStreamContent(`📥 收到响应 (${result.length}字符)\n`);
                }

                return result;
            } else {
                throw new Error('无法访问SillyTavern上下文，请确保在酒馆环境中运行此脚本');
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`API请求超时 (${timeout/1000}秒)`);
            }
            updateStreamContent(`\n❌ 错误: ${error.message}\n`);
            throw error;
        }
    }

    // ========== 世界书数据处理 ==========
    function normalizeWorldbookEntry(entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        if (entry.content !== undefined && entry['内容'] !== undefined) {
            const contentLen = String(entry.content || '').length;
            const neirongLen = String(entry['内容'] || '').length;
            if (contentLen > neirongLen) entry['内容'] = entry.content;
            delete entry.content;
        } else if (entry.content !== undefined) {
            entry['内容'] = entry.content;
            delete entry.content;
        }
        return entry;
    }

    function normalizeWorldbookData(data) {
        if (!data || typeof data !== 'object') return data;
        for (const category in data) {
            if (typeof data[category] === 'object' && data[category] !== null && !Array.isArray(data[category])) {
                if (data[category]['关键词'] || data[category]['内容'] || data[category].content) {
                    normalizeWorldbookEntry(data[category]);
                } else {
                    for (const entryName in data[category]) {
                        if (typeof data[category][entryName] === 'object') {
                            normalizeWorldbookEntry(data[category][entryName]);
                        }
                    }
                }
            }
        }
        return data;
    }

    function mergeWorldbookData(target, source) {
        normalizeWorldbookData(source);
        for (const key in source) {
            if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
                if (!target[key]) target[key] = {};
                mergeWorldbookData(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }

    function mergeWorldbookDataIncremental(target, source) {
        normalizeWorldbookData(source);
        for (const category in source) {
            if (typeof source[category] !== 'object' || source[category] === null) continue;
            if (!target[category]) target[category] = {};
            for (const entryName in source[category]) {
                const sourceEntry = source[category][entryName];
                if (typeof sourceEntry !== 'object' || sourceEntry === null) continue;
                if (target[category][entryName]) {
                    const targetEntry = target[category][entryName];
                    if (Array.isArray(sourceEntry['关键词']) && Array.isArray(targetEntry['关键词'])) {
                        const mergedKeywords = [...new Set([...targetEntry['关键词'], ...sourceEntry['关键词']])];
                        targetEntry['关键词'] = mergedKeywords;
                    } else if (Array.isArray(sourceEntry['关键词'])) {
                        targetEntry['关键词'] = sourceEntry['关键词'];
                    }
                    if (sourceEntry['内容']) targetEntry['内容'] = sourceEntry['内容'];
                } else {
                    target[category][entryName] = sourceEntry;
                }
            }
        }
    }

    function findChangedEntries(oldWorldbook, newWorldbook) {
        const changes = [];
        for (const category in newWorldbook) {
            const oldCategory = oldWorldbook[category] || {};
            const newCategory = newWorldbook[category];
            for (const entryName in newCategory) {
                const oldEntry = oldCategory[entryName];
                const newEntry = newCategory[entryName];
                if (!oldEntry) {
                    changes.push({ type: 'add', category, entryName, oldValue: null, newValue: newEntry });
                } else if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
                    changes.push({ type: 'modify', category, entryName, oldValue: oldEntry, newValue: newEntry });
                }
            }
        }
        for (const category in oldWorldbook) {
            const oldCategory = oldWorldbook[category];
            const newCategory = newWorldbook[category] || {};
            for (const entryName in oldCategory) {
                if (!newCategory[entryName]) {
                    changes.push({ type: 'delete', category, entryName, oldValue: oldCategory[entryName], newValue: null });
                }
            }
        }
        return changes;
    }

    async function mergeWorldbookDataWithHistory(target, source, memoryIndex, memoryTitle) {
        const previousWorldbook = JSON.parse(JSON.stringify(target));
        if (incrementalOutputMode) {
            mergeWorldbookDataIncremental(target, source);
        } else {
            mergeWorldbookData(target, source);
        }
        const changedEntries = findChangedEntries(previousWorldbook, target);
        if (changedEntries.length > 0) {
            await MemoryHistoryDB.saveHistory(memoryIndex, memoryTitle, previousWorldbook, target, changedEntries);
        }
        return changedEntries;
    }

    // ========== 正则回退解析 ==========
    function extractWorldbookDataByRegex(jsonString) {
        const result = {};
        const categories = ['角色', '地点', '组织', '剧情大纲', '知识书', '文风配置'];
        for (const category of categories) {
            const categoryPattern = new RegExp(`"${category}"\\s*:\\s*\\{`, 'g');
            const categoryMatch = categoryPattern.exec(jsonString);
            if (!categoryMatch) continue;
            const startPos = categoryMatch.index + categoryMatch[0].length;
            let braceCount = 1;
            let endPos = startPos;
            while (braceCount > 0 && endPos < jsonString.length) {
                if (jsonString[endPos] === '{') braceCount++;
                if (jsonString[endPos] === '}') braceCount--;
                endPos++;
            }
            if (braceCount !== 0) continue;
            const categoryContent = jsonString.substring(startPos, endPos - 1);
            result[category] = {};
            const entryPattern = /"([^"]+)"\s*:\s*\{/g;
            let entryMatch;
            while ((entryMatch = entryPattern.exec(categoryContent)) !== null) {
                const entryName = entryMatch[1];
                const entryStartPos = entryMatch.index + entryMatch[0].length;
                let entryBraceCount = 1;
                let entryEndPos = entryStartPos;
                while (entryBraceCount > 0 && entryEndPos < categoryContent.length) {
                    if (categoryContent[entryEndPos] === '{') entryBraceCount++;
                    if (categoryContent[entryEndPos] === '}') entryBraceCount--;
                    entryEndPos++;
                }
                if (entryBraceCount !== 0) continue;
                const entryContent = categoryContent.substring(entryStartPos, entryEndPos - 1);
                let keywords = [];
                const keywordsMatch = entryContent.match(/"关键词"\s*:\s*\[([\s\S]*?)\]/);
                if (keywordsMatch) {
                    const keywordStrings = keywordsMatch[1].match(/"([^"]+)"/g);
                    if (keywordStrings) keywords = keywordStrings.map(s => s.replace(/"/g, ''));
                }
                let content = '';
                const contentMatch = entryContent.match(/"内容"\s*:\s*"/);
                if (contentMatch) {
                    const contentStartPos = contentMatch.index + contentMatch[0].length;
                    let contentEndPos = contentStartPos;
                    let escaped = false;
                    while (contentEndPos < entryContent.length) {
                        const char = entryContent[contentEndPos];
                        if (escaped) { escaped = false; }
                        else if (char === '\\') { escaped = true; }
                        else if (char === '"') { break; }
                        contentEndPos++;
                    }
                    content = entryContent.substring(contentStartPos, contentEndPos);
                    try { content = JSON.parse(`"${content}"`); }
                    catch (e) { content = content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
                }
                if (content || keywords.length > 0) {
                    result[category][entryName] = { '关键词': keywords, '内容': content };
                }
            }
            if (Object.keys(result[category]).length === 0) delete result[category];
        }
        return result;
    }

    function parseAIResponse(response) {
        try {
            return JSON.parse(response);
        } catch (e) {
            let clean = response.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '');
            const first = clean.indexOf('{');
            const last = clean.lastIndexOf('}');
            if (first !== -1 && last > first) clean = clean.substring(first, last + 1);
            try {
                return JSON.parse(clean);
            } catch (e2) {
                const open = (clean.match(/{/g) || []).length;
                const close = (clean.match(/}/g) || []).length;
                if (open > close) {
                    try { return JSON.parse(clean + '}'.repeat(open - close)); }
                    catch (e3) { return extractWorldbookDataByRegex(clean); }
                }
                return extractWorldbookDataByRegex(clean);
            }
        }
    }

    // ========== 分卷功能 ==========
    function startNewVolume() {
        if (Object.keys(generatedWorldbook).length > 0) {
            worldbookVolumes.push({
                volumeIndex: currentVolumeIndex,
                worldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                timestamp: Date.now()
            });
        }
        currentVolumeIndex++;
        generatedWorldbook = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
        updateVolumeIndicator();
    }

    function updateVolumeIndicator() {
        const indicator = document.getElementById('ttw-volume-indicator');
        if (indicator) {
            indicator.textContent = `当前: 第${currentVolumeIndex + 1}卷 | 已完成: ${worldbookVolumes.length}卷`;
            indicator.style.display = 'block';
        }
    }

    function getAllVolumesWorldbook() {
        const merged = {};
        for (const volume of worldbookVolumes) {
            for (const category in volume.worldbook) {
                if (!merged[category]) merged[category] = {};
                for (const entryName in volume.worldbook[category]) {
                    const key = merged[category][entryName] ? `${entryName}_卷${volume.volumeIndex + 1}` : entryName;
                    merged[category][key] = volume.worldbook[category][entryName];
                }
            }
        }
        for (const category in generatedWorldbook) {
            if (!merged[category]) merged[category] = {};
            for (const entryName in generatedWorldbook[category]) {
                const key = merged[category][entryName] ? `${entryName}_卷${currentVolumeIndex + 1}` : entryName;
                merged[category][key] = generatedWorldbook[category][entryName];
            }
        }
        return merged;
    }

    // ========== 记忆分裂 ==========
    function splitMemoryIntoTwo(memoryIndex) {
        const memory = memoryQueue[memoryIndex];
        if (!memory) return null;
        const content = memory.content;
        const halfLength = Math.floor(content.length / 2);
        let splitPoint = halfLength;
        const paragraphBreak = content.indexOf('\n\n', halfLength);
        if (paragraphBreak !== -1 && paragraphBreak < halfLength + 5000) {
            splitPoint = paragraphBreak + 2;
        } else {
            const sentenceBreak = content.indexOf('。', halfLength);
            if (sentenceBreak !== -1 && sentenceBreak < halfLength + 1000) {
                splitPoint = sentenceBreak + 1;
            }
        }
        const content1 = content.substring(0, splitPoint);
        const content2 = content.substring(splitPoint);
        const originalTitle = memory.title;
        let baseName = originalTitle;
        let suffix1, suffix2;
        const splitMatch = originalTitle.match(/^(.+)-(\d+)$/);
        if (splitMatch) {
            baseName = splitMatch[1];
            const currentNum = parseInt(splitMatch[2]);
            suffix1 = `-${currentNum}-1`;
            suffix2 = `-${currentNum}-2`;
        } else {
            suffix1 = '-1';
            suffix2 = '-2';
        }
        const memory1 = { title: baseName + suffix1, content: content1, processed: false, failed: false, failedError: null };
        const memory2 = { title: baseName + suffix2, content: content2, processed: false, failed: false, failedError: null };
        memoryQueue.splice(memoryIndex, 1, memory1, memory2);
        return { part1: memory1, part2: memory2 };
    }

    function deleteMemoryAt(index) {
        if (index < 0 || index >= memoryQueue.length) return;
        const memory = memoryQueue[index];
        if (confirm(`确定要删除 "${memory.title}" 吗？`)) {
            memoryQueue.splice(index, 1);
            memoryQueue.forEach((m, i) => { if (!m.title.includes('-')) m.title = `记忆${i + 1}`; });
            if (startFromIndex > index) startFromIndex = Math.max(0, startFromIndex - 1);
            else if (startFromIndex >= memoryQueue.length) startFromIndex = Math.max(0, memoryQueue.length - 1);
            if (userSelectedStartIndex !== null) {
                if (userSelectedStartIndex > index) userSelectedStartIndex = Math.max(0, userSelectedStartIndex - 1);
                else if (userSelectedStartIndex >= memoryQueue.length) userSelectedStartIndex = null;
            }
            updateMemoryQueueUI();
            updateStartButtonState(false);
        }
    }

    // ========== 获取系统提示词 ==========
    function getSystemPrompt() {
        const worldbookPrompt = settings.customWorldbookPrompt?.trim() || defaultWorldbookPrompt;
        const additionalParts = [];
        if (settings.enablePlotOutline) additionalParts.push(settings.customPlotPrompt?.trim() || defaultPlotPrompt);
        if (settings.enableLiteraryStyle) additionalParts.push(settings.customStylePrompt?.trim() || defaultStylePrompt);
        if (additionalParts.length === 0) return worldbookPrompt;
        let fullPrompt = worldbookPrompt;
        const insertContent = ',\n' + additionalParts.join(',\n');
        fullPrompt = fullPrompt.replace(/(\}\s*)\n\`\`\`/, `${insertContent}\n$1\n\`\`\``);
        return fullPrompt;
    }

    // ========== 并行处理 ==========
    async function processMemoryChunkIndependent(index, retryCount = 0) {
        const memory = memoryQueue[index];
        const maxRetries = 3;
        const taskId = index + 1;

        if (isProcessingStopped) throw new Error('ABORTED');

        memory.processing = true;
        updateMemoryQueueUI();

        let prompt = getLanguagePrefix() + getSystemPrompt();
        if (index > 0 && memoryQueue[index - 1].content) {
            prompt += `\n\n这是前文的结尾部分（供参考）：\n---\n${memoryQueue[index - 1].content.slice(-800)}\n---\n`;
        }
        prompt += `\n\n这是当前需要分析的内容：\n---\n${memory.content}\n---\n\n请从上述内容中提取角色、地点、组织等信息，直接输出JSON格式。`;

        updateStreamContent(`\n🔄 [记忆${taskId}] 开始处理: ${memory.title}\n`);

        try {
            const response = await callAPI(prompt, taskId);
            if (isProcessingStopped) { memory.processing = false; throw new Error('ABORTED'); }
            if (isTokenLimitError(response)) throw new Error('Token limit exceeded');
            let memoryUpdate = parseAIResponse(response);
            updateStreamContent(`✅ [记忆${taskId}] 处理完成\n`);
            return memoryUpdate;
        } catch (error) {
            memory.processing = false;
            if (error.message === 'ABORTED') throw error;
            updateStreamContent(`❌ [记忆${taskId}] 错误: ${error.message}\n`);
            if (isTokenLimitError(error.message)) throw new Error(`TOKEN_LIMIT:${index}`);
            if (retryCount < maxRetries && !isProcessingStopped) {
                const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateStreamContent(`🔄 [记忆${taskId}] ${delay/1000}秒后重试...\n`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return processMemoryChunkIndependent(index, retryCount + 1);
            }
            throw error;
        }
    }

    async function processMemoryChunksParallel(startIndex, endIndex) {
        const tasks = [];
        const results = new Map();
        const tokenLimitIndices = [];

        for (let i = startIndex; i < endIndex && i < memoryQueue.length; i++) {
            if (memoryQueue[i].processed && !memoryQueue[i].failed) continue;
            tasks.push({ index: i, memory: memoryQueue[i] });
        }
        if (tasks.length === 0) return { tokenLimitIndices };

        updateStreamContent(`\n🚀 开始并行处理 ${tasks.length} 个记忆块 (并发数: ${parallelConfig.concurrency})\n${'='.repeat(50)}\n`);

        let completed = 0;
        const totalTasks = tasks.length;
        globalSemaphore = new Semaphore(parallelConfig.concurrency);

        const processOne = async (task) => {
            if (isProcessingStopped) return null;
            try { await globalSemaphore.acquire(); }
            catch (e) { if (e.message === 'ABORTED') return null; throw e; }
            if (isProcessingStopped) { globalSemaphore.release(); return null; }
            activeParallelTasks.add(task.index);

            try {
                updateProgress(((startIndex + completed) / memoryQueue.length) * 100, `🚀 并行处理中 (${completed}/${totalTasks})`);
                const result = await processMemoryChunkIndependent(task.index);
                task.memory.processed = true;
                task.memory.failed = false;
                task.memory.processing = false;
                task.memory.result = result;
                results.set(task.index, result);
                completed++;
                if (result) {
                    await mergeWorldbookDataWithHistory(generatedWorldbook, result, task.index, task.memory.title);
                    await MemoryHistoryDB.saveRollResult(task.index, result);
                }
                updateMemoryQueueUI();
                return result;
            } catch (error) {
                completed++;
                task.memory.processing = false;
                if (error.message === 'ABORTED') { updateMemoryQueueUI(); return null; }
                if (error.message.startsWith('TOKEN_LIMIT:')) {
                    tokenLimitIndices.push(parseInt(error.message.split(':')[1]));
                } else {
                    task.memory.failed = true;
                    task.memory.failedError = error.message;
                    task.memory.processed = true;
                }
                updateMemoryQueueUI();
                return null;
            } finally {
                activeParallelTasks.delete(task.index);
                globalSemaphore.release();
            }
        };

        await Promise.allSettled(tasks.map(task => processOne(task)));
        activeParallelTasks.clear();
        globalSemaphore = null;
        updateStreamContent(`\n${'='.repeat(50)}\n📦 并行处理完成，成功: ${results.size}/${tasks.length}\n`);
        return { tokenLimitIndices };
    }

    // ========== 串行处理 ==========
    async function processMemoryChunk(index, retryCount = 0) {
        if (isProcessingStopped) return;
        const memory = memoryQueue[index];
        const progress = ((index + 1) / memoryQueue.length) * 100;
        const maxRetries = 3;

        updateProgress(progress, `正在处理: ${memory.title} (${index + 1}/${memoryQueue.length})${retryCount > 0 ? ` (重试 ${retryCount})` : ''}`);
        memory.processing = true;
        updateMemoryQueueUI();

        let prompt = getLanguagePrefix() + getSystemPrompt() + '\n\n';
        if (index > 0) {
            prompt += `上一次阅读的结尾：\n---\n${memoryQueue[index - 1].content.slice(-500)}\n---\n\n`;
            prompt += `当前记忆：\n${JSON.stringify(generatedWorldbook, null, 2)}\n\n`;
        }
        prompt += `现在阅读的部分：\n---\n${memory.content}\n---\n\n`;
        if (incrementalOutputMode) {
            prompt += `请基于新内容**增量更新**世界书，只输出变更的条目。`;
        } else {
            prompt += `请基于新内容**累积补充**世界书。`;
        }
        prompt += `\n\n请直接输出JSON格式的结果。`;

        try {
            const response = await callAPI(prompt);
            memory.processing = false;
            if (isProcessingStopped) { updateMemoryQueueUI(); return; }

            if (isTokenLimitError(response)) {
                if (useVolumeMode) {
                    startNewVolume();
                    await MemoryHistoryDB.saveState(index);
                    await processMemoryChunk(index, 0);
                    return;
                }
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(index);
                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                }
            }

            let memoryUpdate = parseAIResponse(response);
            await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memory.title);
            await MemoryHistoryDB.saveRollResult(index, memoryUpdate);
            memory.processed = true;
            memory.result = memoryUpdate;
            updateMemoryQueueUI();

        } catch (error) {
            memory.processing = false;
            const errorMsg = error.message || '';

            if (isTokenLimitError(errorMsg)) {
                if (useVolumeMode) {
                    startNewVolume();
                    await MemoryHistoryDB.saveState(index);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await processMemoryChunk(index, 0);
                    return;
                }
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(index);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                } else {
                    memory.processed = true;
                    memory.failed = true;
                    memory.failedError = error.message;
                    if (!failedMemoryQueue.find(m => m.index === index)) {
                        failedMemoryQueue.push({ index, memory, error: error.message });
                    }
                    updateMemoryQueueUI();
                    return;
                }
            }

            if (retryCount < maxRetries) {
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateProgress(progress, `处理失败，${retryDelay/1000}秒后重试`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                return await processMemoryChunk(index, retryCount + 1);
            } else {
                memory.processed = true;
                memory.failed = true;
                memory.failedError = error.message;
                if (!failedMemoryQueue.find(m => m.index === index)) {
                    failedMemoryQueue.push({ index, memory, error: error.message });
                }
                updateMemoryQueueUI();
            }
        }

        if (memory.processed) await new Promise(resolve => setTimeout(resolve, 1000));
    }

    function stopProcessing() {
        isProcessingStopped = true;
        if (globalSemaphore) globalSemaphore.abort();
        activeParallelTasks.clear();
        memoryQueue.forEach(m => { if (m.processing) m.processing = false; });
        updateMemoryQueueUI();
        updateStreamContent(`\n⏸️ 用户请求暂停...\n`);
    }

    // ========== 主处理流程 ==========
    async function startAIProcessing() {
        showProgressSection(true);
        isProcessingStopped = false;
        if (globalSemaphore) globalSemaphore.reset();
        activeParallelTasks.clear();

        updateStreamContent('', true);
        updateStreamContent(`🚀 开始处理...\n📊 处理模式: ${parallelConfig.enabled ? `并行 (${parallelConfig.concurrency}并发)` : '串行'}\n${'='.repeat(50)}\n`);

        const effectiveStartIndex = userSelectedStartIndex !== null ? userSelectedStartIndex : startFromIndex;

        if (effectiveStartIndex === 0) {
            worldbookVolumes = [];
            currentVolumeIndex = 0;
            generatedWorldbook = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
        }
        userSelectedStartIndex = null;
        if (useVolumeMode) updateVolumeIndicator();
        updateStartButtonState(true);

        try {
            if (parallelConfig.enabled) {
                if (parallelConfig.mode === 'independent') {
                    const { tokenLimitIndices } = await processMemoryChunksParallel(effectiveStartIndex, memoryQueue.length);
                    if (isProcessingStopped) {
                        const processedCount = memoryQueue.filter(m => m.processed).length;
                        updateProgress((processedCount / memoryQueue.length) * 100, `⏸️ 已暂停 (${processedCount}/${memoryQueue.length})`);
                        await MemoryHistoryDB.saveState(processedCount);
                        updateStartButtonState(false);
                        return;
                    }
                    if (tokenLimitIndices.length > 0) {
                        updateStreamContent(`\n⚠️ ${tokenLimitIndices.length} 个记忆需要分裂处理...\n`);
                        for (const idx of tokenLimitIndices.sort((a, b) => b - a)) {
                            splitMemoryIntoTwo(idx);
                            updateMemoryQueueUI();
                        }
                        for (let i = 0; i < memoryQueue.length; i++) {
                            if (isProcessingStopped) break;
                            if (!memoryQueue[i].processed || memoryQueue[i].failed) {
                                await processMemoryChunk(i);
                            }
                        }
                    }
                } else {
                    const batchSize = parallelConfig.concurrency;
                    let i = effectiveStartIndex;
                    while (i < memoryQueue.length && !isProcessingStopped) {
                        const batchEnd = Math.min(i + batchSize, memoryQueue.length);
                        const { tokenLimitIndices } = await processMemoryChunksParallel(i, batchEnd);
                        if (isProcessingStopped) break;
                        for (const idx of tokenLimitIndices.sort((a, b) => b - a)) splitMemoryIntoTwo(idx);
                        for (let j = i; j < batchEnd && j < memoryQueue.length && !isProcessingStopped; j++) {
                            if (!memoryQueue[j].processed || memoryQueue[j].failed) await processMemoryChunk(j);
                        }
                        i = batchEnd;
                        await MemoryHistoryDB.saveState(i);
                    }
                }
            } else {
                let i = effectiveStartIndex;
                while (i < memoryQueue.length) {
                    if (isProcessingStopped) {
                        updateProgress((i / memoryQueue.length) * 100, `⏸️ 已暂停 (${i}/${memoryQueue.length})`);
                        await MemoryHistoryDB.saveState(i);
                        updateStartButtonState(false);
                        return;
                    }
                    if (memoryQueue[i].processed && !memoryQueue[i].failed) { i++; continue; }
                    const currentQueueLength = memoryQueue.length;
                    await processMemoryChunk(i);
                    if (memoryQueue.length > currentQueueLength) i += (memoryQueue.length - currentQueueLength);
                    i++;
                    await MemoryHistoryDB.saveState(i);
                }
            }

            if (isProcessingStopped) {
                const processedCount = memoryQueue.filter(m => m.processed).length;
                updateProgress((processedCount / memoryQueue.length) * 100, `⏸️ 已暂停 (${processedCount}/${memoryQueue.length})`);
                await MemoryHistoryDB.saveState(processedCount);
                updateStartButtonState(false);
                return;
            }

            if (useVolumeMode && Object.keys(generatedWorldbook).length > 0) {
                worldbookVolumes.push({ volumeIndex: currentVolumeIndex, worldbook: JSON.parse(JSON.stringify(generatedWorldbook)), timestamp: Date.now() });
            }

            const failedCount = memoryQueue.filter(m => m.failed === true).length;
            if (failedCount > 0) {
                updateProgress(100, `⚠️ 完成，但有 ${failedCount} 个失败`);
            } else {
                updateProgress(100, `✅ 所有记忆块处理完成！`);
            }

            showResultSection(true);
            updateWorldbookPreview();
            updateStreamContent(`\n${'='.repeat(50)}\n✅ 处理完成！\n`);

            if (!isProcessingStopped) {
                await MemoryHistoryDB.saveState(memoryQueue.length);
                await MemoryHistoryDB.clearState();
            }
            updateStartButtonState(false);

        } catch (error) {
            console.error('AI处理过程中发生错误:', error);
            updateProgress(0, `❌ 处理出错: ${error.message}`);
            updateStreamContent(`\n❌ 严重错误: ${error.message}\n`);
            updateStartButtonState(false);
        }
    }

    function updateStartButtonState(isProcessing) {
        const startBtn = document.getElementById('ttw-start-btn');
        if (!startBtn) return;
        if (isProcessing) {
            startBtn.disabled = true;
            startBtn.textContent = '转换中...';
        } else {
            startBtn.disabled = false;
            if (userSelectedStartIndex !== null) {
                startBtn.textContent = `▶️ 从记忆${userSelectedStartIndex + 1}开始`;
                startFromIndex = userSelectedStartIndex;
                return;
            }
            const firstUnprocessed = memoryQueue.findIndex(m => !m.processed || m.failed);
            if (firstUnprocessed !== -1 && firstUnprocessed < memoryQueue.length) {
                startBtn.textContent = `▶️ 继续转换 (从记忆${firstUnprocessed + 1})`;
                startFromIndex = firstUnprocessed;
            } else if (memoryQueue.length > 0 && memoryQueue.every(m => m.processed && !m.failed)) {
                startBtn.textContent = '🚀 重新转换';
                startFromIndex = 0;
            } else {
                startBtn.textContent = '🚀 开始转换';
                startFromIndex = 0;
            }
        }
    }

    // ========== 修复失败记忆 ==========
    async function repairSingleMemory(index) {
        const memory = memoryQueue[index];
        let prompt = getLanguagePrefix() + getSystemPrompt();
        if (Object.keys(generatedWorldbook).length > 0) {
            prompt += `\n\n当前记忆：\n${JSON.stringify(generatedWorldbook, null, 2)}\n\n`;
        }
        prompt += `阅读内容：\n---\n${memory.content}\n---\n\n请基于内容更新世界书，直接输出JSON。`;
        const response = await callAPI(prompt);
        let memoryUpdate = parseAIResponse(response);
        await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, `记忆-修复-${memory.title}`);
        await MemoryHistoryDB.saveRollResult(index, memoryUpdate);
        memory.result = memoryUpdate;
    }

    async function repairMemoryWithSplit(memoryIndex, stats) {
        const memory = memoryQueue[memoryIndex];
        if (!memory) return;
        updateProgress((memoryIndex / memoryQueue.length) * 100, `正在修复: ${memory.title}`);
        try {
            await repairSingleMemory(memoryIndex);
            memory.failed = false;
            memory.failedError = null;
            memory.processed = true;
            stats.successCount++;
            updateMemoryQueueUI();
            await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            const errorMsg = error.message || '';
            if (isTokenLimitError(errorMsg)) {
                if (useVolumeMode) {
                    startNewVolume();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await repairMemoryWithSplit(memoryIndex, stats);
                    return;
                }
                const splitResult = splitMemoryIntoTwo(memoryIndex);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const part1Index = memoryQueue.indexOf(splitResult.part1);
                    await repairMemoryWithSplit(part1Index, stats);
                    const part2Index = memoryQueue.indexOf(splitResult.part2);
                    await repairMemoryWithSplit(part2Index, stats);
                } else {
                    stats.stillFailedCount++;
                    memory.failedError = error.message;
                }
            } else {
                stats.stillFailedCount++;
                memory.failedError = error.message;
                updateMemoryQueueUI();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async function startRepairFailedMemories() {
        const failedMemories = memoryQueue.filter(m => m.failed === true);
        if (failedMemories.length === 0) { alert('没有需要修复的记忆'); return; }
        isRepairingMemories = true;
        showProgressSection(true);
        updateProgress(0, `正在修复 (0/${failedMemories.length})`);
        const stats = { successCount: 0, stillFailedCount: 0 };
        for (let i = 0; i < failedMemories.length; i++) {
            const memory = failedMemories[i];
            const memoryIndex = memoryQueue.indexOf(memory);
            if (memoryIndex === -1) continue;
            updateProgress(((i + 1) / failedMemories.length) * 100, `正在修复: ${memory.title}`);
            await repairMemoryWithSplit(memoryIndex, stats);
        }
        failedMemoryQueue = failedMemoryQueue.filter(item => memoryQueue[item.index]?.failed === true);
        updateProgress(100, `修复完成: 成功 ${stats.successCount}, 仍失败 ${stats.stillFailedCount}`);
        await MemoryHistoryDB.saveState(memoryQueue.length);
        isRepairingMemories = false;
        if (stats.stillFailedCount > 0) {
            alert(`修复完成！成功: ${stats.successCount}, 仍失败: ${stats.stillFailedCount}`);
        } else {
            alert(`全部修复成功！共修复 ${stats.successCount} 个`);
        }
        updateMemoryQueueUI();
    }

    // ========== 【修复】重Roll功能 ==========
    async function rerollMemory(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        // 【修复】重置停止标志
        isProcessingStopped = false;
        if (globalSemaphore) globalSemaphore.reset();

        updateStreamContent(`\n🎲 开始重Roll: ${memory.title}\n`);

        try {
            memory.processing = true;
            updateMemoryQueueUI();

            const result = await processMemoryChunkIndependent(index);

            memory.processing = false;

            if (result) {
                await MemoryHistoryDB.saveRollResult(index, result);
                memory.result = result;
                memory.processed = true;
                memory.failed = false;
                await mergeWorldbookDataWithHistory(generatedWorldbook, result, index, `${memory.title}-重Roll`);
                updateStreamContent(`✅ 重Roll完成: ${memory.title}\n`);
                updateMemoryQueueUI();
                updateWorldbookPreview();
                return result;
            }
        } catch (error) {
            memory.processing = false;
            updateStreamContent(`❌ 重Roll失败: ${error.message}\n`);
            updateMemoryQueueUI();
            throw error;
        }
    }

    async function showRollHistorySelector(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        const rollResults = await MemoryHistoryDB.getRollResults(index);

        const existingModal = document.getElementById('ttw-roll-history-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-roll-history-modal';
        modal.className = 'ttw-modal-container';

        let listHtml = '';
        if (rollResults.length === 0) {
            listHtml = '<div style="text-align: center; color: #888; padding: 20px;">暂无历史Roll结果<br><br>点击上方"🎲 重Roll"按钮生成</div>';
        } else {
            rollResults.forEach((roll, idx) => {
                const time = new Date(roll.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const entryCount = roll.result ? Object.keys(roll.result).reduce((sum, cat) => sum + (typeof roll.result[cat] === 'object' ? Object.keys(roll.result[cat]).length : 0), 0) : 0;
                const isCurrentSelected = memory.result && JSON.stringify(memory.result) === JSON.stringify(roll.result);
                listHtml += `
                    <div class="ttw-roll-item ${isCurrentSelected ? 'selected' : ''}" data-roll-id="${roll.id}" data-roll-index="${idx}" style="padding: 10px 12px; background: ${isCurrentSelected ? 'rgba(39, 174, 96, 0.2)' : 'rgba(0,0,0,0.2)'}; border-radius: 6px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid ${isCurrentSelected ? '#27ae60' : '#9b59b6'};">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: bold; color: ${isCurrentSelected ? '#27ae60' : '#e67e22'};">Roll #${idx + 1} ${isCurrentSelected ? '(当前)' : ''}</span>
                            <span style="font-size: 11px; color: #888;">${time}</span>
                        </div>
                        <div style="font-size: 11px; color: #aaa; margin-top: 4px;">提取了 ${entryCount} 个条目</div>
                    </div>
                `;
            });
        }

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🎲 ${memory.title} - Roll历史</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display: flex; gap: 15px; height: 400px;">
                        <div style="width: 220px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">
                            <div style="margin-bottom: 12px;">
                                <button id="ttw-do-reroll" class="ttw-btn ttw-btn-primary" style="width: 100%; padding: 12px;">🎲 重新Roll</button>
                            </div>
                            ${listHtml}
                        </div>
                        <div id="ttw-roll-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 点击左侧Roll结果查看详情<br><br>或点击"🎲 重新Roll"生成新结果</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    ${rollResults.length > 0 ? '<button class="ttw-btn ttw-btn-warning" id="ttw-clear-rolls">🗑️ 清空历史</button>' : ''}
                    <button class="ttw-btn" id="ttw-close-roll-history">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-roll-history').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-do-reroll').addEventListener('click', async () => {
            const btn = modal.querySelector('#ttw-do-reroll');
            btn.disabled = true;
            btn.textContent = '🔄 生成中...';
            try {
                await rerollMemory(index);
                modal.remove();
                showRollHistorySelector(index);
            } catch (error) {
                btn.disabled = false;
                btn.textContent = '🎲 重新Roll';
                alert('重Roll失败: ' + error.message);
            }
        });

        if (rollResults.length > 0) {
            modal.querySelector('#ttw-clear-rolls').addEventListener('click', async () => {
                if (confirm(`确定要清空 "${memory.title}" 的所有Roll历史吗？`)) {
                    await MemoryHistoryDB.clearRollResults(index);
                    modal.remove();
                    alert('已清空Roll历史');
                }
            });
        }

        modal.querySelectorAll('.ttw-roll-item').forEach(item => {
            item.addEventListener('click', () => {
                const rollIndex = parseInt(item.dataset.rollIndex);
                const roll = rollResults[rollIndex];
                const detailDiv = modal.querySelector('#ttw-roll-detail');
                modal.querySelectorAll('.ttw-roll-item').forEach(i => { i.style.background = 'rgba(0,0,0,0.2)'; i.style.borderLeftColor = '#9b59b6'; });
                item.style.background = 'rgba(0,0,0,0.4)';
                item.style.borderLeftColor = '#e67e22';
                const time = new Date(roll.timestamp).toLocaleString('zh-CN');
                detailDiv.innerHTML = `
                    <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #444;">
                        <h4 style="color: #e67e22; margin: 0 0 10px 0;">Roll #${rollIndex + 1}</h4>
                        <div style="font-size: 12px; color: #888; margin-bottom: 10px;">生成时间: ${time}</div>
                        <button class="ttw-btn ttw-btn-primary ttw-btn-small" id="ttw-use-this-roll">✅ 使用这个结果</button>
                    </div>
                    <pre style="white-space: pre-wrap; word-break: break-all; font-size: 11px; line-height: 1.5; max-height: 280px; overflow-y: auto;">${JSON.stringify(roll.result, null, 2)}</pre>
                `;
                detailDiv.querySelector('#ttw-use-this-roll').addEventListener('click', async () => {
                    memory.result = roll.result;
                    memory.processed = true;
                    memory.failed = false;
                    await mergeWorldbookDataWithHistory(generatedWorldbook, roll.result, index, `${memory.title}-选用Roll#${rollIndex + 1}`);
                    updateMemoryQueueUI();
                    updateWorldbookPreview();
                    modal.remove();
                    alert(`已使用 Roll #${rollIndex + 1} 的结果`);
                });
            });
        });
    }

    // ========== 【新增】导入JSON合并世界书 ==========
    function showImportMergeModal() {
        const existingModal = document.getElementById('ttw-import-merge-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-import-merge-modal';
        modal.className = 'ttw-modal-container';

        const currentMergePrompt = settings.customMergePrompt?.trim() || defaultMergePrompt;

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width: 800px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📥 导入JSON并合并世界书</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 70vh; overflow-y: auto;">
                    <div style="margin-bottom: 16px; padding: 12px; background: rgba(52, 152, 219, 0.15); border-radius: 8px;">
                        <div style="font-weight: bold; color: #3498db; margin-bottom: 8px;">📋 功能说明</div>
                        <div style="font-size: 12px; color: #ccc; line-height: 1.6;">
                            导入一个JSON格式的世界书文件，与当前世界书进行智能合并。<br>
                            相同名称的条目会通过AI进行内容整合，避免重复信息。
                        </div>
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: bold;">选择要导入的JSON文件：</label>
                        <div id="ttw-import-drop-area" style="border: 2px dashed #555; border-radius: 8px; padding: 30px; text-align: center; cursor: pointer;">
                            <div style="font-size: 32px; margin-bottom: 8px;">📁</div>
                            <div>点击或拖拽JSON文件到此处</div>
                            <input type="file" id="ttw-import-json-input" accept=".json" style="display: none;">
                        </div>
                        <div id="ttw-import-file-info" style="display: none; margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px;"></div>
                    </div>

                    <div style="margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <label style="font-weight: bold;">合并提示词：</label>
                            <button id="ttw-reset-merge-prompt" class="ttw-btn-small">🔄 恢复默认</button>
                        </div>
                        <textarea id="ttw-merge-prompt-input" rows="8" style="width: 100%; padding: 10px; border: 1px solid #555; border-radius: 6px; background: rgba(0,0,0,0.3); color: #fff; font-size: 12px; resize: vertical;">${currentMergePrompt}</textarea>
                    </div>

                    <div style="padding: 12px; background: rgba(230, 126, 34, 0.15); border-radius: 8px;">
                        <label class="ttw-checkbox-label" style="display: flex; align-items: center; gap: 10px;">
                            <input type="checkbox" id="ttw-auto-merge-duplicates" checked style="width: 18px; height: 18px;">
                            <div>
                                <span style="font-weight: bold;">🤖 自动AI合并重复条目</span>
                                <div style="font-size: 11px; color: #888; margin-top: 2px;">关闭则仅简单覆盖，不调用AI</div>
                            </div>
                        </label>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-import">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-start-import" disabled>📥 开始导入合并</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        let importedData = null;

        const dropArea = modal.querySelector('#ttw-import-drop-area');
        const fileInput = modal.querySelector('#ttw-import-json-input');
        const fileInfo = modal.querySelector('#ttw-import-file-info');
        const startBtn = modal.querySelector('#ttw-start-import');

        dropArea.addEventListener('click', () => fileInput.click());
        dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.style.borderColor = '#e67e22'; });
        dropArea.addEventListener('dragleave', () => { dropArea.style.borderColor = '#555'; });
        dropArea.addEventListener('drop', (e) => {
            e.preventDefault();
            dropArea.style.borderColor = '#555';
            if (e.dataTransfer.files.length > 0) handleImportFile(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) handleImportFile(e.target.files[0]);
        });

        async function handleImportFile(file) {
            if (!file.name.endsWith('.json')) {
                alert('请选择JSON文件');
                return;
            }
            try {
                const content = await file.text();
                importedData = JSON.parse(content);

                // 尝试识别格式
                let entryCount = 0;
                let categories = [];

                if (importedData.entries && Array.isArray(importedData.entries)) {
                    // SillyTavern格式
                    entryCount = importedData.entries.length;
                    categories = [...new Set(importedData.entries.map(e => e.group || '未分类'))];
                    fileInfo.innerHTML = `<div style="color: #27ae60;">✅ SillyTavern世界书格式</div><div style="font-size: 12px; color: #888; margin-top: 4px;">${entryCount} 个条目 | 分类: ${categories.join(', ')}</div>`;
                } else if (typeof importedData === 'object') {
                    // 自定义格式
                    for (const cat in importedData) {
                        if (typeof importedData[cat] === 'object') {
                            categories.push(cat);
                            entryCount += Object.keys(importedData[cat]).length;
                        }
                    }
                    fileInfo.innerHTML = `<div style="color: #3498db;">📚 自定义世界书格式</div><div style="font-size: 12px; color: #888; margin-top: 4px;">${entryCount} 个条目 | 分类: ${categories.join(', ')}</div>`;
                }

                fileInfo.style.display = 'block';
                startBtn.disabled = false;

            } catch (error) {
                alert('JSON解析失败: ' + error.message);
                importedData = null;
                startBtn.disabled = true;
            }
        }

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-import').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-reset-merge-prompt').addEventListener('click', () => {
            modal.querySelector('#ttw-merge-prompt-input').value = defaultMergePrompt;
        });

        modal.querySelector('#ttw-start-import').addEventListener('click', async () => {
            if (!importedData) return;

            const mergePrompt = modal.querySelector('#ttw-merge-prompt-input').value;
            const autoMerge = modal.querySelector('#ttw-auto-merge-duplicates').checked;

            settings.customMergePrompt = mergePrompt;
            saveCurrentSettings();

            modal.remove();

            await performWorldbookMerge(importedData, mergePrompt, autoMerge);
        });
    }

    async function performWorldbookMerge(importedData, mergePrompt, autoMerge) {
        showProgressSection(true);
        updateProgress(0, '正在分析导入数据...');
        updateStreamContent('', true);
        updateStreamContent('📥 开始导入合并世界书...\n');

        // 转换导入数据为统一格式
        let normalizedImport = {};

        if (importedData.entries && Array.isArray(importedData.entries)) {
            // SillyTavern格式转换
            for (const entry of importedData.entries) {
                const category = entry.group || '未分类';
                const name = entry.comment?.split(' - ')[1] || entry.comment || `条目${entry.uid}`;
                if (!normalizedImport[category]) normalizedImport[category] = {};
                normalizedImport[category][name] = {
                    '关键词': entry.key || [],
                    '内容': entry.content || ''
                };
            }
        } else {
            normalizedImport = JSON.parse(JSON.stringify(importedData));
        }

        normalizeWorldbookData(normalizedImport);

        // 找出重复条目
        const duplicates = [];
        const newEntries = [];

        for (const category in normalizedImport) {
            if (!generatedWorldbook[category]) {
                generatedWorldbook[category] = {};
            }
            for (const entryName in normalizedImport[category]) {
                if (generatedWorldbook[category][entryName]) {
                    duplicates.push({ category, entryName, existing: generatedWorldbook[category][entryName], imported: normalizedImport[category][entryName] });
                } else {
                    newEntries.push({ category, entryName, data: normalizedImport[category][entryName] });
                }
            }
        }

        updateStreamContent(`📊 分析结果: ${newEntries.length} 个新条目, ${duplicates.length} 个重复条目\n`);

        // 添加新条目
        for (const entry of newEntries) {
            generatedWorldbook[entry.category][entry.entryName] = entry.data;
        }
        updateStreamContent(`✅ 已添加 ${newEntries.length} 个新条目\n`);

        // 处理重复条目
        if (duplicates.length > 0) {
            if (autoMerge) {
                updateStreamContent(`\n🤖 开始AI合并 ${duplicates.length} 个重复条目...\n`);
                for (let i = 0; i < duplicates.length; i++) {
                    const dup = duplicates[i];
                    updateProgress(((i + 1) / duplicates.length) * 100, `合并: [${dup.category}] ${dup.entryName}`);

                    try {
                        const prompt = getLanguagePrefix() + mergePrompt + `\n\n## 条目A（现有）\n${JSON.stringify(dup.existing, null, 2)}\n\n## 条目B（导入）\n${JSON.stringify(dup.imported, null, 2)}\n\n请输出合并后的JSON对象：`;

                        const response = await callAPI(prompt);
                        let merged = parseAIResponse(response);

                        if (merged && (merged['关键词'] || merged['内容'])) {
                            generatedWorldbook[dup.category][dup.entryName] = merged;
                            updateStreamContent(`  ✅ [${dup.category}] ${dup.entryName}\n`);
                        } else {
                            // 回退到简单合并
                            const existingKeywords = dup.existing['关键词'] || [];
                            const importedKeywords = dup.imported['关键词'] || [];
                            generatedWorldbook[dup.category][dup.entryName] = {
                                '关键词': [...new Set([...existingKeywords, ...importedKeywords])],
                                '内容': dup.imported['内容'] || dup.existing['内容']
                            };
                            updateStreamContent(`  ⚠️ [${dup.category}] ${dup.entryName} (AI解析失败，简单合并)\n`);
                        }

                        await new Promise(resolve => setTimeout(resolve, 500));

                    } catch (error) {
                        updateStreamContent(`  ❌ [${dup.category}] ${dup.entryName}: ${error.message}\n`);
                        // 出错时简单覆盖
                        generatedWorldbook[dup.category][dup.entryName] = dup.imported;
                    }
                }
            } else {
                // 简单覆盖
                for (const dup of duplicates) {
                    const existingKeywords = generatedWorldbook[dup.category][dup.entryName]['关键词'] || [];
                    const importedKeywords = dup.imported['关键词'] || [];
                    generatedWorldbook[dup.category][dup.entryName] = {
                        '关键词': [...new Set([...existingKeywords, ...importedKeywords])],
                        '内容': dup.imported['内容'] || generatedWorldbook[dup.category][dup.entryName]['内容']
                    };
                }
                updateStreamContent(`✅ 已简单合并 ${duplicates.length} 个重复条目\n`);
            }
        }

        updateProgress(100, '导入合并完成！');
        updateStreamContent(`\n${'='.repeat(50)}\n✅ 导入合并完成！\n`);

        showResultSection(true);
        updateWorldbookPreview();

        alert(`导入合并完成！\n\n新增: ${newEntries.length} 个条目\n合并: ${duplicates.length} 个重复条目`);
    }

    // ========== 导出功能 ==========
    function convertToSillyTavernFormat(worldbook) {
        const entries = [];
        let entryId = 0;
        const triggerCategories = new Set(['地点', '剧情大纲']);

        for (const [category, categoryData] of Object.entries(worldbook)) {
            if (typeof categoryData !== 'object' || categoryData === null) continue;
            const isTriggerCategory = triggerCategories.has(category);
            const constant = !isTriggerCategory;
            const selective = isTriggerCategory;

            for (const [itemName, itemData] of Object.entries(categoryData)) {
                if (typeof itemData !== 'object' || itemData === null) continue;
                if (itemData.关键词 && itemData.内容) {
                    const keywords = Array.isArray(itemData.关键词) ? itemData.关键词 : [itemData.关键词];
                    const cleanKeywords = keywords.map(k => String(k).trim().replace(/[-_\s]+/g, '')).filter(k => k.length > 0 && k.length <= 20);
                    if (cleanKeywords.length === 0) cleanKeywords.push(itemName);
                    entries.push({
                        uid: entryId++, key: [...new Set(cleanKeywords)], keysecondary: [],
                        comment: `${category} - ${itemName}`, content: String(itemData.内容).trim(),
                        constant, selective, selectiveLogic: 0, addMemo: true, order: entryId * 100,
                        position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
                        delayUntilRecursion: false, probability: 100, depth: 4, group: category,
                        groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: false,
                        matchWholeWords: true, useGroupScoring: null, automationId: '', role: 0,
                        vectorized: false, sticky: null, cooldown: null, delay: null
                    });
                }
            }
        }

        if (entries.length === 0) {
            entries.push({
                uid: 0, key: ['默认条目'], keysecondary: [],
                comment: '默认条目', content: '这是一个自动生成的世界书条目。',
                constant: false, selective: true, selectiveLogic: 0, addMemo: true, order: 100,
                position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
                delayUntilRecursion: false, probability: 100, depth: 4, group: '默认',
                groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: false,
                matchWholeWords: true, useGroupScoring: null, automationId: '', role: 0,
                vectorized: false, sticky: null, cooldown: null, delay: null
            });
        }

        return { entries, originalData: { name: '小说转换的世界书', description: '由TXT转世界书功能生成', version: 1 } };
    }

    function exportWorldbook() {
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        let fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-世界书-${timeString}` : `世界书-${timeString}`;
        const exportData = useVolumeMode ? { volumes: worldbookVolumes, currentVolume: generatedWorldbook, merged: getAllVolumesWorldbook() } : generatedWorldbook;
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fileName + '.json'; a.click();
        URL.revokeObjectURL(url);
    }

    function exportToSillyTavern() {
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        try {
            const worldbookToExport = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
            const sillyTavernWorldbook = convertToSillyTavernFormat(worldbookToExport);
            let fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-酒馆书-${timeString}` : `酒馆书-${timeString}`;
            const blob = new Blob([JSON.stringify(sillyTavernWorldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = fileName + '.json'; a.click();
            URL.revokeObjectURL(url);
            alert('世界书已转换为SillyTavern格式并下载！');
        } catch (error) {
            alert('转换失败：' + error.message);
        }
    }

    function exportVolumes() {
        if (worldbookVolumes.length === 0) { alert('没有分卷数据'); return; }
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        for (let i = 0; i < worldbookVolumes.length; i++) {
            const volume = worldbookVolumes[i];
            const fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-卷${i + 1}-${timeString}.json` : `世界书-卷${i + 1}-${timeString}.json`;
            const blob = new Blob([JSON.stringify(volume.worldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
            URL.revokeObjectURL(url);
        }
        alert(`已导出 ${worldbookVolumes.length} 卷`);
    }

    async function exportTaskState() {
        const state = { version: '2.4.1', timestamp: Date.now(), memoryQueue, generatedWorldbook, worldbookVolumes, currentVolumeIndex, fileHash: currentFileHash, settings, parallelConfig };
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        const fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-任务-${timeString}.json` : `任务-${timeString}.json`;
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
        URL.revokeObjectURL(url);
        alert(`任务状态已导出！已处理: ${memoryQueue.filter(m => m.processed).length}/${memoryQueue.length}`);
    }

    async function importTaskState() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const content = await file.text();
                const state = JSON.parse(content);
                if (!state.memoryQueue || !Array.isArray(state.memoryQueue)) throw new Error('无效的任务状态文件');
                memoryQueue = state.memoryQueue;
                generatedWorldbook = state.generatedWorldbook || {};
                worldbookVolumes = state.worldbookVolumes || [];
                currentVolumeIndex = state.currentVolumeIndex || 0;
                currentFileHash = state.fileHash || null;
                if (state.settings) settings = { ...defaultSettings, ...state.settings };
                if (state.parallelConfig) parallelConfig = { ...parallelConfig, ...state.parallelConfig };
                const firstUnprocessed = memoryQueue.findIndex(m => !m.processed || m.failed);
                startFromIndex = firstUnprocessed !== -1 ? firstUnprocessed : 0;
                userSelectedStartIndex = null;
                showQueueSection(true);
                updateMemoryQueueUI();
                if (useVolumeMode) updateVolumeIndicator();
                updateStartButtonState(false);
                updateSettingsUI();
                document.getElementById('ttw-start-btn').disabled = false;
                alert(`任务状态已导入！将从记忆${startFromIndex + 1}继续`);
            } catch (error) {
                alert('导入失败: ' + error.message);
            }
        };
        input.click();
    }

    function updateSettingsUI() {
        document.getElementById('ttw-chunk-size').value = settings.chunkSize;
        document.getElementById('ttw-api-timeout').value = Math.round((settings.apiTimeout || 120000) / 1000);
        document.getElementById('ttw-incremental-mode').checked = incrementalOutputMode;
        document.getElementById('ttw-volume-mode').checked = useVolumeMode;
        document.getElementById('ttw-enable-plot').checked = settings.enablePlotOutline;
        document.getElementById('ttw-enable-style').checked = settings.enableLiteraryStyle;
        document.getElementById('ttw-worldbook-prompt').value = settings.customWorldbookPrompt || '';
        document.getElementById('ttw-plot-prompt').value = settings.customPlotPrompt || '';
        document.getElementById('ttw-style-prompt').value = settings.customStylePrompt || '';
        document.getElementById('ttw-parallel-enabled').checked = parallelConfig.enabled;
        document.getElementById('ttw-parallel-concurrency').value = parallelConfig.concurrency;
        document.getElementById('ttw-parallel-mode').value = parallelConfig.mode;
    }

    // ========== 帮助弹窗 ==========
    function showHelpModal() {
        const existingHelp = document.getElementById('ttw-help-modal');
        if (existingHelp) existingHelp.remove();
        const helpModal = document.createElement('div');
        helpModal.id = 'ttw-help-modal';
        helpModal.className = 'ttw-modal-container';
        helpModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 600px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">❓ TXT转世界书 v2.4.1 帮助</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 70vh; overflow-y: auto;">
                    <div style="margin-bottom: 16px;">
                        <h4 style="color: #e67e22; margin: 0 0 10px 0;">📌 基本功能</h4>
                        <p style="color: #ccc; line-height: 1.6;">将TXT小说转换为SillyTavern世界书格式。</p>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <h4 style="color: #27ae60; margin: 0 0 10px 0;">✨ v2.4.1 修复</h4>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li>修复API调用CSRF错误</li>
                            <li>重Roll按钮位置更明显</li>
                            <li>新增JSON导入合并功能</li>
                            <li>修复ABORTED错误</li>
                        </ul>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <h4 style="color: #3498db; margin: 0 0 10px 0;">🎲 重Roll功能</h4>
                        <p style="color: #ccc; line-height: 1.6;">点击记忆 → Roll历史 → 点击"🎲 重新Roll"按钮</p>
                    </div>
                    <div>
                        <h4 style="color: #9b59b6; margin: 0 0 10px 0;">📥 导入合并</h4>
                        <p style="color: #ccc; line-height: 1.6;">在结果区域点击"📥 导入合并"，可导入JSON世界书并智能合并重复条目。</p>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-primary" id="ttw-close-help">我知道了</button>
                </div>
            </div>
        `;
        document.body.appendChild(helpModal);
        helpModal.querySelector('.ttw-modal-close').addEventListener('click', () => helpModal.remove());
        helpModal.querySelector('#ttw-close-help').addEventListener('click', () => helpModal.remove());
        helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.remove(); });
    }

    function showStartFromSelector() {
        if (memoryQueue.length === 0) { alert('请先上传文件'); return; }
        const existingModal = document.getElementById('ttw-start-selector-modal');
        if (existingModal) existingModal.remove();
        const selectorModal = document.createElement('div');
        selectorModal.id = 'ttw-start-selector-modal';
        selectorModal.className = 'ttw-modal-container';
        let optionsHtml = '';
        memoryQueue.forEach((memory, index) => {
            const status = memory.processed ? (memory.failed ? '❗' : '✅') : '⏳';
            const currentSelected = userSelectedStartIndex !== null ? userSelectedStartIndex : startFromIndex;
            optionsHtml += `<option value="${index}" ${index === currentSelected ? 'selected' : ''}>${status} ${memory.title} (${memory.content.length.toLocaleString()}字)</option>`;
        });
        selectorModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 500px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📍 选择起始位置</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px;">从哪个记忆块开始：</label>
                        <select id="ttw-start-from-select" style="width: 100%; padding: 10px; border: 1px solid #555; border-radius: 6px; background: rgba(0,0,0,0.3); color: #fff;">${optionsHtml}</select>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-start-select">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-confirm-start-select">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(selectorModal);
        selectorModal.querySelector('.ttw-modal-close').addEventListener('click', () => selectorModal.remove());
        selectorModal.querySelector('#ttw-cancel-start-select').addEventListener('click', () => selectorModal.remove());
        selectorModal.querySelector('#ttw-confirm-start-select').addEventListener('click', () => {
            const selectedIndex = parseInt(document.getElementById('ttw-start-from-select').value);
            userSelectedStartIndex = selectedIndex;
            startFromIndex = selectedIndex;
            document.getElementById('ttw-start-btn').textContent = `▶️ 从记忆${selectedIndex + 1}开始`;
            selectorModal.remove();
        });
        selectorModal.addEventListener('click', (e) => { if (e.target === selectorModal) selectorModal.remove(); });
    }

    // ========== 【修复】记忆内容弹窗 - 加入重Roll按钮 ==========
    function showMemoryContentModal(index) {
        const memory = memoryQueue[index];
        if (!memory) return;
        const existingModal = document.getElementById('ttw-memory-content-modal');
        if (existingModal) existingModal.remove();

        const contentModal = document.createElement('div');
        contentModal.id = 'ttw-memory-content-modal';
        contentModal.className = 'ttw-modal-container';

        const statusText = memory.processing ? '🔄 处理中' : (memory.processed ? (memory.failed ? '❗ 失败' : '✅ 已处理') : '⏳ 未处理');
        const statusColor = memory.processing ? '#3498db' : (memory.processed ? (memory.failed ? '#e74c3c' : '#27ae60') : '#f39c12');

        let resultHtml = '';
        if (memory.processed && memory.result && !memory.failed) {
            resultHtml = `
                <div style="margin-top: 16px;">
                    <h4 style="color: #9b59b6; margin: 0 0 10px 0;">📊 处理结果</h4>
                    <pre style="max-height: 120px; overflow-y: auto; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all;">${JSON.stringify(memory.result, null, 2)}</pre>
                </div>
            `;
        }

        contentModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📄 ${memory.title}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 75vh; overflow-y: auto;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px; flex-wrap: wrap; gap: 10px;">
                        <div>
                            <span style="color: ${statusColor}; font-weight: bold;">${statusText}</span>
                            <span style="margin-left: 16px; color: #888;">字数: <span id="ttw-char-count">${memory.content.length.toLocaleString()}</span></span>
                        </div>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                            <button id="ttw-reroll-btn" class="ttw-btn ttw-btn-primary ttw-btn-small" style="background: linear-gradient(135deg, #9b59b6, #8e44ad);">🎲 重Roll</button>
                            <button id="ttw-roll-history-btn" class="ttw-btn ttw-btn-small">📜 Roll历史</button>
                            <button id="ttw-copy-memory-content" class="ttw-btn ttw-btn-small">📋 复制</button>
                            <button id="ttw-delete-memory-btn" class="ttw-btn ttw-btn-warning ttw-btn-small">🗑️ 删除</button>
                        </div>
                    </div>
                    ${memory.failedError ? `<div style="margin-bottom: 16px; padding: 10px; background: rgba(231, 76, 60, 0.2); border-radius: 6px; color: #e74c3c; font-size: 12px;">❌ 错误: ${memory.failedError}</div>` : ''}

                    <div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <h4 style="color: #3498db; margin: 0;">📝 原文内容 <span style="font-size: 12px; font-weight: normal; color: #888;">(可编辑)</span></h4>
                            <div style="display: flex; gap: 8px;">
                                <button id="ttw-append-to-prev" class="ttw-btn ttw-btn-small" ${index === 0 ? 'disabled style="opacity: 0.5;"' : ''}>⬆️ 追加到上一个</button>
                                <button id="ttw-append-to-next" class="ttw-btn ttw-btn-small" ${index === memoryQueue.length - 1 ? 'disabled style="opacity: 0.5;"' : ''}>⬇️ 追加到下一个</button>
                            </div>
                        </div>
                        <textarea id="ttw-memory-content-editor" style="width: 100%; min-height: 200px; padding: 12px; background: rgba(0,0,0,0.3); border: 1px solid #555; border-radius: 6px; color: #fff; font-size: 13px; line-height: 1.6; resize: vertical;">${memory.content.replace(/</g, '<').replace(/>/g, '>')}</textarea>
                    </div>
                    ${resultHtml}
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-memory-edit">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-save-memory-edit">💾 保存修改</button>
                </div>
            </div>
        `;

        document.body.appendChild(contentModal);

        const editor = contentModal.querySelector('#ttw-memory-content-editor');
        const charCount = contentModal.querySelector('#ttw-char-count');
        editor.addEventListener('input', () => { charCount.textContent = editor.value.length.toLocaleString(); });

        contentModal.querySelector('.ttw-modal-close').addEventListener('click', () => contentModal.remove());
        contentModal.querySelector('#ttw-cancel-memory-edit').addEventListener('click', () => contentModal.remove());
        contentModal.addEventListener('click', (e) => { if (e.target === contentModal) contentModal.remove(); });

        contentModal.querySelector('#ttw-save-memory-edit').addEventListener('click', () => {
            const newContent = editor.value;
            if (newContent !== memory.content) {
                memory.content = newContent;
                memory.processed = false;
                memory.failed = false;
                memory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
            }
            contentModal.remove();
        });

        contentModal.querySelector('#ttw-copy-memory-content').addEventListener('click', () => {
            navigator.clipboard.writeText(editor.value).then(() => {
                const btn = contentModal.querySelector('#ttw-copy-memory-content');
                btn.textContent = '✅ 已复制';
                setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
            });
        });

        // 【修复】重Roll按钮
        contentModal.querySelector('#ttw-reroll-btn').addEventListener('click', async () => {
            const btn = contentModal.querySelector('#ttw-reroll-btn');
            btn.disabled = true;
            btn.textContent = '🔄 生成中...';
            try {
                await rerollMemory(index);
                contentModal.remove();
                showMemoryContentModal(index); // 重新打开显示新结果
            } catch (error) {
                btn.disabled = false;
                btn.textContent = '🎲 重Roll';
                alert('重Roll失败: ' + error.message);
            }
        });

        contentModal.querySelector('#ttw-roll-history-btn').addEventListener('click', () => {
            contentModal.remove();
            showRollHistorySelector(index);
        });

        contentModal.querySelector('#ttw-delete-memory-btn').addEventListener('click', () => {
            contentModal.remove();
            deleteMemoryAt(index);
        });

        contentModal.querySelector('#ttw-append-to-prev').addEventListener('click', () => {
            if (index === 0) return;
            const prevMemory = memoryQueue[index - 1];
            if (confirm(`确定追加到 "${prevMemory.title}" 末尾吗？`)) {
                prevMemory.content += '\n\n' + editor.value;
                prevMemory.processed = false;
                prevMemory.failed = false;
                prevMemory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
                alert(`已追加到 "${prevMemory.title}"`);
            }
        });

        contentModal.querySelector('#ttw-append-to-next').addEventListener('click', () => {
            if (index === memoryQueue.length - 1) return;
            const nextMemory = memoryQueue[index + 1];
            if (confirm(`确定追加到 "${nextMemory.title}" 开头吗？`)) {
                nextMemory.content = editor.value + '\n\n' + nextMemory.content;
                nextMemory.processed = false;
                nextMemory.failed = false;
                nextMemory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
                alert(`已追加到 "${nextMemory.title}"`);
            }
        });
    }

    function showProcessedResults() {
        const processedMemories = memoryQueue.filter(m => m.processed && !m.failed && m.result);
        if (processedMemories.length === 0) { alert('暂无已处理的结果'); return; }
        const existingModal = document.getElementById('ttw-processed-results-modal');
        if (existingModal) existingModal.remove();

        const resultsModal = document.createElement('div');
        resultsModal.id = 'ttw-processed-results-modal';
        resultsModal.className = 'ttw-modal-container';

        let listHtml = '';
        processedMemories.forEach((memory) => {
            const realIndex = memoryQueue.indexOf(memory);
            const entryCount = memory.result ? Object.keys(memory.result).reduce((sum, cat) => sum + (typeof memory.result[cat] === 'object' ? Object.keys(memory.result[cat]).length : 0), 0) : 0;
            listHtml += `
                <div class="ttw-processed-item" data-index="${realIndex}" style="padding: 10px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #27ae60;">
                    <div style="font-weight: bold; color: #27ae60; margin-bottom: 4px;">✅ ${memory.title}</div>
                    <div style="font-size: 11px; color: #888;">${entryCount} 条目 | ${memory.content.length.toLocaleString()} 字</div>
                </div>
            `;
        });

        resultsModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📊 已处理结果 (${processedMemories.length}/${memoryQueue.length})</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display: flex; gap: 15px; height: 450px;">
                        <div style="width: 250px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">${listHtml}</div>
                        <div id="ttw-result-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 点击左侧记忆查看</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-close-processed-results">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(resultsModal);

        resultsModal.querySelector('.ttw-modal-close').addEventListener('click', () => resultsModal.remove());
        resultsModal.querySelector('#ttw-close-processed-results').addEventListener('click', () => resultsModal.remove());
        resultsModal.addEventListener('click', (e) => { if (e.target === resultsModal) resultsModal.remove(); });

        resultsModal.querySelectorAll('.ttw-processed-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                const memory = memoryQueue[index];
                const detailDiv = resultsModal.querySelector('#ttw-result-detail');
                resultsModal.querySelectorAll('.ttw-processed-item').forEach(i => i.style.background = 'rgba(0,0,0,0.2)');
                item.style.background = 'rgba(0,0,0,0.4)';
                if (memory && memory.result) {
                    detailDiv.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                            <h4 style="color: #27ae60; margin: 0;">${memory.title}</h4>
                            <button class="ttw-btn ttw-btn-small" id="ttw-copy-result">📋 复制</button>
                        </div>
                        <pre style="white-space: pre-wrap; word-break: break-all; font-size: 11px; line-height: 1.5;">${JSON.stringify(memory.result, null, 2)}</pre>
                    `;
                    detailDiv.querySelector('#ttw-copy-result').addEventListener('click', () => {
                        navigator.clipboard.writeText(JSON.stringify(memory.result, null, 2)).then(() => {
                            const btn = detailDiv.querySelector('#ttw-copy-result');
                            btn.textContent = '✅ 已复制';
                            setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
                        });
                    });
                }
            });
        });
    }

    // ========== UI相关 ==========
    let modalContainer = null;

    function createModal() {
        if (modalContainer) modalContainer.remove();

        modalContainer = document.createElement('div');
        modalContainer.id = 'txt-to-worldbook-modal';
        modalContainer.className = 'ttw-modal-container';
        modalContainer.innerHTML = `
            <div class="ttw-modal">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📚 TXT转世界书 v2.4.1</span>
                    <div class="ttw-header-actions">
                        <span class="ttw-help-btn" title="帮助">❓</span>
                        <button class="ttw-modal-close" type="button">✕</button>
                    </div>
                </div>
                <div class="ttw-modal-body">
                    <!-- 设置区域 -->
                    <div class="ttw-section ttw-settings-section">
                        <div class="ttw-section-header" data-section="settings">
                            <span>⚙️ 设置</span>
                            <span class="ttw-collapse-icon">▼</span>
                        </div>
                        <div class="ttw-section-content" id="ttw-settings-content">
                            <div class="ttw-parallel-settings" style="margin-bottom: 16px; padding: 12px; background: rgba(52, 152, 219, 0.15); border: 1px solid rgba(52, 152, 219, 0.3); border-radius: 8px;">
                                <div style="font-weight: bold; color: #3498db; margin-bottom: 10px;">🚀 并行处理</div>
                                <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                                    <label class="ttw-checkbox-label" style="display: flex; align-items: center; gap: 8px;">
                                        <input type="checkbox" id="ttw-parallel-enabled" checked style="width: 18px; height: 18px;">
                                        <span>启用并行</span>
                                    </label>
                                    <div>
                                        <label style="font-size: 12px;">并发数</label>
                                        <input type="number" id="ttw-parallel-concurrency" value="3" min="1" max="10" style="width: 60px; padding: 6px; margin-left: 8px;">
                                    </div>
                                    <select id="ttw-parallel-mode" style="padding: 8px; border: 1px solid #555; border-radius: 4px; background: rgba(0,0,0,0.3); color: #fff; font-size: 12px;">
                                        <option value="independent">🚀 独立模式</option>
                                        <option value="batch">📦 分批模式</option>
                                    </select>
                                </div>
                            </div>

                            <div class="ttw-setting-row" style="display: flex; gap: 12px;">
                                <div class="ttw-setting-item" style="flex: 1;">
                                    <label>每块字数</label>
                                    <input type="number" id="ttw-chunk-size" value="15000" min="1000" max="500000">
                                </div>
                                <div class="ttw-setting-item" style="flex: 1;">
                                    <label>API超时(秒)</label>
                                    <input type="number" id="ttw-api-timeout" value="120" min="30" max="600">
                                </div>
                            </div>
                            <div class="ttw-checkbox-group" style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
                                <label class="ttw-checkbox-label" style="display: flex; align-items: center; gap: 8px;">
                                    <input type="checkbox" id="ttw-incremental-mode" checked>
                                    <span>📝 增量输出</span>
                                </label>
                                <label class="ttw-checkbox-label" style="display: flex; align-items: center; gap: 8px; background: rgba(155, 89, 182, 0.15); padding: 8px 12px; border-radius: 6px;">
                                    <input type="checkbox" id="ttw-volume-mode">
                                    <span>📦 分卷模式</span>
                                </label>
                            </div>
                            <div id="ttw-volume-indicator" style="display: none; margin-top: 12px; padding: 8px 12px; background: rgba(155, 89, 182, 0.2); border-radius: 6px; font-size: 12px; color: #bb86fc;"></div>

                            <!-- 提示词配置 -->
                            <div class="ttw-prompt-config" style="margin-top: 16px; border: 1px solid #444; border-radius: 8px; overflow: hidden;">
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; background: rgba(230, 126, 34, 0.15); border-bottom: 1px solid #444;">
                                    <span>📝 提示词配置</span>
                                    <button id="ttw-preview-prompt" class="ttw-btn-small">👁️ 预览</button>
                                </div>
                                <div class="ttw-prompt-section" style="border-bottom: 1px solid #333;">
                                    <div class="ttw-prompt-header" data-target="ttw-worldbook-content" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; cursor: pointer; background: rgba(52, 152, 219, 0.1);">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <span>📚</span><span>世界书词条</span>
                                            <span style="font-size: 10px; padding: 2px 6px; border-radius: 10px; background: rgba(52, 152, 219, 0.3); color: #5dade2;">必需</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-worldbook-content" style="display: none; padding: 12px 14px; background: rgba(0, 0, 0, 0.15);">
                                        <div style="font-size: 11px; color: #888; margin-bottom: 10px;">留空使用默认。</div>
                                        <textarea id="ttw-worldbook-prompt" rows="6" style="width: 100%; padding: 10px; border: 1px solid #444; border-radius: 4px; background: #1e1e2e; color: #fff; font-family: monospace; font-size: 12px; resize: vertical;" placeholder="留空使用默认..."></textarea>
                                        <div style="margin-top: 8px;"><button class="ttw-btn-small ttw-reset-prompt" data-type="worldbook">🔄 恢复默认</button></div>
                                    </div>
                                </div>
                                <div class="ttw-prompt-section" style="border-bottom: 1px solid #333;">
                                    <div class="ttw-prompt-header" data-target="ttw-plot-content" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; cursor: pointer; background: rgba(155, 89, 182, 0.1);">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="checkbox" id="ttw-enable-plot" style="width: 16px; height: 16px;"><span>📖</span><span>剧情大纲</span></label>
                                            <span style="font-size: 10px; padding: 2px 6px; border-radius: 10px; background: rgba(149, 165, 166, 0.3); color: #bdc3c7;">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-plot-content" style="display: none; padding: 12px 14px; background: rgba(0, 0, 0, 0.15);">
                                        <textarea id="ttw-plot-prompt" rows="4" style="width: 100%; padding: 10px; border: 1px solid #444; border-radius: 4px; background: #1e1e2e; color: #fff; font-family: monospace; font-size: 12px; resize: vertical;" placeholder="留空使用默认..."></textarea>
                                        <div style="margin-top: 8px;"><button class="ttw-btn-small ttw-reset-prompt" data-type="plot">🔄 恢复默认</button></div>
                                    </div>
                                </div>
                                <div class="ttw-prompt-section">
                                    <div class="ttw-prompt-header" data-target="ttw-style-content" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; cursor: pointer; background: rgba(46, 204, 113, 0.1);">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="checkbox" id="ttw-enable-style" style="width: 16px; height: 16px;"><span>🎨</span><span>文风配置</span></label>
                                            <span style="font-size: 10px; padding: 2px 6px; border-radius: 10px; background: rgba(149, 165, 166, 0.3); color: #bdc3c7;">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-style-content" style="display: none; padding: 12px 14px; background: rgba(0, 0, 0, 0.15);">
                                        <textarea id="ttw-style-prompt" rows="4" style="width: 100%; padding: 10px; border: 1px solid #444; border-radius: 4px; background: #1e1e2e; color: #fff; font-family: monospace; font-size: 12px; resize: vertical;" placeholder="留空使用默认..."></textarea>
                                        <div style="margin-top: 8px;"><button class="ttw-btn-small ttw-reset-prompt" data-type="style">🔄 恢复默认</button></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 文件上传 -->
                    <div class="ttw-section ttw-upload-section">
                        <div class="ttw-section-header">
                            <span>📄 文件上传</span>
                            <div style="display: flex; gap: 8px;">
                                <button id="ttw-import-task" class="ttw-btn-small">📥 导入任务</button>
                                <button id="ttw-export-task" class="ttw-btn-small">📤 导出任务</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-upload-area" id="ttw-upload-area" style="border: 2px dashed #555; border-radius: 8px; padding: 40px 20px; text-align: center; cursor: pointer;">
                                <div style="font-size: 48px; margin-bottom: 12px;">📁</div>
                                <div>点击或拖拽TXT文件到此处</div>
                                <input type="file" id="ttw-file-input" accept=".txt" style="display: none;">
                            </div>
                            <div id="ttw-file-info" style="display: none; display: flex; align-items: center; gap: 12px; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-top: 12px;">
                                <span id="ttw-file-name"></span>
                                <span id="ttw-file-size"></span>
                                <button id="ttw-clear-file" class="ttw-btn-small">清除</button>
                            </div>
                        </div>
                    </div>

                    <!-- 记忆队列 -->
                    <div class="ttw-section ttw-queue-section" id="ttw-queue-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>📋 记忆队列</span>
                            <div style="display: flex; gap: 8px; margin-left: auto;">
                                <button id="ttw-view-processed" class="ttw-btn-small">📊 已处理</button>
                                <button id="ttw-select-start" class="ttw-btn-small">📍 选择起始</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div style="font-size: 11px; color: #888; margin-bottom: 8px;">💡 点击记忆可<strong>编辑/复制/重Roll</strong></div>
                            <div class="ttw-memory-queue" id="ttw-memory-queue" style="max-height: 200px; overflow-y: auto;"></div>
                        </div>
                    </div>

                    <!-- 进度 -->
                    <div class="ttw-section ttw-progress-section" id="ttw-progress-section" style="display: none;">
                        <div class="ttw-section-header"><span>⏳ 处理进度</span></div>
                        <div class="ttw-section-content">
                            <div style="width: 100%; height: 8px; background: rgba(0,0,0,0.3); border-radius: 4px; overflow: hidden; margin-bottom: 12px;">
                                <div id="ttw-progress-fill" style="height: 100%; background: linear-gradient(90deg, #e67e22, #f39c12); border-radius: 4px; transition: width 0.3s; width: 0%;"></div>
                            </div>
                            <div id="ttw-progress-text" style="font-size: 13px; text-align: center; margin-bottom: 12px;">准备中...</div>
                            <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
                                <button id="ttw-stop-btn" class="ttw-btn" style="background: rgba(108, 117, 125, 0.5);">⏸️ 暂停</button>
                                <button id="ttw-repair-btn" class="ttw-btn" style="display: none; background: rgba(255, 107, 53, 0.5); border-color: #ff6b35;">🔧 修复失败</button>
                                <button id="ttw-toggle-stream" class="ttw-btn-small">👁️ 实时输出</button>
                            </div>
                            <div id="ttw-stream-container" style="display: none; margin-top: 12px; border: 1px solid #444; border-radius: 6px; overflow: hidden;">
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(0,0,0,0.3); font-size: 12px;">
                                    <span>📤 实时输出</span>
                                    <button id="ttw-clear-stream" class="ttw-btn-small">清空</button>
                                </div>
                                <pre id="ttw-stream-content" style="max-height: 200px; overflow-y: auto; padding: 12px; background: rgba(0,0,0,0.2); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; margin: 0; font-family: monospace;"></pre>
                            </div>
                        </div>
                    </div>

                    <!-- 结果 -->
                    <div class="ttw-section ttw-result-section" id="ttw-result-section" style="display: none;">
                        <div class="ttw-section-header"><span>📊 生成结果</span></div>
                        <div class="ttw-section-content">
                            <div id="ttw-result-preview" style="max-height: 300px; overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 12px;"></div>
                            <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                                <button id="ttw-view-worldbook" class="ttw-btn">📖 查看世界书</button>
                                <button id="ttw-view-history" class="ttw-btn">📜 修改历史</button>
                                <button id="ttw-import-merge" class="ttw-btn" style="background: rgba(155, 89, 182, 0.3);">📥 导入合并</button>
                                <button id="ttw-export-json" class="ttw-btn">📥 导出JSON</button>
                                <button id="ttw-export-volumes" class="ttw-btn" style="display: none;">📦 分卷导出</button>
                                <button id="ttw-export-st" class="ttw-btn" style="background: linear-gradient(135deg, #e67e22, #d35400); border-color: #e67e22;">📥 导出SillyTavern格式</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button id="ttw-start-btn" class="ttw-btn" style="background: linear-gradient(135deg, #e67e22, #d35400); border-color: #e67e22;" disabled>🚀 开始转换</button>
                </div>
            </div>
        `;

        document.body.appendChild(modalContainer);
        addModalStyles();
        bindModalEvents();
        loadSavedSettings();
        checkAndRestoreState();
    }

    function addModalStyles() {
        if (document.getElementById('ttw-styles')) return;
        const styles = document.createElement('style');
        styles.id = 'ttw-styles';
        styles.textContent = `
            .ttw-modal-container { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 99999; padding: 20px; box-sizing: border-box; }
            .ttw-modal { background: var(--SmartThemeBlurTintColor, #1e1e2e); border: 1px solid var(--SmartThemeBorderColor, #555); border-radius: 12px; width: 100%; max-width: 750px; max-height: calc(100vh - 40px); display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); overflow: hidden; }
            .ttw-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); background: rgba(0, 0, 0, 0.2); }
            .ttw-modal-title { font-weight: bold; font-size: 16px; color: #e67e22; }
            .ttw-header-actions { display: flex; align-items: center; gap: 12px; }
            .ttw-help-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: rgba(231, 76, 60, 0.2); color: #e74c3c; font-size: 14px; cursor: pointer; transition: all 0.2s; border: 1px solid rgba(231, 76, 60, 0.4); }
            .ttw-help-btn:hover { background: rgba(231, 76, 60, 0.4); transform: scale(1.1); }
            .ttw-modal-close { background: rgba(255, 255, 255, 0.1); border: none; color: #fff; font-size: 18px; width: 36px; height: 36px; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
            .ttw-modal-close:hover { background: rgba(255, 100, 100, 0.3); color: #ff6b6b; }
            .ttw-modal-body { flex: 1; overflow-y: auto; padding: 16px; }
            .ttw-modal-footer { padding: 16px 20px; border-top: 1px solid var(--SmartThemeBorderColor, #444); background: rgba(0, 0, 0, 0.2); display: flex; justify-content: flex-end; gap: 10px; }
            .ttw-section { background: rgba(0, 0, 0, 0.2); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
            .ttw-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: rgba(0, 0, 0, 0.3); cursor: pointer; font-weight: bold; font-size: 14px; }
            .ttw-section-content { padding: 16px; }
            .ttw-collapse-icon { font-size: 10px; transition: transform 0.2s; }
            .ttw-section.collapsed .ttw-collapse-icon { transform: rotate(-90deg); }
            .ttw-section.collapsed .ttw-section-content { display: none; }
            .ttw-setting-item { margin-bottom: 12px; }
            .ttw-setting-item > label { display: block; margin-bottom: 6px; font-size: 12px; opacity: 0.9; }
            .ttw-setting-item input, .ttw-setting-item select { width: 100%; padding: 10px 12px; border: 1px solid var(--SmartThemeBorderColor, #555); border-radius: 6px; background: rgba(0, 0, 0, 0.3); color: #fff; font-size: 13px; box-sizing: border-box; }
            .ttw-checkbox-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
            .ttw-checkbox-label input { width: 18px; height: 18px; accent-color: #e67e22; }
            .ttw-memory-item { padding: 8px 12px; background: rgba(0, 0, 0, 0.2); border-radius: 4px; margin-bottom: 6px; font-size: 13px; display: flex; align-items: center; gap: 8px; cursor: pointer; transition: background 0.2s; }
            .ttw-memory-item:hover { background: rgba(0, 0, 0, 0.4); }
            .ttw-memory-item.processed { opacity: 0.6; }
            .ttw-memory-item.processing { border-left: 3px solid #3498db; background: rgba(52, 152, 219, 0.15); opacity: 1; }
            .ttw-memory-item.failed { border-left: 3px solid #e74c3c; opacity: 1; }
            .ttw-btn { padding: 10px 16px; border: 1px solid var(--SmartThemeBorderColor, #555); border-radius: 6px; background: rgba(255, 255, 255, 0.1); color: #fff; font-size: 13px; cursor: pointer; transition: all 0.2s; }
            .ttw-btn:hover { background: rgba(255, 255, 255, 0.2); }
            .ttw-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .ttw-btn-small { padding: 6px 12px; font-size: 12px; border: 1px solid var(--SmartThemeBorderColor, #555); border-radius: 4px; background: rgba(255, 255, 255, 0.1); color: #fff; cursor: pointer; transition: all 0.2s; }
            .ttw-btn-small:hover { background: rgba(255, 255, 255, 0.2); }
            .ttw-btn-primary { background: linear-gradient(135deg, #e67e22, #d35400); border-color: #e67e22; }
            .ttw-btn-primary:hover { background: linear-gradient(135deg, #f39c12, #e67e22); }
            .ttw-btn-warning { background: rgba(255, 107, 53, 0.5); border-color: #ff6b35; }
            .ttw-category-card { margin-bottom: 12px; border: 1px solid #e67e22; border-radius: 8px; overflow: hidden; }
            .ttw-category-header { background: linear-gradient(135deg, #e67e22, #d35400); padding: 10px 14px; cursor: pointer; font-weight: bold; font-size: 14px; display: flex; justify-content: space-between; }
            .ttw-category-content { background: #2d2d2d; display: none; }
            .ttw-entry-card { margin: 8px; border: 1px solid #555; border-radius: 6px; overflow: hidden; }
            .ttw-entry-header { background: #3a3a3a; padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between; border-left: 3px solid #3498db; }
            .ttw-entry-content { display: none; background: #1c1c1c; padding: 12px; }
            .ttw-keywords { margin-bottom: 8px; padding: 8px; background: #252525; border-left: 3px solid #9b59b6; border-radius: 4px; }
            .ttw-content-text { padding: 8px; background: #252525; border-left: 3px solid #27ae60; border-radius: 4px; line-height: 1.6; }
        `;
        document.head.appendChild(styles);
    }

    function bindModalEvents() {
        const modal = modalContainer.querySelector('.ttw-modal');
        modal.addEventListener('click', (e) => e.stopPropagation(), false);
        modal.addEventListener('mousedown', (e) => e.stopPropagation(), false);

        modalContainer.querySelector('.ttw-modal-close').addEventListener('click', (e) => { e.stopPropagation(); closeModal(); }, false);
        modalContainer.querySelector('.ttw-help-btn').addEventListener('click', (e) => { e.stopPropagation(); showHelpModal(); }, false);
        modalContainer.addEventListener('click', (e) => { if (e.target === modalContainer) closeModal(); }, false);
        document.addEventListener('keydown', handleEscKey, true);

        ['ttw-chunk-size', 'ttw-api-timeout'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });
        ['ttw-incremental-mode', 'ttw-volume-mode', 'ttw-enable-plot', 'ttw-enable-style'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });

        document.getElementById('ttw-parallel-enabled').addEventListener('change', (e) => { parallelConfig.enabled = e.target.checked; saveCurrentSettings(); });
        document.getElementById('ttw-parallel-concurrency').addEventListener('change', (e) => { parallelConfig.concurrency = Math.max(1, Math.min(10, parseInt(e.target.value) || 3)); e.target.value = parallelConfig.concurrency; saveCurrentSettings(); });
        document.getElementById('ttw-parallel-mode').addEventListener('change', (e) => { parallelConfig.mode = e.target.value; saveCurrentSettings(); });
        document.getElementById('ttw-volume-mode').addEventListener('change', (e) => { useVolumeMode = e.target.checked; const indicator = document.getElementById('ttw-volume-indicator'); if (indicator) indicator.style.display = useVolumeMode ? 'block' : 'none'; });

        document.querySelectorAll('.ttw-prompt-header[data-target]').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const targetId = header.getAttribute('data-target');
                const content = document.getElementById(targetId);
                const icon = header.querySelector('.ttw-collapse-icon');
                if (content.style.display === 'none') { content.style.display = 'block'; icon.textContent = '▼'; }
                else { content.style.display = 'none'; icon.textContent = '▶'; }
            });
        });

        ['ttw-worldbook-prompt', 'ttw-plot-prompt', 'ttw-style-prompt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', saveCurrentSettings);
        });

        document.querySelectorAll('.ttw-reset-prompt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = btn.getAttribute('data-type');
                const textarea = document.getElementById(`ttw-${type}-prompt`);
                if (textarea) { textarea.value = ''; saveCurrentSettings(); }
            });
        });

        document.getElementById('ttw-preview-prompt').addEventListener('click', showPromptPreview);
        document.getElementById('ttw-import-task').addEventListener('click', importTaskState);
        document.getElementById('ttw-export-task').addEventListener('click', exportTaskState);

        const uploadArea = document.getElementById('ttw-upload-area');
        const fileInput = document.getElementById('ttw-file-input');
        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#e67e22'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = '#555'; });
        uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#555'; if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]); });
        fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFileSelect(e.target.files[0]); });

        document.getElementById('ttw-clear-file').addEventListener('click', clearFile);
        document.getElementById('ttw-start-btn').addEventListener('click', startConversion);
        document.getElementById('ttw-stop-btn').addEventListener('click', stopProcessing);
        document.getElementById('ttw-repair-btn').addEventListener('click', startRepairFailedMemories);
        document.getElementById('ttw-select-start').addEventListener('click', showStartFromSelector);
        document.getElementById('ttw-view-processed').addEventListener('click', showProcessedResults);
        document.getElementById('ttw-toggle-stream').addEventListener('click', () => { const container = document.getElementById('ttw-stream-container'); container.style.display = container.style.display === 'none' ? 'block' : 'none'; });
        document.getElementById('ttw-clear-stream').addEventListener('click', () => { updateStreamContent('', true); });
        document.getElementById('ttw-view-worldbook').addEventListener('click', showWorldbookView);
        document.getElementById('ttw-view-history').addEventListener('click', showHistoryView);
        document.getElementById('ttw-import-merge').addEventListener('click', showImportMergeModal);
        document.getElementById('ttw-export-json').addEventListener('click', exportWorldbook);
        document.getElementById('ttw-export-volumes').addEventListener('click', exportVolumes);
        document.getElementById('ttw-export-st').addEventListener('click', exportToSillyTavern);

        document.querySelector('[data-section="settings"]').addEventListener('click', () => { document.querySelector('.ttw-settings-section').classList.toggle('collapsed'); });
    }

    function handleEscKey(e) {
        if (e.key === 'Escape' && modalContainer) {
            e.stopPropagation();
            e.preventDefault();
            closeModal();
        }
    }

    function saveCurrentSettings() {
        settings.chunkSize = parseInt(document.getElementById('ttw-chunk-size').value) || 15000;
        settings.apiTimeout = (parseInt(document.getElementById('ttw-api-timeout').value) || 120) * 1000;
        incrementalOutputMode = document.getElementById('ttw-incremental-mode').checked;
        useVolumeMode = document.getElementById('ttw-volume-mode').checked;
        settings.useVolumeMode = useVolumeMode;
        settings.enablePlotOutline = document.getElementById('ttw-enable-plot').checked;
        settings.enableLiteraryStyle = document.getElementById('ttw-enable-style').checked;
        settings.customWorldbookPrompt = document.getElementById('ttw-worldbook-prompt').value;
        settings.customPlotPrompt = document.getElementById('ttw-plot-prompt').value;
        settings.customStylePrompt = document.getElementById('ttw-style-prompt').value;
        settings.parallelEnabled = parallelConfig.enabled;
        settings.parallelConcurrency = parallelConfig.concurrency;
        settings.parallelMode = parallelConfig.mode;
        try { localStorage.setItem('txtToWorldbookSettings', JSON.stringify(settings)); } catch (e) {}
    }

    function loadSavedSettings() {
        try {
            const saved = localStorage.getItem('txtToWorldbookSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                settings = { ...defaultSettings, ...parsed };
                useVolumeMode = settings.useVolumeMode || false;
                parallelConfig.enabled = settings.parallelEnabled !== undefined ? settings.parallelEnabled : true;
                parallelConfig.concurrency = settings.parallelConcurrency || 3;
                parallelConfig.mode = settings.parallelMode || 'independent';
            }
        } catch (e) {}

        document.getElementById('ttw-chunk-size').value = settings.chunkSize;
        document.getElementById('ttw-api-timeout').value = Math.round((settings.apiTimeout || 120000) / 1000);
        document.getElementById('ttw-incremental-mode').checked = incrementalOutputMode;
        document.getElementById('ttw-volume-mode').checked = useVolumeMode;
        document.getElementById('ttw-enable-plot').checked = settings.enablePlotOutline;
        document.getElementById('ttw-enable-style').checked = settings.enableLiteraryStyle;
        document.getElementById('ttw-worldbook-prompt').value = settings.customWorldbookPrompt || '';
        document.getElementById('ttw-plot-prompt').value = settings.customPlotPrompt || '';
        document.getElementById('ttw-style-prompt').value = settings.customStylePrompt || '';
        document.getElementById('ttw-parallel-enabled').checked = parallelConfig.enabled;
        document.getElementById('ttw-parallel-concurrency').value = parallelConfig.concurrency;
        document.getElementById('ttw-parallel-mode').value = parallelConfig.mode;

        const indicator = document.getElementById('ttw-volume-indicator');
        if (indicator) indicator.style.display = useVolumeMode ? 'block' : 'none';
    }

    function showPromptPreview() {
        const prompt = getSystemPrompt();
        const previewModal = document.createElement('div');
        previewModal.className = 'ttw-modal-container';
        previewModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 800px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">👁️ 提示词预览</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 70vh; overflow-y: auto;">
                    <pre style="white-space: pre-wrap; word-wrap: break-word; font-size: 12px; line-height: 1.5; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; max-height: 50vh; overflow-y: auto;">${prompt.replace(/</g, '<').replace(/>/g, '>')}</pre>
                </div>
                <div class="ttw-modal-footer"><button class="ttw-btn ttw-btn-primary ttw-close-preview">关闭</button></div>
            </div>
        `;
        previewModal.querySelector('.ttw-modal-close').addEventListener('click', () => previewModal.remove());
        previewModal.querySelector('.ttw-close-preview').addEventListener('click', () => previewModal.remove());
        previewModal.addEventListener('click', (e) => { if (e.target === previewModal) previewModal.remove(); });
        document.body.appendChild(previewModal);
    }

    async function checkAndRestoreState() {
        try {
            const savedState = await MemoryHistoryDB.loadState();
            if (savedState && savedState.memoryQueue && savedState.memoryQueue.length > 0) {
                const processedCount = savedState.memoryQueue.filter(m => m.processed).length;
                const unprocessedCount = savedState.memoryQueue.length - processedCount;
                const shouldRestore = confirm(`检测到未完成的任务\n\n已处理: ${processedCount}/${savedState.memoryQueue.length}\n未处理: ${unprocessedCount}\n\n是否恢复？`);
                if (shouldRestore) {
                    memoryQueue = savedState.memoryQueue;
                    generatedWorldbook = savedState.generatedWorldbook || {};
                    worldbookVolumes = savedState.worldbookVolumes || [];
                    currentVolumeIndex = savedState.currentVolumeIndex || 0;
                    currentFileHash = savedState.fileHash;
                    startFromIndex = memoryQueue.findIndex(m => !m.processed || m.failed);
                    if (startFromIndex === -1) startFromIndex = memoryQueue.length;
                    userSelectedStartIndex = null;
                    showQueueSection(true);
                    updateMemoryQueueUI();
                    if (useVolumeMode) updateVolumeIndicator();
                    if (startFromIndex >= memoryQueue.length) { showResultSection(true); updateWorldbookPreview(); }
                    updateStartButtonState(false);
                    document.getElementById('ttw-start-btn').disabled = false;
                } else {
                    await MemoryHistoryDB.clearState();
                }
            }
        } catch (e) {}
    }

    async function handleFileSelect(file) {
        if (!file.name.endsWith('.txt')) { alert('请选择TXT文件'); return; }
        try {
            const { encoding, content } = await detectBestEncoding(file);
            currentFile = file;
            const newHash = await calculateFileHash(content);
            const savedHash = await MemoryHistoryDB.getSavedFileHash();
            if (savedHash && savedHash !== newHash) {
                const historyList = await MemoryHistoryDB.getAllHistory();
                if (historyList.length > 0) {
                    if (confirm(`检测到新文件，是否清空旧的历史？\n\n当前有 ${historyList.length} 条记录。`)) {
                        await MemoryHistoryDB.clearAllHistory();
                        await MemoryHistoryDB.clearState();
                    }
                }
            }
            currentFileHash = newHash;
            await MemoryHistoryDB.saveFileHash(newHash);
            document.getElementById('ttw-upload-area').style.display = 'none';
            document.getElementById('ttw-file-info').style.display = 'flex';
            document.getElementById('ttw-file-name').textContent = file.name;
            document.getElementById('ttw-file-size').textContent = `(${(content.length / 1024).toFixed(1)} KB, ${encoding})`;
            splitContentIntoMemory(content);
            showQueueSection(true);
            updateMemoryQueueUI();
            document.getElementById('ttw-start-btn').disabled = false;
            startFromIndex = 0;
            userSelectedStartIndex = null;
            updateStartButtonState(false);
        } catch (error) {
            alert('文件处理失败: ' + error.message);
        }
    }

    function splitContentIntoMemory(content) {
        const chunkSize = settings.chunkSize;
        memoryQueue = [];
        const chapterRegex = /第[一二三四五六七八九十百千万0-9]+[章节卷集回]/g;
        const matches = [...content.matchAll(chapterRegex)];

        if (matches.length > 0) {
            const chapters = [];
            for (let i = 0; i < matches.length; i++) {
                const startIndex = matches[i].index;
                const endIndex = i < matches.length - 1 ? matches[i + 1].index : content.length;
                chapters.push({ title: matches[i][0], content: content.slice(startIndex, endIndex) });
            }
            let currentChunk = '';
            let chunkIndex = 1;
            for (let i = 0; i < chapters.length; i++) {
                const chapter = chapters[i];
                if (chapter.content.length > chunkSize) {
                    if (currentChunk.length > 0) {
                        memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                        currentChunk = '';
                        chunkIndex++;
                    }
                    let remaining = chapter.content;
                    let subIndex = 1;
                    while (remaining.length > 0) {
                        let endPos = Math.min(chunkSize, remaining.length);
                        if (endPos < remaining.length) {
                            const paragraphBreak = remaining.lastIndexOf('\n\n', endPos);
                            if (paragraphBreak > endPos * 0.5) endPos = paragraphBreak + 2;
                            else {
                                const sentenceBreak = remaining.lastIndexOf('。', endPos);
                                if (sentenceBreak > endPos * 0.5) endPos = sentenceBreak + 1;
                            }
                        }
                        memoryQueue.push({ title: `记忆${chunkIndex}-${subIndex}`, content: remaining.slice(0, endPos), processed: false, failed: false, processing: false });
                        remaining = remaining.slice(endPos);
                        subIndex++;
                    }
                    chunkIndex++;
                    continue;
                }
                if (currentChunk.length + chapter.content.length > chunkSize && currentChunk.length > 0) {
                    memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                    currentChunk = '';
                    chunkIndex++;
                }
                currentChunk += chapter.content;
            }
            if (currentChunk.length > 0) {
                if (currentChunk.length < chunkSize * 0.2 && memoryQueue.length > 0) {
                    const lastMemory = memoryQueue[memoryQueue.length - 1];
                    if (lastMemory.content.length + currentChunk.length <= chunkSize) lastMemory.content += currentChunk;
                    else memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                } else {
                    memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                }
            }
        } else {
            let i = 0;
            let chunkIndex = 1;
            while (i < content.length) {
                let endIndex = Math.min(i + chunkSize, content.length);
                if (endIndex < content.length) {
                    const paragraphBreak = content.lastIndexOf('\n\n', endIndex);
                    if (paragraphBreak > i + chunkSize * 0.5) endIndex = paragraphBreak + 2;
                    else {
                        const sentenceBreak = content.lastIndexOf('。', endIndex);
                        if (sentenceBreak > i + chunkSize * 0.5) endIndex = sentenceBreak + 1;
                    }
                }
                memoryQueue.push({ title: `记忆${chunkIndex}`, content: content.slice(i, endIndex), processed: false, failed: false, processing: false });
                i = endIndex;
                chunkIndex++;
            }
        }

        const minChunkSize = chunkSize * 0.1;
        for (let i = memoryQueue.length - 1; i > 0; i--) {
            if (memoryQueue[i].content.length < minChunkSize) {
                const prevMemory = memoryQueue[i - 1];
                if (prevMemory.content.length + memoryQueue[i].content.length <= chunkSize) {
                    prevMemory.content += memoryQueue[i].content;
                    memoryQueue.splice(i, 1);
                }
            }
        }
        memoryQueue.forEach((memory, index) => { memory.title = `记忆${index + 1}`; });
    }

    function clearFile() {
        currentFile = null;
        memoryQueue = [];
        generatedWorldbook = {};
        worldbookVolumes = [];
        currentVolumeIndex = 0;
        startFromIndex = 0;
        userSelectedStartIndex = null;
        document.getElementById('ttw-upload-area').style.display = 'block';
        document.getElementById('ttw-file-info').style.display = 'none';
        document.getElementById('ttw-file-input').value = '';
        document.getElementById('ttw-start-btn').disabled = true;
        document.getElementById('ttw-start-btn').textContent = '🚀 开始转换';
        showQueueSection(false);
        showProgressSection(false);
        showResultSection(false);
    }

    async function startConversion() {
        saveCurrentSettings();
        if (memoryQueue.length === 0) { alert('请先上传文件'); return; }
        await startAIProcessing();
    }

    function showQueueSection(show) { document.getElementById('ttw-queue-section').style.display = show ? 'block' : 'none'; }
    function showProgressSection(show) { document.getElementById('ttw-progress-section').style.display = show ? 'block' : 'none'; }
    function showResultSection(show) {
        document.getElementById('ttw-result-section').style.display = show ? 'block' : 'none';
        const volumeExportBtn = document.getElementById('ttw-export-volumes');
        if (volumeExportBtn) volumeExportBtn.style.display = (show && useVolumeMode && worldbookVolumes.length > 0) ? 'inline-block' : 'none';
    }

    function updateProgress(percent, text) {
        document.getElementById('ttw-progress-fill').style.width = `${percent}%`;
        document.getElementById('ttw-progress-text').textContent = text;
        const failedCount = memoryQueue.filter(m => m.failed === true).length;
        const repairBtn = document.getElementById('ttw-repair-btn');
        if (failedCount > 0) { repairBtn.style.display = 'inline-block'; repairBtn.textContent = `🔧 修复失败 (${failedCount})`; }
        else { repairBtn.style.display = 'none'; }
    }

    function updateMemoryQueueUI() {
        const container = document.getElementById('ttw-memory-queue');
        if (!container) return;
        container.innerHTML = '';
        memoryQueue.forEach((memory, index) => {
            const item = document.createElement('div');
            item.className = 'ttw-memory-item';
            if (memory.processing) item.classList.add('processing');
            else if (memory.processed && !memory.failed) item.classList.add('processed');
            else if (memory.failed) item.classList.add('failed');
            let statusIcon = '⏳';
            if (memory.processing) statusIcon = '🔄';
            else if (memory.processed && !memory.failed) statusIcon = '✅';
            else if (memory.failed) statusIcon = '❗';
            item.innerHTML = `
                <span>${statusIcon}</span>
                <span style="flex: 1;">${memory.title}</span>
                <small>(${memory.content.length.toLocaleString()}字)</small>
                ${memory.failed && memory.failedError ? `<small style="color:#e74c3c;margin-left:8px;" title="${memory.failedError}">错误</small>` : ''}
            `;
            item.addEventListener('click', () => { showMemoryContentModal(index); });
            container.appendChild(item);
        });
    }

    function updateWorldbookPreview() {
        const container = document.getElementById('ttw-result-preview');
        const worldbookToShow = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
        let headerInfo = '';
        if (useVolumeMode && worldbookVolumes.length > 0) {
            headerInfo = `<div style="margin-bottom: 12px; padding: 10px; background: rgba(155, 89, 182, 0.2); border-radius: 6px; font-size: 12px; color: #bb86fc;">📦 分卷模式 | 共 ${worldbookVolumes.length} 卷</div>`;
        }
        container.innerHTML = headerInfo + formatWorldbookAsCards(worldbookToShow);
    }

    function formatWorldbookAsCards(worldbook) {
        if (!worldbook || Object.keys(worldbook).length === 0) {
            return '<div style="text-align: center; color: #888; padding: 20px;">暂无世界书数据</div>';
        }
        let html = '';
        let totalEntries = 0;
        for (const category in worldbook) {
            const entries = worldbook[category];
            const entryCount = typeof entries === 'object' ? Object.keys(entries).length : 0;
            if (entryCount === 0) continue;
            totalEntries += entryCount;
            html += `
            <div class="ttw-category-card">
                <div class="ttw-category-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                    <span>📁 ${category}</span><span style="font-size: 12px;">${entryCount} 条目</span>
                </div>
                <div class="ttw-category-content">`;
            for (const entryName in entries) {
                const entry = entries[entryName];
                html += `
                <div class="ttw-entry-card">
                    <div class="ttw-entry-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                        <span>📄 ${entryName}</span><span style="font-size: 11px;">▼</span>
                    </div>
                    <div class="ttw-entry-content">`;
                if (entry && typeof entry === 'object') {
                    if (entry['关键词']) {
                        const keywords = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : entry['关键词'];
                        html += `<div class="ttw-keywords"><div style="color: #9b59b6; font-size: 11px; margin-bottom: 4px;">🔑 关键词</div><div style="font-size: 13px;">${keywords}</div></div>`;
                    }
                    if (entry['内容']) {
                        const content = String(entry['内容']).replace(/</g, '<').replace(/>/g, '>').replace(/\*\*(.+?)\*\*/g, '<strong style="color: #3498db;">$1</strong>').replace(/\n/g, '<br>');
                        html += `<div class="ttw-content-text"><div style="color: #27ae60; font-size: 11px; margin-bottom: 4px;">📝 内容</div><div style="font-size: 13px;">${content}</div></div>`;
                    }
                }
                html += `</div></div>`;
            }
            html += `</div></div>`;
        }
        return `<div style="margin-bottom: 12px; font-size: 13px;">共 ${Object.keys(worldbook).filter(k => Object.keys(worldbook[k]).length > 0).length} 个分类, ${totalEntries} 个条目</div>` + html;
    }

    function showWorldbookView() {
        const existingModal = document.getElementById('ttw-worldbook-view-modal');
        if (existingModal) existingModal.remove();
        const worldbookToShow = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
        const viewModal = document.createElement('div');
        viewModal.id = 'ttw-worldbook-view-modal';
        viewModal.className = 'ttw-modal-container';
        viewModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📖 世界书视图${useVolumeMode ? ` (${worldbookVolumes.length}卷)` : ''}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">${formatWorldbookAsCards(worldbookToShow)}</div>
                <div class="ttw-modal-footer"><button class="ttw-btn" id="ttw-close-worldbook-view">关闭</button></div>
            </div>
        `;
        document.body.appendChild(viewModal);
        viewModal.querySelector('.ttw-modal-close').addEventListener('click', () => viewModal.remove());
        viewModal.querySelector('#ttw-close-worldbook-view').addEventListener('click', () => viewModal.remove());
        viewModal.addEventListener('click', (e) => { if (e.target === viewModal) viewModal.remove(); });
    }

    async function showHistoryView() {
        const existingModal = document.getElementById('ttw-history-modal');
        if (existingModal) existingModal.remove();
        let historyList = [];
        try { await MemoryHistoryDB.cleanDuplicateHistory(); historyList = await MemoryHistoryDB.getAllHistory(); } catch (e) {}
        const historyModal = document.createElement('div');
        historyModal.id = 'ttw-history-modal';
        historyModal.className = 'ttw-modal-container';

        const sortedList = [...historyList].sort((a, b) => b.timestamp - a.timestamp);
        let listHtml = '';
        if (sortedList.length === 0) {
            listHtml = '<div style="text-align: center; color: #888; padding: 20px;">暂无历史记录</div>';
        } else {
            sortedList.forEach((history) => {
                const time = new Date(history.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                const changeCount = history.changedEntries?.length || 0;
                listHtml += `
                <div class="ttw-history-item" data-history-id="${history.id}" style="background: rgba(0,0,0,0.2); border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #9b59b6;">
                    <div style="font-weight: bold; color: #e67e22; font-size: 13px; margin-bottom: 4px;">📝 ${history.memoryTitle || `记忆块 ${history.memoryIndex + 1}`}</div>
                    <div style="font-size: 11px; color: #888;">${time}</div>
                    <div style="font-size: 11px; color: #aaa; margin-top: 4px;">共 ${changeCount} 项变更</div>
                </div>`;
            });
        }

        historyModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📜 修改历史 (${historyList.length}条)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display: flex; gap: 15px; height: 400px;">
                        <div style="width: 250px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">${listHtml}</div>
                        <div id="ttw-history-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 点击左侧历史记录查看</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-warning" id="ttw-clear-history">🗑️ 清空历史</button>
                    <button class="ttw-btn" id="ttw-close-history">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(historyModal);
        historyModal.querySelector('.ttw-modal-close').addEventListener('click', () => historyModal.remove());
        historyModal.querySelector('#ttw-close-history').addEventListener('click', () => historyModal.remove());
        historyModal.querySelector('#ttw-clear-history').addEventListener('click', async () => { if (confirm('确定清空所有历史？')) { await MemoryHistoryDB.clearAllHistory(); historyModal.remove(); showHistoryView(); } });
        historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.remove(); });

        historyModal.querySelectorAll('.ttw-history-item').forEach(item => {
            item.addEventListener('click', async () => {
                const historyId = parseInt(item.dataset.historyId);
                const history = await MemoryHistoryDB.getHistoryById(historyId);
                const detailContainer = historyModal.querySelector('#ttw-history-detail');
                historyModal.querySelectorAll('.ttw-history-item').forEach(i => i.style.background = 'rgba(0,0,0,0.2)');
                item.style.background = 'rgba(0,0,0,0.4)';
                if (!history) { detailContainer.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 40px;">找不到该记录</div>'; return; }
                const time = new Date(history.timestamp).toLocaleString('zh-CN');
                let html = `
                <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #444;">
                    <h4 style="color: #e67e22; margin: 0 0 10px 0;">📝 ${history.memoryTitle || `记忆块 ${history.memoryIndex + 1}`}</h4>
                    <div style="font-size: 12px; color: #888;">时间: ${time}</div>
                    <div style="margin-top: 10px;"><button class="ttw-btn ttw-btn-warning ttw-btn-small" id="ttw-rollback-btn">⏪ 回退到此版本前</button></div>
                </div>
                <div style="font-size: 14px; font-weight: bold; color: #9b59b6; margin-bottom: 10px;">变更内容 (${history.changedEntries?.length || 0}项)</div>`;
                if (history.changedEntries && history.changedEntries.length > 0) {
                    history.changedEntries.forEach(change => {
                        const typeIcon = change.type === 'add' ? '➕' : change.type === 'modify' ? '✏️' : '❌';
                        const typeColor = change.type === 'add' ? '#27ae60' : change.type === 'modify' ? '#3498db' : '#e74c3c';
                        html += `
                        <div style="background: rgba(0,0,0,0.2); border-radius: 6px; padding: 12px; margin-bottom: 10px; border-left: 3px solid ${typeColor};">
                            <div style="margin-bottom: 8px;"><span style="color: ${typeColor}; font-weight: bold;">${typeIcon}</span><span style="color: #e67e22; margin-left: 8px;">[${change.category}] ${change.entryName}</span></div>
                            <div style="font-size: 12px; color: #ccc; max-height: 100px; overflow-y: auto;">${change.newValue ? JSON.stringify(change.newValue).substring(0, 200) + '...' : '无'}</div>
                        </div>`;
                    });
                } else {
                    html += '<div style="color: #888; text-align: center; padding: 20px;">无变更</div>';
                }
                detailContainer.innerHTML = html;
                detailContainer.querySelector('#ttw-rollback-btn').addEventListener('click', () => rollbackToHistory(historyId));
            });
        });
    }

    async function rollbackToHistory(historyId) {
        if (!confirm('确定回退到此版本吗？\n\n回退后将刷新页面。')) return;
        try {
            const history = await MemoryHistoryDB.rollbackToHistory(historyId);
            const rollbackMemoryIndex = history.memoryIndex;
            for (let i = 0; i < memoryQueue.length; i++) {
                if (i < rollbackMemoryIndex) memoryQueue[i].processed = true;
                else { memoryQueue[i].processed = false; memoryQueue[i].failed = false; }
            }
            await MemoryHistoryDB.saveState(rollbackMemoryIndex);
            alert('回退成功！页面将刷新。');
            location.reload();
        } catch (error) {
            alert('回退失败: ' + error.message);
        }
    }

    function closeModal() {
        if (modalContainer) { modalContainer.remove(); modalContainer = null; }
        document.removeEventListener('keydown', handleEscKey, true);
    }

    function open() { createModal(); }

    // ========== 公开 API ==========
    window.TxtToWorldbook = {
        open,
        close: closeModal,
        _rollbackToHistory: rollbackToHistory,
        getWorldbook: () => generatedWorldbook,
        getMemoryQueue: () => memoryQueue,
        getVolumes: () => worldbookVolumes,
        getAllVolumesWorldbook,
        exportTaskState,
        importTaskState,
        getParallelConfig: () => parallelConfig,
        rerollMemory,
        showRollHistory: showRollHistorySelector,
        showImportMerge: showImportMergeModal
    };

    console.log('📚 TxtToWorldbook v2.4.1 已加载');
})();
