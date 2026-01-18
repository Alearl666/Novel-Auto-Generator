
/**
 * TXT转世界书独立模块 v2.1
 * 新增：世界书分卷功能 - 上下文超限时自动开新卷
 */

(function() {
    'use strict';

    // ========== 全局状态 ==========
    let generatedWorldbook = {};
    let worldbookVolumes = []; // 新增：世界书分卷存储
    let currentVolumeIndex = 0; // 当前卷索引
    let memoryQueue = [];
    let failedMemoryQueue = [];
    let currentFile = null;
    let currentFileHash = null;
    let isProcessingStopped = false;
    let isRepairingMemories = false;
    let currentProcessingIndex = 0;
    let incrementalOutputMode = true;
    let useVolumeMode = false; // 新增：是否启用分卷模式
    let currentStreamContent = '';

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
"内容": "基于原文的角色描述，包含但不限于**名称**:（必须要）、**性别**:、**MBTI(必须要，如变化请说明背景)**:、**貌龄**:、**年龄**:、**身份**:、**背景**:、**性格**:、**外貌**:、**技能**:、**重要事件**:、**话语示例**:、**弱点**:、**背景故事**:等（实际嵌套或者排列方式按合理的逻辑）"
}
},
"地点": {
"地点真实名称": {
"关键词": ["地点名", "别称", "俗称"],
"内容": "基于原文的地点描述，包含但不限于**名称**:（必须要）、**位置**:、**特征**:、**重要事件**:等（实际嵌套或者排列方式按合理的逻辑）"
}
},
"组织": {
"组织真实名称": {
"关键词": ["组织名", "简称", "代号"],
"内容": "基于原文的组织描述，包含但不限于**名称**:（必须要）、**性质**:、**成员**:、**目标**:等（实际嵌套或者排列方式按合理的逻辑）"
}
}
}
\`\`\`

## 重要提醒
- 直接输出JSON，不要包含代码块标记
- 所有信息必须来源于原文，不要编造
- 关键词必须是文中实际出现的词语
- 内容描述要完整但简洁`;

    const defaultPlotPrompt = `"剧情大纲": {
"主线剧情": {
"关键词": ["主线", "核心剧情", "故事线"],
"内容": "## 故事主线\\n**核心冲突**: 故事的中心矛盾\\n**主要目标**: 主角追求的目标\\n**阻碍因素**: 实现目标的障碍\\n\\n## 剧情阶段\\n**第一幕 - 起始**: 故事开端，世界观建立\\n**第二幕 - 发展**: 冲突升级，角色成长\\n**第三幕 - 高潮**: 决战时刻，矛盾爆发\\n**第四幕 - 结局**: [如已完结] 故事收尾\\n\\n## 关键转折点\\n1. **转折点1**: 描述和影响\\n2. **转折点2**: 描述和影响\\n3. **转折点3**: 描述和影响\\n\\n## 伏笔与暗线\\n**已揭示的伏笔**: 已经揭晓的铺垫\\n**未解之谜**: 尚未解答的疑问\\n**暗线推测**: 可能的隐藏剧情线"
},
"支线剧情": {
"关键词": ["支线", "副线", "分支剧情"],
"内容": "## 主要支线\\n**支线1标题**: 简要描述\\n**支线2标题**: 简要描述\\n**支线3标题**: 简要描述\\n\\n## 支线与主线的关联\\n**交织点**: 支线如何影响主线\\n**独立价值**: 支线的独特意义"
}
}`;

    const defaultStylePrompt = `"文风配置": {
"作品文风": {
"关键词": ["文风", "写作风格", "叙事特点"],
"内容": "## 叙事视角\\n**视角类型**: 第一人称/第三人称/全知视角\\n**叙述者特点**: 叙述者的语气和态度\\n\\n## 语言风格\\n**用词特点**: 华丽/简洁/口语化/书面化\\n**句式特点**: 长句/短句/对话多/描写多\\n**修辞手法**: 常用的修辞手法\\n\\n## 情感基调\\n**整体氛围**: 轻松/沉重/悬疑/浪漫\\n**情感表达**: 直接/含蓄/细腻/粗犷"
}
}`;

    const defaultSettings = {
        chunkSize: 15000,
        enablePlotOutline: false,
        enableLiteraryStyle: false,
        language: 'zh',
        customWorldbookPrompt: '',
        customPlotPrompt: '',
        customStylePrompt: '',
        useVolumeMode: false // 新增
    };

    let settings = { ...defaultSettings };

    // ========== IndexedDB 持久化 ==========
    const MemoryHistoryDB = {
        dbName: 'TxtToWorldbookDB',
        storeName: 'history',
        metaStoreName: 'meta',
        stateStoreName: 'state',
        db: null,

        async openDB() {
            if (this.db) return this.db;

            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 3);

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
                };

                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve(this.db);
                };

                request.onerror = (event) => {
                    reject(event.target.error);
                };
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
                        console.log(`🗑️ 删除 ${duplicates.length} 条重复记录: "${memoryTitle}"`);
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
                    volumeIndex: currentVolumeIndex // 新增：记录卷索引
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

                request.onsuccess = () => {
                    console.log('📚 记忆历史已清除');
                    resolve();
                };
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
                    worldbookVolumes: JSON.parse(JSON.stringify(worldbookVolumes)), // 新增
                    currentVolumeIndex: currentVolumeIndex, // 新增
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

        async rollbackToHistory(historyId) {
            const history = await this.getHistoryById(historyId);
            if (!history) {
                throw new Error('找不到指定的历史记录');
            }

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
                if (!groupedByTitle[title]) {
                    groupedByTitle[title] = [];
                }
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
                console.log(`🗑️ 清理 ${toDelete.length} 条重复历史记录`);
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

    // ========== 文件编码检测 ==========
    async function detectBestEncoding(file) {
        const encodings = ['UTF-8', 'GBK', 'GB2312', 'GB18030', 'Big5'];

        for (const encoding of encodings) {
            try {
                const content = await readFileWithEncoding(file, encoding);
                if (!content.includes('�') && !content.includes('\uFFFD')) {
                    return { encoding, content };
                }
            } catch (e) {
                continue;
            }
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

    // ========== 使用SillyTavern内置API调用 ==========
    async function callSillyTavernAPI(prompt) {
        updateStreamContent('', true);
        updateStreamContent('📤 正在发送请求...\n');

        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const context = SillyTavern.getContext();

                updateStreamContent('✅ 已获取酒馆上下文\n');

                const result = await context.generateRaw(prompt, '', false);

                updateStreamContent(`\n📥 收到响应 (${result.length}字符)\n`);
                updateStreamContent(result.substring(0, 500) + (result.length > 500 ? '...' : ''));

                return result;
            }

            updateStreamContent('⚠️ 未找到酒馆API，尝试备用方案...\n');

            const response = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    messages: [{ role: 'user', content: prompt }],
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API请求失败: ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || data.content || '';

            updateStreamContent(`\n📥 收到响应 (${content.length}字符)\n`);
            return content;

        } catch (error) {
            updateStreamContent(`\n❌ 错误: ${error.message}`);
            throw error;
        }
    }

    async function callDirectAPI(prompt, apiConfig) {
        updateStreamContent('', true);
        updateStreamContent('📤 使用直接API调用...\n');

        const { provider, apiKey, endpoint, model } = apiConfig;

        let requestUrl, requestOptions;

        switch (provider) {
            case 'gemini':
                requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
                requestOptions = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { maxOutputTokens: 63000, temperature: 0.3 }
                    }),
                };
                break;

            case 'openai':
            default:
                requestUrl = endpoint || 'https://api.openai.com/v1/chat/completions';
                requestOptions = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: model || 'gpt-4',
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.3,
                        max_tokens: 8192
                    }),
                };
                break;
        }

        const response = await fetch(requestUrl, requestOptions);

        if (!response.ok) {
            const errorText = await response.text();
            updateStreamContent(`\n❌ API错误: ${response.status}\n${errorText}`);
            throw new Error(`API请求失败: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        let content = '';

        if (provider === 'gemini') {
            content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
            content = data.choices?.[0]?.message?.content || '';
        }

        updateStreamContent(`\n📥 收到响应 (${content.length}字符)\n`);
        updateStreamContent(content.substring(0, 500) + (content.length > 500 ? '...' : ''));

        return content;
    }

    async function callAPI(prompt) {
        try {
            return await callSillyTavernAPI(prompt);
        } catch (stError) {
            console.warn('SillyTavern API调用失败，尝试备用方案:', stError);

            if (settings.backupApiKey) {
                return await callDirectAPI(prompt, {
                    provider: settings.backupApiProvider || 'openai',
                    apiKey: settings.backupApiKey,
                    endpoint: settings.backupApiEndpoint,
                    model: settings.backupApiModel
                });
            }

            throw stError;
        }
    }

    // ========== 实时内容显示 ==========
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

    // ========== 世界书数据处理 ==========
    function normalizeWorldbookEntry(entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;

        if (entry.content !== undefined && entry['内容'] !== undefined) {
            const contentLen = String(entry.content || '').length;
            const neirongLen = String(entry['内容'] || '').length;
            if (contentLen > neirongLen) {
                entry['内容'] = entry.content;
            }
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

        const stats = { updated: [], added: [] };

        for (const category in source) {
            if (typeof source[category] !== 'object' || source[category] === null) continue;

            if (!target[category]) {
                target[category] = {};
            }

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

                    if (sourceEntry['内容']) {
                        targetEntry['内容'] = sourceEntry['内容'];
                    }

                    stats.updated.push(`[${category}] ${entryName}`);
                } else {
                    target[category][entryName] = sourceEntry;
                    stats.added.push(`[${category}] ${entryName}`);
                }
            }
        }

        if (stats.updated.length > 0) {
            console.log(`📝 增量更新 ${stats.updated.length} 个条目`);
        }
        if (stats.added.length > 0) {
            console.log(`➕ 增量新增 ${stats.added.length} 个条目`);
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
                    changes.push({
                        type: 'add',
                        category: category,
                        entryName: entryName,
                        oldValue: null,
                        newValue: newEntry
                    });
                } else if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
                    changes.push({
                        type: 'modify',
                        category: category,
                        entryName: entryName,
                        oldValue: oldEntry,
                        newValue: newEntry
                    });
                }
            }
        }

        for (const category in oldWorldbook) {
            const oldCategory = oldWorldbook[category];
            const newCategory = newWorldbook[category] || {};

            for (const entryName in oldCategory) {
                if (!newCategory[entryName]) {
                    changes.push({
                        type: 'delete',
                        category: category,
                        entryName: entryName,
                        oldValue: oldCategory[entryName],
                        newValue: null
                    });
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
            await MemoryHistoryDB.saveHistory(
                memoryIndex,
                memoryTitle,
                previousWorldbook,
                target,
                changedEntries
            );
            console.log(`📚 已保存历史记录: ${memoryTitle}, ${changedEntries.length}个变更`);
        }

        return changedEntries;
    }

    // ========== 正则回退解析 ==========
    function extractWorldbookDataByRegex(jsonString) {
        console.log('🔧 开始正则提取世界书数据...');
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

            if (braceCount !== 0) {
                console.log(`⚠️ 分类 "${category}" 括号不匹配，跳过`);
                continue;
            }

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
                    if (keywordStrings) {
                        keywords = keywordStrings.map(s => s.replace(/"/g, ''));
                    }
                }

                let content = '';
                const contentMatch = entryContent.match(/"内容"\s*:\s*"/);
                if (contentMatch) {
                    const contentStartPos = contentMatch.index + contentMatch[0].length;
                    let contentEndPos = contentStartPos;
                    let escaped = false;
                    while (contentEndPos < entryContent.length) {
                        const char = entryContent[contentEndPos];
                        if (escaped) {
                            escaped = false;
                        } else if (char === '\\') {
                            escaped = true;
                        } else if (char === '"') {
                            break;
                        }
                        contentEndPos++;
                    }
                    content = entryContent.substring(contentStartPos, contentEndPos);
                    try {
                        content = JSON.parse(`"${content}"`);
                    } catch (e) {
                        content = content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    }
                }

                if (content || keywords.length > 0) {
                    result[category][entryName] = {
                        '关键词': keywords,
                        '内容': content
                    };
                    console.log(`  ✓ 提取条目: ${category} -> ${entryName}`);
                }
            }

            if (Object.keys(result[category]).length === 0) {
                delete result[category];
            }
        }

        const extractedCategories = Object.keys(result);
        const totalEntries = extractedCategories.reduce((sum, cat) => sum + Object.keys(result[cat]).length, 0);
        console.log(`🔧 正则提取完成: ${extractedCategories.length}个分类, ${totalEntries}个条目`);

        return result;
    }

    // ========== 新增：世界书分卷功能 ==========
    function startNewVolume() {
        // 保存当前卷
        if (Object.keys(generatedWorldbook).length > 0) {
            worldbookVolumes.push({
                volumeIndex: currentVolumeIndex,
                worldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                timestamp: Date.now()
            });
            console.log(`📦 第${currentVolumeIndex + 1}卷已保存，共${Object.keys(generatedWorldbook).length}个分类`);
        }

        // 开启新卷
        currentVolumeIndex++;
        generatedWorldbook = {
            地图环境: {},
            剧情节点: {},
            角色: {},
            知识书: {}
        };

        console.log(`📖 开始第${currentVolumeIndex + 1}卷`);
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
        // 合并所有卷的世界书
        const merged = {};

        for (const volume of worldbookVolumes) {
            for (const category in volume.worldbook) {
                if (!merged[category]) {
                    merged[category] = {};
                }
                for (const entryName in volume.worldbook[category]) {
                    // 如果条目已存在，添加卷标识
                    const key = merged[category][entryName]
                        ? `${entryName}_卷${volume.volumeIndex + 1}`
                        : entryName;
                    merged[category][key] = volume.worldbook[category][entryName];
                }
            }
        }

        // 加入当前卷
        for (const category in generatedWorldbook) {
            if (!merged[category]) {
                merged[category] = {};
            }
            for (const entryName in generatedWorldbook[category]) {
                const key = merged[category][entryName]
                    ? `${entryName}_卷${currentVolumeIndex + 1}`
                    : entryName;
                merged[category][key] = generatedWorldbook[category][entryName];
            }
        }

        return merged;
    }

    // ========== 记忆处理核心（修改版支持分卷） ==========
    async function processMemoryChunk(index, retryCount = 0) {
        if (isProcessingStopped) {
            console.log(`处理被暂停，跳过记忆块 ${index + 1}`);
            return;
        }

        const memory = memoryQueue[index];
        const progress = ((index + 1) / memoryQueue.length) * 100;
        const maxRetries = 3;

        updateProgress(progress, `正在处理: ${memory.title} (${index + 1}/${memoryQueue.length})${retryCount > 0 ? ` (重试 ${retryCount}/${maxRetries})` : ''}${useVolumeMode ? ` [第${currentVolumeIndex + 1}卷]` : ''}`);

        let basePrompt = getSystemPrompt();
        let prompt = getLanguagePrefix() + basePrompt;

        let additionalReminders = '';
        if (settings.enablePlotOutline) {
            additionalReminders += '\n- 剧情大纲是必需项，必须生成';
        }
        if (settings.enableLiteraryStyle) {
            additionalReminders += '\n- 文风配置字段为可选项，如果能够分析出明确的文风特征则生成，否则可以省略';
        }
        if (additionalReminders) {
            prompt += additionalReminders;
        }

        prompt += '\n\n';

        if (index > 0) {
            prompt += `这是你上一次阅读的结尾部分：
---
${memoryQueue[index - 1].content.slice(-500)}
---

`;
            // 分卷模式下只发送当前卷的世界书
            prompt += `这是当前你对该作品的记忆：
${JSON.stringify(generatedWorldbook, null, 2)}

`;
        }

        prompt += `这是你现在阅读的部分：
---
${memory.content}
---

`;

        if (index === 0) {
            prompt += `现在开始分析小说内容，请专注于提取文中实际出现的信息：

`;
        } else {
            if (incrementalOutputMode) {
                prompt += `请基于新内容**增量更新**世界书，采用**点对点覆盖**模式：

**增量输出规则**：
1. **只输出本次需要变更的条目**，不要输出完整的世界书
2. **新增条目**：直接输出新条目的完整内容
3. **修改条目**：输出该条目的完整新内容（会覆盖原有内容）
4. **未变更的条目不要输出**，系统会自动保留
5. **关键词合并**：新关键词会自动与原有关键词合并，无需重复原有关键词

**示例**：如果只有"张三"角色有新信息，只需输出：
{"角色": {"张三": {"关键词": ["新称呼"], "内容": "更新后的完整描述..."}}}

`;
            } else {
                prompt += `请基于新内容**累积补充**世界书，注意以下要点：

**重要规则**：
1. **已有角色**：如果角色已存在，请在原有内容基础上**追加新信息**，不要删除或覆盖已有描述
2. **新角色**：如果是新出现的角色，添加为新条目
3. **剧情大纲**：持续追踪主线发展，**追加新的剧情进展**而不是重写
4. **关键词**：为已有条目补充新的关键词（如新称呼、新关系等）
5. **保持完整性**：确保之前章节提取的重要信息不会丢失

`;
            }
        }

        prompt += `请直接输出JSON格式的结果，不要添加任何代码块标记或解释文字。`;

        console.log(`=== 第${index + 1}步 Prompt (前500字) ===`);
        console.log(prompt.substring(0, 500) + '...');
        console.log('=====================');

        try {
            console.log(`开始调用API处理第${index + 1}个记忆块...`);
            updateProgress(progress, `正在调用API: ${memory.title} (${index + 1}/${memoryQueue.length})`);

            const response = await callAPI(prompt);

            if (isProcessingStopped) {
                console.log(`API调用完成后检测到暂停，跳过后续处理`);
                return;
            }

            console.log(`API调用完成，返回内容长度: ${response.length}`);

            // 检查返回内容是否包含token超限错误
            const containsTokenError = /max|exceed|token.*limit|input.*token|INVALID_ARGUMENT/i.test(response);

            if (containsTokenError) {
                console.log(`⚠️ 返回内容包含token超限错误`);

                // 分卷模式：开新卷继续
                if (useVolumeMode) {
                    console.log(`📦 分卷模式：开启新卷继续处理`);
                    updateProgress(progress, `📦 上下文超限，开启第${currentVolumeIndex + 2}卷...`);

                    startNewVolume();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);

                    // 重试当前块（使用新的空白世界书）
                    await processMemoryChunk(index, 0);
                    return;
                }

                // 非分卷模式：分裂当前块
                updateProgress(progress, `🔀 上下文超限，分裂当前记忆块...`);

                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);

                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                }
            }

            // 清理和解析返回的JSON
            let memoryUpdate;
            try {
                memoryUpdate = JSON.parse(response);
                console.log('✅ JSON直接解析成功');
            } catch (jsonError) {
                console.log('直接JSON解析失败，开始清理...');
                let cleanResponse = response.trim();

                cleanResponse = cleanResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

                if (!cleanResponse.startsWith('{')) {
                    const firstBrace = cleanResponse.indexOf('{');
                    const lastBrace = cleanResponse.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        cleanResponse = cleanResponse.substring(firstBrace, lastBrace + 1);
                    }
                }

                try {
                    memoryUpdate = JSON.parse(cleanResponse);
                    console.log('✅ JSON清理后解析成功');
                } catch (secondError) {
                    console.error('❌ JSON解析仍然失败');

                    const openBraces = (cleanResponse.match(/{/g) || []).length;
                    const closeBraces = (cleanResponse.match(/}/g) || []).length;
                    const missingBraces = openBraces - closeBraces;

                    if (missingBraces > 0) {
                        console.log(`⚠️ 检测到内容不完整：缺少${missingBraces}个闭合括号`);

                        try {
                            memoryUpdate = JSON.parse(cleanResponse + '}'.repeat(missingBraces));
                            console.log(`✅ 自动添加${missingBraces}个闭合括号后解析成功`);
                        } catch (autoFixError) {
                            console.log('❌ 自动添加闭合括号后仍然失败，尝试正则提取...');

                            const regexExtractedData = extractWorldbookDataByRegex(cleanResponse);

                            if (regexExtractedData && Object.keys(regexExtractedData).length > 0) {
                                console.log('✅ 正则提取成功！');
                                memoryUpdate = regexExtractedData;
                            } else {
                                throw new Error(`JSON解析失败: ${secondError.message}`);
                            }
                        }
                    } else {
                        const regexExtractedData = extractWorldbookDataByRegex(cleanResponse);

                        if (regexExtractedData && Object.keys(regexExtractedData).length > 0) {
                            console.log('✅ 正则提取成功！');
                            memoryUpdate = regexExtractedData;
                        } else {
                            throw new Error(`JSON解析失败: ${secondError.message}`);
                        }
                    }
                }
            }

            // 合并到主世界书
            const changedEntries = await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memory.title);

            if (incrementalOutputMode && changedEntries.length > 0) {
                console.log(`📝 第${index + 1}个记忆块变更 ${changedEntries.length} 个条目`);
            }

            memory.processed = true;
            updateMemoryQueueUI();
            console.log(`记忆块 ${index + 1} 处理完成`);

        } catch (error) {
            console.error(`处理记忆块 ${index + 1} 时出错 (第${retryCount + 1}次尝试):`, error);

            const errorMsg = error.message || '';
            const isTokenLimitError = errorMsg.includes('max_prompt_tokens') ||
                                       errorMsg.includes('exceeded') ||
                                       errorMsg.includes('input tokens') ||
                                       errorMsg.includes('context_length') ||
                                       (errorMsg.includes('20015') && errorMsg.includes('limit'));

            if (isTokenLimitError) {
                // 分卷模式：开新卷继续
                if (useVolumeMode) {
                    console.log(`📦 分卷模式：开启新卷继续处理`);
                    updateProgress((index / memoryQueue.length) * 100, `📦 上下文超限，开启第${currentVolumeIndex + 2}卷...`);

                    startNewVolume();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // 重试当前块
                    await processMemoryChunk(index, 0);
                    return;
                }

                // 非分卷模式：分裂当前块
                console.log(`⚠️ 检测到token超限错误，分裂当前记忆块: ${memory.title}`);
                updateProgress((index / memoryQueue.length) * 100, `🔀 字数超限，正在分裂记忆: ${memory.title}`);

                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    console.log(`✅ 记忆分裂成功`);
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));

                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);

                    return;
                } else {
                    console.error(`❌ 记忆分裂失败: ${memory.title}`);
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

            // 非token超限错误，使用重试机制
            if (retryCount < maxRetries) {
                console.log(`准备重试，当前重试次数: ${retryCount + 1}/${maxRetries}`);
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateProgress((index / memoryQueue.length) * 100, `处理失败，${retryDelay/1000}秒后重试: ${memory.title}`);

                await new Promise(resolve => setTimeout(resolve, retryDelay));

                return await processMemoryChunk(index, retryCount + 1);
            } else {
                console.error(`记忆块 ${index + 1} 重试${maxRetries}次后仍然失败`);
                updateProgress((index / memoryQueue.length) * 100, `处理失败 (已重试${maxRetries}次): ${memory.title}`);

                memory.processed = true;
                memory.failed = true;
                memory.failedError = error.message;

                if (!failedMemoryQueue.find(m => m.index === index)) {
                    failedMemoryQueue.push({ index, memory, error: error.message });
                }

                updateMemoryQueueUI();
            }
        }

        if (memory.processed) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // ========== 记忆分裂机制 ==========
    function splitMemoryIntoTwo(memoryIndex) {
        const memory = memoryQueue[memoryIndex];
        if (!memory) {
            console.error('❌ 无法找到要分裂的记忆');
            return null;
        }

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

        const memory1 = {
            title: baseName + suffix1,
            content: content1,
            processed: false,
            failed: false,
            failedError: null
        };

        const memory2 = {
            title: baseName + suffix2,
            content: content2,
            processed: false,
            failed: false,
            failedError: null
        };

        memoryQueue.splice(memoryIndex, 1, memory1, memory2);

        console.log(`🔀 记忆分裂完成: "${originalTitle}" -> "${memory1.title}" + "${memory2.title}"`);
        console.log(`   原始长度: ${content.length}, 分裂后: ${content1.length} + ${content2.length}`);

        return { part1: memory1, part2: memory2 };
    }

    async function startAIProcessing() {
        showProgressSection(true);
        isProcessingStopped = false;

        // 初始化分卷
        worldbookVolumes = [];
        currentVolumeIndex = 0;

        generatedWorldbook = {
            地图环境: {},
            剧情节点: {},
            角色: {},
            知识书: {}
        };

        if (useVolumeMode) {
            updateVolumeIndicator();
        }

        try {
            let i = 0;
            while (i < memoryQueue.length) {
                if (isProcessingStopped) {
                    console.log('处理被用户停止');
                    updateProgress((i / memoryQueue.length) * 100, `⏸️ 已暂停处理 (${i}/${memoryQueue.length})`);
                    await MemoryHistoryDB.saveState(i);
                    alert(`处理已暂停！\n当前进度: ${i}/${memoryQueue.length}\n\n进度已保存，刷新页面后可继续。`);
                    break;
                }

                if (isRepairingMemories) {
                    console.log(`检测到修复模式，暂停当前处理于索引 ${i}`);
                    currentProcessingIndex = i;
                    updateProgress((i / memoryQueue.length) * 100, `⏸️ 修复记忆中，已暂停处理 (${i}/${memoryQueue.length})`);

                    while (isRepairingMemories) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    console.log(`修复完成，从索引 ${i} 继续处理`);
                }

                const currentQueueLength = memoryQueue.length;
                await processMemoryChunk(i);

                if (memoryQueue.length > currentQueueLength) {
                    i += (memoryQueue.length - currentQueueLength);
                }

                i++;
                await MemoryHistoryDB.saveState(i);
            }

            // 保存最后一卷
            if (useVolumeMode && Object.keys(generatedWorldbook).length > 0) {
                worldbookVolumes.push({
                    volumeIndex: currentVolumeIndex,
                    worldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                    timestamp: Date.now()
                });
            }

            const failedCount = memoryQueue.filter(m => m.failed === true).length;

            if (failedCount > 0) {
                updateProgress(100, `⚠️ 处理完成，但有 ${failedCount} 个记忆块失败，请点击修复`);
            } else {
                const volumeInfo = useVolumeMode ? ` (共${worldbookVolumes.length}卷)` : '';
                updateProgress(100, `✅ 所有记忆块处理完成！${volumeInfo}`);
            }

            showResultSection(true);
            updateWorldbookPreview();

            console.log('AI记忆大师处理完成');

            if (!isProcessingStopped) {
                await MemoryHistoryDB.saveState(memoryQueue.length);
                console.log('✅ 转换完成，状态已保存');
            }

        } catch (error) {
            console.error('AI处理过程中发生错误:', error);
            updateProgress(0, `❌ 处理过程出错: ${error.message}`);
            alert(`处理失败: ${error.message}\n\n进度已保存，可以稍后继续。`);
        }
    }

    // ========== 修复失败记忆 ==========
    async function repairSingleMemory(index) {
        const memory = memoryQueue[index];
        const enableLiteraryStyle = settings.enableLiteraryStyle;
        const enablePlotOutline = settings.enablePlotOutline;

        let prompt = getLanguagePrefix() + `你是专业的小说世界书生成专家。请仔细阅读提供的小说内容，提取关键信息，生成世界书条目。

## 输出格式
请生成标准JSON格式：
{
"角色": { "角色名": { "关键词": ["..."], "内容": "..." } },
"地点": { "地点名": { "关键词": ["..."], "内容": "..." } },
"组织": { "组织名": { "关键词": ["..."], "内容": "..." } }${enablePlotOutline ? `,
"剧情大纲": { "主线剧情": { "关键词": ["主线"], "内容": "..." } }` : ''}${enableLiteraryStyle ? `,
"文风配置": { "作品文风": { "关键词": ["文风"], "内容": "..." } }` : ''}
}

直接输出更新后的JSON，保持一致性，不要包含代码块标记。
`;

        if (Object.keys(generatedWorldbook).length > 0) {
            prompt += `当前记忆：\n${JSON.stringify(generatedWorldbook, null, 2)}\n\n`;
        }

        prompt += `阅读内容：\n---\n${memory.content}\n---\n\n请基于内容更新世界书，直接输出JSON。`;

        console.log(`=== 修复记忆 第${index + 1}步 ===`);

        const response = await callAPI(prompt);
        let memoryUpdate;

        try {
            memoryUpdate = JSON.parse(response);
        } catch (jsonError) {
            let cleanResponse = response.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '');
            const firstBrace = cleanResponse.indexOf('{');
            const lastBrace = cleanResponse.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                cleanResponse = cleanResponse.substring(firstBrace, lastBrace + 1);
            }

            try {
                memoryUpdate = JSON.parse(cleanResponse);
            } catch (secondError) {
                const openBraces = (cleanResponse.match(/{/g) || []).length;
                const closeBraces = (cleanResponse.match(/}/g) || []).length;
                if (openBraces > closeBraces) {
                    try {
                        memoryUpdate = JSON.parse(cleanResponse + '}'.repeat(openBraces - closeBraces));
                    } catch (e) {
                        const regexData = extractWorldbookDataByRegex(cleanResponse);
                        if (regexData && Object.keys(regexData).length > 0) {
                            memoryUpdate = regexData;
                        } else {
                            throw new Error(`JSON解析失败: ${secondError.message}`);
                        }
                    }
                } else {
                    const regexData = extractWorldbookDataByRegex(cleanResponse);
                    if (regexData && Object.keys(regexData).length > 0) {
                        memoryUpdate = regexData;
                    } else {
                        throw new Error(`JSON解析失败: ${secondError.message}`);
                    }
                }
            }
        }

        const memoryTitle = `记忆-修复-${memory.title}`;
        await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memoryTitle);
        console.log(`记忆块 ${index + 1} 修复完成`);
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
            console.log(`✅ 修复成功: ${memory.title}`);
            updateMemoryQueueUI();
            await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            const errorMsg = error.message || '';
            const isTokenLimitError = errorMsg.includes('max_prompt_tokens') ||
                                       errorMsg.includes('exceeded') ||
                                       errorMsg.includes('input tokens') ||
                                       errorMsg.includes('context_length') ||
                                       (errorMsg.includes('20015') && errorMsg.includes('limit'));

            if (isTokenLimitError) {
                // 分卷模式：开新卷
                if (useVolumeMode) {
                    console.log(`📦 分卷模式：开启新卷继续修复`);
                    startNewVolume();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await repairMemoryWithSplit(memoryIndex, stats);
                    return;
                }

                console.log(`⚠️ 检测到token超限错误，分裂当前记忆: ${memory.title}`);
                updateProgress((memoryIndex / memoryQueue.length) * 100, `🔀 正在分裂记忆: ${memory.title}`);

                const splitResult = splitMemoryIntoTwo(memoryIndex);
                if (splitResult) {
                    console.log(`✅ 记忆分裂成功`);
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
                    console.error(`❌ 记忆分裂失败: ${memory.title}`);
                }
            } else {
                stats.stillFailedCount++;
                memory.failedError = error.message;
                console.error(`❌ 修复失败: ${memory.title}`, error);
                updateMemoryQueueUI();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async function startRepairFailedMemories() {
        const failedMemories = memoryQueue.filter(m => m.failed === true);
        if (failedMemories.length === 0) {
            alert('没有需要修复的记忆');
            return;
        }

        isRepairingMemories = true;
        console.log(`🔧 开始一键修复 ${failedMemories.length} 个失败的记忆...`);

        showProgressSection(true);
        updateProgress(0, `正在修复失败的记忆 (0/${failedMemories.length})`);

        const stats = {
            successCount: 0,
            stillFailedCount: 0
        };

        for (let i = 0; i < failedMemories.length; i++) {
            const memory = failedMemories[i];
            const memoryIndex = memoryQueue.indexOf(memory);

            if (memoryIndex === -1) continue;

            updateProgress(((i + 1) / failedMemories.length) * 100, `正在修复: ${memory.title}`);

            await repairMemoryWithSplit(memoryIndex, stats);
        }

        failedMemoryQueue = failedMemoryQueue.filter(item => {
            const memory = memoryQueue[item.index];
            return memory && memory.failed === true;
        });

        updateProgress(100, `修复完成: 成功 ${stats.successCount} 个, 仍失败 ${stats.stillFailedCount} 个`);

        await MemoryHistoryDB.saveState(memoryQueue.length);

        isRepairingMemories = false;
        console.log(`🔧 修复模式结束`);

        if (stats.stillFailedCount > 0) {
            alert(`修复完成！\n成功: ${stats.successCount} 个\n仍失败: ${stats.stillFailedCount} 个\n\n失败的记忆仍显示❗，可继续点击修复。`);
        } else {
            alert(`全部修复成功！共修复 ${stats.successCount} 个记忆块。`);
        }

        updateMemoryQueueUI();
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

                    const cleanKeywords = keywords.map(keyword => {
                        const keywordStr = String(keyword).trim();
                        return keywordStr.replace(/[-_\s]+/g, '');
                    }).filter(keyword =>
                        keyword.length > 0 &&
                        keyword.length <= 20 &&
                        !['的', '了', '在', '是', '有', '和', '与', '或', '但'].includes(keyword)
                    );

                    if (cleanKeywords.length === 0) {
                        cleanKeywords.push(itemName);
                    }

                    const uniqueKeywords = [...new Set(cleanKeywords)];

                    let content = String(itemData.内容).trim();

                    entries.push({
                        uid: entryId++,
                        key: uniqueKeywords,
                        keysecondary: [],
                        comment: `${category} - ${itemName}`,
                        content: content,
                        constant,
                        selective,
                        selectiveLogic: 0,
                        addMemo: true,
                        order: entryId * 100,
                        position: 0,
                        disable: false,
                        excludeRecursion: false,
                        preventRecursion: false,
                        delayUntilRecursion: false,
                        probability: 100,
                        depth: 4,
                        group: category,
                        groupOverride: false,
                        groupWeight: 100,
                        scanDepth: null,
                        caseSensitive: false,
                        matchWholeWords: true,
                        useGroupScoring: null,
                        automationId: '',
                        role: 0,
                        vectorized: false,
                        sticky: null,
                        cooldown: null,
                        delay: null
                    });
                }
            }
        }

        if (entries.length === 0) {
            entries.push({
                uid: 0,
                key: ['默认条目'],
                keysecondary: [],
                comment: '世界书转换时生成的默认条目',
                content: '这是一个从小说自动生成的世界书条目。',
                constant: false,
                selective: true,
                selectiveLogic: 0,
                addMemo: true,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: false,
                preventRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                depth: 4,
                group: '默认',
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: false,
                matchWholeWords: true,
                useGroupScoring: null,
                automationId: '',
                role: 0,
                vectorized: false,
                sticky: null,
                cooldown: null,
                delay: null
            });
        }

        return {
            entries: entries,
            originalData: {
                name: '小说转换的世界书',
                description: '由TXT转世界书功能生成',
                version: 1,
                author: 'TxtToWorldbook',
                tags: ['小说', 'AI生成', '世界书'],
                source: 'TxtToWorldbook'
            }
        };
    }

    function exportWorldbook() {
        const timeString = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).replace(/[:/\s]/g, '').replace(/,/g, '-');

        let fileName = '转换数据';
        if (currentFile && currentFile.name) {
            const baseName = currentFile.name.replace(/\.[^/.]+$/, '');
            fileName = `${baseName}-世界书生成数据-${timeString}`;
        } else {
            fileName = `转换数据-${timeString}`;
        }

        // 分卷模式下导出所有卷
        const exportData = useVolumeMode ? {
            volumes: worldbookVolumes,
            currentVolume: generatedWorldbook,
            merged: getAllVolumesWorldbook()
        } : generatedWorldbook;

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName + '.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportToSillyTavern() {
        const timeString = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).replace(/[:/\s]/g, '').replace(/,/g, '-');

        try {
            // 分卷模式下使用合并后的世界书
            const worldbookToExport = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
            const sillyTavernWorldbook = convertToSillyTavernFormat(worldbookToExport);

            let fileName = '酒馆书';
            if (currentFile && currentFile.name) {
                const baseName = currentFile.name.replace(/\.[^/.]+$/, '');
                fileName = `${baseName}-世界书参考-${timeString}`;
            } else {
                fileName = `酒馆书-${timeString}`;
            }

            const blob = new Blob([JSON.stringify(sillyTavernWorldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName + '.json';
            a.click();
            URL.revokeObjectURL(url);

            const volumeInfo = useVolumeMode ? `\n\n共${worldbookVolumes.length}卷已合并导出。` : '';
            alert(`世界书已转换为SillyTavern格式并下载${volumeInfo}\n请在SillyTavern中手动导入该文件。`);
        } catch (error) {
            console.error('转换为SillyTavern格式失败:', error);
            alert('转换失败：' + error.message);
        }
    }

    // ========== 新增：导出各卷 ==========
    function exportVolumes() {
        if (worldbookVolumes.length === 0) {
            alert('没有分卷数据可导出');
            return;
        }

        const timeString = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).replace(/[:/\s]/g, '').replace(/,/g, '-');

        for (let i = 0; i < worldbookVolumes.length; i++) {
            const volume = worldbookVolumes[i];
            const fileName = currentFile
                ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-世界书-卷${i + 1}-${timeString}.json`
                : `世界书-卷${i + 1}-${timeString}.json`;

            const blob = new Blob([JSON.stringify(volume.worldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        }

        alert(`已导出 ${worldbookVolumes.length} 卷世界书`);
    }

    // ========== 获取系统提示词 ==========
    function getSystemPrompt() {
        const worldbookPrompt = settings.customWorldbookPrompt?.trim() || defaultWorldbookPrompt;

        const additionalParts = [];

        if (settings.enablePlotOutline) {
            const plotPrompt = settings.customPlotPrompt?.trim() || defaultPlotPrompt;
            additionalParts.push(plotPrompt);
        }

        if (settings.enableLiteraryStyle) {
            const stylePrompt = settings.customStylePrompt?.trim() || defaultStylePrompt;
            additionalParts.push(stylePrompt);
        }

        if (additionalParts.length === 0) {
            return worldbookPrompt;
        }

        let fullPrompt = worldbookPrompt;
        const insertContent = ',\n' + additionalParts.join(',\n');
        fullPrompt = fullPrompt.replace(
            /(\}\s*)\n\`\`\`/,
            `${insertContent}\n$1\n\`\`\``
        );

        return fullPrompt;
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
                    <span class="ttw-modal-title">❓ TXT转世界书 使用帮助</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 70vh; overflow-y: auto;">
                    <div class="ttw-help-section">
                        <h4 style="color: #e67e22; margin: 0 0 10px 0;">📌 基本功能</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            将TXT格式的小说文本转换为SillyTavern世界书格式，自动提取角色、地点、组织等信息。
                        </p>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #3498db; margin: 0 0 10px 0;">⚙️ API设置</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            <strong>本工具使用酒馆当前配置的API预设</strong>，无需额外配置API。请确保酒馆已正确配置并能正常对话。
                        </p>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #9b59b6; margin: 0 0 10px 0;">📦 分卷模式（新功能）</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            开启后，当上下文超限时会<strong>自动开启新卷</strong>，而不是分裂记忆块。这样可以：
                        </p>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li>避免记忆块无限分裂</li>
                            <li>每卷独立处理，不累积上下文</li>
                            <li>生成后可以手动合并或分别使用</li>
                            <li>适合超长小说（百万字以上）</li>
                        </ul>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #e74c3c; margin: 0 0 10px 0;">🔀 自动分裂机制</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            关闭分卷模式时，检测到Token超限会<strong>只分裂当前失败的记忆块</strong>。
                        </p>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #1abc9c; margin: 0 0 10px 0;">💡 使用技巧</h4>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li>超长小说建议开启分卷模式</li>
                            <li>每卷生成后可以导出再压缩</li>
                            <li>处理中途可以暂停，刷新后继续</li>
                        </ul>
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
        helpModal.addEventListener('click', (e) => {
            if (e.target === helpModal) helpModal.remove();
        });
    }

    // ========== UI 相关 ==========
    let modalContainer = null;

    function createModal() {
        if (modalContainer) {
            modalContainer.remove();
        }

        modalContainer = document.createElement('div');
        modalContainer.id = 'txt-to-worldbook-modal';
        modalContainer.className = 'ttw-modal-container';
        modalContainer.innerHTML = `
            <div class="ttw-modal">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📚 TXT转世界书 v2.1</span>
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
                            <div class="ttw-api-notice">
                                <div style="color: #27ae60; font-weight: bold; margin-bottom: 8px;">✅ 使用酒馆预设</div>
                                <div style="color: #aaa; font-size: 12px;">本工具直接使用酒馆当前配置的API和预设，无需额外配置。</div>
                            </div>
                            <div class="ttw-setting-item">
                                <label>每块字数</label>
                                <input type="number" id="ttw-chunk-size" value="100000" min="1000" max="500000">
                            </div>
                            <div class="ttw-checkbox-group">
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-incremental-mode" checked>
                                    <span>📝 增量输出模式</span>
                                </label>
                                <label class="ttw-checkbox-label" style="background: rgba(155, 89, 182, 0.15); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(155, 89, 182, 0.3);">
                                    <input type="checkbox" id="ttw-volume-mode">
                                    <span>📦 分卷模式（超限时开新卷而非分裂）</span>
                                </label>
                            </div>
                            <!-- 分卷指示器 -->
                            <div id="ttw-volume-indicator" style="display: none; margin-top: 12px; padding: 8px 12px; background: rgba(155, 89, 182, 0.2); border-radius: 6px; font-size: 12px; color: #bb86fc;">
                                当前: 第1卷 | 已完成: 0卷
                            </div>
                            <!-- 提示词配置区域 -->
                            <div class="ttw-prompt-config">
                                <div class="ttw-prompt-config-header">
                                    <span>📝 提示词配置</span>
                                    <button id="ttw-preview-prompt" class="ttw-btn ttw-btn-small">👁️ 预览</button>
                                </div>

                                <!-- 世界书词条 -->
                                <div class="ttw-prompt-section ttw-prompt-worldbook">
                                    <div class="ttw-prompt-header" data-target="ttw-worldbook-content">
                                        <div class="ttw-prompt-header-left">
                                            <span class="ttw-prompt-icon">📚</span>
                                            <span class="ttw-prompt-title">世界书词条</span>
                                            <span class="ttw-prompt-badge ttw-badge-required">必需</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div class="ttw-prompt-content" id="ttw-worldbook-content" style="display: none;">
                                        <div class="ttw-prompt-hint">核心提示词。留空使用默认。</div>
                                        <textarea id="ttw-worldbook-prompt" rows="6" placeholder="留空使用默认提示词..."></textarea>
                                        <div class="ttw-prompt-actions">
                                            <button class="ttw-btn ttw-btn-small ttw-reset-prompt" data-type="worldbook">🔄 恢复默认</button>
                                        </div>
                                    </div>
                                </div>

                                <!-- 剧情大纲 -->
                                <div class="ttw-prompt-section ttw-prompt-plot">
                                    <div class="ttw-prompt-header" data-target="ttw-plot-content">
                                        <div class="ttw-prompt-header-left">
                                            <label class="ttw-prompt-enable-label">
                                                <input type="checkbox" id="ttw-enable-plot">
                                                <span class="ttw-prompt-icon">📖</span>
                                                <span class="ttw-prompt-title">剧情大纲</span>
                                            </label>
                                            <span class="ttw-prompt-badge ttw-badge-optional">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div class="ttw-prompt-content" id="ttw-plot-content" style="display: none;">
                                        <textarea id="ttw-plot-prompt" rows="4" placeholder="留空使用默认提示词..."></textarea>
                                        <div class="ttw-prompt-actions">
                                            <button class="ttw-btn ttw-btn-small ttw-reset-prompt" data-type="plot">🔄 恢复默认</button>
                                        </div>
                                    </div>
                                </div>

                                <!-- 文风配置 -->
                                <div class="ttw-prompt-section ttw-prompt-style">
                                    <div class="ttw-prompt-header" data-target="ttw-style-content">
                                        <div class="ttw-prompt-header-left">
                                            <label class="ttw-prompt-enable-label">
                                                <input type="checkbox" id="ttw-enable-style">
                                                <span class="ttw-prompt-icon">🎨</span>
                                                <span class="ttw-prompt-title">文风配置</span>
                                            </label>
                                            <span class="ttw-prompt-badge ttw-badge-optional">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div class="ttw-prompt-content" id="ttw-style-content" style="display: none;">
                                        <textarea id="ttw-style-prompt" rows="4" placeholder="留空使用默认提示词..."></textarea>
                                        <div class="ttw-prompt-actions">
                                            <button class="ttw-btn ttw-btn-small ttw-reset-prompt" data-type="style">🔄 恢复默认</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 文件上传区域 -->
                    <div class="ttw-section ttw-upload-section">
                        <div class="ttw-section-header">
                            <span>📄 文件上传</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-upload-area" id="ttw-upload-area">
                                <div class="ttw-upload-icon">📁</div>
                                <div class="ttw-upload-text">点击或拖拽TXT文件到此处</div>
                                <input type="file" id="ttw-file-input" accept=".txt" style="display: none;">
                            </div>
                            <div class="ttw-file-info" id="ttw-file-info" style="display: none;">
                                <span id="ttw-file-name"></span>
                                <span id="ttw-file-size"></span>
                                <button id="ttw-clear-file" class="ttw-btn-small">清除</button>
                            </div>
                        </div>
                    </div>

                    <!-- 记忆队列区域 -->
                    <div class="ttw-section ttw-queue-section" id="ttw-queue-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>📋 记忆队列</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-memory-queue" id="ttw-memory-queue"></div>
                        </div>
                    </div>

                    <!-- 进度区域 -->
                    <div class="ttw-section ttw-progress-section" id="ttw-progress-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>⏳ 处理进度</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-progress-bar">
                                <div class="ttw-progress-fill" id="ttw-progress-fill"></div>
                            </div>
                            <div class="ttw-progress-text" id="ttw-progress-text">准备中...</div>
                            <div class="ttw-progress-controls" id="ttw-progress-controls">
                                <button id="ttw-stop-btn" class="ttw-btn ttw-btn-secondary">⏸️ 暂停</button>
                                <button id="ttw-repair-btn" class="ttw-btn ttw-btn-warning" style="display: none;">🔧 修复失败</button>
                                <button id="ttw-toggle-stream" class="ttw-btn ttw-btn-small">👁️ 查看实时输出</button>
                            </div>
                            <!-- 实时输出显示区域 -->
                            <div class="ttw-stream-container" id="ttw-stream-container" style="display: none;">
                                <div class="ttw-stream-header">
                                    <span>📤 实时输出</span>
                                    <button id="ttw-clear-stream" class="ttw-btn-small">清空</button>
                                </div>
                                <pre class="ttw-stream-content" id="ttw-stream-content"></pre>
                            </div>
                        </div>
                    </div>

                    <!-- 结果区域 -->
                    <div class="ttw-section ttw-result-section" id="ttw-result-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>📊 生成结果</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-result-preview" id="ttw-result-preview"></div>
                            <div class="ttw-result-actions">
                                <button id="ttw-view-worldbook" class="ttw-btn">📖 查看世界书</button>
                                <button id="ttw-view-history" class="ttw-btn">📜 修改历史</button>
                                <button id="ttw-export-json" class="ttw-btn">📥 导出JSON</button>
                                <button id="ttw-export-volumes" class="ttw-btn" style="display: none;">📦 分卷导出</button>
                                <button id="ttw-export-st" class="ttw-btn ttw-btn-primary">📥 导出SillyTavern格式</button>
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
            .ttw-modal-container {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 99999;
                padding: 20px;
                box-sizing: border-box;
            }

            .ttw-modal {
                background: var(--SmartThemeBlurTintColor, #1e1e2e);
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 12px;
                width: 100%;
                max-width: 700px;
                max-height: calc(100vh - 40px);
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                overflow: hidden;
            }

            .ttw-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
                background: rgba(0, 0, 0, 0.2);
            }

            .ttw-modal-title {
                font-weight: bold;
                font-size: 16px;
                color: #e67e22;
            }

            .ttw-header-actions {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .ttw-help-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: rgba(231, 76, 60, 0.2);
                color: #e74c3c;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.2s;
                border: 1px solid rgba(231, 76, 60, 0.4);
            }

            .ttw-help-btn:hover {
                background: rgba(231, 76, 60, 0.4);
                transform: scale(1.1);
            }

            .ttw-modal-close {
                background: rgba(255, 255, 255, 0.1);
                border: none;
                color: #fff;
                font-size: 18px;
                width: 36px;
                height: 36px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-modal-close:hover {
                background: rgba(255, 100, 100, 0.3);
                color: #ff6b6b;
            }

            .ttw-modal-body {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
            }

            .ttw-modal-footer {
                padding: 16px 20px;
                border-top: 1px solid var(--SmartThemeBorderColor, #444);
                background: rgba(0, 0, 0, 0.2);
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }

            .ttw-section {
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                margin-bottom: 12px;
                overflow: hidden;
            }

            .ttw-section-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: rgba(0, 0, 0, 0.3);
                cursor: pointer;
                font-weight: bold;
                font-size: 14px;
            }

            .ttw-section-content {
                padding: 16px;
            }

            .ttw-collapse-icon {
                font-size: 10px;
                transition: transform 0.2s;
            }

            .ttw-section.collapsed .ttw-collapse-icon {
                transform: rotate(-90deg);
            }

            .ttw-section.collapsed .ttw-section-content {
                display: none;
            }

            .ttw-api-notice {
                background: rgba(39, 174, 96, 0.1);
                border: 1px solid rgba(39, 174, 96, 0.3);
                border-radius: 8px;
                padding: 12px;
                margin-bottom: 16px;
            }

            .ttw-setting-item {
                margin-bottom: 12px;
            }

            .ttw-setting-item > label {
                display: block;
                margin-bottom: 6px;
                font-size: 12px;
                opacity: 0.9;
            }

            .ttw-setting-item input,
            .ttw-setting-item select {
                width: 100%;
                padding: 10px 12px;
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 6px;
                background: rgba(0, 0, 0, 0.3);
                color: #fff;
                font-size: 13px;
                box-sizing: border-box;
            }

            .ttw-checkbox-group {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 12px;
            }

            .ttw-checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                font-size: 13px;
            }

            .ttw-checkbox-label input {
                width: 18px;
                height: 18px;
                accent-color: #e67e22;
            }

            .ttw-prompt-config {
                margin-top: 16px;
                border: 1px solid var(--SmartThemeBorderColor, #444);
                border-radius: 8px;
                overflow: hidden;
            }

            .ttw-prompt-config-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 14px;
                background: rgba(230, 126, 34, 0.15);
                border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
                font-weight: 500;
            }

            .ttw-prompt-section {
                border-bottom: 1px solid var(--SmartThemeBorderColor, #333);
            }

            .ttw-prompt-section:last-child {
                border-bottom: none;
            }

            .ttw-prompt-worldbook .ttw-prompt-header {
                background: rgba(52, 152, 219, 0.1);
            }

            .ttw-prompt-plot .ttw-prompt-header {
                background: rgba(155, 89, 182, 0.1);
            }

            .ttw-prompt-style .ttw-prompt-header {
                background: rgba(46, 204, 113, 0.1);
            }

            .ttw-prompt-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px;
                cursor: pointer;
                font-size: 13px;
                transition: background 0.2s;
            }

            .ttw-prompt-header:hover {
                filter: brightness(1.1);
            }

            .ttw-prompt-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .ttw-prompt-enable-label {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
            }

            .ttw-prompt-enable-label input {
                width: 16px;
                height: 16px;
                accent-color: #e67e22;
                cursor: pointer;
            }

            .ttw-prompt-icon {
                font-size: 14px;
            }

            .ttw-prompt-title {
                font-weight: 500;
            }

            .ttw-prompt-badge {
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 10px;
                font-weight: 500;
            }

            .ttw-badge-required {
                background: rgba(52, 152, 219, 0.3);
                color: #5dade2;
            }

            .ttw-badge-optional {
                background: rgba(149, 165, 166, 0.3);
                color: #bdc3c7;
            }

            .ttw-prompt-content {
                padding: 12px 14px;
                background: rgba(0, 0, 0, 0.15);
            }

            .ttw-prompt-hint {
                font-size: 11px;
                color: #888;
                margin-bottom: 10px;
            }

            .ttw-prompt-config textarea {
                width: 100%;
                min-height: 80px;
                padding: 10px;
                border: 1px solid var(--SmartThemeBorderColor, #444);
                border-radius: 4px;
                background: var(--SmartThemeBlurTintColor, #1e1e2e);
                color: inherit;
                font-family: monospace;
                font-size: 12px;
                line-height: 1.5;
                resize: vertical;
                box-sizing: border-box;
            }

            .ttw-prompt-config textarea:focus {
                outline: none;
                border-color: #e67e22;
            }

            .ttw-prompt-actions {
                display: flex;
                gap: 8px;
                margin-top: 8px;
            }

            .ttw-upload-area {
                border: 2px dashed var(--SmartThemeBorderColor, #555);
                border-radius: 8px;
                padding: 40px 20px;
                text-align: center;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-upload-area:hover {
                border-color: #e67e22;
                background: rgba(230, 126, 34, 0.1);
            }

            .ttw-upload-area.dragover {
                border-color: #e67e22;
                background: rgba(230, 126, 34, 0.2);
            }

            .ttw-upload-icon {
                font-size: 48px;
                margin-bottom: 12px;
            }

            .ttw-upload-text {
                font-size: 14px;
                opacity: 0.8;
            }

            .ttw-file-info {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 6px;
                margin-top: 12px;
            }

            .ttw-memory-queue {
                max-height: 200px;
                overflow-y: auto;
            }

            .ttw-memory-item {
                padding: 8px 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 4px;
                margin-bottom: 6px;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .ttw-memory-item.processed {
                opacity: 0.6;
            }

            .ttw-memory-item.failed {
                border-left: 3px solid #e74c3c;
            }

            .ttw-progress-bar {
                width: 100%;
                height: 8px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 4px;
                overflow: hidden;
                margin-bottom: 12px;
            }

            .ttw-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #e67e22, #f39c12);
                border-radius: 4px;
                transition: width 0.3s;
                width: 0%;
            }

            .ttw-progress-text {
                font-size: 13px;
                text-align: center;
                margin-bottom: 12px;
            }

            .ttw-progress-controls {
                display: flex;
                gap: 10px;
                justify-content: center;
                flex-wrap: wrap;
            }

            .ttw-stream-container {
                margin-top: 12px;
                border: 1px solid var(--SmartThemeBorderColor, #444);
                border-radius: 6px;
                overflow: hidden;
            }

            .ttw-stream-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px;
                background: rgba(0, 0, 0, 0.3);
                font-size: 12px;
            }

            .ttw-stream-content {
                max-height: 200px;
                overflow-y: auto;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                font-size: 11px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-all;
                margin: 0;
                font-family: monospace;
            }

            .ttw-result-preview {
                max-height: 300px;
                overflow-y: auto;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 6px;
                padding: 12px;
                margin-bottom: 12px;
                font-size: 12px;
            }

            .ttw-result-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }

            .ttw-btn {
                padding: 10px 16px;
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-btn:hover {
                background: rgba(255, 255, 255, 0.2);
            }

            .ttw-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .ttw-btn-primary {
                background: linear-gradient(135deg, #e67e22, #d35400);
                border-color: #e67e22;
            }

            .ttw-btn-primary:hover {
                background: linear-gradient(135deg, #f39c12, #e67e22);
            }

            .ttw-btn-secondary {
                background: rgba(108, 117, 125, 0.5);
            }

            .ttw-btn-warning {
                background: rgba(255, 107, 53, 0.5);
                border-color: #ff6b35;
            }

            .ttw-btn-small {
                padding: 6px 12px;
                font-size: 12px;
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-btn-small:hover {
                background: rgba(255, 255, 255, 0.2);
            }

            .ttw-category-card {
                margin-bottom: 12px;
                border: 1px solid #e67e22;
                border-radius: 8px;
                overflow: hidden;
            }

            .ttw-category-header {
                background: linear-gradient(135deg, #e67e22, #d35400);
                padding: 10px 14px;
                cursor: pointer;
                font-weight: bold;
                font-size: 14px;
                display: flex;
                justify-content: space-between;
            }

            .ttw-category-content {
                background: #2d2d2d;
                display: none;
            }

            .ttw-entry-card {
                margin: 8px;
                border: 1px solid #555;
                border-radius: 6px;
                overflow: hidden;
            }

            .ttw-entry-header {
                background: #3a3a3a;
                padding: 8px 12px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                border-left: 3px solid #3498db;
            }

            .ttw-entry-content {
                display: none;
                background: #1c1c1c;
                padding: 12px;
            }

            .ttw-keywords {
                margin-bottom: 8px;
                padding: 8px;
                background: #252525;
                border-left: 3px solid #9b59b6;
                border-radius: 4px;
            }

            .ttw-content-text {
                padding: 8px;
                background: #252525;
                border-left: 3px solid #27ae60;
                border-radius: 4px;
                line-height: 1.6;
            }
        `;

        document.head.appendChild(styles);
    }

    function bindModalEvents() {
        const modal = modalContainer.querySelector('.ttw-modal');
        modal.addEventListener('click', (e) => e.stopPropagation(), false);
        modal.addEventListener('mousedown', (e) => e.stopPropagation(), false);

        modalContainer.querySelector('.ttw-modal-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeModal();
        }, false);

        modalContainer.querySelector('.ttw-help-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showHelpModal();
        }, false);

        modalContainer.addEventListener('click', (e) => {
            if (e.target === modalContainer) {
                closeModal();
            }
        }, false);

        document.addEventListener('keydown', handleEscKey, true);

        ['ttw-chunk-size'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });

        ['ttw-incremental-mode', 'ttw-volume-mode', 'ttw-enable-plot', 'ttw-enable-style'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });

        // 分卷模式切换时更新UI
        document.getElementById('ttw-volume-mode').addEventListener('change', (e) => {
            useVolumeMode = e.target.checked;
            const indicator = document.getElementById('ttw-volume-indicator');
            if (indicator) {
                indicator.style.display = useVolumeMode ? 'block' : 'none';
            }
        });

        document.querySelectorAll('.ttw-prompt-header[data-target]').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const targetId = header.getAttribute('data-target');
                const content = document.getElementById(targetId);
                const icon = header.querySelector('.ttw-collapse-icon');
                if (content.style.display === 'none') {
                    content.style.display = 'block';
                    icon.textContent = '▼';
                } else {
                    content.style.display = 'none';
                    icon.textContent = '▶';
                }
            });
        });

        ['ttw-worldbook-prompt', 'ttw-plot-prompt', 'ttw-style-prompt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', saveCurrentSettings);
        });

        document.querySelectorAll('.ttw-reset-prompt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = btn.getAttribute('data-type');
                const textareaId = `ttw-${type}-prompt`;
                const textarea = document.getElementById(textareaId);
                if (textarea) {
                    textarea.value = '';
                    saveCurrentSettings();
                }
            });
        });

        document.getElementById('ttw-preview-prompt').addEventListener('click', showPromptPreview);

        // 文件上传
        const uploadArea = document.getElementById('ttw-upload-area');
        const fileInput = document.getElementById('ttw-file-input');

        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                handleFileSelect(e.dataTransfer.files[0]);
            }
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileSelect(e.target.files[0]);
            }
        });

        document.getElementById('ttw-clear-file').addEventListener('click', clearFile);
        document.getElementById('ttw-start-btn').addEventListener('click', startConversion);
        document.getElementById('ttw-stop-btn').addEventListener('click', () => {
            isProcessingStopped = true;
        });
        document.getElementById('ttw-repair-btn').addEventListener('click', startRepairFailedMemories);

        // 实时输出切换
        document.getElementById('ttw-toggle-stream').addEventListener('click', () => {
            const container = document.getElementById('ttw-stream-container');
            container.style.display = container.style.display === 'none' ? 'block' : 'none';
        });

        document.getElementById('ttw-clear-stream').addEventListener('click', () => {
            updateStreamContent('', true);
        });

        document.getElementById('ttw-view-worldbook').addEventListener('click', showWorldbookView);
        document.getElementById('ttw-view-history').addEventListener('click', showHistoryView);
        document.getElementById('ttw-export-json').addEventListener('click', exportWorldbook);
        document.getElementById('ttw-export-volumes').addEventListener('click', exportVolumes);
        document.getElementById('ttw-export-st').addEventListener('click', exportToSillyTavern);

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
        incrementalOutputMode = document.getElementById('ttw-incremental-mode').checked;
        useVolumeMode = document.getElementById('ttw-volume-mode').checked;
        settings.useVolumeMode = useVolumeMode;
        settings.enablePlotOutline = document.getElementById('ttw-enable-plot').checked;
        settings.enableLiteraryStyle = document.getElementById('ttw-enable-style').checked;
        settings.customWorldbookPrompt = document.getElementById('ttw-worldbook-prompt').value;
        settings.customPlotPrompt = document.getElementById('ttw-plot-prompt').value;
        settings.customStylePrompt = document.getElementById('ttw-style-prompt').value;

        try {
            localStorage.setItem('txtToWorldbookSettings', JSON.stringify(settings));
        } catch (e) {
            console.error('保存设置失败:', e);
        }
    }

    function loadSavedSettings() {
        try {
            const saved = localStorage.getItem('txtToWorldbookSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                settings = { ...defaultSettings, ...parsed };
                useVolumeMode = settings.useVolumeMode || false;
            }
        } catch (e) {
            console.error('加载设置失败:', e);
        }

        document.getElementById('ttw-chunk-size').value = settings.chunkSize;
        document.getElementById('ttw-incremental-mode').checked = incrementalOutputMode;
        document.getElementById('ttw-volume-mode').checked = useVolumeMode;
        document.getElementById('ttw-enable-plot').checked = settings.enablePlotOutline;
        document.getElementById('ttw-enable-style').checked = settings.enableLiteraryStyle;
        document.getElementById('ttw-worldbook-prompt').value = settings.customWorldbookPrompt || '';
        document.getElementById('ttw-plot-prompt').value = settings.customPlotPrompt || '';
        document.getElementById('ttw-style-prompt').value = settings.customStylePrompt || '';

        // 更新分卷指示器显示
        const indicator = document.getElementById('ttw-volume-indicator');
        if (indicator) {
            indicator.style.display = useVolumeMode ? 'block' : 'none';
        }
    }

    function showPromptPreview() {
        const prompt = getSystemPrompt();

        const statusItems = [
            `📚 世界书词条: ${settings.customWorldbookPrompt?.trim() ? '自定义' : '默认'}`,
            `📖 剧情大纲: ${settings.enablePlotOutline ? (settings.customPlotPrompt?.trim() ? '✅ 启用 (自定义)' : '✅ 启用 (默认)') : '❌ 禁用'}`,
            `🎨 文风配置: ${settings.enableLiteraryStyle ? (settings.customStylePrompt?.trim() ? '✅ 启用 (自定义)' : '✅ 启用 (默认)') : '❌ 禁用'}`,
            `📦 分卷模式: ${useVolumeMode ? '✅ 启用' : '❌ 禁用'}`
        ];

        const previewModal = document.createElement('div');
        previewModal.className = 'ttw-modal-container';
        previewModal.id = 'ttw-prompt-preview-modal';
        previewModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 800px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">👁️ 最终提示词预览</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 70vh; overflow-y: auto;">
                    <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; padding: 10px; background: rgba(0,0,0,0.15); border-radius: 6px; font-size: 12px;">
                        ${statusItems.map(item => `<span style="padding: 4px 8px; background: rgba(0,0,0,0.2); border-radius: 4px;">${item}</span>`).join('')}
                    </div>
                    <pre style="white-space: pre-wrap; word-wrap: break-word; font-size: 12px; line-height: 1.5; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; max-height: 50vh; overflow-y: auto;">${prompt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-primary ttw-close-preview">关闭</button>
                </div>
            </div>
        `;

        const modal = previewModal.querySelector('.ttw-modal');
        modal.addEventListener('click', (e) => e.stopPropagation(), false);

        previewModal.querySelector('.ttw-modal-close').addEventListener('click', () => previewModal.remove());
        previewModal.querySelector('.ttw-close-preview').addEventListener('click', () => previewModal.remove());
        previewModal.addEventListener('click', (e) => {
            if (e.target === previewModal) previewModal.remove();
        });

        document.body.appendChild(previewModal);
    }

    async function checkAndRestoreState() {
        try {
            const savedState = await MemoryHistoryDB.loadState();
            if (savedState && savedState.memoryQueue && savedState.memoryQueue.length > 0) {
                const shouldRestore = confirm(`检测到未完成的转换任务（${savedState.processedIndex}/${savedState.memoryQueue.length}）\n\n是否恢复？`);

                if (shouldRestore) {
                    memoryQueue = savedState.memoryQueue;
                    generatedWorldbook = savedState.generatedWorldbook || {};
                    worldbookVolumes = savedState.worldbookVolumes || [];
                    currentVolumeIndex = savedState.currentVolumeIndex || 0;
                    currentFileHash = savedState.fileHash;

                    showQueueSection(true);
                    updateMemoryQueueUI();

                    if (useVolumeMode) {
                        updateVolumeIndicator();
                    }

                    if (savedState.processedIndex >= savedState.memoryQueue.length) {
                        showResultSection(true);
                        updateWorldbookPreview();
                    } else {
                        document.getElementById('ttw-start-btn').disabled = false;
                        document.getElementById('ttw-start-btn').textContent = '▶️ 继续转换';
                    }
                } else {
                    await MemoryHistoryDB.clearState();
                }
            }
        } catch (e) {
            console.error('恢复状态失败:', e);
        }
    }

    async function handleFileSelect(file) {
        if (!file.name.endsWith('.txt')) {
            alert('请选择TXT文件');
            return;
        }

        try {
            const { encoding, content } = await detectBestEncoding(file);

            currentFile = file;

            const newHash = await calculateFileHash(content);
            const savedHash = await MemoryHistoryDB.getSavedFileHash();

            if (savedHash && savedHash !== newHash) {
                const historyList = await MemoryHistoryDB.getAllHistory();
                if (historyList.length > 0) {
                    const shouldClear = confirm(`检测到新文件，是否清空旧的历史记录？\n\n当前有 ${historyList.length} 条记录。`);
                    if (shouldClear) {
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

        } catch (error) {
            console.error('文件处理失败:', error);
            alert('文件处理失败: ' + error.message);
        }
    }

    function splitContentIntoMemory(content) {
        const chunkSize = settings.chunkSize;
        memoryQueue = [];

        const chapterRegex = /第[一二三四五六七八九十百千0-9]+[章节卷集回]/g;
        const chapters = [];
        const matches = [...content.matchAll(chapterRegex)];

        if (matches.length > 0) {
            for (let i = 0; i < matches.length; i++) {
                const startIndex = matches[i].index;
                const endIndex = i < matches.length - 1 ? matches[i + 1].index : content.length;
                chapters.push(content.slice(startIndex, endIndex));
            }

            let currentChunk = '';
            let chunkIndex = 1;

            for (const chapter of chapters) {
                if (currentChunk.length + chapter.length > chunkSize && currentChunk.length > 0) {
                    memoryQueue.push({
                        title: `记忆${chunkIndex}`,
                        content: currentChunk,
                        processed: false,
                        failed: false
                    });
                    currentChunk = '';
                    chunkIndex++;
                }
                currentChunk += chapter;
            }

            if (currentChunk.length > 0) {
                memoryQueue.push({
                    title: `记忆${chunkIndex}`,
                    content: currentChunk,
                    processed: false,
                    failed: false
                });
            }
        } else {
            for (let i = 0; i < content.length; i += chunkSize) {
                let endIndex = Math.min(i + chunkSize, content.length);

                if (endIndex < content.length) {
                    const paragraphBreak = content.lastIndexOf('\n\n', endIndex);
                    if (paragraphBreak > i) {
                        endIndex = paragraphBreak + 2;
                    }
                }

                memoryQueue.push({
                    title: `记忆${memoryQueue.length + 1}`,
                    content: content.slice(i, endIndex),
                    processed: false,
                    failed: false
                });

                i = endIndex - chunkSize;
            }
        }

        console.log(`文本已切分为 ${memoryQueue.length} 个记忆块`);
    }

    function clearFile() {
        currentFile = null;
        memoryQueue = [];
        generatedWorldbook = {};
        worldbookVolumes = [];
        currentVolumeIndex = 0;

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

        if (memoryQueue.length === 0) {
            alert('请先上传文件');
            return;
        }

        document.getElementById('ttw-start-btn').disabled = true;
        document.getElementById('ttw-start-btn').textContent = '转换中...';

        await startAIProcessing();

        document.getElementById('ttw-start-btn').textContent = '🚀 开始转换';
    }

    function showQueueSection(show) {
        document.getElementById('ttw-queue-section').style.display = show ? 'block' : 'none';
    }

    function showProgressSection(show) {
        document.getElementById('ttw-progress-section').style.display = show ? 'block' : 'none';
    }

    function showResultSection(show) {
        document.getElementById('ttw-result-section').style.display = show ? 'block' : 'none';

        // 分卷模式下显示分卷导出按钮
        const volumeExportBtn = document.getElementById('ttw-export-volumes');
        if (volumeExportBtn) {
            volumeExportBtn.style.display = (show && useVolumeMode && worldbookVolumes.length > 0) ? 'inline-block' : 'none';
        }
    }

    function updateProgress(percent, text) {
        document.getElementById('ttw-progress-fill').style.width = `${percent}%`;
        document.getElementById('ttw-progress-text').textContent = text;

        const failedCount = memoryQueue.filter(m => m.failed === true).length;
        const repairBtn = document.getElementById('ttw-repair-btn');
        if (failedCount > 0) {
            repairBtn.style.display = 'inline-block';
            repairBtn.textContent = `🔧 修复失败 (${failedCount})`;
        } else {
            repairBtn.style.display = 'none';
        }
    }

    function updateMemoryQueueUI() {
        const container = document.getElementById('ttw-memory-queue');
        container.innerHTML = '';

        memoryQueue.forEach((memory, index) => {
            const item = document.createElement('div');
            item.className = 'ttw-memory-item';
            if (memory.processed) item.classList.add('processed');
            if (memory.failed) item.classList.add('failed');

            let statusIcon = '⏳';
            if (memory.processed) statusIcon = '✅';
            if (memory.failed) statusIcon = '❗';

            item.innerHTML = `
                <span>${statusIcon}</span>
                <span>${memory.title}</span>
                <small>(${memory.content.length.toLocaleString()}字)</small>
                ${memory.failed && memory.failedError ? `<small style="color:#e74c3c;margin-left:8px;">${memory.failedError.substring(0, 30)}...</small>` : ''}
            `;
            container.appendChild(item);
        });
    }

    function updateWorldbookPreview() {
        const container = document.getElementById('ttw-result-preview');

        // 分卷模式显示合并后的世界书
        const worldbookToShow = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;

        let headerInfo = '';
        if (useVolumeMode && worldbookVolumes.length > 0) {
            headerInfo = `<div style="margin-bottom: 12px; padding: 10px; background: rgba(155, 89, 182, 0.2); border-radius: 6px; font-size: 12px; color: #bb86fc;">
                📦 分卷模式 | 共 ${worldbookVolumes.length} 卷 | 下方为合并视图
            </div>`;
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
            <div class="ttw-category-card" data-category="${category}">
                <div class="ttw-category-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                    <span>📁 ${category}</span>
                    <span style="font-size: 12px;">${entryCount} 条目</span>
                </div>
                <div class="ttw-category-content">`;

            if (typeof entries === 'object') {
                for (const entryName in entries) {
                    const entry = entries[entryName];

                    html += `
                    <div class="ttw-entry-card">
                        <div class="ttw-entry-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                            <span>📄 ${entryName}</span>
                            <span style="font-size: 11px;">▼</span>
                        </div>
                        <div class="ttw-entry-content">`;

                    if (entry && typeof entry === 'object') {
                        if (entry['关键词']) {
                            const keywords = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : entry['关键词'];
                            html += `
                            <div class="ttw-keywords">
                                <div style="color: #9b59b6; font-size: 11px; margin-bottom: 4px;">🔑 关键词</div>
                                <div style="font-size: 13px;">${keywords}</div>
                            </div>`;
                        }

                        if (entry['内容']) {
                            const content = String(entry['内容'])
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .replace(/\*\*(.+?)\*\*/g, '<strong style="color: #3498db;">$1</strong>')
                                .replace(/\n/g, '<br>');
                            html += `
                            <div class="ttw-content-text">
                                <div style="color: #27ae60; font-size: 11px; margin-bottom: 4px;">📝 内容</div>
                                <div style="font-size: 13px;">${content}</div>
                            </div>`;
                        }
                    }

                    html += `
                        </div>
                    </div>`;
                }
            }

            html += `
                </div>
            </div>`;
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
                    <span class="ttw-modal-title">📖 世界书详细视图${useVolumeMode ? ` (${worldbookVolumes.length}卷合并)` : ''}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    ${formatWorldbookAsCards(worldbookToShow)}
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-close-worldbook-view">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(viewModal);

        viewModal.querySelector('.ttw-modal-close').addEventListener('click', () => viewModal.remove());
        viewModal.querySelector('#ttw-close-worldbook-view').addEventListener('click', () => viewModal.remove());
        viewModal.addEventListener('click', (e) => {
            if (e.target === viewModal) viewModal.remove();
        });
    }

    async function showHistoryView() {
        const existingModal = document.getElementById('ttw-history-modal');
        if (existingModal) existingModal.remove();

        let historyList = [];
        try {
            await MemoryHistoryDB.cleanDuplicateHistory();
            historyList = await MemoryHistoryDB.getAllHistory();
        } catch (e) {
            console.error('获取历史记录失败:', e);
        }

        const historyModal = document.createElement('div');
        historyModal.id = 'ttw-history-modal';
        historyModal.className = 'ttw-modal-container';
        historyModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📜 修改历史 (${historyList.length}条)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display: flex; gap: 15px; height: 400px;">
                        <div style="width: 250px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">
                            ${generateHistoryListHTML(historyList)}
                        </div>
                        <div id="ttw-history-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 点击左侧历史记录查看详情</div>
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
        historyModal.querySelector('#ttw-clear-history').addEventListener('click', async () => {
            if (confirm('确定要清空所有历史记录吗？')) {
                await MemoryHistoryDB.clearAllHistory();
                historyModal.remove();
                showHistoryView();
            }
        });
        historyModal.addEventListener('click', (e) => {
            if (e.target === historyModal) historyModal.remove();
        });

        historyModal.querySelectorAll('.ttw-history-item').forEach(item => {
            item.addEventListener('click', async () => {
                const historyId = parseInt(item.dataset.historyId);
                await showHistoryDetail(historyId, historyModal);

                historyModal.querySelectorAll('.ttw-history-item').forEach(i => i.style.background = 'rgba(0,0,0,0.2)');
                item.style.background = 'rgba(0,0,0,0.4)';
            });
        });
    }

    function generateHistoryListHTML(historyList) {
        if (historyList.length === 0) {
            return '<div style="text-align: center; color: #888; padding: 20px;">暂无历史记录</div>';
        }

        const sortedList = [...historyList].sort((a, b) => b.timestamp - a.timestamp);

        let html = '';
        sortedList.forEach((history) => {
            const time = new Date(history.timestamp).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            const changeCount = history.changedEntries?.length || 0;
            const volumeInfo = history.volumeIndex !== undefined ? ` [卷${history.volumeIndex + 1}]` : '';

            html += `
            <div class="ttw-history-item" data-history-id="${history.id}" style="background: rgba(0,0,0,0.2); border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #9b59b6;">
                <div style="font-weight: bold; color: #e67e22; font-size: 13px; margin-bottom: 4px;">
                    📝 ${history.memoryTitle || `记忆块 ${history.memoryIndex + 1}`}${volumeInfo}
                </div>
                <div style="font-size: 11px; color: #888;">${time}</div>
                <div style="font-size: 11px; color: #aaa; margin-top: 4px;">共 ${changeCount} 项变更</div>
            </div>`;
        });

        return html;
    }

    async function showHistoryDetail(historyId, modal) {
        const detailContainer = modal.querySelector('#ttw-history-detail');
        const history = await MemoryHistoryDB.getHistoryById(historyId);

        if (!history) {
            detailContainer.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 40px;">找不到该历史记录</div>';
            return;
        }

        const time = new Date(history.timestamp).toLocaleString('zh-CN');
        const volumeInfo = history.volumeIndex !== undefined ? ` [第${history.volumeIndex + 1}卷]` : '';

        let html = `
        <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #444;">
            <h4 style="color: #e67e22; margin: 0 0 10px 0;">📝 ${history.memoryTitle || `记忆块 ${history.memoryIndex + 1}`}${volumeInfo}</h4>
            <div style="font-size: 12px; color: #888;">时间: ${time}</div>
            <div style="margin-top: 10px;">
                <button class="ttw-btn ttw-btn-warning ttw-btn-small" onclick="window.TxtToWorldbook._rollbackToHistory(${historyId})">⏪ 回退到此版本前</button>
            </div>
        </div>
        <div style="font-size: 14px; font-weight: bold; color: #9b59b6; margin-bottom: 10px;">变更内容 (${history.changedEntries?.length || 0}项)</div>
        `;

        if (history.changedEntries && history.changedEntries.length > 0) {
            history.changedEntries.forEach(change => {
                const typeIcon = change.type === 'add' ? '➕ 新增' : change.type === 'modify' ? '✏️ 修改' : '❌ 删除';
                const typeColor = change.type === 'add' ? '#27ae60' : change.type === 'modify' ? '#3498db' : '#e74c3c';

                html += `
                <div style="background: rgba(0,0,0,0.2); border-radius: 6px; padding: 12px; margin-bottom: 10px; border-left: 3px solid ${typeColor};">
                    <div style="margin-bottom: 8px;">
                        <span style="color: ${typeColor}; font-weight: bold;">${typeIcon}</span>
                        <span style="color: #e67e22; margin-left: 8px;">[${change.category}] ${change.entryName}</span>
                    </div>
                    <div style="font-size: 12px; color: #ccc; max-height: 100px; overflow-y: auto;">
                        ${change.newValue ? formatEntryForDisplay(change.newValue) : '<span style="color: #666;">无</span>'}
                    </div>
                </div>`;
            });
        } else {
            html += '<div style="color: #888; text-align: center; padding: 20px;">无变更记录</div>';
        }

        detailContainer.innerHTML = html;
    }

    function formatEntryForDisplay(entry) {
        if (!entry) return '';
        if (typeof entry === 'string') return entry.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

        let html = '';
        if (entry['关键词']) {
            const keywords = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : entry['关键词'];
            html += `<div style="color: #9b59b6; margin-bottom: 4px;"><strong>关键词:</strong> ${keywords}</div>`;
        }
        if (entry['内容']) {
            const content = String(entry['内容']).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            html += `<div><strong>内容:</strong> ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}</div>`;
        }
        return html || JSON.stringify(entry);
    }

    async function rollbackToHistory(historyId) {
        if (!confirm('确定要回退到此版本吗？\n\n回退后将刷新页面以确保状态正确。')) {
            return;
        }

        try {
            const history = await MemoryHistoryDB.rollbackToHistory(historyId);
            console.log(`📚 已回退到历史记录 #${historyId}: ${history.memoryTitle}`);

            const rollbackMemoryIndex = history.memoryIndex;

            for (let i = 0; i < memoryQueue.length; i++) {
                if (i < rollbackMemoryIndex) {
                    memoryQueue[i].processed = true;
                } else {
                    memoryQueue[i].processed = false;
                    memoryQueue[i].failed = false;
                }
            }

            await MemoryHistoryDB.saveState(rollbackMemoryIndex);

            alert(`回退成功！页面将刷新。`);
            location.reload();
        } catch (error) {
            console.error('回退失败:', error);
            alert('回退失败: ' + error.message);
        }
    }

    function closeModal() {
        if (modalContainer) {
            modalContainer.remove();
            modalContainer = null;
        }
        document.removeEventListener('keydown', handleEscKey, true);
    }

    function open() {
        createModal();
    }

    // ========== 公开 API ==========
    window.TxtToWorldbook = {
        open: open,
        close: closeModal,
        _rollbackToHistory: rollbackToHistory,
        getWorldbook: () => generatedWorldbook,
        getMemoryQueue: () => memoryQueue,
        getVolumes: () => worldbookVolumes,
        getAllVolumesWorldbook: getAllVolumesWorldbook
    };

    console.log('📚 TxtToWorldbook v2.1 已加载 (新增分卷模式)');
})();
