/**
 * TXT转世界书独立模块 v2.4.0
 * 新增: 记忆编辑/复制、重Roll功能、真正使用酒馆预设
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
    let memoryRollHistory = {}; // { memoryIndex: [ {result, timestamp}, ... ] }

    // ========== 并行处理配置 ==========
    let parallelConfig = {
        enabled: true,
        concurrency: 3,
        mode: 'independent'
    };

    // ========== 并行处理活跃任务追踪 ==========
    let activeParallelTasks = new Set();
    let parallelAbortController = null;

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
        useVolumeMode: false,
        apiTimeout: 120000,
        parallelEnabled: true,
        parallelConcurrency: 3,
        parallelMode: 'independent',
        useTavernPreset: false // 【新增】是否使用酒馆预设
    };

    let settings = { ...defaultSettings };

    // ========== 信号量类（控制并发）- 支持中断 ==========
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

    // 全局信号量实例
    let globalSemaphore = null;

    // ========== IndexedDB 持久化 ==========
    const MemoryHistoryDB = {
        dbName: 'TxtToWorldbookDB',
        storeName: 'history',
        metaStoreName: 'meta',
        stateStoreName: 'state',
        rollStoreName: 'rolls', // 【新增】存储重Roll历史
        db: null,

        async openDB() {
            if (this.db) return this.db;

            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 4); // 版本升级到4

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
                    // 【新增】Roll历史存储
                    if (!db.objectStoreNames.contains(this.rollStoreName)) {
                        const rollStore = db.createObjectStore(this.rollStoreName, { keyPath: 'id', autoIncrement: true });
                        rollStore.createIndex('memoryIndex', 'memoryIndex', { unique: false });
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

        // 【新增】保存Roll结果
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

        // 【新增】获取某个记忆的所有Roll结果
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

        // 【新增】清除某个记忆的Roll结果
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

    function isTokenLimitError(errorMsg) {
        if (!errorMsg) return false;
        const msg = errorMsg.toLowerCase();

        const patterns = [
            /prompt is too long/i,
            /tokens? >\s*\d+\s*maximum/i,
            /max_prompt_tokens/i,
            /exceeded/i,
            /input tokens/i,
            /context_length/i,
            /too many tokens/i,
            /token limit/i,
            /maximum.*tokens/i,
            /20015.*limit/i,
            /INVALID_ARGUMENT/i
        ];

        return patterns.some(pattern => pattern.test(errorMsg));
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

    // ========== 【重构】API调用 - 支持真正使用酒馆预设 ==========

    /**
     * 使用酒馆预设发送请求
     * 这会真正使用酒馆的"对话补全预设"，包括系统提示词、格式等
     */
    async function callWithTavernPreset(userMessage, taskId = null) {
        const timeout = settings.apiTimeout || 120000;

        if (taskId !== null) {
            updateStreamContent(`\n📤 [任务${taskId}] 使用酒馆预设发送...\n`);
        } else {
            updateStreamContent(`\n📤 使用酒馆预设发送...\n`);
        }

        try {
            // 检查SillyTavern环境
            if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
                throw new Error('无法访问SillyTavern上下文，请确保在酒馆环境中运行');
            }

            const context = SillyTavern.getContext();

            // 方法1: 使用 sendMessageAsUser + Generate 来触发完整的对话流程
            // 这会应用酒馆的所有预设，包括系统提示词、角色卡等

            // 方法2: 直接构建符合酒馆预设的messages格式
            // 获取当前的聊天补全设置
            const chatCompletionSettings = context.chatCompletionSettings || {};
            const mainApi = context.mainApi || 'openai';

            // 构建消息数组，按照酒馆预设的格式
            let messages = [];

            // 添加系统提示词（如果酒馆预设中有的话）
            if (chatCompletionSettings.systemPrompt) {
                messages.push({
                    role: 'system',
                    content: chatCompletionSettings.systemPrompt
                });
            }

            // 添加用户消息（我们的提示词放在最后）
            messages.push({
                role: 'user',
                content: userMessage
            });

            // 使用酒馆的API发送
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`API请求超时 (${timeout/1000}秒)`)), timeout);
            });

            let apiPromise;

            // 根据不同的API类型选择调用方式
            if (mainApi === 'openai' || mainApi === 'claude' || mainApi === 'openrouter') {
                // 使用Chat Completions API
                apiPromise = new Promise(async (resolve, reject) => {
                    try {
                        const response = await fetch('/api/backends/chat-completions/generate', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            credentials: 'include',
                            body: JSON.stringify({
                                messages: messages,
                                // 这些参数会被酒馆的预设覆盖
                            }),
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            reject(new Error(`API请求失败: ${response.status} - ${errorText}`));
                            return;
                        }

                        const data = await response.json();
                        const content = data.choices?.[0]?.message?.content || data.content || '';
                        resolve(content);
                    } catch (error) {
                        reject(error);
                    }
                });
            } else {
                // 其他API类型，回退到generateRaw
                apiPromise = context.generateRaw(userMessage, '', false);
            }

            const result = await Promise.race([apiPromise, timeoutPromise]);

            if (taskId !== null) {
                updateStreamContent(`📥 [任务${taskId}] 收到响应 (${result.length}字符)\n`);
            } else {
                updateStreamContent(`📥 收到响应 (${result.length}字符)\n`);
            }

            return result;

        } catch (error) {
            updateStreamContent(`\n❌ 酒馆预设调用错误: ${error.message}\n`);
            throw error;
        }
    }

    /**
     * 直接发送原始提示词（不使用酒馆预设）
     */
    async function callRawAPI(prompt, taskId = null) {
        const timeout = settings.apiTimeout || 120000;

        if (taskId !== null) {
            updateStreamContent(`\n📤 [任务${taskId}] 发送原始请求...\n`);
        } else {
            updateStreamContent(`\n📤 发送原始请求...\n`);
        }

        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const context = SillyTavern.getContext();

                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`API请求超时 (${timeout/1000}秒)`)), timeout);
                });

                const apiPromise = context.generateRaw(prompt, '', false);

                const result = await Promise.race([apiPromise, timeoutPromise]);

                if (taskId !== null) {
                    updateStreamContent(`📥 [任务${taskId}] 收到响应 (${result.length}字符)\n`);
                } else {
                    updateStreamContent(`📥 收到响应 (${result.length}字符)\n`);
                }

                return result;
            }

            // 备用：直接调用API
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    messages: [{ role: 'user', content: prompt }],
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API请求失败: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || data.content || '';

            if (taskId !== null) {
                updateStreamContent(`📥 [任务${taskId}] 收到响应 (${content.length}字符)\n`);
            } else {
                updateStreamContent(`📥 收到响应 (${content.length}字符)\n`);
            }

            return content;

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`API请求超时 (${timeout/1000}秒)`);
            }
            updateStreamContent(`\n❌ 错误: ${error.message}\n`);
            throw error;
        }
    }

    /**
     * 统一API调用入口
     */
    async function callAPI(prompt, taskId = null) {
        if (settings.useTavernPreset) {
            // 使用酒馆预设时，提示词配置作为用户消息的一部分
            return await callWithTavernPreset(prompt, taskId);
        } else {
            // 不使用酒馆预设，直接发送原始提示词
            return await callRawAPI(prompt, taskId);
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

    // ========== 解析AI响应 ==========
    function parseAIResponse(response) {
        try {
            return JSON.parse(response);
        } catch (e) {
            let clean = response.trim()
                .replace(/```json\s*/gi, '')
                .replace(/```\s*/g, '');

            const first = clean.indexOf('{');
            const last = clean.lastIndexOf('}');
            if (first !== -1 && last > first) {
                clean = clean.substring(first, last + 1);
            }

            try {
                return JSON.parse(clean);
            } catch (e2) {
                const open = (clean.match(/{/g) || []).length;
                const close = (clean.match(/}/g) || []).length;
                if (open > close) {
                    try {
                        return JSON.parse(clean + '}'.repeat(open - close));
                    } catch (e3) {
                        return extractWorldbookDataByRegex(clean);
                    }
                }
                return extractWorldbookDataByRegex(clean);
            }
        }
    }

    // ========== 世界书分卷功能 ==========
    function startNewVolume() {
        if (Object.keys(generatedWorldbook).length > 0) {
            worldbookVolumes.push({
                volumeIndex: currentVolumeIndex,
                worldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                timestamp: Date.now()
            });
            console.log(`📦 第${currentVolumeIndex + 1}卷已保存，共${Object.keys(generatedWorldbook).length}个分类`);
        }

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
        const merged = {};

        for (const volume of worldbookVolumes) {
            for (const category in volume.worldbook) {
                if (!merged[category]) {
                    merged[category] = {};
                }
                for (const entryName in volume.worldbook[category]) {
                    const key = merged[category][entryName]
                        ? `${entryName}_卷${volume.volumeIndex + 1}`
                        : entryName;
                    merged[category][key] = volume.worldbook[category][entryName];
                }
            }
        }

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

    // ========== 删除单个记忆 ==========
    function deleteMemoryAt(index) {
        if (index < 0 || index >= memoryQueue.length) return;

        const memory = memoryQueue[index];
        if (confirm(`确定要删除 "${memory.title}" 吗？\n\n该记忆包含 ${memory.content.length.toLocaleString()} 字`)) {
            memoryQueue.splice(index, 1);

            memoryQueue.forEach((m, i) => {
                if (!m.title.includes('-')) {
                    m.title = `记忆${i + 1}`;
                }
            });

            if (startFromIndex > index) {
                startFromIndex = Math.max(0, startFromIndex - 1);
            } else if (startFromIndex >= memoryQueue.length) {
                startFromIndex = Math.max(0, memoryQueue.length - 1);
            }

            if (userSelectedStartIndex !== null) {
                if (userSelectedStartIndex > index) {
                    userSelectedStartIndex = Math.max(0, userSelectedStartIndex - 1);
                } else if (userSelectedStartIndex >= memoryQueue.length) {
                    userSelectedStartIndex = null;
                }
            }

            updateMemoryQueueUI();
            updateStartButtonState(false);

            console.log(`🗑️ 已删除记忆: ${memory.title}`);
        }
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

    // ========== 并行处理核心 ==========

    async function processMemoryChunkIndependent(index, retryCount = 0) {
        const memory = memoryQueue[index];
        const maxRetries = 3;
        const taskId = index + 1;

        if (isProcessingStopped) {
            throw new Error('ABORTED');
        }

        memory.processing = true;
        updateMemoryQueueUI();

        let prompt = getLanguagePrefix() + getSystemPrompt();

        if (index > 0 && memoryQueue[index - 1].content) {
            prompt += `\n\n这是前文的结尾部分（供参考连贯性）：
---
${memoryQueue[index - 1].content.slice(-800)}
---
`;
        }

        prompt += `\n\n这是当前需要分析的内容：
---
${memory.content}
---

请从上述内容中提取角色、地点、组织等信息，直接输出JSON格式，不要包含代码块标记。`;

        console.log(`📤 [并行] 发送记忆 ${taskId}: ${memory.title} (${memory.content.length}字)`);
        updateStreamContent(`\n🔄 [记忆${taskId}] 开始处理: ${memory.title}\n`);

        try {
            const response = await callAPI(prompt, taskId);

            if (isProcessingStopped) {
                memory.processing = false;
                throw new Error('ABORTED');
            }

            if (isTokenLimitError(response)) {
                throw new Error('Token limit exceeded');
            }

            let memoryUpdate = parseAIResponse(response);

            console.log(`📥 [并行] 记忆 ${taskId} 完成`);
            updateStreamContent(`✅ [记忆${taskId}] 处理完成\n`);

            return memoryUpdate;

        } catch (error) {
            memory.processing = false;

            if (error.message === 'ABORTED') {
                throw error;
            }

            console.error(`❌ [并行] 记忆 ${taskId} 出错 (尝试 ${retryCount + 1}/${maxRetries}):`, error.message);
            updateStreamContent(`❌ [记忆${taskId}] 错误: ${error.message}\n`);

            if (isTokenLimitError(error.message)) {
                console.log(`⚠️ [并行] 记忆 ${taskId} token超限，标记为需要分裂`);
                throw new Error(`TOKEN_LIMIT:${index}`);
            }

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

            tasks.push({
                index: i,
                memory: memoryQueue[i]
            });
        }

        if (tasks.length === 0) return { tokenLimitIndices };

        console.log(`🚀 并行处理 ${tasks.length} 个记忆块 (并发数: ${parallelConfig.concurrency})`);
        updateStreamContent(`\n🚀 开始并行处理 ${tasks.length} 个记忆块 (并发数: ${parallelConfig.concurrency})\n`);
        updateStreamContent(`${'='.repeat(50)}\n`);

        let completed = 0;
        const totalTasks = tasks.length;

        globalSemaphore = new Semaphore(parallelConfig.concurrency);

        const processOne = async (task) => {
            if (isProcessingStopped) {
                console.log(`⏸️ 任务 ${task.index + 1} 被跳过（已暂停）`);
                return null;
            }

            try {
                await globalSemaphore.acquire();
            } catch (e) {
                if (e.message === 'ABORTED') {
                    console.log(`⏸️ 任务 ${task.index + 1} 被中断（信号量已中止）`);
                    return null;
                }
                throw e;
            }

            if (isProcessingStopped) {
                globalSemaphore.release();
                return null;
            }

            activeParallelTasks.add(task.index);

            try {
                updateProgress(
                    ((startIndex + completed) / memoryQueue.length) * 100,
                    `🚀 并行处理中 (${completed}/${totalTasks}) - 活跃任务: ${activeParallelTasks.size}`
                );

                const result = await processMemoryChunkIndependent(task.index);

                task.memory.processed = true;
                task.memory.failed = false;
                task.memory.processing = false;
                task.memory.result = result;
                results.set(task.index, result);

                completed++;

                if (result) {
                    await mergeWorldbookDataWithHistory(
                        generatedWorldbook,
                        result,
                        task.index,
                        task.memory.title
                    );

                    // 【新增】保存Roll结果
                    await MemoryHistoryDB.saveRollResult(task.index, result);
                }

                updateMemoryQueueUI();
                updateProgress(
                    ((startIndex + completed) / memoryQueue.length) * 100,
                    `🚀 并行处理中 (${completed}/${totalTasks}) - 完成: ${task.memory.title}`
                );

                return result;
            } catch (error) {
                completed++;
                task.memory.processing = false;

                if (error.message === 'ABORTED') {
                    console.log(`⏸️ 任务 ${task.index + 1} 被中断`);
                    updateMemoryQueueUI();
                    return null;
                }

                if (error.message.startsWith('TOKEN_LIMIT:')) {
                    const idx = parseInt(error.message.split(':')[1]);
                    tokenLimitIndices.push(idx);
                    console.log(`⚠️ 记忆 ${idx + 1} 需要分裂处理`);
                } else {
                    console.error(`❌ 记忆 ${task.index + 1} 处理失败:`, error.message);
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

        console.log(`📦 并行处理完成，成功: ${results.size}/${tasks.length}`);
        updateStreamContent(`\n${'='.repeat(50)}\n`);
        updateStreamContent(`📦 并行处理完成，成功: ${results.size}/${tasks.length}\n`);

        return { tokenLimitIndices };
    }

    // ========== 串行记忆处理 ==========
    async function processMemoryChunk(index, retryCount = 0) {
        if (isProcessingStopped) {
            console.log(`处理被暂停，跳过记忆块 ${index + 1}`);
            return;
        }

        const memory = memoryQueue[index];
        const progress = ((index + 1) / memoryQueue.length) * 100;
        const maxRetries = 3;

        updateProgress(progress, `正在处理: ${memory.title} (${index + 1}/${memoryQueue.length})${retryCount > 0 ? ` (重试 ${retryCount}/${maxRetries})` : ''}${useVolumeMode ? ` [第${currentVolumeIndex + 1}卷]` : ''}`);

        memory.processing = true;
        updateMemoryQueueUI();

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
            prompt += `这是当前你对该作品的记忆：
${JSON.stringify(generatedWorldbook, null, 2)}

`;
        }

        prompt += `这是你现在阅读的部分：
---
${memory.content}
---

`;

        if (index === 0 || index === startFromIndex) {
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

        try {
            console.log(`开始调用API处理第${index + 1}个记忆块...`);
            updateProgress(progress, `正在调用API: ${memory.title} (${index + 1}/${memoryQueue.length})`);

            const response = await callAPI(prompt);

            memory.processing = false;

            if (isProcessingStopped) {
                console.log(`API调用完成后检测到暂停，跳过后续处理`);
                updateMemoryQueueUI();
                return;
            }

            console.log(`API调用完成，返回内容长度: ${response.length}`);

            const containsTokenError = isTokenLimitError(response);

            if (containsTokenError) {
                console.log(`⚠️ 返回内容包含token超限错误`);

                if (useVolumeMode) {
                    console.log(`📦 分卷模式：开启新卷继续处理`);
                    updateProgress(progress, `📦 上下文超限，开启第${currentVolumeIndex + 2}卷...`);

                    startNewVolume();
                    await MemoryHistoryDB.saveState(index);

                    await processMemoryChunk(index, 0);
                    return;
                }

                updateProgress(progress, `🔀 上下文超限，分裂当前记忆块...`);

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

            const changedEntries = await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memory.title);

            // 【新增】保存Roll结果
            await MemoryHistoryDB.saveRollResult(index, memoryUpdate);

            if (incrementalOutputMode && changedEntries.length > 0) {
                console.log(`📝 第${index + 1}个记忆块变更 ${changedEntries.length} 个条目`);
            }

            memory.processed = true;
            memory.result = memoryUpdate;
            updateMemoryQueueUI();
            console.log(`记忆块 ${index + 1} 处理完成`);

        } catch (error) {
            memory.processing = false;
            console.error(`处理记忆块 ${index + 1} 时出错 (第${retryCount + 1}次尝试):`, error);

            const errorMsg = error.message || '';

            if (isTokenLimitError(errorMsg)) {
                if (useVolumeMode) {
                    console.log(`📦 分卷模式：开启新卷继续处理`);
                    updateProgress((index / memoryQueue.length) * 100, `📦 上下文超限，开启第${currentVolumeIndex + 2}卷...`);

                    startNewVolume();
                    await MemoryHistoryDB.saveState(index);
                    await new Promise(resolve => setTimeout(resolve, 500));

                    await processMemoryChunk(index, 0);
                    return;
                }

                console.log(`⚠️ 检测到token超限错误，分裂当前记忆块: ${memory.title}`);
                updateProgress((index / memoryQueue.length) * 100, `🔀 字数超限，正在分裂记忆: ${memory.title}`);

                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    console.log(`✅ 记忆分裂成功`);
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(index);
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

    // ========== 暂停处理 ==========
    function stopProcessing() {
        console.log('⏸️ 用户请求暂停处理');
        isProcessingStopped = true;

        if (globalSemaphore) {
            globalSemaphore.abort();
        }

        activeParallelTasks.clear();

        memoryQueue.forEach(m => {
            if (m.processing) {
                m.processing = false;
            }
        });

        updateMemoryQueueUI();
        updateStreamContent(`\n⏸️ 用户请求暂停，正在停止所有任务...\n`);
    }

    // ========== 主处理流程 ==========
    async function startAIProcessing() {
        showProgressSection(true);
        isProcessingStopped = false;

        if (globalSemaphore) {
            globalSemaphore.reset();
        }
        activeParallelTasks.clear();

        updateStreamContent('', true);
        updateStreamContent(`🚀 开始处理...\n`);
        updateStreamContent(`📊 处理模式: ${parallelConfig.enabled ? `并行 (${parallelConfig.mode}, 并发${parallelConfig.concurrency})` : '串行'}\n`);
        updateStreamContent(`🔧 使用酒馆预设: ${settings.useTavernPreset ? '是' : '否'}\n`);
        updateStreamContent(`${'='.repeat(50)}\n`);

        const effectiveStartIndex = userSelectedStartIndex !== null ? userSelectedStartIndex : startFromIndex;
        console.log(`📍 开始处理，起始索引: ${effectiveStartIndex}`);
        console.log(`📊 处理模式: ${parallelConfig.enabled ? `并行 (${parallelConfig.mode}, 并发${parallelConfig.concurrency})` : '串行'}`);

        if (effectiveStartIndex === 0) {
            worldbookVolumes = [];
            currentVolumeIndex = 0;
            generatedWorldbook = {
                地图环境: {},
                剧情节点: {},
                角色: {},
                知识书: {}
            };
        }

        userSelectedStartIndex = null;

        if (useVolumeMode) {
            updateVolumeIndicator();
        }

        updateStartButtonState(true);

        try {
            if (parallelConfig.enabled) {
                console.log('🚀 使用并行模式处理');

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
                        console.log(`⚠️ 有 ${tokenLimitIndices.length} 个记忆需要分裂处理`);
                        updateStreamContent(`\n⚠️ ${tokenLimitIndices.length} 个记忆需要分裂处理...\n`);

                        for (const idx of tokenLimitIndices.sort((a, b) => b - a)) {
                            const splitResult = splitMemoryIntoTwo(idx);
                            if (splitResult) {
                                updateMemoryQueueUI();
                            }
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
                        console.log(`📦 处理批次: 记忆 ${i + 1} - ${batchEnd}`);
                        updateStreamContent(`\n📦 处理批次: 记忆 ${i + 1} - ${batchEnd}\n`);

                        const { tokenLimitIndices } = await processMemoryChunksParallel(i, batchEnd);

                        if (isProcessingStopped) break;

                        for (const idx of tokenLimitIndices.sort((a, b) => b - a)) {
                            splitMemoryIntoTwo(idx);
                        }

                        for (let j = i; j < batchEnd && j < memoryQueue.length && !isProcessingStopped; j++) {
                            if (!memoryQueue[j].processed || memoryQueue[j].failed) {
                                await processMemoryChunk(j);
                            }
                        }

                        i = batchEnd;
                        await MemoryHistoryDB.saveState(i);
                    }
                }

            } else {
                console.log('📝 使用串行模式处理');

                let i = effectiveStartIndex;
                while (i < memoryQueue.length) {
                    if (isProcessingStopped) {
                        console.log('处理被用户停止');
                        updateProgress((i / memoryQueue.length) * 100, `⏸️ 已暂停处理 (${i}/${memoryQueue.length})`);
                        await MemoryHistoryDB.saveState(i);
                        updateStartButtonState(false);
                        return;
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

                    if (memoryQueue[i].processed && !memoryQueue[i].failed) {
                        console.log(`跳过已处理的记忆: ${memoryQueue[i].title}`);
                        i++;
                        continue;
                    }

                    const currentQueueLength = memoryQueue.length;
                    await processMemoryChunk(i);

                    if (memoryQueue.length > currentQueueLength) {
                        i += (memoryQueue.length - currentQueueLength);
                    }

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
                const modeInfo = parallelConfig.enabled ? ' [并行模式]' : '';
                updateProgress(100, `✅ 所有记忆块处理完成！${volumeInfo}${modeInfo}`);
            }

            showResultSection(true);
            updateWorldbookPreview();

            console.log('AI记忆大师处理完成');
            updateStreamContent(`\n${'='.repeat(50)}\n`);
            updateStreamContent(`✅ 处理完成！\n`);

            if (!isProcessingStopped) {
                await MemoryHistoryDB.saveState(memoryQueue.length);
                await MemoryHistoryDB.clearState();
                console.log('✅ 转换完成，状态已保存');
            }

            updateStartButtonState(false);

        } catch (error) {
            console.error('AI处理过程中发生错误:', error);
            updateProgress(0, `❌ 处理过程出错: ${error.message}`);
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
        let memoryUpdate = parseAIResponse(response);

        const memoryTitle = `记忆-修复-${memory.title}`;
        await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memoryTitle);

        // 【新增】保存Roll结果
        await MemoryHistoryDB.saveRollResult(index, memoryUpdate);

        memory.result = memoryUpdate;
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

            if (isTokenLimitError(errorMsg)) {
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

    // ========== 【新增】重Roll功能 ==========
    async function rerollMemory(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        updateStreamContent(`\n🎲 开始重Roll: ${memory.title}\n`);

        try {
            // 标记为处理中
            memory.processing = true;
            updateMemoryQueueUI();

            // 使用独立处理逻辑
            const result = await processMemoryChunkIndependent(index);

            memory.processing = false;

            if (result) {
                // 保存新的Roll结果
                await MemoryHistoryDB.saveRollResult(index, result);

                // 更新当前结果
                memory.result = result;
                memory.processed = true;
                memory.failed = false;

                // 合并到世界书
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

    // 【新增】显示Roll历史选择器
    async function showRollHistorySelector(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        const rollResults = await MemoryHistoryDB.getRollResults(index);

        if (rollResults.length === 0) {
            alert(`"${memory.title}" 暂无历史Roll结果\n\n点击"🎲 重Roll"生成新结果`);
            return;
        }

        const existingModal = document.getElementById('ttw-roll-history-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-roll-history-modal';
        modal.className = 'ttw-modal-container';

        let listHtml = '';
        rollResults.forEach((roll, idx) => {
            const time = new Date(roll.timestamp).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            const entryCount = roll.result ? Object.keys(roll.result).reduce((sum, cat) =>
                sum + (typeof roll.result[cat] === 'object' ? Object.keys(roll.result[cat]).length : 0), 0) : 0;

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

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🎲 ${memory.title} - Roll历史 (${rollResults.length}次)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display: flex; gap: 15px; height: 400px;">
                        <div style="width: 200px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">
                            <div style="margin-bottom: 10px;">
                                <button id="ttw-do-reroll" class="ttw-btn ttw-btn-primary" style="width: 100%;">🎲 重新Roll</button>
                            </div>
                            ${listHtml}
                        </div>
                        <div id="ttw-roll-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 点击左侧Roll结果查看详情</div>
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

        // 绑定事件
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-roll-history').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        // 重Roll按钮
        modal.querySelector('#ttw-do-reroll').addEventListener('click', async () => {
            modal.remove();
            try {
                await rerollMemory(index);
                // 重新打开选择器
                showRollHistorySelector(index);
            } catch (error) {
                alert('重Roll失败: ' + error.message);
            }
        });

        // 清空历史
        modal.querySelector('#ttw-clear-rolls').addEventListener('click', async () => {
            if (confirm(`确定要清空 "${memory.title}" 的所有Roll历史吗？`)) {
                await MemoryHistoryDB.clearRollResults(index);
                modal.remove();
                alert('已清空Roll历史');
            }
        });

        // 点击Roll项查看详情
        modal.querySelectorAll('.ttw-roll-item').forEach(item => {
            item.addEventListener('click', () => {
                const rollIndex = parseInt(item.dataset.rollIndex);
                const roll = rollResults[rollIndex];
                const detailDiv = modal.querySelector('#ttw-roll-detail');

                // 高亮选中项
                modal.querySelectorAll('.ttw-roll-item').forEach(i => {
                    i.style.background = 'rgba(0,0,0,0.2)';
                    i.style.borderLeftColor = '#9b59b6';
                });
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

                // 使用这个结果
                detailDiv.querySelector('#ttw-use-this-roll').addEventListener('click', async () => {
                    memory.result = roll.result;
                    memory.processed = true;
                    memory.failed = false;

                    // 重新合并到世界书
                    await mergeWorldbookDataWithHistory(generatedWorldbook, roll.result, index, `${memory.title}-选用Roll#${rollIndex + 1}`);

                    updateMemoryQueueUI();
                    updateWorldbookPreview();

                    modal.remove();
                    alert(`已使用 Roll #${rollIndex + 1} 的结果`);
                });
            });
        });
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

    // ========== 导出/导入未完成任务 ==========
    async function exportTaskState() {
        const state = {
            version: '2.4.0',
            timestamp: Date.now(),
            memoryQueue: memoryQueue,
            generatedWorldbook: generatedWorldbook,
            worldbookVolumes: worldbookVolumes,
            currentVolumeIndex: currentVolumeIndex,
            fileHash: currentFileHash,
            settings: settings,
            parallelConfig: parallelConfig
        };

        const timeString = new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).replace(/[:/\s]/g, '').replace(/,/g, '-');

        const fileName = currentFile
            ? `${currentFile.name.replace(/\.[^/.]+$/, '')}-任务状态-${timeString}.json`
            : `任务状态-${timeString}.json`;

        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        const processedCount = memoryQueue.filter(m => m.processed).length;
        alert(`任务状态已导出！\n\n已处理: ${processedCount}/${memoryQueue.length}\n未处理: ${memoryQueue.length - processedCount}`);
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

                if (!state.memoryQueue || !Array.isArray(state.memoryQueue)) {
                    throw new Error('无效的任务状态文件');
                }

                memoryQueue = state.memoryQueue;
                generatedWorldbook = state.generatedWorldbook || {};
                worldbookVolumes = state.worldbookVolumes || [];
                currentVolumeIndex = state.currentVolumeIndex || 0;
                currentFileHash = state.fileHash || null;

                if (state.settings) {
                    settings = { ...defaultSettings, ...state.settings };
                }

                if (state.parallelConfig) {
                    parallelConfig = { ...parallelConfig, ...state.parallelConfig };
                }

                const firstUnprocessed = memoryQueue.findIndex(m => !m.processed || m.failed);
                startFromIndex = firstUnprocessed !== -1 ? firstUnprocessed : 0;
                userSelectedStartIndex = null;

                showQueueSection(true);
                updateMemoryQueueUI();

                if (useVolumeMode) {
                    updateVolumeIndicator();
                }

                updateStartButtonState(false);
                updateParallelSettingsUI();
                updateTavernPresetUI();

                const processedCount = memoryQueue.filter(m => m.processed).length;
                alert(`任务状态已导入！\n\n已处理: ${processedCount}/${memoryQueue.length}\n将从记忆${startFromIndex + 1}继续`);

                document.getElementById('ttw-start-btn').disabled = false;

            } catch (error) {
                console.error('导入任务状态失败:', error);
                alert('导入失败: ' + error.message);
            }
        };

        input.click();
    }

    function updateParallelSettingsUI() {
        const enabledEl = document.getElementById('ttw-parallel-enabled');
        const concurrencyEl = document.getElementById('ttw-parallel-concurrency');
        const modeEl = document.getElementById('ttw-parallel-mode');

        if (enabledEl) enabledEl.checked = parallelConfig.enabled;
        if (concurrencyEl) concurrencyEl.value = parallelConfig.concurrency;
        if (modeEl) modeEl.value = parallelConfig.mode;
    }

    function updateTavernPresetUI() {
        const el = document.getElementById('ttw-use-tavern-preset');
        if (el) el.checked = settings.useTavernPreset;
    }

    // ========== 帮助弹窗 ==========
    function showHelpModal() {
        const existingHelp = document.getElementById('ttw-help-modal');
        if (existingHelp) existingHelp.remove();

        const helpModal = document.createElement('div');
        helpModal.id = 'ttw-help-modal';
        helpModal.className = 'ttw-modal-container';
        helpModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 650px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">❓ TXT转世界书 v2.4.0 使用帮助</span>
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
                        <h4 style="color: #27ae60; margin: 0 0 10px 0;">✨ v2.4.0 新功能</h4>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li><strong>📝 记忆编辑</strong>：点击记忆可编辑内容，支持一键复制</li>
                            <li><strong>🎲 重Roll功能</strong>：每个记忆可多次生成，选择最佳结果</li>
                            <li><strong>🍺 酒馆预设</strong>：可选择使用酒馆的对话补全预设</li>
                        </ul>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #3498db; margin: 0 0 10px 0;">🚀 并行处理</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            <strong>独立模式</strong>：每个记忆独立提取，最后合并，速度最快<br>
                            <strong>分批模式</strong>：批次内并行，批次间累积上下文
                        </p>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #9b59b6; margin: 0 0 10px 0;">🍺 使用酒馆预设</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            勾选后，会使用酒馆当前配置的"对话补全预设"，<br>
                            本工具的提示词配置会作为用户消息发送。<br>
                            <span style="color: #f39c12;">⚠️ 需要确保酒馆预设适合世界书生成任务</span>
                        </p>
                    </div>

                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #1abc9c; margin: 0 0 10px 0;">💡 使用技巧</h4>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li>点击记忆块可<strong>查看/编辑/复制</strong>内容</li>
                            <li>使用<strong>🎲 Roll历史</strong>对比不同生成结果</li>
                            <li>可将记忆内容<strong>复制到相邻记忆</strong>进行手动合并</li>
                            <li>处理失败的记忆会自动重试</li>
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

    // ========== 选择起始记忆弹窗 ==========
    function showStartFromSelector() {
        if (memoryQueue.length === 0) {
            alert('请先上传文件');
            return;
        }

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
                        <label style="display: block; margin-bottom: 8px; font-size: 13px;">从哪个记忆块开始处理：</label>
                        <select id="ttw-start-from-select" style="width: 100%; padding: 10px; border: 1px solid #555; border-radius: 6px; background: rgba(0,0,0,0.3); color: #fff; font-size: 13px;">
                            ${optionsHtml}
                        </select>
                    </div>
                    <div style="padding: 12px; background: rgba(230, 126, 34, 0.1); border-radius: 6px; font-size: 12px; color: #f39c12;">
                        ⚠️ 注意：从中间开始时，之前记忆块的世界书数据不会自动加载。如需保留之前的数据，请先恢复保存的状态。
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
            const select = document.getElementById('ttw-start-from-select');
            const selectedIndex = parseInt(select.value);

            userSelectedStartIndex = selectedIndex;
            startFromIndex = selectedIndex;

            const startBtn = document.getElementById('ttw-start-btn');
            if (startBtn) {
                startBtn.textContent = `▶️ 从记忆${selectedIndex + 1}开始`;
            }

            console.log(`📍 用户选择从记忆${selectedIndex + 1}开始`);
            selectorModal.remove();
        });
        selectorModal.addEventListener('click', (e) => {
            if (e.target === selectorModal) selectorModal.remove();
        });
    }

    // ========== 【重构】查看/编辑记忆内容弹窗 ==========
    function showMemoryContentModal(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        const existingModal = document.getElementById('ttw-memory-content-modal');
        if (existingModal) existingModal.remove();

        const contentModal = document.createElement('div');
        contentModal.id = 'ttw-memory-content-modal';
        contentModal.className = 'ttw-modal-container';

        const statusText = memory.processing ? '🔄 处理中' : (memory.processed ? (memory.failed ? '❗ 处理失败' : '✅ 已处理') : '⏳ 未处理');
        const statusColor = memory.processing ? '#3498db' : (memory.processed ? (memory.failed ? '#e74c3c' : '#27ae60') : '#f39c12');

        let resultHtml = '';
        if (memory.processed && memory.result && !memory.failed) {
            resultHtml = `
                <div style="margin-top: 16px;">
                    <h4 style="color: #9b59b6; margin: 0 0 10px 0;">📊 处理结果</h4>
                    <pre id="ttw-memory-result" style="max-height: 150px; overflow-y: auto; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all;">${JSON.stringify(memory.result, null, 2)}</pre>
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
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                        <div>
                            <span style="color: ${statusColor}; font-weight: bold;">${statusText}</span>
                            <span style="margin-left: 16px; color: #888;">字数: <span id="ttw-char-count">${memory.content.length.toLocaleString()}</span></span>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button id="ttw-copy-memory-content" class="ttw-btn ttw-btn-small">📋 复制内容</button>
                            <button id="ttw-roll-history-btn" class="ttw-btn ttw-btn-small" style="background: rgba(155, 89, 182, 0.3);">🎲 Roll历史</button>
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
                        <textarea id="ttw-memory-content-editor" style="width: 100%; min-height: 250px; padding: 12px; background: rgba(0,0,0,0.3); border: 1px solid #555; border-radius: 6px; color: #fff; font-size: 13px; line-height: 1.6; resize: vertical; font-family: inherit;">${memory.content.replace(/</g, '<').replace(/>/g, '>')}</textarea>
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

        // 实时更新字数
        editor.addEventListener('input', () => {
            charCount.textContent = editor.value.length.toLocaleString();
        });

        // 关闭
        contentModal.querySelector('.ttw-modal-close').addEventListener('click', () => contentModal.remove());
        contentModal.querySelector('#ttw-cancel-memory-edit').addEventListener('click', () => contentModal.remove());
        contentModal.addEventListener('click', (e) => {
            if (e.target === contentModal) contentModal.remove();
        });

        // 保存修改
        contentModal.querySelector('#ttw-save-memory-edit').addEventListener('click', () => {
            const newContent = editor.value;
            if (newContent !== memory.content) {
                memory.content = newContent;
                // 标记为未处理，需要重新生成
                memory.processed = false;
                memory.failed = false;
                memory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
                console.log(`📝 已保存记忆修改: ${memory.title}`);
            }
            contentModal.remove();
        });

        // 复制内容
        contentModal.querySelector('#ttw-copy-memory-content').addEventListener('click', () => {
            navigator.clipboard.writeText(editor.value).then(() => {
                const btn = contentModal.querySelector('#ttw-copy-memory-content');
                btn.textContent = '✅ 已复制';
                setTimeout(() => { btn.textContent = '📋 复制内容'; }, 1500);
            });
        });

        // Roll历史
        contentModal.querySelector('#ttw-roll-history-btn').addEventListener('click', () => {
            contentModal.remove();
            showRollHistorySelector(index);
        });

        // 删除
        contentModal.querySelector('#ttw-delete-memory-btn').addEventListener('click', () => {
            contentModal.remove();
            deleteMemoryAt(index);
        });

        // 追加到上一个
        contentModal.querySelector('#ttw-append-to-prev').addEventListener('click', () => {
            if (index === 0) return;
            const prevMemory = memoryQueue[index - 1];
            const contentToAppend = editor.value;

            if (confirm(`确定要将当前内容追加到 "${prevMemory.title}" 的末尾吗？\n\n追加后当前记忆不会被删除，您可以手动删除。`)) {
                prevMemory.content += '\n\n' + contentToAppend;
                prevMemory.processed = false;
                prevMemory.failed = false;
                prevMemory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
                alert(`已追加到 "${prevMemory.title}"`);
            }
        });

        // 追加到下一个
        contentModal.querySelector('#ttw-append-to-next').addEventListener('click', () => {
            if (index === memoryQueue.length - 1) return;
            const nextMemory = memoryQueue[index + 1];
            const contentToAppend = editor.value;

            if (confirm(`确定要将当前内容追加到 "${nextMemory.title}" 的开头吗？\n\n追加后当前记忆不会被删除，您可以手动删除。`)) {
                nextMemory.content = contentToAppend + '\n\n' + nextMemory.content;
                nextMemory.processed = false;
                nextMemory.failed = false;
                nextMemory.result = null;
                updateMemoryQueueUI();
                updateStartButtonState(false);
                alert(`已追加到 "${nextMemory.title}"`);
            }
        });
    }

    // ========== 查看已处理结果 ==========
    function showProcessedResults() {
        const processedMemories = memoryQueue.filter(m => m.processed && !m.failed && m.result);

        if (processedMemories.length === 0) {
            alert('暂无已处理的结果');
            return;
        }

        const existingModal = document.getElementById('ttw-processed-results-modal');
        if (existingModal) existingModal.remove();

        const resultsModal = document.createElement('div');
        resultsModal.id = 'ttw-processed-results-modal';
        resultsModal.className = 'ttw-modal-container';

        let listHtml = '';
        processedMemories.forEach((memory, idx) => {
            const realIndex = memoryQueue.indexOf(memory);
            const entryCount = memory.result ? Object.keys(memory.result).reduce((sum, cat) =>
                sum + (typeof memory.result[cat] === 'object' ? Object.keys(memory.result[cat]).length : 0), 0) : 0;

            listHtml += `
                <div class="ttw-processed-item" data-index="${realIndex}" style="padding: 10px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #27ae60;">
                    <div style="font-weight: bold; color: #27ae60; margin-bottom: 4px;">✅ ${memory.title}</div>
                    <div style="font-size: 11px; color: #888;">提取了 ${entryCount} 个条目 | ${memory.content.length.toLocaleString()} 字</div>
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
                        <div style="width: 250px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">
                            ${listHtml}
                        </div>
                        <div id="ttw-result-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 点击左侧记忆查看处理结果</div>
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
        resultsModal.addEventListener('click', (e) => {
            if (e.target === resultsModal) resultsModal.remove();
        });

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
                            <h4 style="color: #27ae60; margin: 0;">${memory.title} 的处理结果</h4>
                            <button class="ttw-btn ttw-btn-small" id="ttw-copy-result">📋 复制结果</button>
                        </div>
                        <pre style="white-space: pre-wrap; word-break: break-all; font-size: 11px; line-height: 1.5;">${JSON.stringify(memory.result, null, 2)}</pre>
                    `;

                    detailDiv.querySelector('#ttw-copy-result').addEventListener('click', () => {
                        navigator.clipboard.writeText(JSON.stringify(memory.result, null, 2)).then(() => {
                            const btn = detailDiv.querySelector('#ttw-copy-result');
                            btn.textContent = '✅ 已复制';
                            setTimeout(() => { btn.textContent = '📋 复制结果'; }, 1500);
                        });
                    });
                }
            });
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
                    <span class="ttw-modal-title">📚 TXT转世界书 v2.4.0 ✨编辑/重Roll/酒馆预设</span>
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
                            <!-- 【新增】酒馆预设选项 -->
                            <div class="ttw-tavern-preset-section" style="margin-bottom: 16px; padding: 12px; background: rgba(39, 174, 96, 0.1); border: 1px solid rgba(39, 174, 96, 0.3); border-radius: 8px;">
                                <label class="ttw-checkbox-label" style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                                    <input type="checkbox" id="ttw-use-tavern-preset" style="width: 20px; height: 20px; accent-color: #27ae60;">
                                    <div>
                                        <span style="font-weight: bold; color: #27ae60;">🍺 使用酒馆对话补全预设</span>
                                        <div style="font-size: 11px; color: #888; margin-top: 4px;">勾选后使用酒馆当前预设，下方提示词配置作为用户消息发送</div>
                                    </div>
                                </label>
                            </div>

                            <!-- 并行处理设置 -->
                            <div class="ttw-parallel-settings" style="margin-bottom: 16px; padding: 12px; background: rgba(52, 152, 219, 0.15); border: 1px solid rgba(52, 152, 219, 0.3); border-radius: 8px;">
                                <div style="font-weight: bold; color: #3498db; margin-bottom: 10px;">🚀 并行处理设置</div>
                                <div class="ttw-setting-row" style="display: flex; gap: 12px; align-items: center;">
                                    <div class="ttw-setting-item" style="flex: 1;">
                                        <label class="ttw-checkbox-label" style="display: flex; align-items: center; gap: 8px;">
                                            <input type="checkbox" id="ttw-parallel-enabled" checked style="width: 18px; height: 18px;">
                                            <span>启用并行处理</span>
                                        </label>
                                    </div>
                                    <div class="ttw-setting-item" style="flex: 1;">
                                        <label style="font-size: 12px;">并发数量</label>
                                        <input type="number" id="ttw-parallel-concurrency" value="3" min="1" max="10" style="width: 70px; padding: 6px 8px; margin-left: 8px;">
                                    </div>
                                </div>
                                <div class="ttw-setting-row" style="margin-top: 10px;">
                                    <div class="ttw-setting-item" style="flex: 1;">
                                        <label style="font-size: 12px; display: block; margin-bottom: 6px;">处理模式</label>
                                        <select id="ttw-parallel-mode" style="width: 100%; padding: 8px; border: 1px solid #555; border-radius: 4px; background: rgba(0,0,0,0.3); color: #fff; font-size: 12px;">
                                            <option value="independent">🚀 独立模式（推荐，最快）</option>
                                            <option value="batch">📦 分批模式</option>
                                        </select>
                                    </div>
                                </div>
                            </div>

                            <div class="ttw-setting-row">
                                <div class="ttw-setting-item" style="flex: 1;">
                                    <label>每块字数</label>
                                    <input type="number" id="ttw-chunk-size" value="15000" min="1000" max="500000">
                                </div>
                                <div class="ttw-setting-item" style="flex: 1;">
                                    <label>API超时(秒)</label>
                                    <input type="number" id="ttw-api-timeout" value="120" min="30" max="600">
                                </div>
                            </div>
                            <div class="ttw-checkbox-group">
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-incremental-mode" checked>
                                    <span>📝 增量输出模式</span>
                                </label>
                                <label class="ttw-checkbox-label" style="background: rgba(155, 89, 182, 0.15); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(155, 89, 182, 0.3);">
                                    <input type="checkbox" id="ttw-volume-mode">
                                    <span>📦 分卷模式</span>
                                </label>
                            </div>
                            <div id="ttw-volume-indicator" style="display: none; margin-top: 12px; padding: 8px 12px; background: rgba(155, 89, 182, 0.2); border-radius: 6px; font-size: 12px; color: #bb86fc;">
                                当前: 第1卷 | 已完成: 0卷
                            </div>

                            <!-- 提示词配置区域 -->
                            <div class="ttw-prompt-config" style="margin-top: 16px;">
                                <div class="ttw-prompt-config-header">
                                    <span>📝 提示词配置</span>
                                    <button id="ttw-preview-prompt" class="ttw-btn ttw-btn-small">👁️ 预览</button>
                                </div>

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
                            <div class="ttw-task-actions">
                                <button id="ttw-import-task" class="ttw-btn-small" title="导入任务状态">📥 导入任务</button>
                                <button id="ttw-export-task" class="ttw-btn-small" title="导出当前任务状态">📤 导出任务</button>
                            </div>
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
                            <div style="display: flex; gap: 8px; margin-left: auto;">
                                <button id="ttw-view-processed" class="ttw-btn-small">📊 已处理</button>
                                <button id="ttw-select-start" class="ttw-btn-small">📍 选择起始</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-memory-queue-hint" style="font-size: 11px; color: #888; margin-bottom: 8px;">💡 点击记忆可<strong>查看/编辑/复制</strong>内容，支持<strong>🎲重Roll</strong></div>
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
                                <button id="ttw-toggle-stream" class="ttw-btn ttw-btn-small">👁️ 实时输出</button>
                            </div>
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
                max-width: 750px;
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
                font-size: 15px;
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

            .ttw-setting-row {
                display: flex;
                gap: 12px;
                margin-bottom: 12px;
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

            .ttw-task-actions {
                display: flex;
                gap: 8px;
            }

            .ttw-prompt-config {
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
                cursor: pointer;
                transition: background 0.2s;
            }

            .ttw-memory-item:hover {
                background: rgba(0, 0, 0, 0.4);
            }

            .ttw-memory-item.processed {
                opacity: 0.6;
            }

            .ttw-memory-item.processing {
                border-left: 3px solid #3498db;
                background: rgba(52, 152, 219, 0.15);
                opacity: 1;
            }

            .ttw-memory-item.failed {
                border-left: 3px solid #e74c3c;
                opacity: 1;
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

        // 基础设置
        ['ttw-chunk-size', 'ttw-api-timeout'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });

        ['ttw-incremental-mode', 'ttw-volume-mode', 'ttw-enable-plot', 'ttw-enable-style'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });

        // 【新增】酒馆预设选项
        document.getElementById('ttw-use-tavern-preset').addEventListener('change', (e) => {
            settings.useTavernPreset = e.target.checked;
            saveCurrentSettings();
        });

        // 并行设置
        document.getElementById('ttw-parallel-enabled').addEventListener('change', (e) => {
            parallelConfig.enabled = e.target.checked;
            saveCurrentSettings();
        });

        document.getElementById('ttw-parallel-concurrency').addEventListener('change', (e) => {
            parallelConfig.concurrency = Math.max(1, Math.min(10, parseInt(e.target.value) || 3));
            e.target.value = parallelConfig.concurrency;
            saveCurrentSettings();
        });

        document.getElementById('ttw-parallel-mode').addEventListener('change', (e) => {
            parallelConfig.mode = e.target.value;
            saveCurrentSettings();
        });

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

        document.getElementById('ttw-import-task').addEventListener('click', importTaskState);
        document.getElementById('ttw-export-task').addEventListener('click', exportTaskState);

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

        document.getElementById('ttw-stop-btn').addEventListener('click', stopProcessing);

        document.getElementById('ttw-repair-btn').addEventListener('click', startRepairFailedMemories);

        document.getElementById('ttw-select-start').addEventListener('click', showStartFromSelector);
        document.getElementById('ttw-view-processed').addEventListener('click', showProcessedResults);

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
        settings.apiTimeout = (parseInt(document.getElementById('ttw-api-timeout').value) || 120) * 1000;
        incrementalOutputMode = document.getElementById('ttw-incremental-mode').checked;
        useVolumeMode = document.getElementById('ttw-volume-mode').checked;
        settings.useVolumeMode = useVolumeMode;
        settings.enablePlotOutline = document.getElementById('ttw-enable-plot').checked;
        settings.enableLiteraryStyle = document.getElementById('ttw-enable-style').checked;
        settings.customWorldbookPrompt = document.getElementById('ttw-worldbook-prompt').value;
        settings.customPlotPrompt = document.getElementById('ttw-plot-prompt').value;
        settings.customStylePrompt = document.getElementById('ttw-style-prompt').value;
        settings.useTavernPreset = document.getElementById('ttw-use-tavern-preset').checked;

        // 保存并行配置
        settings.parallelEnabled = parallelConfig.enabled;
        settings.parallelConcurrency = parallelConfig.concurrency;
        settings.parallelMode = parallelConfig.mode;

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

                // 恢复并行配置
                parallelConfig.enabled = settings.parallelEnabled !== undefined ? settings.parallelEnabled : true;
                parallelConfig.concurrency = settings.parallelConcurrency || 3;
                parallelConfig.mode = settings.parallelMode || 'independent';
            }
        } catch (e) {
            console.error('加载设置失败:', e);
        }

        document.getElementById('ttw-chunk-size').value = settings.chunkSize;
        document.getElementById('ttw-api-timeout').value = Math.round((settings.apiTimeout || 120000) / 1000);
        document.getElementById('ttw-incremental-mode').checked = incrementalOutputMode;
        document.getElementById('ttw-volume-mode').checked = useVolumeMode;
        document.getElementById('ttw-enable-plot').checked = settings.enablePlotOutline;
        document.getElementById('ttw-enable-style').checked = settings.enableLiteraryStyle;
        document.getElementById('ttw-worldbook-prompt').value = settings.customWorldbookPrompt || '';
        document.getElementById('ttw-plot-prompt').value = settings.customPlotPrompt || '';
        document.getElementById('ttw-style-prompt').value = settings.customStylePrompt || '';
        document.getElementById('ttw-use-tavern-preset').checked = settings.useTavernPreset || false;

        // 恢复并行设置UI
        document.getElementById('ttw-parallel-enabled').checked = parallelConfig.enabled;
        document.getElementById('ttw-parallel-concurrency').value = parallelConfig.concurrency;
        document.getElementById('ttw-parallel-mode').value = parallelConfig.mode;

        const indicator = document.getElementById('ttw-volume-indicator');
        if (indicator) {
            indicator.style.display = useVolumeMode ? 'block' : 'none';
        }
    }

    function showPromptPreview() {
        const prompt = getSystemPrompt();

        const statusItems = [
            `🍺 酒馆预设: ${settings.useTavernPreset ? '✅ 使用' : '❌ 不使用'}`,
            `📚 世界书词条: ${settings.customWorldbookPrompt?.trim() ? '自定义' : '默认'}`,
            `📖 剧情大纲: ${settings.enablePlotOutline ? '✅' : '❌'}`,
            `🎨 文风配置: ${settings.enableLiteraryStyle ? '✅' : '❌'}`,
            `🚀 并行: ${parallelConfig.enabled ? `${parallelConfig.concurrency}并发` : '关闭'}`
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
                    <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; padding: 10px; background: rgba(0,0,0,0.15); border-radius: 6px; font-size: 11px;">
                        ${statusItems.map(item => `<span style="padding: 4px 8px; background: rgba(0,0,0,0.2); border-radius: 4px;">${item}</span>`).join('')}
                    </div>
                    ${settings.useTavernPreset ? `
                    <div style="margin-bottom: 12px; padding: 10px; background: rgba(39, 174, 96, 0.15); border-radius: 6px; font-size: 12px; color: #27ae60;">
                        ✅ 使用酒馆预设时，上述提示词会作为<strong>用户消息</strong>发送，酒馆的系统提示词会被自动添加
                    </div>
                    ` : ''}
                    <pre style="white-space: pre-wrap; word-wrap: break-word; font-size: 12px; line-height: 1.5; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; max-height: 50vh; overflow-y: auto;">${prompt.replace(/</g, '<').replace(/>/g, '>')}</pre>
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
                const processedCount = savedState.memoryQueue.filter(m => m.processed).length;
                const unprocessedCount = savedState.memoryQueue.length - processedCount;

                const shouldRestore = confirm(`检测到未完成的转换任务\n\n已处理: ${processedCount}/${savedState.memoryQueue.length}\n未处理: ${unprocessedCount}\n\n是否恢复？`);

                if (shouldRestore) {
                    memoryQueue = savedState.memoryQueue;
                    generatedWorldbook = savedState.generatedWorldbook || {};
                    worldbookVolumes = savedState.worldbookVolumes || [];
                    currentVolumeIndex = savedState.currentVolumeIndex || 0;
                    currentFileHash = savedState.fileHash;

                    startFromIndex = memoryQueue.findIndex(m => !m.processed || m.failed);
                    if (startFromIndex === -1) {
                        startFromIndex = memoryQueue.length;
                    }
                    userSelectedStartIndex = null;

                    showQueueSection(true);
                    updateMemoryQueueUI();

                    if (useVolumeMode) {
                        updateVolumeIndicator();
                    }

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
            startFromIndex = 0;
            userSelectedStartIndex = null;
            updateStartButtonState(false);

        } catch (error) {
            console.error('文件处理失败:', error);
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
                chapters.push({
                    title: matches[i][0],
                    content: content.slice(startIndex, endIndex)
                });
            }

            let currentChunk = '';
            let chunkIndex = 1;

            for (let i = 0; i < chapters.length; i++) {
                const chapter = chapters[i];

                if (chapter.content.length > chunkSize) {
                    if (currentChunk.length > 0) {
                        memoryQueue.push({
                            title: `记忆${chunkIndex}`,
                            content: currentChunk,
                            processed: false,
                            failed: false,
                            processing: false
                        });
                        currentChunk = '';
                        chunkIndex++;
                    }

                    let remaining = chapter.content;
                    let subIndex = 1;
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

                        memoryQueue.push({
                            title: `记忆${chunkIndex}-${subIndex}`,
                            content: remaining.slice(0, endPos),
                            processed: false,
                            failed: false,
                            processing: false
                        });
                        remaining = remaining.slice(endPos);
                        subIndex++;
                    }
                    chunkIndex++;
                    continue;
                }

                if (currentChunk.length + chapter.content.length > chunkSize && currentChunk.length > 0) {
                    memoryQueue.push({
                        title: `记忆${chunkIndex}`,
                        content: currentChunk,
                        processed: false,
                        failed: false,
                        processing: false
                    });
                    currentChunk = '';
                    chunkIndex++;
                }
                currentChunk += chapter.content;
            }

            if (currentChunk.length > 0) {
                if (currentChunk.length < chunkSize * 0.2 && memoryQueue.length > 0) {
                    const lastMemory = memoryQueue[memoryQueue.length - 1];
                    if (lastMemory.content.length + currentChunk.length <= chunkSize) {
                        lastMemory.content += currentChunk;
                    } else {
                        memoryQueue.push({
                            title: `记忆${chunkIndex}`,
                            content: currentChunk,
                            processed: false,
                            failed: false,
                            processing: false
                        });
                    }
                } else {
                    memoryQueue.push({
                        title: `记忆${chunkIndex}`,
                        content: currentChunk,
                        processed: false,
                        failed: false,
                        processing: false
                    });
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

                memoryQueue.push({
                    title: `记忆${chunkIndex}`,
                    content: content.slice(i, endIndex),
                    processed: false,
                    failed: false,
                    processing: false
                });

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

        memoryQueue.forEach((memory, index) => {
            memory.title = `记忆${index + 1}`;
        });

        console.log(`文本已切分为 ${memoryQueue.length} 个记忆块`);
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

        if (memoryQueue.length === 0) {
            alert('请先上传文件');
            return;
        }

        await startAIProcessing();
    }

    function showQueueSection(show) {
        document.getElementById('ttw-queue-section').style.display = show ? 'block' : 'none';
    }

    function showProgressSection(show) {
        document.getElementById('ttw-progress-section').style.display = show ? 'block' : 'none';
    }

    function showResultSection(show) {
        document.getElementById('ttw-result-section').style.display = show ? 'block' : 'none';

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
        if (!container) return;

        container.innerHTML = '';

        memoryQueue.forEach((memory, index) => {
            const item = document.createElement('div');
            item.className = 'ttw-memory-item';

            if (memory.processing) {
                item.classList.add('processing');
            } else if (memory.processed && !memory.failed) {
                item.classList.add('processed');
            } else if (memory.failed) {
                item.classList.add('failed');
            }

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

            item.addEventListener('click', () => {
                showMemoryContentModal(index);
            });

            container.appendChild(item);
        });
    }

    function updateWorldbookPreview() {
        const container = document.getElementById('ttw-result-preview');

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
                                .replace(/</g, '<')
                                .replace(/>/g, '>')
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
        if (typeof entry === 'string') return entry.replace(/</g, '<').replace(/>/g, '>').replace(/\n/g, '<br>');

        let html = '';
        if (entry['关键词']) {
            const keywords = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : entry['关键词'];
            html += `<div style="color: #9b59b6; margin-bottom: 4px;"><strong>关键词:</strong> ${keywords}</div>`;
        }
        if (entry['内容']) {
            const content = String(entry['内容']).replace(/</g, '<').replace(/>/g, '>').replace(/\n/g, '<br>');
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
        getAllVolumesWorldbook: getAllVolumesWorldbook,
        exportTaskState: exportTaskState,
        importTaskState: importTaskState,
        getParallelConfig: () => parallelConfig,
        rerollMemory: rerollMemory,
        showRollHistory: showRollHistorySelector
    };

    console.log('📚 TxtToWorldbook v2.4.0 已加载 (✨记忆编辑/复制 + 🎲重Roll + 🍺酒馆预设)');
})();
