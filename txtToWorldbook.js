/**
 * TXT转世界书独立模块 v2.5.0
 * 修复CSRF + 重Roll按钮优化 + JSON导入合并功能
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

    // ========== 重Roll功能 ==========
    let memoryRollHistory = {};

    // ========== 并行处理配置 ==========
    let parallelConfig = {
        enabled: true,
        concurrency: 3,
        mode: 'independent'
    };

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
请生成标准JSON格式：

\`\`\`json
{
"角色": {
"角色真实姓名": {
"关键词": ["真实姓名", "称呼1", "称呼2"],
"内容": "角色描述..."
}
},
"地点": {},
"组织": {}
}
\`\`\`

直接输出JSON，不要包含代码块标记。`;

    const defaultMergePrompt = `你是专业的世界书整理专家。请对以下世界书条目进行智能合并和整理。

## 合并规则
1. **相同名称的条目**：合并内容，去除重复信息，保留最完整的描述
2. **关键词合并**：所有关键词去重合并
3. **内容整合**：将多个版本的描述整合成一个完整、连贯的描述
4. **保持格式**：输出保持标准的世界书JSON格式

## 输出格式
直接输出合并后的JSON，格式与输入相同。`;

    const defaultSettings = {
        chunkSize: 15000,
        enablePlotOutline: false,
        enableLiteraryStyle: false,
        language: 'zh',
        customWorldbookPrompt: '',
        customPlotPrompt: '',
        customStylePrompt: '',
        customMergePrompt: '',
        useVolumeMode: false,
        apiTimeout: 120000,
        parallelEnabled: true,
        parallelConcurrency: 3,
        parallelMode: 'independent',
        useTavernPreset: true
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
            if (this.aborted) throw new Error('ABORTED');
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
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const record = {
                    timestamp: Date.now(),
                    memoryIndex,
                    memoryTitle,
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
                    processedIndex,
                    memoryQueue: JSON.parse(JSON.stringify(memoryQueue)),
                    generatedWorldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                    worldbookVolumes: JSON.parse(JSON.stringify(worldbookVolumes)),
                    currentVolumeIndex,
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
                    memoryIndex,
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
                for (const r of results) store.delete(r.id);
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
            for (const h of toDelete) store.delete(h.id);
            return history;
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
            // 【关键修复】必须使用SillyTavern暴露的API，不能直接fetch
            if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
                throw new Error('请在SillyTavern环境中运行此脚本');
            }

            const context = SillyTavern.getContext();

            // 使用generateRaw - 这个方法会自动处理认证和预设
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`API请求超时 (${timeout/1000}秒)`)), timeout);
            });

            let result;

            if (settings.useTavernPreset) {
                // 使用酒馆预设：generateRaw会应用当前的API设置
                // 第一个参数是prompt，第二个是api（空字符串表示使用当前API），第三个是是否包含聊天历史
                updateStreamContent(`🍺 使用酒馆预设...\n`);
                result = await Promise.race([
                    context.generateRaw(prompt, null, false, false),
                    timeoutPromise
                ]);
            } else {
                // 不使用预设：同样用generateRaw，但可以传递不同参数
                updateStreamContent(`📝 直接调用API...\n`);
                result = await Promise.race([
                    context.generateRaw(prompt, null, false, false),
                    timeoutPromise
                ]);
            }

            const resultText = typeof result === 'string' ? result : (result?.content || result?.message || JSON.stringify(result));

            if (taskId !== null) {
                updateStreamContent(`📥 [任务${taskId}] 收到响应 (${resultText.length}字符)\n`);
            } else {
                updateStreamContent(`📥 收到响应 (${resultText.length}字符)\n`);
            }

            return resultText;

        } catch (error) {
            updateStreamContent(`\n❌ 错误: ${error.message}\n`);
            throw error;
        }
    }

    // ========== 世界书数据处理 ==========
    function normalizeWorldbookData(data) {
        if (!data || typeof data !== 'object') return data;
        for (const category in data) {
            if (typeof data[category] === 'object' && data[category] !== null && !Array.isArray(data[category])) {
                for (const entryName in data[category]) {
                    const entry = data[category][entryName];
                    if (entry && typeof entry === 'object') {
                        if (entry.content !== undefined && entry['内容'] === undefined) {
                            entry['内容'] = entry.content;
                            delete entry.content;
                        }
                    }
                }
            }
        }
        return data;
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
                        targetEntry['关键词'] = [...new Set([...targetEntry['关键词'], ...sourceEntry['关键词']])];
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
        return changes;
    }

    async function mergeWorldbookDataWithHistory(target, source, memoryIndex, memoryTitle) {
        const previousWorldbook = JSON.parse(JSON.stringify(target));
        mergeWorldbookDataIncremental(target, source);
        const changedEntries = findChangedEntries(previousWorldbook, target);
        if (changedEntries.length > 0) {
            await MemoryHistoryDB.saveHistory(memoryIndex, memoryTitle, previousWorldbook, target, changedEntries);
        }
        return changedEntries;
    }

    // ========== 解析AI响应 ==========
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
                return extractWorldbookDataByRegex(clean);
            }
        }
    }

    function extractWorldbookDataByRegex(jsonString) {
        const result = {};
        const categories = ['角色', '地点', '组织', '剧情大纲', '知识书', '文风配置'];
        for (const category of categories) {
            const categoryPattern = new RegExp(`"${category}"\\s*:\\s*\\{`, 'g');
            const categoryMatch = categoryPattern.exec(jsonString);
            if (!categoryMatch) continue;
            const startPos = categoryMatch.index + categoryMatch[0].length;
            let braceCount = 1, endPos = startPos;
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
                let entryBraceCount = 1, entryEndPos = entryStartPos;
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
                    let contentEndPos = contentStartPos, escaped = false;
                    while (contentEndPos < entryContent.length) {
                        const char = entryContent[contentEndPos];
                        if (escaped) escaped = false;
                        else if (char === '\\') escaped = true;
                        else if (char === '"') break;
                        contentEndPos++;
                    }
                    content = entryContent.substring(contentStartPos, contentEndPos);
                    try { content = JSON.parse(`"${content}"`); }
                    catch (e) { content = content.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
                }
                if (content || keywords.length > 0) {
                    result[category][entryName] = { '关键词': keywords, '内容': content };
                }
            }
            if (Object.keys(result[category]).length === 0) delete result[category];
        }
        return result;
    }

    // ========== 获取系统提示词 ==========
    function getSystemPrompt() {
        return settings.customWorldbookPrompt?.trim() || defaultWorldbookPrompt;
    }

    // ========== 记忆处理 ==========
    async function processMemoryChunkIndependent(index, retryCount = 0) {
        const memory = memoryQueue[index];
        const maxRetries = 3;
        const taskId = index + 1;

        if (isProcessingStopped) throw new Error('ABORTED');

        memory.processing = true;
        updateMemoryQueueUI();

        let prompt = getLanguagePrefix() + getSystemPrompt();
        if (index > 0 && memoryQueue[index - 1].content) {
            prompt += `\n\n前文结尾（供参考）：\n---\n${memoryQueue[index - 1].content.slice(-800)}\n---\n`;
        }
        prompt += `\n\n当前内容：\n---\n${memory.content}\n---\n\n请提取角色、地点、组织等信息，直接输出JSON。`;

        try {
            const response = await callAPI(prompt, taskId);
            if (isProcessingStopped) { memory.processing = false; throw new Error('ABORTED'); }
            if (isTokenLimitError(response)) throw new Error('Token limit exceeded');
            return parseAIResponse(response);
        } catch (error) {
            memory.processing = false;
            if (error.message === 'ABORTED') throw error;
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

        updateStreamContent(`\n🚀 并行处理 ${tasks.length} 个记忆 (并发${parallelConfig.concurrency})\n${'='.repeat(50)}\n`);

        let completed = 0;
        globalSemaphore = new Semaphore(parallelConfig.concurrency);

        const processOne = async (task) => {
            if (isProcessingStopped) return null;
            try { await globalSemaphore.acquire(); }
            catch (e) { if (e.message === 'ABORTED') return null; throw e; }
            if (isProcessingStopped) { globalSemaphore.release(); return null; }
            activeParallelTasks.add(task.index);

            try {
                updateProgress(((startIndex + completed) / memoryQueue.length) * 100,
                    `🚀 并行处理 (${completed}/${tasks.length}) - 活跃: ${activeParallelTasks.size}`);
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
        updateStreamContent(`\n${'='.repeat(50)}\n📦 完成: ${results.size}/${tasks.length}\n`);
        return { tokenLimitIndices };
    }

    function splitMemoryIntoTwo(memoryIndex) {
        const memory = memoryQueue[memoryIndex];
        if (!memory) return null;
        const content = memory.content;
        const halfLength = Math.floor(content.length / 2);
        let splitPoint = halfLength;
        const paragraphBreak = content.indexOf('\n\n', halfLength);
        if (paragraphBreak !== -1 && paragraphBreak < halfLength + 5000) splitPoint = paragraphBreak + 2;
        else {
            const sentenceBreak = content.indexOf('。', halfLength);
            if (sentenceBreak !== -1 && sentenceBreak < halfLength + 1000) splitPoint = sentenceBreak + 1;
        }
        const memory1 = { title: memory.title + '-1', content: content.substring(0, splitPoint), processed: false, failed: false };
        const memory2 = { title: memory.title + '-2', content: content.substring(splitPoint), processed: false, failed: false };
        memoryQueue.splice(memoryIndex, 1, memory1, memory2);
        return { part1: memory1, part2: memory2 };
    }

    function stopProcessing() {
        isProcessingStopped = true;
        if (globalSemaphore) globalSemaphore.abort();
        activeParallelTasks.clear();
        memoryQueue.forEach(m => { if (m.processing) m.processing = false; });
        updateMemoryQueueUI();
        updateStreamContent(`\n⏸️ 已暂停\n`);
    }

    async function startAIProcessing() {
        showProgressSection(true);
        isProcessingStopped = false;
        if (globalSemaphore) globalSemaphore.reset();
        activeParallelTasks.clear();
        updateStreamContent('', true);
        updateStreamContent(`🚀 开始处理...\n📊 模式: ${parallelConfig.enabled ? `并行(${parallelConfig.mode})` : '串行'}\n🍺 酒馆预设: ${settings.useTavernPreset ? '是' : '否'}\n${'='.repeat(50)}\n`);

        const effectiveStartIndex = userSelectedStartIndex !== null ? userSelectedStartIndex : startFromIndex;
        if (effectiveStartIndex === 0) {
            worldbookVolumes = [];
            currentVolumeIndex = 0;
            generatedWorldbook = {};
        }
        userSelectedStartIndex = null;
        updateStartButtonState(true);

        try {
            if (parallelConfig.enabled && parallelConfig.mode === 'independent') {
                const { tokenLimitIndices } = await processMemoryChunksParallel(effectiveStartIndex, memoryQueue.length);
                if (isProcessingStopped) {
                    const processedCount = memoryQueue.filter(m => m.processed).length;
                    updateProgress((processedCount / memoryQueue.length) * 100, `⏸️ 已暂停 (${processedCount}/${memoryQueue.length})`);
                    await MemoryHistoryDB.saveState(processedCount);
                    updateStartButtonState(false);
                    return;
                }
                if (tokenLimitIndices.length > 0) {
                    for (const idx of tokenLimitIndices.sort((a, b) => b - a)) {
                        splitMemoryIntoTwo(idx);
                        updateMemoryQueueUI();
                    }
                    for (let i = 0; i < memoryQueue.length && !isProcessingStopped; i++) {
                        if (!memoryQueue[i].processed || memoryQueue[i].failed) {
                            await processMemoryChunkSerial(i);
                        }
                    }
                }
            } else {
                for (let i = effectiveStartIndex; i < memoryQueue.length && !isProcessingStopped; i++) {
                    if (memoryQueue[i].processed && !memoryQueue[i].failed) continue;
                    await processMemoryChunkSerial(i);
                    await MemoryHistoryDB.saveState(i + 1);
                }
            }

            if (!isProcessingStopped) {
                const failedCount = memoryQueue.filter(m => m.failed).length;
                updateProgress(100, failedCount > 0 ? `⚠️ 完成，${failedCount}个失败` : `✅ 全部完成！`);
                showResultSection(true);
                updateWorldbookPreview();
                await MemoryHistoryDB.clearState();
            }
        } catch (error) {
            updateProgress(0, `❌ 错误: ${error.message}`);
        }
        updateStartButtonState(false);
    }

    async function processMemoryChunkSerial(index, retryCount = 0) {
        if (isProcessingStopped) return;
        const memory = memoryQueue[index];
        const maxRetries = 3;

        updateProgress(((index + 1) / memoryQueue.length) * 100, `处理: ${memory.title} (${index + 1}/${memoryQueue.length})`);
        memory.processing = true;
        updateMemoryQueueUI();

        let prompt = getLanguagePrefix() + getSystemPrompt();
        if (index > 0) {
            prompt += `\n\n前文结尾：\n---\n${memoryQueue[index - 1].content.slice(-500)}\n---\n`;
            if (Object.keys(generatedWorldbook).length > 0) {
                prompt += `\n当前记忆：\n${JSON.stringify(generatedWorldbook, null, 2)}\n`;
            }
        }
        prompt += `\n当前内容：\n---\n${memory.content}\n---\n\n请提取并更新世界书，直接输出JSON。`;

        try {
            const response = await callAPI(prompt);
            memory.processing = false;
            if (isProcessingStopped) { updateMemoryQueueUI(); return; }
            if (isTokenLimitError(response)) {
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await processMemoryChunkSerial(index, 0);
                    await processMemoryChunkSerial(index + 1, 0);
                    return;
                }
            }
            const memoryUpdate = parseAIResponse(response);
            await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memory.title);
            await MemoryHistoryDB.saveRollResult(index, memoryUpdate);
            memory.processed = true;
            memory.result = memoryUpdate;
            updateMemoryQueueUI();
        } catch (error) {
            memory.processing = false;
            if (isTokenLimitError(error.message)) {
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await new Promise(r => setTimeout(r, 500));
                    await processMemoryChunkSerial(index, 0);
                    await processMemoryChunkSerial(index + 1, 0);
                    return;
                }
            }
            if (retryCount < maxRetries) {
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, retryCount), 10000)));
                return processMemoryChunkSerial(index, retryCount + 1);
            }
            memory.processed = true;
            memory.failed = true;
            memory.failedError = error.message;
            updateMemoryQueueUI();
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    // ========== 【新增】重Roll功能 ==========
    async function rerollMemory(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        updateStreamContent(`\n🎲 重Roll: ${memory.title}\n`);
        memory.processing = true;
        updateMemoryQueueUI();

        try {
            const result = await processMemoryChunkIndependent(index);
            memory.processing = false;
            if (result) {
                await MemoryHistoryDB.saveRollResult(index, result);
                memory.result = result;
                memory.processed = true;
                memory.failed = false;
                await mergeWorldbookDataWithHistory(generatedWorldbook, result, index, `${memory.title}-重Roll`);
                updateStreamContent(`✅ 重Roll完成\n`);
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

        let listHtml = rollResults.length === 0
            ? '<div style="text-align:center;color:#888;padding:20px;">暂无Roll历史<br><br>点击上方"🎲 重Roll"生成</div>'
            : rollResults.map((roll, idx) => {
                const time = new Date(roll.timestamp).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
                const entryCount = roll.result ? Object.keys(roll.result).reduce((sum, cat) =>
                    sum + (typeof roll.result[cat] === 'object' ? Object.keys(roll.result[cat]).length : 0), 0) : 0;
                const isCurrent = memory.result && JSON.stringify(memory.result) === JSON.stringify(roll.result);
                return `<div class="ttw-roll-item ${isCurrent ? 'selected' : ''}" data-roll-id="${roll.id}" data-roll-index="${idx}" style="padding:10px 12px;background:${isCurrent ? 'rgba(39,174,96,0.2)' : 'rgba(0,0,0,0.2)'};border-radius:6px;margin-bottom:8px;cursor:pointer;border-left:3px solid ${isCurrent ? '#27ae60' : '#9b59b6'};">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span style="font-weight:bold;color:${isCurrent ? '#27ae60' : '#e67e22'};">Roll #${idx + 1} ${isCurrent ? '(当前)' : ''}</span>
                        <span style="font-size:11px;color:#888;">${time}</span>
                    </div>
                    <div style="font-size:11px;color:#aaa;margin-top:4px;">${entryCount} 个条目</div>
                </div>`;
            }).join('');

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🎲 ${memory.title} - Roll历史</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display:flex;gap:15px;height:400px;">
                        <div style="width:220px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:8px;padding:10px;">
                            <button id="ttw-do-reroll" class="ttw-btn ttw-btn-primary" style="width:100%;margin-bottom:12px;">🎲 重新Roll</button>
                            ${listHtml}
                        </div>
                        <div id="ttw-roll-detail" style="flex:1;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:8px;padding:15px;">
                            <div style="text-align:center;color:#888;padding:40px;">👈 点击左侧查看详情</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-warning" id="ttw-clear-rolls">🗑️ 清空历史</button>
                    <button class="ttw-btn" id="ttw-close-roll-history">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-roll-history').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-do-reroll').addEventListener('click', async () => {
            modal.remove();
            showProgressSection(true);
            try {
                await rerollMemory(index);
                showRollHistorySelector(index);
            } catch (error) {
                alert('重Roll失败: ' + error.message);
            }
        });

        modal.querySelector('#ttw-clear-rolls').addEventListener('click', async () => {
            if (confirm(`清空 "${memory.title}" 的Roll历史？`)) {
                await MemoryHistoryDB.clearRollResults(index);
                modal.remove();
                alert('已清空');
            }
        });

        modal.querySelectorAll('.ttw-roll-item').forEach(item => {
            item.addEventListener('click', () => {
                const rollIndex = parseInt(item.dataset.rollIndex);
                const roll = rollResults[rollIndex];
                const detailDiv = modal.querySelector('#ttw-roll-detail');
                modal.querySelectorAll('.ttw-roll-item').forEach(i => { i.style.background = 'rgba(0,0,0,0.2)'; i.style.borderLeftColor = '#9b59b6'; });
                item.style.background = 'rgba(0,0,0,0.4)';
                item.style.borderLeftColor = '#e67e22';
                detailDiv.innerHTML = `
                    <div style="margin-bottom:15px;padding-bottom:15px;border-bottom:1px solid #444;">
                        <h4 style="color:#e67e22;margin:0 0 10px 0;">Roll #${rollIndex + 1}</h4>
                        <button class="ttw-btn ttw-btn-primary ttw-btn-small" id="ttw-use-this-roll">✅ 使用这个结果</button>
                    </div>
                    <pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;max-height:280px;overflow-y:auto;">${JSON.stringify(roll.result, null, 2)}</pre>
                `;
                detailDiv.querySelector('#ttw-use-this-roll').addEventListener('click', async () => {
                    memory.result = roll.result;
                    memory.processed = true;
                    memory.failed = false;
                    await mergeWorldbookDataWithHistory(generatedWorldbook, roll.result, index, `${memory.title}-选用Roll#${rollIndex + 1}`);
                    updateMemoryQueueUI();
                    updateWorldbookPreview();
                    modal.remove();
                    alert(`已使用 Roll #${rollIndex + 1}`);
                });
            });
        });
    }

    // ========== 【新增】JSON导入合并功能 ==========
    function showWorldbookMergeModal() {
        const existingModal = document.getElementById('ttw-merge-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-merge-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📦 世界书合并工具</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                    <div style="margin-bottom:16px;padding:12px;background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.3);border-radius:8px;">
                        <div style="font-weight:bold;color:#3498db;margin-bottom:8px;">📥 导入世界书JSON</div>
                        <div style="font-size:12px;color:#888;margin-bottom:12px;">支持导入多个JSON文件，将与当前世界书合并</div>
                        <div style="display:flex;gap:10px;flex-wrap:wrap;">
                            <button id="ttw-import-json-btn" class="ttw-btn">📁 选择JSON文件</button>
                            <button id="ttw-import-from-clipboard" class="ttw-btn">📋 从剪贴板导入</button>
                        </div>
                        <input type="file" id="ttw-json-file-input" accept=".json" multiple style="display:none;">
                    </div>

                    <div style="margin-bottom:16px;">
                        <div style="font-weight:bold;margin-bottom:8px;">📊 待合并的世界书</div>
                        <div id="ttw-merge-queue" style="max-height:150px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:10px;">
                            <div style="text-align:center;color:#888;padding:20px;">暂未导入任何世界书</div>
                        </div>
                    </div>

                    <div style="margin-bottom:16px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <span style="font-weight:bold;">📝 合并提示词</span>
                            <button id="ttw-reset-merge-prompt" class="ttw-btn-small">🔄 恢复默认</button>
                        </div>
                        <textarea id="ttw-merge-prompt-input" rows="6" style="width:100%;padding:10px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;resize:vertical;" placeholder="留空使用默认提示词...">${settings.customMergePrompt || ''}</textarea>
                    </div>

                    <div style="margin-bottom:16px;">
                        <label class="ttw-checkbox-label" style="display:flex;align-items:center;gap:8px;">
                            <input type="checkbox" id="ttw-ai-merge" checked style="width:18px;height:18px;">
                            <span>🤖 使用AI智能合并（否则简单合并）</span>
                        </label>
                    </div>

                    <div id="ttw-merge-preview" style="display:none;">
                        <div style="font-weight:bold;margin-bottom:8px;">👁️ 合并预览</div>
                        <div id="ttw-merge-preview-content" style="max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:10px;font-size:12px;"></div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-merge">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-start-merge" disabled>🔀 开始合并</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        let importedWorldbooks = [];

        const updateMergeQueue = () => {
            const queueEl = modal.querySelector('#ttw-merge-queue');
            const startBtn = modal.querySelector('#ttw-start-merge');
            if (importedWorldbooks.length === 0) {
                queueEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">暂未导入任何世界书</div>';
                startBtn.disabled = true;
            } else {
                queueEl.innerHTML = importedWorldbooks.map((wb, idx) => {
                    const entryCount = Object.keys(wb.data).reduce((sum, cat) =>
                        sum + (typeof wb.data[cat] === 'object' ? Object.keys(wb.data[cat]).length : 0), 0);
                    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:6px;">
                        <span>📚 ${wb.name} (${entryCount}条目)</span>
                        <button class="ttw-btn-small ttw-remove-wb" data-index="${idx}">❌</button>
                    </div>`;
                }).join('');
                startBtn.disabled = false;
                queueEl.querySelectorAll('.ttw-remove-wb').forEach(btn => {
                    btn.addEventListener('click', () => {
                        importedWorldbooks.splice(parseInt(btn.dataset.index), 1);
                        updateMergeQueue();
                    });
                });
            }
        };

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-merge').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-reset-merge-prompt').addEventListener('click', () => {
            modal.querySelector('#ttw-merge-prompt-input').value = '';
        });

        modal.querySelector('#ttw-import-json-btn').addEventListener('click', () => {
            modal.querySelector('#ttw-json-file-input').click();
        });

        modal.querySelector('#ttw-json-file-input').addEventListener('change', async (e) => {
            for (const file of e.target.files) {
                try {
                    const content = await file.text();
                    const data = JSON.parse(content);
                    // 处理不同格式
                    let worldbookData = data;
                    if (data.entries) {
                        // SillyTavern格式
                        worldbookData = convertSTFormatToInternal(data);
                    } else if (data.merged) {
                        worldbookData = data.merged;
                    }
                    importedWorldbooks.push({ name: file.name, data: worldbookData });
                } catch (err) {
                    alert(`解析 ${file.name} 失败: ${err.message}`);
                }
            }
            updateMergeQueue();
            e.target.value = '';
        });

        modal.querySelector('#ttw-import-from-clipboard').addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                const data = JSON.parse(text);
                let worldbookData = data;
                if (data.entries) worldbookData = convertSTFormatToInternal(data);
                else if (data.merged) worldbookData = data.merged;
                importedWorldbooks.push({ name: '剪贴板导入', data: worldbookData });
                updateMergeQueue();
            } catch (err) {
                alert('从剪贴板导入失败: ' + err.message);
            }
        });

        modal.querySelector('#ttw-start-merge').addEventListener('click', async () => {
            if (importedWorldbooks.length === 0) return;

            const useAI = modal.querySelector('#ttw-ai-merge').checked;
            const customPrompt = modal.querySelector('#ttw-merge-prompt-input').value.trim();
            settings.customMergePrompt = customPrompt;
            saveCurrentSettings();

            modal.remove();
            showProgressSection(true);
            updateStreamContent('', true);
            updateStreamContent(`📦 开始合并世界书...\n`);

            try {
                // 先简单合并所有导入的世界书
                let mergedData = JSON.parse(JSON.stringify(generatedWorldbook));
                for (const wb of importedWorldbooks) {
                    mergeWorldbookDataIncremental(mergedData, wb.data);
                    updateStreamContent(`✅ 合并: ${wb.name}\n`);
                }

                if (useAI) {
                    // 使用AI智能合并相同名称的条目
                    updateStreamContent(`\n🤖 使用AI智能整理...\n`);

                    const prompt = getLanguagePrefix() + (customPrompt || defaultMergePrompt) +
                        `\n\n以下是需要整理的世界书数据：\n\`\`\`json\n${JSON.stringify(mergedData, null, 2)}\n\`\`\`\n\n请整理并合并相同或相似的条目，输出完整的JSON。`;

                    const response = await callAPI(prompt);
                    const aiMerged = parseAIResponse(response);
                    if (aiMerged && Object.keys(aiMerged).length > 0) {
                        mergedData = aiMerged;
                        updateStreamContent(`✅ AI整理完成\n`);
                    }
                }

                generatedWorldbook = mergedData;
                await MemoryHistoryDB.saveHistory(-1, '世界书合并', {}, mergedData, []);

                updateProgress(100, '✅ 世界书合并完成！');
                showResultSection(true);
                updateWorldbookPreview();
                updateStreamContent(`\n${'='.repeat(50)}\n✅ 合并完成！\n`);

            } catch (error) {
                updateProgress(0, `❌ 合并失败: ${error.message}`);
                updateStreamContent(`\n❌ 错误: ${error.message}\n`);
            }
        });

        updateMergeQueue();
    }

    // 将SillyTavern世界书格式转换为内部格式
    function convertSTFormatToInternal(stData) {
        const result = {};
        if (!stData.entries) return result;

        for (const entry of stData.entries) {
            const group = entry.group || '未分类';
            if (!result[group]) result[group] = {};

            const name = entry.comment?.split(' - ')[1] || entry.key?.[0] || `条目${entry.uid}`;
            result[group][name] = {
                '关键词': entry.key || [],
                '内容': entry.content || ''
            };
        }
        return result;
    }

    // ========== 导出功能 ==========
    function convertToSillyTavernFormat(worldbook) {
        const entries = [];
        let entryId = 0;
        for (const [category, categoryData] of Object.entries(worldbook)) {
            if (typeof categoryData !== 'object' || categoryData === null) continue;
            for (const [itemName, itemData] of Object.entries(categoryData)) {
                if (typeof itemData !== 'object' || itemData === null) continue;
                if (itemData.关键词 || itemData.内容) {
                    const keywords = Array.isArray(itemData.关键词) ? itemData.关键词 : [itemData.关键词 || itemName];
                    entries.push({
                        uid: entryId++,
                        key: keywords.filter(k => k && k.length <= 20),
                        keysecondary: [],
                        comment: `${category} - ${itemName}`,
                        content: String(itemData.内容 || '').trim(),
                        constant: !['地点', '剧情大纲'].includes(category),
                        selective: ['地点', '剧情大纲'].includes(category),
                        selectiveLogic: 0,
                        addMemo: true,
                        order: entryId * 100,
                        position: 0,
                        disable: false,
                        probability: 100,
                        depth: 4,
                        group: category,
                        groupOverride: false,
                        groupWeight: 100,
                        caseSensitive: false,
                        matchWholeWords: true,
                        role: 0,
                        vectorized: false
                    });
                }
            }
        }
        return { entries };
    }

    function exportWorldbook() {
        const timeString = new Date().toISOString().slice(0, 16).replace(/[:-]/g, '');
        const fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-世界书-${timeString}.json` : `世界书-${timeString}.json`;
        const blob = new Blob([JSON.stringify(generatedWorldbook, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportToSillyTavern() {
        const timeString = new Date().toISOString().slice(0, 16).replace(/[:-]/g, '');
        const sillyTavernWorldbook = convertToSillyTavernFormat(generatedWorldbook);
        const fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-ST格式-${timeString}.json` : `ST格式-${timeString}.json`;
        const blob = new Blob([JSON.stringify(sillyTavernWorldbook, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        alert('已导出SillyTavern格式，请在酒馆中手动导入。');
    }

    async function exportTaskState() {
        const state = {
            version: '2.5.0',
            timestamp: Date.now(),
            memoryQueue,
            generatedWorldbook,
            worldbookVolumes,
            currentVolumeIndex,
            fileHash: currentFileHash,
            settings,
            parallelConfig
        };
        const timeString = new Date().toISOString().slice(0, 16).replace(/[:-]/g, '');
        const fileName = currentFile ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-任务-${timeString}.json` : `任务-${timeString}.json`;
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        alert(`任务已导出！已处理: ${memoryQueue.filter(m => m.processed).length}/${memoryQueue.length}`);
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
                if (!state.memoryQueue) throw new Error('无效的任务文件');
                memoryQueue = state.memoryQueue;
                generatedWorldbook = state.generatedWorldbook || {};
                worldbookVolumes = state.worldbookVolumes || [];
                currentVolumeIndex = state.currentVolumeIndex || 0;
                currentFileHash = state.fileHash;
                if (state.settings) settings = { ...defaultSettings, ...state.settings };
                if (state.parallelConfig) parallelConfig = { ...parallelConfig, ...state.parallelConfig };
                startFromIndex = memoryQueue.findIndex(m => !m.processed || m.failed);
                if (startFromIndex === -1) startFromIndex = 0;
                userSelectedStartIndex = null;
                showQueueSection(true);
                updateMemoryQueueUI();
                updateStartButtonState(false);
                document.getElementById('ttw-start-btn').disabled = false;
                alert(`任务已导入！将从记忆${startFromIndex + 1}继续`);
            } catch (error) {
                alert('导入失败: ' + error.message);
            }
        };
        input.click();
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
            if (firstUnprocessed !== -1) {
                startBtn.textContent = `▶️ 继续 (从记忆${firstUnprocessed + 1})`;
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

    // ========== UI ==========
    let modalContainer = null;

    function createModal() {
        if (modalContainer) modalContainer.remove();

        modalContainer = document.createElement('div');
        modalContainer.id = 'txt-to-worldbook-modal';
        modalContainer.className = 'ttw-modal-container';
        modalContainer.innerHTML = `
            <div class="ttw-modal">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📚 TXT转世界书 v2.5.0</span>
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
                            <div class="ttw-checkbox-group" style="margin-bottom:16px;">
                                <label class="ttw-checkbox-label" style="padding:10px 12px;background:rgba(39,174,96,0.15);border-radius:6px;border:1px solid rgba(39,174,96,0.3);">
                                    <input type="checkbox" id="ttw-use-tavern-preset" checked>
                                    <span>🍺 使用酒馆预设</span>
                                </label>
                            </div>
                            <div class="ttw-parallel-settings" style="padding:12px;background:rgba(52,152,219,0.15);border:1px solid rgba(52,152,219,0.3);border-radius:8px;margin-bottom:16px;">
                                <div style="font-weight:bold;color:#3498db;margin-bottom:10px;">🚀 并行处理</div>
                                <div style="display:flex;gap:12px;align-items:center;">
                                    <label class="ttw-checkbox-label"><input type="checkbox" id="ttw-parallel-enabled" checked><span>启用</span></label>
                                    <div><label style="font-size:12px;">并发:</label><input type="number" id="ttw-parallel-concurrency" value="3" min="1" max="10" style="width:60px;padding:5px;margin-left:6px;"></div>
                                </div>
                                <div style="margin-top:10px;">
                                    <select id="ttw-parallel-mode" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;">
                                        <option value="independent">🚀 独立模式（推荐）</option>
                                        <option value="batch">📦 分批模式</option>
                                    </select>
                                </div>
                            </div>
                            <div style="display:flex;gap:12px;margin-bottom:12px;">
                                <div style="flex:1;"><label style="display:block;font-size:12px;margin-bottom:4px;">每块字数</label><input type="number" id="ttw-chunk-size" value="15000" min="1000" max="500000" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;"></div>
                                <div style="flex:1;"><label style="display:block;font-size:12px;margin-bottom:4px;">超时(秒)</label><input type="number" id="ttw-api-timeout" value="120" min="30" max="600" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;"></div>
                            </div>
                            <div class="ttw-prompt-config" style="border:1px solid #444;border-radius:8px;overflow:hidden;">
                                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(230,126,34,0.15);">
                                    <span>📝 提示词配置</span>
                                    <button id="ttw-preview-prompt" class="ttw-btn-small">👁️ 预览</button>
                                </div>
                                <div style="padding:12px;">
                                    <textarea id="ttw-worldbook-prompt" rows="4" style="width:100%;padding:8px;border:1px solid #444;border-radius:4px;background:rgba(0,0,0,0.2);color:#fff;font-size:12px;resize:vertical;" placeholder="留空使用默认..."></textarea>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 文件上传 -->
                    <div class="ttw-section">
                        <div class="ttw-section-header">
                            <span>📄 文件</span>
                            <div style="display:flex;gap:6px;">
                                <button id="ttw-import-task" class="ttw-btn-small">📥 导入任务</button>
                                <button id="ttw-export-task" class="ttw-btn-small">📤 导出任务</button>
                                <button id="ttw-merge-worldbook" class="ttw-btn-small" style="background:rgba(155,89,182,0.3);">📦 合并世界书</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-upload-area" id="ttw-upload-area">
                                <div style="font-size:40px;margin-bottom:10px;">📁</div>
                                <div>点击或拖拽TXT文件</div>
                                <input type="file" id="ttw-file-input" accept=".txt" style="display:none;">
                            </div>
                            <div id="ttw-file-info" style="display:none;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;margin-top:10px;">
                                <span id="ttw-file-name"></span> <span id="ttw-file-size" style="color:#888;"></span>
                                <button id="ttw-clear-file" class="ttw-btn-small" style="margin-left:10px;">清除</button>
                            </div>
                        </div>
                    </div>

                    <!-- 记忆队列 -->
                    <div class="ttw-section" id="ttw-queue-section" style="display:none;">
                        <div class="ttw-section-header">
                            <span>📋 记忆队列</span>
                            <div style="display:flex;gap:6px;">
                                <button id="ttw-view-processed" class="ttw-btn-small">📊 结果</button>
                                <button id="ttw-select-start" class="ttw-btn-small">📍 起始</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div style="font-size:11px;color:#888;margin-bottom:8px;">💡 点击查看/编辑 | 🎲=重Roll</div>
                            <div class="ttw-memory-queue" id="ttw-memory-queue"></div>
                        </div>
                    </div>

                    <!-- 进度 -->
                    <div class="ttw-section" id="ttw-progress-section" style="display:none;">
                        <div class="ttw-section-header"><span>⏳ 进度</span></div>
                        <div class="ttw-section-content">
                            <div style="width:100%;height:8px;background:rgba(0,0,0,0.3);border-radius:4px;overflow:hidden;margin-bottom:10px;">
                                <div id="ttw-progress-fill" style="height:100%;background:linear-gradient(90deg,#e67e22,#f39c12);width:0%;transition:width 0.3s;"></div>
                            </div>
                            <div id="ttw-progress-text" style="text-align:center;font-size:13px;margin-bottom:10px;">准备中...</div>
                            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
                                <button id="ttw-stop-btn" class="ttw-btn">⏸️ 暂停</button>
                                <button id="ttw-repair-btn" class="ttw-btn ttw-btn-warning" style="display:none;">🔧 修复</button>
                                <button id="ttw-toggle-stream" class="ttw-btn-small">👁️ 日志</button>
                            </div>
                            <div id="ttw-stream-container" style="display:none;margin-top:10px;border:1px solid #444;border-radius:6px;overflow:hidden;">
                                <div style="display:flex;justify-content:space-between;padding:6px 10px;background:rgba(0,0,0,0.3);font-size:11px;">
                                    <span>📤 实时输出</span>
                                    <button id="ttw-clear-stream" class="ttw-btn-small">清空</button>
                                </div>
                                <pre id="ttw-stream-content" style="max-height:180px;overflow-y:auto;padding:10px;background:rgba(0,0,0,0.2);font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;"></pre>
                            </div>
                        </div>
                    </div>

                    <!-- 结果 -->
                    <div class="ttw-section" id="ttw-result-section" style="display:none;">
                        <div class="ttw-section-header"><span>📊 结果</span></div>
                        <div class="ttw-section-content">
                            <div id="ttw-result-preview" style="max-height:250px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:10px;margin-bottom:10px;font-size:12px;"></div>
                            <div style="display:flex;flex-wrap:wrap;gap:8px;">
                                <button id="ttw-view-worldbook" class="ttw-btn">📖 查看</button>
                                <button id="ttw-view-history" class="ttw-btn">📜 历史</button>
                                <button id="ttw-export-json" class="ttw-btn">📥 JSON</button>
                                <button id="ttw-export-st" class="ttw-btn ttw-btn-primary">📥 ST格式</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button id="ttw-start-btn" class="ttw-btn ttw-btn-primary" disabled>🚀 开始转换</button>
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
            .ttw-modal-container{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;box-sizing:border-box;}
            .ttw-modal{background:var(--SmartThemeBlurTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:12px;width:100%;max-width:700px;max-height:calc(100vh - 40px);display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4);overflow:hidden;}
            .ttw-modal-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);background:rgba(0,0,0,0.2);}
            .ttw-modal-title{font-weight:bold;font-size:15px;color:#e67e22;}
            .ttw-header-actions{display:flex;align-items:center;gap:10px;}
            .ttw-help-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:rgba(231,76,60,0.2);color:#e74c3c;font-size:13px;cursor:pointer;border:1px solid rgba(231,76,60,0.4);}
            .ttw-help-btn:hover{background:rgba(231,76,60,0.4);}
            .ttw-modal-close{background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:16px;width:32px;height:32px;border-radius:6px;cursor:pointer;}
            .ttw-modal-close:hover{background:rgba(255,100,100,0.3);}
            .ttw-modal-body{flex:1;overflow-y:auto;padding:14px;}
            .ttw-modal-footer{padding:14px 18px;border-top:1px solid var(--SmartThemeBorderColor,#444);background:rgba(0,0,0,0.2);display:flex;justify-content:flex-end;gap:10px;}
            .ttw-section{background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:10px;overflow:hidden;}
            .ttw-section-header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(0,0,0,0.3);cursor:pointer;font-weight:bold;font-size:13px;}
            .ttw-section-content{padding:14px;}
            .ttw-collapse-icon{font-size:10px;transition:transform 0.2s;}
            .ttw-section.collapsed .ttw-collapse-icon{transform:rotate(-90deg);}
            .ttw-section.collapsed .ttw-section-content{display:none;}
            .ttw-checkbox-label{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;}
            .ttw-checkbox-label input{width:16px;height:16px;accent-color:#e67e22;}
            .ttw-checkbox-group{display:flex;flex-direction:column;gap:8px;}
            .ttw-upload-area{border:2px dashed var(--SmartThemeBorderColor,#555);border-radius:8px;padding:30px 20px;text-align:center;cursor:pointer;transition:all 0.2s;}
            .ttw-upload-area:hover{border-color:#e67e22;background:rgba(230,126,34,0.1);}
            .ttw-memory-queue{max-height:180px;overflow-y:auto;}
            .ttw-memory-item{padding:8px 10px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:5px;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;transition:background 0.2s;}
            .ttw-memory-item:hover{background:rgba(0,0,0,0.4);}
            .ttw-memory-item.processed{opacity:0.6;}
            .ttw-memory-item.processing{border-left:3px solid #3498db;background:rgba(52,152,219,0.15);opacity:1;}
            .ttw-memory-item.failed{border-left:3px solid #e74c3c;opacity:1;}
            .ttw-btn{padding:8px 14px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;background:rgba(255,255,255,0.1);color:#fff;font-size:12px;cursor:pointer;transition:all 0.2s;}
            .ttw-btn:hover{background:rgba(255,255,255,0.2);}
            .ttw-btn:disabled{opacity:0.5;cursor:not-allowed;}
            .ttw-btn-primary{background:linear-gradient(135deg,#e67e22,#d35400);border-color:#e67e22;}
            .ttw-btn-primary:hover{background:linear-gradient(135deg,#f39c12,#e67e22);}
            .ttw-btn-warning{background:rgba(255,107,53,0.5);border-color:#ff6b35;}
            .ttw-btn-small{padding:5px 10px;font-size:11px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:4px;background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;}
            .ttw-btn-small:hover{background:rgba(255,255,255,0.2);}
            .ttw-reroll-btn{padding:3px 8px;font-size:10px;background:rgba(155,89,182,0.3);border:1px solid rgba(155,89,182,0.5);border-radius:4px;color:#bb86fc;cursor:pointer;}
            .ttw-reroll-btn:hover{background:rgba(155,89,182,0.5);}
        `;
        document.head.appendChild(styles);
    }

    function bindModalEvents() {
        const modal = modalContainer.querySelector('.ttw-modal');
        modal.addEventListener('click', e => e.stopPropagation());

        modalContainer.querySelector('.ttw-modal-close').addEventListener('click', closeModal);
        modalContainer.querySelector('.ttw-help-btn').addEventListener('click', showHelpModal);
        modalContainer.addEventListener('click', e => { if (e.target === modalContainer) closeModal(); });
        document.addEventListener('keydown', handleEscKey, true);

        // 设置事件
        ['ttw-chunk-size', 'ttw-api-timeout', 'ttw-parallel-concurrency'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });
        ['ttw-use-tavern-preset', 'ttw-parallel-enabled'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });
        document.getElementById('ttw-parallel-mode').addEventListener('change', e => {
            parallelConfig.mode = e.target.value;
            saveCurrentSettings();
        });
        document.getElementById('ttw-worldbook-prompt').addEventListener('input', saveCurrentSettings);
        document.getElementById('ttw-preview-prompt').addEventListener('click', showPromptPreview);

        // 任务导入导出
        document.getElementById('ttw-import-task').addEventListener('click', importTaskState);
        document.getElementById('ttw-export-task').addEventListener('click', exportTaskState);
        document.getElementById('ttw-merge-worldbook').addEventListener('click', showWorldbookMergeModal);

        // 文件上传
        const uploadArea = document.getElementById('ttw-upload-area');
        const fileInput = document.getElementById('ttw-file-input');
        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.style.borderColor = '#e67e22'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
        uploadArea.addEventListener('drop', e => {
            e.preventDefault();
            uploadArea.style.borderColor = '';
            if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', e => { if (e.target.files.length > 0) handleFileSelect(e.target.files[0]); });
        document.getElementById('ttw-clear-file').addEventListener('click', clearFile);

        // 控制按钮
        document.getElementById('ttw-start-btn').addEventListener('click', startConversion);
        document.getElementById('ttw-stop-btn').addEventListener('click', stopProcessing);
        document.getElementById('ttw-repair-btn').addEventListener('click', startRepairFailedMemories);
        document.getElementById('ttw-select-start').addEventListener('click', showStartFromSelector);
        document.getElementById('ttw-view-processed').addEventListener('click', showProcessedResults);
        document.getElementById('ttw-toggle-stream').addEventListener('click', () => {
            const container = document.getElementById('ttw-stream-container');
            container.style.display = container.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('ttw-clear-stream').addEventListener('click', () => updateStreamContent('', true));

        // 结果
        document.getElementById('ttw-view-worldbook').addEventListener('click', showWorldbookView);
        document.getElementById('ttw-view-history').addEventListener('click', showHistoryView);
        document.getElementById('ttw-export-json').addEventListener('click', exportWorldbook);
        document.getElementById('ttw-export-st').addEventListener('click', exportToSillyTavern);

        // 折叠
        document.querySelector('[data-section="settings"]').addEventListener('click', () => {
            document.querySelector('.ttw-settings-section').classList.toggle('collapsed');
        });
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
        settings.useTavernPreset = document.getElementById('ttw-use-tavern-preset').checked;
        settings.customWorldbookPrompt = document.getElementById('ttw-worldbook-prompt').value;
        parallelConfig.enabled = document.getElementById('ttw-parallel-enabled').checked;
        parallelConfig.concurrency = Math.max(1, Math.min(10, parseInt(document.getElementById('ttw-parallel-concurrency').value) || 3));
        parallelConfig.mode = document.getElementById('ttw-parallel-mode').value;
        settings.parallelEnabled = parallelConfig.enabled;
        settings.parallelConcurrency = parallelConfig.concurrency;
        settings.parallelMode = parallelConfig.mode;
        try { localStorage.setItem('txtToWorldbookSettings', JSON.stringify(settings)); }
        catch (e) { console.error('保存设置失败:', e); }
    }

    function loadSavedSettings() {
        try {
            const saved = localStorage.getItem('txtToWorldbookSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                settings = { ...defaultSettings, ...parsed };
                parallelConfig.enabled = settings.parallelEnabled !== undefined ? settings.parallelEnabled : true;
                parallelConfig.concurrency = settings.parallelConcurrency || 3;
                parallelConfig.mode = settings.parallelMode || 'independent';
            }
        } catch (e) {}
        document.getElementById('ttw-chunk-size').value = settings.chunkSize;
        document.getElementById('ttw-api-timeout').value = Math.round((settings.apiTimeout || 120000) / 1000);
        document.getElementById('ttw-use-tavern-preset').checked = settings.useTavernPreset;
        document.getElementById('ttw-worldbook-prompt').value = settings.customWorldbookPrompt || '';
        document.getElementById('ttw-parallel-enabled').checked = parallelConfig.enabled;
        document.getElementById('ttw-parallel-concurrency').value = parallelConfig.concurrency;
        document.getElementById('ttw-parallel-mode').value = parallelConfig.mode;
    }

    function showPromptPreview() {
        const prompt = getLanguagePrefix() + getSystemPrompt();
        alert('当前提示词:\n\n' + prompt.substring(0, 500) + '...');
    }

    async function checkAndRestoreState() {
        try {
            const savedState = await MemoryHistoryDB.loadState();
            if (savedState?.memoryQueue?.length > 0) {
                const processedCount = savedState.memoryQueue.filter(m => m.processed).length;
                if (confirm(`检测到未完成任务 (${processedCount}/${savedState.memoryQueue.length})\n\n是否恢复？`)) {
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
                    if (startFromIndex >= memoryQueue.length) {
                        showResultSection(true);
                        updateWorldbookPreview();
                    }
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
            currentFileHash = await calculateFileHash(content);
            await MemoryHistoryDB.saveFileHash(currentFileHash);
            document.getElementById('ttw-upload-area').style.display = 'none';
            document.getElementById('ttw-file-info').style.display = 'block';
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
        let i = 0, chunkIndex = 1;
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

    function clearFile() {
        currentFile = null;
        memoryQueue = [];
        generatedWorldbook = {};
        worldbookVolumes = [];
        startFromIndex = 0;
        userSelectedStartIndex = null;
        document.getElementById('ttw-upload-area').style.display = 'block';
        document.getElementById('ttw-file-info').style.display = 'none';
        document.getElementById('ttw-file-input').value = '';
        document.getElementById('ttw-start-btn').disabled = true;
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
    function showResultSection(show) { document.getElementById('ttw-result-section').style.display = show ? 'block' : 'none'; }

    function updateProgress(percent, text) {
        document.getElementById('ttw-progress-fill').style.width = `${percent}%`;
        document.getElementById('ttw-progress-text').textContent = text;
        const failedCount = memoryQueue.filter(m => m.failed).length;
        const repairBtn = document.getElementById('ttw-repair-btn');
        repairBtn.style.display = failedCount > 0 ? 'inline-block' : 'none';
        if (failedCount > 0) repairBtn.textContent = `🔧 修复(${failedCount})`;
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
                <span style="flex:1;">${memory.title}</span>
                <small style="color:#888;">${memory.content.length.toLocaleString()}字</small>
                <button class="ttw-reroll-btn" data-index="${index}" title="重Roll / Roll历史">🎲</button>
            `;

            // 点击查看/编辑
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('ttw-reroll-btn')) return;
                showMemoryContentModal(index);
            });

            container.appendChild(item);
        });

        // 绑定重Roll按钮事件
        container.querySelectorAll('.ttw-reroll-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                showRollHistorySelector(index);
            });
        });
    }

    function showMemoryContentModal(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        const existingModal = document.getElementById('ttw-memory-content-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-memory-content-modal';
        modal.className = 'ttw-modal-container';

        const statusText = memory.processing ? '🔄 处理中' : (memory.processed ? (memory.failed ? '❗ 失败' : '✅ 完成') : '⏳ 等待');

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:850px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📄 ${memory.title} - ${statusText}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;">
                        <span>字数: <span id="ttw-char-count">${memory.content.length.toLocaleString()}</span></span>
                        <div style="display:flex;gap:6px;">
                            <button id="ttw-copy-content" class="ttw-btn-small">📋 复制</button>
                            <button id="ttw-reroll-in-modal" class="ttw-btn-small" style="background:rgba(155,89,182,0.3);">🎲 重Roll</button>
                            <button id="ttw-roll-history-in-modal" class="ttw-btn-small">📜 Roll历史</button>
                            <button id="ttw-delete-memory" class="ttw-btn-small" style="background:rgba(231,76,60,0.3);">🗑️ 删除</button>
                        </div>
                    </div>
                    ${memory.failedError ? `<div style="margin-bottom:12px;padding:8px;background:rgba(231,76,60,0.2);border-radius:6px;color:#e74c3c;font-size:12px;">❌ ${memory.failedError}</div>` : ''}
                    <div style="margin-bottom:12px;">
                        <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                            <span style="font-weight:bold;">📝 内容 (可编辑)</span>
                            <div style="display:flex;gap:6px;">
                                <button id="ttw-append-prev" class="ttw-btn-small" ${index === 0 ? 'disabled style="opacity:0.5;"' : ''}>⬆️ 追加到上一个</button>
                                <button id="ttw-append-next" class="ttw-btn-small" ${index === memoryQueue.length - 1 ? 'disabled style="opacity:0.5;"' : ''}>⬇️ 追加到下一个</button>
                            </div>
                        </div>
                        <textarea id="ttw-content-editor" style="width:100%;min-height:200px;padding:10px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:13px;line-height:1.6;resize:vertical;">${memory.content.replace(/</g, '<').replace(/>/g, '>')}</textarea>
                    </div>
                    ${memory.result ? `
                    <div>
                        <div style="font-weight:bold;margin-bottom:6px;">📊 处理结果</div>
                        <pre style="max-height:150px;overflow-y:auto;background:rgba(0,0,0,0.2);padding:10px;border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-all;">${JSON.stringify(memory.result, null, 2)}</pre>
                    </div>
                    ` : ''}
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-edit">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-save-edit">💾 保存</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const editor = modal.querySelector('#ttw-content-editor');
        const charCount = modal.querySelector('#ttw-char-count');

        editor.addEventListener('input', () => { charCount.textContent = editor.value.length.toLocaleString(); });

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-edit').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-save-edit').addEventListener('click', () => {
            if (editor.value !== memory.content) {
                memory.content = editor.value;
                memory.processed = false;
                memory.failed = false;
                memory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
            }
            modal.remove();
        });

        modal.querySelector('#ttw-copy-content').addEventListener('click', () => {
            navigator.clipboard.writeText(editor.value);
            const btn = modal.querySelector('#ttw-copy-content');
            btn.textContent = '✅ 已复制';
            setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
        });

        modal.querySelector('#ttw-reroll-in-modal').addEventListener('click', async () => {
            modal.remove();
            showProgressSection(true);
            try {
                await rerollMemory(index);
            } catch (error) {
                alert('重Roll失败: ' + error.message);
            }
        });

        modal.querySelector('#ttw-roll-history-in-modal').addEventListener('click', () => {
            modal.remove();
            showRollHistorySelector(index);
        });

        modal.querySelector('#ttw-delete-memory').addEventListener('click', () => {
            if (confirm(`删除 "${memory.title}"？`)) {
                memoryQueue.splice(index, 1);
                memoryQueue.forEach((m, i) => { m.title = `记忆${i + 1}`; });
                updateMemoryQueueUI();
                updateStartButtonState(false);
                modal.remove();
            }
        });

        modal.querySelector('#ttw-append-prev').addEventListener('click', () => {
            if (index === 0) return;
            if (confirm(`追加到 "${memoryQueue[index - 1].title}" 末尾？`)) {
                memoryQueue[index - 1].content += '\n\n' + editor.value;
                memoryQueue[index - 1].processed = false;
                memoryQueue[index - 1].result = null;
                updateMemoryQueueUI();
                alert('已追加');
            }
        });

        modal.querySelector('#ttw-append-next').addEventListener('click', () => {
            if (index === memoryQueue.length - 1) return;
            if (confirm(`追加到 "${memoryQueue[index + 1].title}" 开头？`)) {
                memoryQueue[index + 1].content = editor.value + '\n\n' + memoryQueue[index + 1].content;
                memoryQueue[index + 1].processed = false;
                memoryQueue[index + 1].result = null;
                updateMemoryQueueUI();
                alert('已追加');
            }
        });
    }

    function updateWorldbookPreview() {
        const container = document.getElementById('ttw-result-preview');
        if (!generatedWorldbook || Object.keys(generatedWorldbook).length === 0) {
            container.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">暂无数据</div>';
            return;
        }
        let html = '';
        let totalEntries = 0;
        for (const category in generatedWorldbook) {
            const entries = generatedWorldbook[category];
            const entryCount = typeof entries === 'object' ? Object.keys(entries).length : 0;
            if (entryCount === 0) continue;
            totalEntries += entryCount;
            html += `<div style="margin-bottom:8px;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;border-left:3px solid #e67e22;">
                <strong style="color:#e67e22;">${category}</strong> <span style="color:#888;font-size:11px;">(${entryCount})</span>
                <div style="font-size:11px;color:#aaa;margin-top:4px;">${Object.keys(entries).slice(0, 5).join(', ')}${entryCount > 5 ? '...' : ''}</div>
            </div>`;
        }
        container.innerHTML = `<div style="margin-bottom:8px;font-size:12px;">共 ${Object.keys(generatedWorldbook).length} 分类, ${totalEntries} 条目</div>` + html;
    }

    function showWorldbookView() {
        const existingModal = document.getElementById('ttw-worldbook-view-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-worldbook-view-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📖 世界书详情</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                    <pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.5;">${JSON.stringify(generatedWorldbook, null, 2)}</pre>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-close-wb-view">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-wb-view').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }

    async function showHistoryView() {
        const historyList = await MemoryHistoryDB.getAllHistory();
        const existingModal = document.getElementById('ttw-history-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-history-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:700px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📜 修改历史 (${historyList.length})</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:60vh;overflow-y:auto;">
                    ${historyList.length === 0 ? '<div style="text-align:center;color:#888;padding:30px;">暂无历史</div>' :
                    historyList.sort((a, b) => b.timestamp - a.timestamp).map(h => {
                        const time = new Date(h.timestamp).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
                        return `<div style="padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:8px;border-left:3px solid #9b59b6;">
                            <div style="font-weight:bold;color:#e67e22;">${h.memoryTitle || `记忆${h.memoryIndex + 1}`}</div>
                            <div style="font-size:11px;color:#888;">${time} | ${h.changedEntries?.length || 0}项变更</div>
                        </div>`;
                    }).join('')}
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-warning" id="ttw-clear-history">🗑️ 清空</button>
                    <button class="ttw-btn" id="ttw-close-history">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-history').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-clear-history').addEventListener('click', async () => {
            if (confirm('清空所有历史？')) {
                await MemoryHistoryDB.clearAllHistory();
                modal.remove();
                showHistoryView();
            }
        });
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }

    function showStartFromSelector() {
        if (memoryQueue.length === 0) { alert('请先上传文件'); return; }
        const index = prompt(`从第几个记忆开始？(1-${memoryQueue.length})`, startFromIndex + 1);
        if (index) {
            const idx = parseInt(index) - 1;
            if (idx >= 0 && idx < memoryQueue.length) {
                userSelectedStartIndex = idx;
                startFromIndex = idx;
                updateStartButtonState(false);
            }
        }
    }

    function showProcessedResults() {
        const processed = memoryQueue.filter(m => m.processed && !m.failed && m.result);
        if (processed.length === 0) { alert('暂无已处理结果'); return; }
        const modal = document.createElement('div');
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:700px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📊 已处理 (${processed.length}/${memoryQueue.length})</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:60vh;overflow-y:auto;">
                    ${processed.map(m => {
                        const entryCount = m.result ? Object.keys(m.result).reduce((sum, cat) =>
                            sum + (typeof m.result[cat] === 'object' ? Object.keys(m.result[cat]).length : 0), 0) : 0;
                        return `<div style="padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:8px;border-left:3px solid #27ae60;">
                            <strong style="color:#27ae60;">✅ ${m.title}</strong>
                            <span style="font-size:11px;color:#888;margin-left:10px;">${entryCount}条目</span>
                        </div>`;
                    }).join('')}
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-close">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('.ttw-close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }

    async function startRepairFailedMemories() {
        const failed = memoryQueue.filter(m => m.failed);
        if (failed.length === 0) { alert('没有失败的记忆'); return; }
        updateStreamContent('', true);
        updateStreamContent(`🔧 开始修复 ${failed.length} 个失败记忆...\n`);
        let success = 0;
        for (const memory of failed) {
            const index = memoryQueue.indexOf(memory);
            if (index === -1) continue;
            try {
                updateStreamContent(`🔄 修复: ${memory.title}\n`);
                await processMemoryChunkSerial(index);
                if (!memory.failed) success++;
            } catch (e) {
                updateStreamContent(`❌ 修复失败: ${e.message}\n`);
            }
        }
        updateStreamContent(`\n✅ 修复完成: 成功${success}/${failed.length}\n`);
        updateMemoryQueueUI();
        alert(`修复完成: 成功${success}/${failed.length}`);
    }

    function showHelpModal() {
        alert(`📚 TXT转世界书 v2.5.0

✨ 新功能:
• 🎲 重Roll - 每个记忆列表都有重Roll按钮
• 📦 合并世界书 - 导入JSON合并多个世界书
• 🍺 酒馆预设 - 使用SillyTavern的API设置

💡 使用方法:
1. 上传TXT文件
2. 点击"开始转换"
3. 点击记忆右侧的🎲按钮可重Roll
4. 点击"📦 合并世界书"导入JSON合并

⚙️ 并行模式:
• 独立模式: 每块独立处理，最快
• 分批模式: 批次间有上下文`);
    }

    function closeModal() {
        if (modalContainer) {
            modalContainer.remove();
            modalContainer = null;
        }
        document.removeEventListener('keydown', handleEscKey, true);
    }

    function open() { createModal(); }

    window.TxtToWorldbook = {
        open,
        close: closeModal,
        getWorldbook: () => generatedWorldbook,
        getMemoryQueue: () => memoryQueue,
        rerollMemory,
        showMergeModal: showWorldbookMergeModal
    };

    console.log('📚 TxtToWorldbook v2.5.0 已加载 (🎲重Roll按钮优化 + 📦JSON导入合并 + 🍺CSRF修复)');
})();
