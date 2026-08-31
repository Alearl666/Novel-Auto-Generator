/**
 * TXT转世界书独立模块 v3.2.1
 * v3.0.8 新增:
 *   - 消息链配置：发送给AI的提示词支持多消息格式，每条消息可指定角色（系统/用户/AI助手）
 *   - 酒馆API优先使用generateRaw消息数组格式（ST 1.13.2+），自动回退兼容旧版
 *   - 自定义API各provider原生支持多消息：OpenAI兼容/DeepSeek用messages[]，Gemini用systemInstruction+contents[]
 *   - 修复整理条目结果未过滤响应标签（thinking等标签残留在内容中）的bug
 * v3.0.9 新增:
 *   - 整理条目支持多预设提示词：可添加任意数量的命名预设，每个分类可独立指定使用哪个预设
 *   - 内置「默认」预设不可删除，自定义预设支持添加/编辑名称和内容/删除
 *   - 每个分类标题旁有预设下拉选择，分类-预设映射持久保存
 *   - 整理条目预设和分类映射纳入导出/导入配置，旧版单提示词自动迁移为预设
 *   - 条目列表显示Token数，分类标题显示汇总Token数
 * v3.1.0 新增:
 *   - 手动合并条目：在世界书视图中新增「✋手动合并」按钮
 *   - 支持跨分类勾选2+条目合并，可自定义主名称和目标分类
 *   - 条目筛选、全部展开/收起、合并预览（关键词+Token统计）
 *   - 适用于AI别名识别遗漏的场景，与自动别名合并互补
 * v3.2.0 新增:
 *   - 导入更新章节：章节队列新增「📗导入更新章节」按钮，只把新增章节追加到队列末尾
 *   - 支持两种模式：仅新增模式（只导新章节直接追加）/ 完整文件模式（导整本自动识别新增去重）
 *   - 追加过程完全不刷新已处理/已整理/已别名合并的世界书条目
 *   - 生成结果视图新增条目/分类删除按钮，可手动删除部分条目或整个分类
 */

(function () {
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
    let isRerolling = false;

    // 新增：小说名称（持久化，不随UI关闭丢失）
    let savedNovelName = '';

    // 新增：导入数据暂存
    let pendingImportData = null;

    // 新增：多选删除模式
    let isMultiSelectMode = false;
    let selectedMemoryIndices = new Set();

    // 新增：查找高亮关键词
    let searchHighlightKeyword = '';

    // 新增：Token高亮阈值
    let tokenHighlightThreshold = 0;

    // 新增：条目位置/深度/顺序配置（按分类和条目名称存储）
    let entryPositionConfig = {};

    // ========== 新增：默认世界书条目UI数据 ==========
    let defaultWorldbookEntriesUI = [];

    // ========== 新增：自定义分类系统 ==========
    const DEFAULT_WORLDBOOK_CATEGORIES = [
        {
            name: "角色",
            enabled: true,
            isBuiltin: true,
            entryExample: "角色真实姓名",
            keywordsExample: ["真实姓名", "称呼1", "称呼2", "绰号"],
            contentGuide: "基于原文的角色描述，包含但不限于**名称**:（必须要）、**性别**:、**MBTI(必须要，如变化请说明背景)**:、**貌龄**:、**年龄**:、**身份**:、**背景**:、**性格**:、**外貌**:、**技能**:、**重要事件**:、**话语示例**:、**弱点**:、**背景故事**:等（实际嵌套或者排列方式按合理的逻辑）",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        },
        {
            name: "地点",
            enabled: true,
            isBuiltin: true,
            entryExample: "地点真实名称",
            keywordsExample: ["地点名", "别称", "俗称"],
            contentGuide: "基于原文的地点描述，包含但不限于**名称**:（必须要）、**位置**:、**特征**:、**重要事件**:等（实际嵌套或者排列方式按合理的逻辑）",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        },
        {
            name: "组织",
            enabled: true,
            isBuiltin: true,
            entryExample: "组织真实名称",
            keywordsExample: ["组织名", "简称", "代号"],
            contentGuide: "基于原文的组织描述，包含但不限于**名称**:（必须要）、**性质**:、**成员**:、**目标**:等（实际嵌套或者排列方式按合理的逻辑）",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        },
        {
            name: "道具",
            enabled: false,
            isBuiltin: false,
            entryExample: "道具名称",
            keywordsExample: ["道具名", "别名"],
            contentGuide: "基于原文的道具描述，包含但不限于**名称**:、**类型**:、**功能**:、**来源**:、**持有者**:等",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        },
        {
            name: "玩法",
            enabled: false,
            isBuiltin: false,
            entryExample: "玩法名称",
            keywordsExample: ["玩法名", "规则名"],
            contentGuide: "基于原文的玩法/规则描述，包含但不限于**名称**:、**规则说明**:、**参与条件**:、**奖惩机制**:等",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        },
        {
            name: "章节剧情",
            enabled: false,
            isBuiltin: false,
            entryExample: "第X章",
            keywordsExample: ["章节名", "章节号"],
            contentGuide: "该章节的剧情概要，包含但不限于**章节标题**:、**主要事件**:、**出场角色**:、**关键转折**:、**伏笔线索**:等",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        },
        {
            name: "角色内心",
            enabled: false,
            isBuiltin: false,
            entryExample: "角色名-内心世界",
            keywordsExample: ["角色名", "内心", "心理"],
            contentGuide: "角色的内心想法和心理活动，包含但不限于**原文内容**:、**内心独白**:、**情感变化**:、**动机分析**:、**心理矛盾**:等",
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        }
    ];


    let customWorldbookCategories = JSON.parse(JSON.stringify(DEFAULT_WORLDBOOK_CATEGORIES));

    // ========== 新增：章回正则配置 ==========
    let chapterRegexSettings = {
        pattern: '第[零一二三四五六七八九十百千万0-9]+[章回卷节部篇]',
        useCustomRegex: false
    };

    // ========== 分类灯状态配置 ==========
    let categoryLightSettings = {
        '角色': false,
        '地点': true,
        '组织': false,
        '剧情大纲': true,
        '知识书': false,
        '文风配置': false,
        '地图环境': true,
        '剧情节点': true
    };

    // ========== 新增：分类默认位置/深度配置 ==========
    let categoryDefaultConfig = {};
    // 新增：剧情大纲导出默认配置
    let plotOutlineExportConfig = {
        position: 0,
        depth: 4,
        order: 100,
        autoIncrementOrder: true
    };

    // ========== 并行处理配置 ==========
    let parallelConfig = {
        enabled: true,
        concurrency: 3,
        mode: 'independent'
    };

    let activeParallelTasks = new Set();

    // ========== Token计数功能 ==========
    function estimateTokenCount(text) {
        if (!text) return 0;
        const str = String(text);
        // 简单估算：中文字符约1.5-2 token，英文单词约1 token，标点符号等
        let tokens = 0;

        // 中文字符计数 (大约每个中文字符1.5-2个token)
        const chineseChars = (str.match(/[\u4e00-\u9fa5]/g) || []).length;
        tokens += chineseChars * 1.5;

        // 英文单词计数
        const englishWords = (str.match(/[a-zA-Z]+/g) || []).length;
        tokens += englishWords;

        // 数字
        const numbers = (str.match(/\d+/g) || []).length;
        tokens += numbers;

        // 标点和特殊字符
        const punctuation = (str.match(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g) || []).length;
        tokens += punctuation * 0.5;

        return Math.ceil(tokens);
    }

    function getEntryTotalTokens(entry) {
        if (!entry || typeof entry !== 'object') return 0;
        let total = 0;

        // 计算关键词tokens
        if (entry['关键词']) {
            const keywords = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : entry['关键词'];
            total += estimateTokenCount(keywords);
        }

        // 计算内容tokens
        if (entry['内容']) {
            total += estimateTokenCount(entry['内容']);
        }

        return total;
    }

    // ========== 自然排序（章节号智能排序） ==========
    function naturalSortEntryNames(names) {
        return [...names].sort((a, b) => {
            // 提取章节号的正则：匹配"第X章"格式
            const chapterRegex = /第([零一二三四五六七八九十百千万\d]+)[章回卷节部篇]/;
            const matchA = a.match(chapterRegex);
            const matchB = b.match(chapterRegex);
            if (matchA && matchB) {
                const numA = chineseNumToInt(matchA[1]);
                const numB = chineseNumToInt(matchB[1]);
                if (numA !== numB) return numA - numB;
            }
            // 通用自然排序：按数字段比较
            return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
        });
    }

    function chineseNumToInt(str) {
        // 纯数字直接返回
        if (/^\d+$/.test(str)) return parseInt(str);
        const numMap = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
        const unitMap = { '十': 10, '百': 100, '千': 1000, '万': 10000 };
        let result = 0, section = 0, current = 0;
        for (const ch of str) {
            if (numMap[ch] !== undefined) {
                current = numMap[ch];
            } else if (unitMap[ch] !== undefined) {
                const unit = unitMap[ch];
                if (unit === 10000) {
                    section = (current === 0 && section === 0) ? unit : (section + current) * unit;
                    result += section;
                    section = 0;
                } else {
                    section += (current === 0 ? 1 : current) * unit;
                }
                current = 0;
            }
        }
        return result + section + current;
    }

    // ========== 默认设置 ==========
    const defaultWorldbookPrompt = `你是专业的小说世界书生成专家。请仔细阅读提供的小说内容，提取其中的关键信息，生成高质量的世界书条目。

## 重要要求
1. **必须基于提供的具体小说内容**，不要生成通用模板
2. **只输出以下指定分类：{ENABLED_CATEGORY_NAMES}**，禁止输出其他未指定的分类
3. **关键词必须是文中实际出现的名称**，用逗号分隔
4. **内容必须基于原文描述**，不要添加原文没有的信息
5. **内容使用markdown格式**，可以层层嵌套或使用序号标题

## 📤 输出格式
请生成标准JSON格式，确保能被JavaScript正确解析：

\`\`\`json
{DYNAMIC_JSON_TEMPLATE}
\`\`\`

## 重要提醒
- 直接输出JSON，不要包含代码块标记
- 所有信息必须来源于原文，不要编造
- 关键词必须是文中实际出现的词语
- 内容描述要完整但简洁
- **严格只输出上述指定的分类，不要自作主张添加其他分类**`;

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

    const defaultMergePrompt = `你是世界书条目合并专家。请将以下两个相同名称的世界书条目合并为一个，保留所有重要信息，去除重复内容。

## 合并规则
1. 关键词：合并两者的关键词，去重
2. 内容：整合两者的描述，保留所有独特信息，用markdown格式组织
3. 如有矛盾信息，保留更详细/更新的版本
4. 输出格式必须是JSON

## 条目A
{ENTRY_A}

## 条目B
{ENTRY_B}

请直接输出合并后的JSON格式条目：
{"关键词": [...], "内容": "..."}`;

    const defaultConsolidatePrompt = `你是世界书条目整理专家。请整理以下条目内容，去除重复信息，合并相似描述，保留所有独特细节。

## 整理规则
1. 合并重复的属性描述（如多个"性别"只保留一个）
2. 整合相似的段落，去除冗余
3. 保留所有独特信息，不要丢失细节
4. 使用清晰的markdown格式输出
5. 关键信息放在前面

## 原始内容
{CONTENT}

请直接输出整理后的内容（纯文本，不要JSON包装）：`;

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
        useTavernApi: true,
        customMergePrompt: '',
        consolidatePromptPresets: [],
        consolidateCategoryPresetMap: {},
        categoryLightSettings: null,
        defaultWorldbookEntries: '',
        customRerollPrompt: '',
        customBatchRerollPrompt: '',
        customApiProvider: 'gemini',
        customApiKey: '',
        customApiEndpoint: '',
        customApiModel: 'gemini-2.5-flash',
        forceChapterMarker: true,
        chapterRegexPattern: '第[零一二三四五六七八九十百千万0-9]+[章回卷节部篇]',
        useCustomChapterRegex: false,
        defaultWorldbookEntriesUI: [],
        categoryDefaultConfig: {},
        entryPositionConfig: {},
        customSuffixPrompt: '',
        promptMessageChain: [
            { role: 'user', content: '{PROMPT}', enabled: true }
        ],
        // ===== 酒馆预设导入相关 =====
        presetTemperature: 0.3,
        presetMaxTokens: null,
        presetTopP: null,
        presetFreqPenalty: null,
        presetPresPenalty: null,
        importedPresetName: '',
        allowRecursion: false,
        filterResponseTags: 'thinking,/think',
        debugMode: false,

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
        categoriesStoreName: 'categories',
        entryRollStoreName: 'entryRolls', // 新增：条目级别Roll历史
        db: null,

        async openDB() {
            if (this.db) return this.db;
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 6); // 升级版本号
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
                    if (!db.objectStoreNames.contains(this.categoriesStoreName)) {
                        db.createObjectStore(this.categoriesStoreName, { keyPath: 'key' });
                    }
                    // 新增：条目级别Roll历史存储
                    if (!db.objectStoreNames.contains(this.entryRollStoreName)) {
                        const entryRollStore = db.createObjectStore(this.entryRollStoreName, { keyPath: 'id', autoIncrement: true });
                        entryRollStore.createIndex('entryKey', 'entryKey', { unique: false }); // category:entryName
                        entryRollStore.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                };
                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve(this.db);
                };
                request.onerror = (event) => reject(event.target.error);
            });
        },

        async saveCustomCategories(categories) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.categoriesStoreName], 'readwrite');
                const store = transaction.objectStore(this.categoriesStoreName);
                const request = store.put({ key: 'customCategories', value: categories });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async getCustomCategories() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.categoriesStoreName], 'readonly');
                const store = transaction.objectStore(this.categoriesStoreName);
                const request = store.get('customCategories');
                request.onsuccess = () => resolve(request.result?.value || null);
                request.onerror = () => reject(request.error);
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

        async clearAllRolls() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.rollStoreName], 'readwrite');
                const store = transaction.objectStore(this.rollStoreName);
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

        async clearFileHash() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.metaStoreName], 'readwrite');
                const store = transaction.objectStore(this.metaStoreName);
                const request = store.delete('currentFileHash');
                request.onsuccess = () => resolve();
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
                    novelName: savedNovelName || '',
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
                for (const r of results) {
                    store.delete(r.id);
                }
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        },

        // ========== 新增：条目级别Roll历史方法 ==========
        async saveEntryRollResult(category, entryName, memoryIndex, result, customPrompt = '') {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.entryRollStoreName], 'readwrite');
                const store = transaction.objectStore(this.entryRollStoreName);
                const entryKey = `${category}:${entryName}`;
                const record = {
                    entryKey,
                    category,
                    entryName,
                    memoryIndex,
                    result: JSON.parse(JSON.stringify(result)),
                    customPrompt,
                    timestamp: Date.now()
                };
                const request = store.add(record);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async getEntryRollResults(category, entryName) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.entryRollStoreName], 'readonly');
                const store = transaction.objectStore(this.entryRollStoreName);
                const index = store.index('entryKey');
                const entryKey = `${category}:${entryName}`;
                const request = index.getAll(entryKey);
                request.onsuccess = () => {
                    const results = request.result || [];
                    // 按时间倒序排列
                    results.sort((a, b) => b.timestamp - a.timestamp);
                    resolve(results);
                };
                request.onerror = () => reject(request.error);
            });
        },

        async clearEntryRollResults(category, entryName) {
            const db = await this.openDB();
            const results = await this.getEntryRollResults(category, entryName);
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.entryRollStoreName], 'readwrite');
                const store = transaction.objectStore(this.entryRollStoreName);
                for (const r of results) {
                    store.delete(r.id);
                }
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        },

        async clearAllEntryRolls() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.entryRollStoreName], 'readwrite');
                const store = transaction.objectStore(this.entryRollStoreName);
                const request = store.clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async deleteEntryRollById(rollId) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.entryRollStoreName], 'readwrite');
                const store = transaction.objectStore(this.entryRollStoreName);
                const request = store.delete(rollId);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async getEntryRollById(rollId) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.entryRollStoreName], 'readonly');
                const store = transaction.objectStore(this.entryRollStoreName);
                const request = store.get(rollId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
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

    // ========== 新增：自定义分类管理函数 ==========
    async function saveCustomCategories() {
        try {
            await MemoryHistoryDB.saveCustomCategories(customWorldbookCategories);
            console.log('自定义分类配置已保存');
        } catch (error) {
            console.error('保存自定义分类配置失败:', error);
        }
    }

    async function loadCustomCategories() {
        try {
            const saved = await MemoryHistoryDB.getCustomCategories();
            if (saved && Array.isArray(saved) && saved.length > 0) {
                customWorldbookCategories = saved;
            }
        } catch (error) {
            console.error('加载自定义分类配置失败:', error);
        }
    }

    async function resetToDefaultCategories() {
        customWorldbookCategories = JSON.parse(JSON.stringify(DEFAULT_WORLDBOOK_CATEGORIES));
        await saveCustomCategories();
        console.log('已重置为默认分类配置');
    }

    async function resetSingleCategory(index) {
        const cat = customWorldbookCategories[index];
        if (!cat) return;

        const defaultCat = DEFAULT_WORLDBOOK_CATEGORIES.find(c => c.name === cat.name);
        if (defaultCat) {
            customWorldbookCategories[index] = JSON.parse(JSON.stringify(defaultCat));
        } else {
            customWorldbookCategories.splice(index, 1);
        }
        await saveCustomCategories();
    }

    function getEnabledCategories() {
        return customWorldbookCategories.filter(cat => cat.enabled);
    }

    function generateDynamicJsonTemplate() {
        const enabledCategories = getEnabledCategories();
        let template = '{\n';
        const parts = [];

        for (const cat of enabledCategories) {
            parts.push(`"${cat.name}": {
"${cat.entryExample}": {
"关键词": ${JSON.stringify(cat.keywordsExample)},
"内容": "${cat.contentGuide}"
}
}`);
        }

        template += parts.join(',\n');
        template += '\n}';
        return template;
    }

    function getEnabledCategoryNames() {
        const names = getEnabledCategories().map(cat => cat.name);
        names.push('剧情大纲', '知识书', '文风配置', '地图环境', '剧情节点');
        return names;
    }

    // ========== 工具函数 ==========
    async function calculateFileHash(content) {
        if (window.crypto && window.crypto.subtle) {
            try {
                const encoder = new TextEncoder();
                const data = encoder.encode(content);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (e) {
                console.warn('Crypto API 失败，回退到简易哈希');
            }
        }
        let hash = 0;
        const len = content.length;
        if (len === 0) return 'hash-empty';
        const sample = len < 100000 ? content : content.slice(0, 1000) + content.slice(Math.floor(len / 2), Math.floor(len / 2) + 1000) + content.slice(-1000);
        for (let i = 0; i < sample.length; i++) {
            hash = ((hash << 5) - hash) + sample.charCodeAt(i);
            hash = hash & hash;
        }
        return 'simple-' + Math.abs(hash).toString(16) + '-' + len;
    }

    function getLanguagePrefix() {
        return settings.language === 'zh' ? '请用中文回复。\n\n' : '';
    }

    // ========== 消息链辅助函数 ==========
    // 将messages数组转换为拼接字符串（用于回退/日志）
    function messagesToString(messages) {
        if (typeof messages === 'string') return messages;
        if (!Array.isArray(messages) || messages.length === 0) return '';
        if (messages.length === 1) return messages[0].content || '';
        return messages.map(m => {
            const roleLabel = m.role === 'system' ? '[System]' : m.role === 'assistant' ? '[Assistant]' : '[User]';
            return `${roleLabel}\n${m.content}`;
        }).join('\n\n');
    }

    // 将字符串prompt通过消息链模板转换为messages数组
    function applyMessageChain(prompt) {
        const chain = settings.promptMessageChain;
        if (!Array.isArray(chain) || chain.length === 0) {
            return [{ role: 'user', content: prompt }];
        }
        const enabledMessages = chain.filter(m => m.enabled !== false);
        if (enabledMessages.length === 0) {
            return [{ role: 'user', content: prompt }];
        }
        return enabledMessages.map(msg => ({
            role: msg.role || 'user',
            content: (msg.content || '').replace(/\{PROMPT\}/g, prompt)
        })).filter(m => m.content.trim().length > 0);
    }

    // ========== 酒馆对话补全预设导入 ==========

    // 酒馆预设里的占位符条目。本插件没有角色卡/聊天记录，需要特殊处理。
    const ST_MARKER_MAP = {
        chatHistory: '{PROMPT}',   // 聊天记录槽 -> 我们的正文提示词
        worldInfoBefore: null,
        worldInfoAfter: null,
        charDescription: null,
        charPersonality: null,
        scenario: null,
        personaDescription: null,
        dialogueExamples: null
    };

    // 解析酒馆对话补全预设 JSON
    function parseTavernPreset(json) {
        if (!json || !Array.isArray(json.prompts)) {
            throw new Error('不是有效的酒馆对话补全预设（缺少 prompts 数组）');
        }

        // identifier -> prompt 映射
        const byId = {};
        for (const p of json.prompts) {
            if (p && p.identifier) byId[p.identifier] = p;
        }

        // 取排布顺序。酒馆用 character_id 100001 作为全局默认档
        let order = null;
        if (Array.isArray(json.prompt_order) && json.prompt_order.length) {
            const global = json.prompt_order.find(o => o.character_id === 100001)
                || json.prompt_order[json.prompt_order.length - 1];
            order = Array.isArray(global && global.order) ? global.order : null;
        }
        // 没有 prompt_order 的老预设：按 prompts 原序
        if (!order) {
            order = json.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));
        }

        const chain = [];
        const depthInjections = [];
        let droppedMarkers = 0, skippedEmpty = 0, hasPromptSlot = false;

        for (const item of order) {
            const p = byId[item.identifier];
            if (!p) continue;

            const enabled = item.enabled !== false;

            // 占位符条目
            if (p.marker === true || Object.prototype.hasOwnProperty.call(ST_MARKER_MAP, p.identifier)) {
                if (ST_MARKER_MAP[p.identifier] === '{PROMPT}') {
                    chain.push({ role: 'user', content: '{PROMPT}', enabled: enabled });
                    hasPromptSlot = true;
                } else {
                    droppedMarkers++;
                }
                continue;
            }

            const content = (p.content || '').trim();
            if (!content) { skippedEmpty++; continue; }

            // 角色：显式 role 优先，否则默认 system
            let role = p.role || 'system';
            if (['system', 'user', 'assistant'].indexOf(role) === -1) role = 'system';

            const entry = { role: role, content: content, enabled: enabled };

            // injection_position: 0=按预设顺序, 1=按深度插进聊天记录
            if (p.injection_position === 1) {
                entry.__depth = typeof p.injection_depth === 'number' ? p.injection_depth : 4;
                depthInjections.push(entry);
            } else {
                chain.push(entry);
            }
        }

        // 深度注入条目：没有真实聊天记录，近似为插在 {PROMPT} 之后，depth 大的靠前
        if (depthInjections.length) {
            depthInjections.sort((a, b) => b.__depth - a.__depth);
            const slotIdx = chain.findIndex(m => m.content === '{PROMPT}');
            const insertAt = slotIdx >= 0 ? slotIdx + 1 : chain.length;
            chain.splice.apply(chain, [insertAt, 0].concat(depthInjections));
        }

        // 预设里没有聊天记录槽时兜底，否则正文发不出去
        if (!hasPromptSlot) {
            chain.push({ role: 'user', content: '{PROMPT}', enabled: true });
        }

        // squash_system_messages：合并相邻的 system 消息
        let finalChain = chain;
        if (json.squash_system_messages === true) {
            finalChain = [];
            for (const m of chain) {
                const prev = finalChain[finalChain.length - 1];
                if (prev && prev.role === 'system' && m.role === 'system'
                    && prev.enabled === m.enabled && m.content !== '{PROMPT}') {
                    prev.content += '\n\n' + m.content;
                } else {
                    finalChain.push({ role: m.role, content: m.content, enabled: m.enabled });
                }
            }
        }

        // 采样参数
        const num = v => (typeof v === 'number' && !isNaN(v)) ? v : null;
        const maxTok = num(json.openai_max_tokens);
        const params = {
            temperature: num(json.temperature),
            maxTokens: maxTok !== null ? maxTok : (num(json.max_tokens) !== null ? num(json.max_tokens) : num(json.genamt)),
            topP: num(json.top_p),
            freqPenalty: num(json.frequency_penalty),
            presPenalty: num(json.presence_penalty)
        };

        return {
            chain: finalChain,
            params: params,
            stats: {
                used: finalChain.length,
                enabled: finalChain.filter(m => m.enabled !== false).length,
                droppedMarkers: droppedMarkers,
                skippedEmpty: skippedEmpty,
                hadPromptSlot: hasPromptSlot
            }
        };
    }

    // 把解析结果写入设置并刷新界面
    function applyTavernPreset(parsed, presetName) {
        settings.promptMessageChain = parsed.chain.map(m => ({
            role: m.role,
            content: m.content,
            enabled: m.enabled !== false
        }));

        const p = parsed.params;
        if (p.temperature !== null) settings.presetTemperature = p.temperature;
        if (p.maxTokens !== null) settings.presetMaxTokens = p.maxTokens;
        if (p.topP !== null) settings.presetTopP = p.topP;
        if (p.freqPenalty !== null) settings.presetFreqPenalty = p.freqPenalty;
        if (p.presPenalty !== null) settings.presetPresPenalty = p.presPenalty;
        settings.importedPresetName = presetName || '';

        saveCurrentSettings();
        renderMessageChainUI();
    }

    // 将messages转换为Gemini原生格式
    function convertToGeminiContents(messages) {
        const systemMsgs = messages.filter(m => m.role === 'system');
        const nonSystemMsgs = messages.filter(m => m.role !== 'system');

        // Gemini要求contents中role交替出现，合并连续同角色消息
        const merged = [];
        for (const msg of nonSystemMsgs) {
            const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
            if (merged.length > 0 && merged[merged.length - 1].role === geminiRole) {
                merged[merged.length - 1].parts[0].text += '\n\n' + msg.content;
            } else {
                merged.push({ role: geminiRole, parts: [{ text: msg.content }] });
            }
        }
        // Gemini要求第一条必须是user
        if (merged.length > 0 && merged[0].role !== 'user') {
            merged.unshift({ role: 'user', parts: [{ text: '请根据以下对话执行任务。' }] });
        }

        const result = { contents: merged };
        if (systemMsgs.length > 0) {
            result.systemInstruction = {
                parts: [{ text: systemMsgs.map(m => m.content).join('\n\n') }]
            };
        }
        return result;
    }

    // 响应内容过滤（移除thinking等标签）
    function filterResponseContent(text) {
        if (!text) return text;
        const filterTagsStr = settings.filterResponseTags || 'thinking,/think';
        const filterTags = filterTagsStr.split(',').map(t => t.trim()).filter(t => t);
        let cleaned = text;
        for (const tag of filterTags) {
            if (tag.startsWith('/')) {
                const tagName = tag.substring(1);
                cleaned = cleaned.replace(new RegExp(`^[\\s\\S]*?<\\/${tagName}>`, 'gi'), '');
            } else {
                cleaned = cleaned.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
            }
        }
        return cleaned;
    }

    function isTokenLimitError(errorMsg) {
        if (!errorMsg) return false;
        // 【修复】只检查前500字符（错误信息不会太长，避免在AI正常响应内容中误匹配）
        const checkStr = String(errorMsg).substring(0, 500);
        const patterns = [
            /prompt is too long/i, /tokens? >\s*\d+\s*maximum/i, /max_prompt_tokens/i,
            /tokens?.*exceeded/i, /context.?length.*exceeded/i, /exceeded.*(?:token|limit|context|maximum)/i,
            /input tokens/i, /context_length/i, /too many tokens/i,
            /token limit/i, /maximum.*tokens/i, /20015.*limit/i, /INVALID_ARGUMENT/i
        ];
        return patterns.some(pattern => pattern.test(checkStr));
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

    // 【新增】调试模式日志 - 带时间戳输出到实时输出面板
    function debugLog(msg) {
        if (!settings.debugMode) return;
        const now = new Date();
        const ts = now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
        updateStreamContent(`[${ts}] 🔍 ${msg}\n`);
    }
    // 位置值转中文显示
    function getPositionDisplayName(position) {
        const positionNames = {
            0: '在角色定义之前',
            1: '在角色定义之后',
            2: '在作者注释之前',
            3: '在作者注释之后',
            4: '自定义深度'
        };
        return positionNames[position] || '在角色定义之前';
    }

    // ========== 分类灯状态管理 ==========
    function getCategoryLightState(category) {
        if (categoryLightSettings.hasOwnProperty(category)) {
            return categoryLightSettings[category];
        }
        return false;
    }

    function setCategoryLightState(category, isGreen) {
        categoryLightSettings[category] = isGreen;
        saveCategoryLightSettings();
    }

    function saveCategoryLightSettings() {
        settings.categoryLightSettings = { ...categoryLightSettings };
        try { localStorage.setItem('txtToWorldbookSettings', JSON.stringify(settings)); } catch (e) { }
    }

    function loadCategoryLightSettings() {
        if (settings.categoryLightSettings) {
            categoryLightSettings = { ...categoryLightSettings, ...settings.categoryLightSettings };
        }
    }

    // ========== 新增：条目位置/深度/顺序配置管理 ==========
    function getEntryConfig(category, entryName) {
        const key = `${category}::${entryName}`;
        if (entryPositionConfig[key]) {
            return entryPositionConfig[key];
        }
        // 特殊处理：剧情大纲
        if (category === '剧情大纲') {
            return {
                position: plotOutlineExportConfig.position || 0,
                depth: plotOutlineExportConfig.depth || 4,
                order: plotOutlineExportConfig.order || 100,
                autoIncrementOrder: plotOutlineExportConfig.autoIncrementOrder || false
            };
        }
        // 优先从分类配置获取
        if (categoryDefaultConfig[category]) {
            return { ...categoryDefaultConfig[category] };
        }
        // 从自定义分类获取默认配置
        const catConfig = customWorldbookCategories.find(c => c.name === category);
        if (catConfig) {
            return {
                position: catConfig.defaultPosition || 0,
                depth: catConfig.defaultDepth || 4,
                order: catConfig.defaultOrder || 100,
                autoIncrementOrder: catConfig.autoIncrementOrder || false
            };
        }
        return { position: 0, depth: 4, order: 100, autoIncrementOrder: false };
    }


    // 新增：获取分类是否自动递增顺序
    // 获取分类是否自动递增顺序
    function getCategoryAutoIncrement(category) {
        // 特殊处理：剧情大纲
        if (category === '剧情大纲') {
            return plotOutlineExportConfig.autoIncrementOrder || false;
        }
        if (categoryDefaultConfig[category]?.autoIncrementOrder !== undefined) {
            return categoryDefaultConfig[category].autoIncrementOrder;
        }
        const catConfig = customWorldbookCategories.find(c => c.name === category);
        return catConfig?.autoIncrementOrder || false;
    }

    // 获取分类的起始顺序
    function getCategoryBaseOrder(category) {
        // 特殊处理：剧情大纲
        if (category === '剧情大纲') {
            return plotOutlineExportConfig.order || 100;
        }
        if (categoryDefaultConfig[category]?.order !== undefined) {
            return categoryDefaultConfig[category].order;
        }
        const catConfig = customWorldbookCategories.find(c => c.name === category);
        return catConfig?.defaultOrder || 100;
    }



    function setEntryConfig(category, entryName, config) {
        const key = `${category}::${entryName}`;
        entryPositionConfig[key] = { ...config };
        settings.entryPositionConfig = entryPositionConfig;
        saveCurrentSettings();
    }

    function setCategoryDefaultConfig(category, config) {
        categoryDefaultConfig[category] = {
            position: config.position !== undefined ? config.position : 0,
            depth: config.depth !== undefined ? config.depth : 4,
            order: config.order !== undefined ? config.order : 100,
            autoIncrementOrder: config.autoIncrementOrder || false
        };
        settings.categoryDefaultConfig = categoryDefaultConfig;
        saveCurrentSettings();
    }


    // ========== API调用 - 酒馆API ==========
    async function callSillyTavernAPI(messages, taskId = null) {
        const timeout = settings.apiTimeout || 120000;
        const logPrefix = taskId !== null ? `[任务${taskId}]` : '';
        const combinedPrompt = messagesToString(messages);
        updateStreamContent(`\n📤 ${logPrefix} 发送请求到酒馆API (${messages.length}条消息)...\n`);
        debugLog(`${logPrefix} 酒馆API开始调用, 消息数=${messages.length}, 总长度=${combinedPrompt.length}, 超时=${timeout / 1000}秒`);

        try {
            if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
                throw new Error('无法访问SillyTavern上下文');
            }

            const context = SillyTavern.getContext();
            debugLog(`${logPrefix} 获取到SillyTavern上下文`);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`API请求超时 (${timeout / 1000}秒)`)), timeout);
            });

            let result;

            if (typeof context.generateRaw === 'function') {
                try {
                    // 尝试新版格式：ST 1.13.2+ 支持 generateRaw({ prompt: messages[] })
                    debugLog(`${logPrefix} 尝试generateRaw消息数组格式 (ST 1.13.2+)`);
                    result = await Promise.race([
                        context.generateRaw({ prompt: messages }),
                        timeoutPromise
                    ]);
                    debugLog(`${logPrefix} generateRaw消息数组格式成功`);
                } catch (rawError) {
                    // 超时/API本身的错误直接抛出
                    if (rawError.message?.includes('超时') || rawError.message?.includes('timeout') ||
                        rawError.message?.includes('API') || rawError.message?.includes('limit')) {
                        throw rawError;
                    }
                    // 其他错误（可能是旧版ST不支持对象参数），回退字符串格式
                    debugLog(`${logPrefix} 消息数组格式不支持(${rawError.message})，回退字符串模式`);
                    updateStreamContent(`⚠️ ${logPrefix} 酒馆不支持消息数组格式，已回退为字符串模式\n`);
                    result = await Promise.race([
                        context.generateRaw(combinedPrompt, '', false),
                        timeoutPromise
                    ]);
                }
            } else if (typeof context.generateQuietPrompt === 'function') {
                debugLog(`${logPrefix} 使用generateQuietPrompt（字符串模式）`);
                updateStreamContent(`ℹ️ ${logPrefix} 酒馆API: 使用generateQuietPrompt（字符串模式，消息角色不生效）\n`);
                result = await Promise.race([
                    context.generateQuietPrompt(combinedPrompt, false, false),
                    timeoutPromise
                ]);
            } else {
                throw new Error('无法找到可用的生成函数');
            }

            debugLog(`${logPrefix} 收到响应, 长度=${result.length}字符`);
            updateStreamContent(`📥 ${logPrefix} 收到响应 (${result.length}字符)\n`);
            return result;

        } catch (error) {
            debugLog(`${logPrefix} 酒馆API出错: ${error.message}`);
            updateStreamContent(`\n❌ ${logPrefix} 错误: ${error.message}\n`);
            throw error;
        }
    }

    // ========== API调用 - 自定义API ==========
    async function callCustomAPI(messages, retryCount = 0) {
        const maxRetries = 3;
        const timeout = settings.apiTimeout || 120000;
        let requestUrl, requestOptions;

        const provider = settings.customApiProvider;
        const apiKey = settings.customApiKey;
        const endpoint = settings.customApiEndpoint;
        const model = settings.customApiModel;

        const combinedPrompt = messagesToString(messages);
        updateStreamContent(`\n📤 发送请求到自定义API (${provider}, ${messages.length}条消息)...\n`);
        debugLog(`自定义API开始调用, provider=${provider}, model=${model}, 消息数=${messages.length}, 总长度=${combinedPrompt.length}, 重试=${retryCount}`);

        // 构建OpenAI兼容的messages数组
        const openaiMessages = messages.map(m => ({ role: m.role, content: m.content }));

        // 采样参数（来自导入的酒馆预设，未导入时用原有默认值）
        const _sp = {
            temperature: (settings.presetTemperature !== null && settings.presetTemperature !== undefined)
                ? settings.presetTemperature : 0.3,
            top_p: settings.presetTopP,
            frequency_penalty: settings.presetFreqPenalty,
            presence_penalty: settings.presetPresPenalty
        };
        const withSampling = (obj, defaultMaxTokens) => {
            const out = Object.assign({}, obj);
            out.temperature = _sp.temperature;
            out.max_tokens = settings.presetMaxTokens || defaultMaxTokens;
            if (_sp.top_p !== null && _sp.top_p !== undefined) out.top_p = _sp.top_p;
            if (_sp.frequency_penalty !== null && _sp.frequency_penalty !== undefined) out.frequency_penalty = _sp.frequency_penalty;
            if (_sp.presence_penalty !== null && _sp.presence_penalty !== undefined) out.presence_penalty = _sp.presence_penalty;
            return out;
        };

        switch (provider) {
            case 'deepseek':
                if (!apiKey) throw new Error('DeepSeek API Key 未设置');
                requestUrl = 'https://api.deepseek.com/chat/completions';
                requestOptions = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(withSampling({
                        model: model || 'deepseek-chat',
                        messages: openaiMessages
                    }, 8192)),
                };
                break;

            case 'gemini': {
                if (!apiKey) throw new Error('Gemini API Key 未设置');
                const geminiModel = model || 'gemini-2.5-flash';
                requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
                const geminiData = convertToGeminiContents(messages);
                const geminiGenConfig = {
                    maxOutputTokens: settings.presetMaxTokens || 65536,
                    temperature: _sp.temperature
                };
                if (_sp.top_p !== null && _sp.top_p !== undefined) geminiGenConfig.topP = _sp.top_p;
                const geminiBody = {
                    ...geminiData,
                    generationConfig: geminiGenConfig,
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
                    ]
                };
                requestOptions = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(geminiBody),
                };
                break;
            }

            case 'gemini-proxy': {
                if (!endpoint) throw new Error('Gemini Proxy Endpoint 未设置');
                if (!apiKey) throw new Error('Gemini Proxy API Key 未设置');

                let proxyBaseUrl = endpoint;
                if (!proxyBaseUrl.startsWith('http')) proxyBaseUrl = 'https://' + proxyBaseUrl;
                if (proxyBaseUrl.endsWith('/')) proxyBaseUrl = proxyBaseUrl.slice(0, -1);

                const geminiProxyModel = model || 'gemini-2.5-flash';
                const useOpenAIFormat = proxyBaseUrl.endsWith('/v1');

                if (useOpenAIFormat) {
                    requestUrl = proxyBaseUrl + '/chat/completions';
                    requestOptions = {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        body: JSON.stringify(withSampling({
                            model: geminiProxyModel,
                            messages: openaiMessages
                        }, 65536)),
                    };
                } else {
                    const finalProxyUrl = `${proxyBaseUrl}/${geminiProxyModel}:generateContent`;
                    requestUrl = finalProxyUrl.includes('?')
                        ? `${finalProxyUrl}&key=${apiKey}`
                        : `${finalProxyUrl}?key=${apiKey}`;
                    const geminiProxyData = convertToGeminiContents(messages);
                    requestOptions = {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ...geminiProxyData,
                            generationConfig: {
                                maxOutputTokens: settings.presetMaxTokens || 65536,
                                temperature: _sp.temperature
                            }
                        }),
                    };
                }
                break;
            }

            case 'openai-compatible': {
                let openaiEndpoint = endpoint || 'http://127.0.0.1:5000/v1/chat/completions';
                const openaiModel = model || 'local-model';

                if (!openaiEndpoint.includes('/chat/completions')) {
                    if (openaiEndpoint.endsWith('/v1')) {
                        openaiEndpoint += '/chat/completions';
                    } else {
                        openaiEndpoint = openaiEndpoint.replace(/\/$/, '') + '/chat/completions';
                    }
                }

                if (!openaiEndpoint.startsWith('http')) {
                    openaiEndpoint = 'http://' + openaiEndpoint;
                }

                requestUrl = openaiEndpoint;
                const headers = { 'Content-Type': 'application/json' };
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                requestOptions = {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(withSampling({
                        model: openaiModel,
                        messages: openaiMessages,
                        stream: true
                    }, 64000)),
                };
                break;
            }

            default:
                throw new Error(`不支持的API提供商: ${provider}`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        requestOptions.signal = controller.signal;

        // 检测是否为流式请求（openai-compatible启用stream:true）
        let isStreamRequest = false;
        try {
            const bodyObj = JSON.parse(requestOptions.body);
            isStreamRequest = bodyObj.stream === true;
        } catch (e) { }

        try {
            debugLog(`自定义API发送fetch请求到: ${requestUrl.substring(0, 80)}...`);
            const response = await fetch(requestUrl, requestOptions);
            clearTimeout(timeoutId);
            debugLog(`自定义API收到HTTP响应, status=${response.status}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.log('API错误响应:', errorText);

                if (response.status === 429 || errorText.includes('resource_exhausted') || errorText.includes('rate limit')) {
                    if (retryCount < maxRetries) {
                        const delay = Math.pow(2, retryCount) * 1000;
                        updateStreamContent(`⏳ 遇到限流，${delay}ms后重试...\n`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return callCustomAPI(messages, retryCount + 1);
                    } else {
                        throw new Error(`API限流：已达到最大重试次数`);
                    }
                }

                throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
            }

            // ========== 流式SSE响应处理 ==========
            if (isStreamRequest && response.body) {
                debugLog(`自定义API开始读取流式响应...`);
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let fullContent = '';
                let buffer = '';
                // 活动超时：如果超过inactivityTimeout没有收到新数据，中断
                const inactivityTimeout = Math.min(timeout, 120000); // 最多等2分钟无数据
                let lastDataTime = Date.now();
                let inactivityTimer = null;

                const resetInactivityTimer = () => {
                    lastDataTime = Date.now();
                    if (inactivityTimer) clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(() => {
                        debugLog(`流式响应无数据超时 (${inactivityTimeout / 1000}秒无新数据)`);
                        try { reader.cancel(); } catch (e) { }
                    }, inactivityTimeout);
                };

                resetInactivityTimer();

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        resetInactivityTimer();
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed.startsWith(':')) continue; // SSE注释或空行
                            if (trimmed.startsWith('data: ')) {
                                const dataStr = trimmed.slice(6).trim();
                                if (dataStr === '[DONE]') continue;
                                try {
                                    const parsed = JSON.parse(dataStr);
                                    const delta = parsed.choices?.[0]?.delta?.content || '';
                                    if (delta) {
                                        fullContent += delta;
                                    }
                                } catch (e) {
                                    // 非JSON的data行，跳过
                                }
                            }
                        }
                    }
                } finally {
                    if (inactivityTimer) clearTimeout(inactivityTimer);
                }

                // 处理buffer中剩余数据
                if (buffer.trim()) {
                    const trimmed = buffer.trim();
                    if (trimmed.startsWith('data: ') && trimmed.slice(6).trim() !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(trimmed.slice(6).trim());
                            const delta = parsed.choices?.[0]?.delta?.content || '';
                            if (delta) fullContent += delta;
                        } catch (e) { }
                    }
                }

                debugLog(`自定义API流式读取完成, 结果长度=${fullContent.length}字符`);
                updateStreamContent(`📥 收到流式响应 (${fullContent.length}字符)\n`);
                return fullContent;
            }

            // ========== 非流式响应处理（Gemini等） ==========
            const data = await response.json();
            debugLog(`自定义API JSON解析完成, 开始提取内容`);
            let result;

            if (provider === 'gemini') {
                result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else if (provider === 'gemini-proxy') {
                if (data.candidates) {
                    result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                } else if (data.choices) {
                    result = data.choices?.[0]?.message?.content || '';
                }
            } else {
                result = data.choices?.[0]?.message?.content || '';
            }

            debugLog(`自定义API提取完成, 结果长度=${result.length}字符`);
            updateStreamContent(`📥 收到响应 (${result.length}字符)\n`);
            return result;

        } catch (error) {
            clearTimeout(timeoutId);
            debugLog(`自定义API出错: ${error.name} - ${error.message}`);
            if (error.name === 'AbortError') {
                throw new Error(`API请求超时 (${timeout / 1000}秒)`);
            }
            throw error;
        }
    }

    // ========== 拉取模型列表 ==========
    async function fetchModelList() {
        const endpoint = settings.customApiEndpoint || '';
        if (!endpoint) {
            throw new Error('请先设置 API Endpoint');
        }

        let modelsUrl = endpoint;
        if (modelsUrl.endsWith('/chat/completions')) {
            modelsUrl = modelsUrl.replace('/chat/completions', '/models');
        } else if (modelsUrl.endsWith('/v1')) {
            modelsUrl = modelsUrl + '/models';
        } else if (!modelsUrl.endsWith('/models')) {
            modelsUrl = modelsUrl.replace(/\/$/, '') + '/models';
        }

        if (!modelsUrl.startsWith('http')) {
            modelsUrl = 'http://' + modelsUrl;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (settings.customApiKey) {
            headers['Authorization'] = `Bearer ${settings.customApiKey}`;
        }

        console.log('📤 拉取模型列表:', modelsUrl);

        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`拉取模型列表失败: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('📥 模型列表响应:', data);

        let models = [];
        if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => m.id || m.name || m);
        } else if (Array.isArray(data)) {
            models = data.map(m => typeof m === 'string' ? m : (m.id || m.name || m));
        } else if (data.models && Array.isArray(data.models)) {
            models = data.models.map(m => typeof m === 'string' ? m : (m.id || m.name || m));
        }

        return models;
    }

    // ========== 快速测试 ==========
    async function quickTestModel() {
        const endpoint = settings.customApiEndpoint || '';
        const model = settings.customApiModel || '';

        if (!endpoint) {
            throw new Error('请先设置 API Endpoint');
        }
        if (!model) {
            throw new Error('请先设置模型名称');
        }

        let requestUrl = endpoint;
        if (!requestUrl.includes('/chat/completions')) {
            if (requestUrl.endsWith('/v1')) {
                requestUrl += '/chat/completions';
            } else {
                requestUrl = requestUrl.replace(/\/$/, '') + '/chat/completions';
            }
        }

        if (!requestUrl.startsWith('http')) {
            requestUrl = 'http://' + requestUrl;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (settings.customApiKey) {
            headers['Authorization'] = `Bearer ${settings.customApiKey}`;
        }

        console.log('📤 快速测试:', requestUrl, '模型:', model);

        const startTime = Date.now();

        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: 'Say "OK" if you can hear me.' }],
                max_tokens: 100,
                temperature: 0.1
            })
        });

        const elapsed = Date.now() - startTime;

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`测试失败: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('📥 测试响应:', data);

        let responseText = '';

        if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
            const choice = data.choices[0];
            if (choice.message && choice.message.content) {
                responseText = choice.message.content;
            } else if (choice.text) {
                responseText = choice.text;
            } else if (typeof choice.content === 'string') {
                responseText = choice.content;
            }
        } else if (data.response) {
            responseText = data.response;
        } else if (data.content) {
            responseText = data.content;
        } else if (data.text) {
            responseText = data.text;
        } else if (data.output) {
            responseText = data.output;
        } else if (data.generated_text) {
            responseText = data.generated_text;
        }

        if (!responseText || responseText.trim() === '') {
            console.warn('无法解析响应，完整数据:', JSON.stringify(data, null, 2));

            const possibleFields = ['result', 'message', 'data', 'completion'];
            for (const field of possibleFields) {
                if (data[field]) {
                    if (typeof data[field] === 'string') {
                        responseText = data[field];
                        break;
                    } else if (typeof data[field] === 'object' && data[field].content) {
                        responseText = data[field].content;
                        break;
                    }
                }
            }
        }

        if (!responseText || responseText.trim() === '') {
            throw new Error(`API返回了无法解析的响应格式。\n响应数据: ${JSON.stringify(data).substring(0, 200)}`);
        }

        return {
            success: true,
            elapsed: elapsed,
            response: responseText.substring(0, 100)
        };
    }

    // ========== 统一API调用入口 ==========
    async function callAPI(prompt, taskId = null) {
        // 将字符串prompt通过消息链模板转换为messages数组
        const messages = applyMessageChain(prompt);
        debugLog(`callAPI: 消息链转换完成, ${messages.length}条消息, roles=[${messages.map(m => m.role).join(',')}]`);
        if (settings.useTavernApi) {
            return await callSillyTavernAPI(messages, taskId);
        } else {
            return await callCustomAPI(messages);
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
                        targetEntry['关键词'] = [...new Set([...targetEntry['关键词'], ...sourceEntry['关键词']])];
                    } else if (Array.isArray(sourceEntry['关键词'])) {
                        targetEntry['关键词'] = sourceEntry['关键词'];
                    }
                    if (sourceEntry['内容']) {
                        const existingContent = targetEntry['内容'] || '';
                        const newContent = sourceEntry['内容'];
                        if (newContent && !existingContent.includes(newContent.substring(0, 50))) {
                            targetEntry['内容'] = existingContent + '\n\n---\n\n' + newContent;
                        }
                    }
                } else {
                    target[category][entryName] = JSON.parse(JSON.stringify(sourceEntry));
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
        debugLog(`合并世界书[${memoryTitle}] 开始, 深拷贝快照...`);
        const previousWorldbook = JSON.parse(JSON.stringify(target));
        if (incrementalOutputMode) {
            mergeWorldbookDataIncremental(target, source);
        } else {
            mergeWorldbookData(target, source);
        }
        debugLog(`合并世界书[${memoryTitle}] 合并完成, 计算差异...`);
        const changedEntries = findChangedEntries(previousWorldbook, target);
        if (changedEntries.length > 0) {
            debugLog(`合并世界书[${memoryTitle}] 发现${changedEntries.length}处变更, 保存历史...`);
            await MemoryHistoryDB.saveHistory(memoryIndex, memoryTitle, previousWorldbook, target, changedEntries);
        }
        debugLog(`合并世界书[${memoryTitle}] 全部完成`);
        return changedEntries;
    }

    // ========== 后处理添加章节编号后缀 ==========
    function postProcessResultWithChapterIndex(result, chapterIndex) {
        if (!result || typeof result !== 'object') return result;
        if (!settings.forceChapterMarker) return result;

        const processed = {};
        for (const category in result) {
            if (typeof result[category] !== 'object' || result[category] === null) {
                processed[category] = result[category];
                continue;
            }
            processed[category] = {};
            for (const entryName in result[category]) {
                let newEntryName = entryName;
                if (category === '剧情大纲' || category === '剧情节点' || category === '章节剧情') {
                    newEntryName = entryName.replace(/第[一二三四五六七八九十百千万\d]+章/g, `第${chapterIndex}章`);
                    if (!newEntryName.includes(`第${chapterIndex}章`) && !newEntryName.includes('-第')) {
                        newEntryName = `${newEntryName}-第${chapterIndex}章`;
                    }
                }
                processed[category][newEntryName] = result[category][entryName];
            }
        }
        return processed;
    }

    // ========== 解析AI响应 ==========
    function extractWorldbookDataByRegex(jsonString) {
        const result = {};
        const categories = getEnabledCategoryNames();
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
                        else if (char === '"') {
                            // 【v3.0.6修复】不再无条件break，判断这个"是否是真正的字符串结束引号
                            // 向后跳过空白，看下一个有意义字符是否是JSON结构字符
                            let peekPos = contentEndPos + 1;
                            while (peekPos < entryContent.length && /[\s\r\n]/.test(entryContent[peekPos])) peekPos++;
                            const nextChar = entryContent[peekPos];
                            if (nextChar === ',' || nextChar === '}' || nextChar === ']' || nextChar === undefined) {
                                break; // 真正的字符串结束
                            }
                            // 否则是内容中未转义的引号，跳过继续
                        }
                        contentEndPos++;
                    }
                    content = entryContent.substring(contentStartPos, contentEndPos);
                    try { content = JSON.parse(`"${content.replace(/(?<!\\)"/g, '\\"')}"`); }
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

    // 【v3.0.6新增】修复JSON字符串值中未转义的双引号
    // AI常见错误：输出 "搜索传说生物"发神"" 而非 "搜索传说生物\"发神\""
    // 状态机扫描JSON，识别出字符串值内部的未转义 " 并转义为 \"
    function repairJsonUnescapedQuotes(jsonStr) {
        let result = '';
        let inString = false;
        let i = 0;

        while (i < jsonStr.length) {
            const char = jsonStr[i];

            // 在字符串内遇到反斜杠，保留转义序列原样
            if (inString && char === '\\') {
                result += char;
                if (i + 1 < jsonStr.length) {
                    result += jsonStr[i + 1];
                    i += 2;
                } else {
                    i++;
                }
                continue;
            }

            if (char === '"') {
                if (!inString) {
                    // 进入字符串
                    inString = true;
                    result += char;
                    i++;
                    continue;
                }

                // 在字符串内遇到 " —— 判断是字符串结束还是未转义的内容引号
                // 向后跳过空白，看下一个有意义字符
                let j = i + 1;
                while (j < jsonStr.length && /[\s\r\n]/.test(jsonStr[j])) j++;
                const nextChar = jsonStr[j];

                if (nextChar === ':' || nextChar === ',' ||
                    nextChar === '}' || nextChar === ']' ||
                    nextChar === undefined) {
                    // 后面是JSON结构字符 → 这是字符串的结束引号
                    inString = false;
                    result += char;
                } else {
                    // 后面不是JSON结构字符 → 这是内容中的未转义引号，修复它
                    result += '\\"';
                }
                i++;
                continue;
            }

            result += char;
            i++;
        }

        return result;
    }

    function parseAIResponse(response) {
        debugLog(`解析响应开始, 响应长度=${response.length}字符`);
        // 【修复】获取用户配置的过滤标签
        const filterTagsStr = settings.filterResponseTags || 'thinking,/think';
        const filterTags = filterTagsStr.split(',').map(t => t.trim()).filter(t => t);

        let cleaned = response;

        // 处理用户定义的过滤标签
        for (const tag of filterTags) {
            if (tag.startsWith('/')) {
                // 情况2: 以/开头，如 /think，表示移除从开头到</think>的内容
                const tagName = tag.substring(1);
                const endTagRegex = new RegExp(`^[\\s\\S]*?<\\/${tagName}>`, 'gi');
                cleaned = cleaned.replace(endTagRegex, '');
            } else {
                // 情况1: 普通标签名，如 thinking，表示移除完整标签对<thinking>内容</thinking>
                const fullTagRegex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi');
                cleaned = cleaned.replace(fullTagRegex, '');
            }
        }

        try {
            return JSON.parse(cleaned.trim());
        } catch (e) {
            let clean = cleaned.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '');
            const first = clean.indexOf('{');
            const last = clean.lastIndexOf('}');
            if (first !== -1 && last > first) clean = clean.substring(first, last + 1);
            try {
                return JSON.parse(clean);
            } catch (e2) {
                // 【v3.0.6修复】尝试修复JSON字符串值中未转义的双引号（AI常见格式错误）
                try {
                    const repaired = repairJsonUnescapedQuotes(clean);
                    return JSON.parse(repaired);
                } catch (e2b) {
                    debugLog('修复未转义引号后仍解析失败，进入bracket补全/regex fallback');
                }
                const open = (clean.match(/{/g) || []).length;
                const close = (clean.match(/}/g) || []).length;
                if (open > close) {
                    let patched = clean + '}'.repeat(open - close);
                    try { return JSON.parse(patched); }
                    catch (e3) {
                        // 【v3.0.6】补全括号后也尝试修复引号
                        try {
                            const repairedPatched = repairJsonUnescapedQuotes(patched);
                            return JSON.parse(repairedPatched);
                        } catch (e3b) { /* fall through */ }
                        return extractWorldbookDataByRegex(clean);
                    }
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

    function deleteSelectedMemories() {
        if (selectedMemoryIndices.size === 0) {
            alert('请先选择要删除的章节');
            return;
        }

        const hasProcessed = [...selectedMemoryIndices].some(i => memoryQueue[i]?.processed && !memoryQueue[i]?.failed);
        let confirmMsg = `确定要删除选中的 ${selectedMemoryIndices.size} 个章节吗？`;
        if (hasProcessed) {
            confirmMsg += '\n\n⚠️ 警告：选中的章节中包含已处理的章节，删除后相关的世界书数据不会自动更新！';
        }

        if (!confirm(confirmMsg)) return;

        const sortedIndices = [...selectedMemoryIndices].sort((a, b) => b - a);
        for (const index of sortedIndices) {
            memoryQueue.splice(index, 1);
        }

        memoryQueue.forEach((m, i) => {
            if (!m.title.includes('-')) m.title = `记忆${i + 1}`;
        });

        startFromIndex = Math.min(startFromIndex, Math.max(0, memoryQueue.length - 1));
        if (userSelectedStartIndex !== null) {
            userSelectedStartIndex = Math.min(userSelectedStartIndex, Math.max(0, memoryQueue.length - 1));
        }

        selectedMemoryIndices.clear();
        isMultiSelectMode = false;

        updateMemoryQueueUI();
        updateStartButtonState(false);
    }

    // ========== 获取系统提示词 ==========
    function getSystemPrompt() {
        let worldbookPrompt = settings.customWorldbookPrompt?.trim() || defaultWorldbookPrompt;

        const dynamicTemplate = generateDynamicJsonTemplate();
        worldbookPrompt = worldbookPrompt.replace('{DYNAMIC_JSON_TEMPLATE}', dynamicTemplate);

        // 【修复】动态替换启用的分类名称
        const enabledCatNames = getEnabledCategories().map(c => c.name);
        if (settings.enablePlotOutline) enabledCatNames.push('剧情大纲');
        if (settings.enableLiteraryStyle) enabledCatNames.push('文风配置');
        worldbookPrompt = worldbookPrompt.replace('{ENABLED_CATEGORY_NAMES}', enabledCatNames.join('、'));

        const additionalParts = [];
        if (settings.enablePlotOutline) {
            additionalParts.push(settings.customPlotPrompt?.trim() || defaultPlotPrompt);
        }
        if (settings.enableLiteraryStyle) {
            additionalParts.push(settings.customStylePrompt?.trim() || defaultStylePrompt);
        }
        if (additionalParts.length === 0) return worldbookPrompt;
        let fullPrompt = worldbookPrompt;
        const insertContent = ',\n' + additionalParts.join(',\n');
        fullPrompt = fullPrompt.replace(/(\}\s*)\n\`\`\`/, `${insertContent}\n$1\n\`\`\``);
        return fullPrompt;
    }

    // ========== 获取上一个记忆的处理结果摘要 ==========
    function getPreviousMemoryContext(index) {
        if (index <= 0) return '';

        for (let i = index - 1; i >= 0; i--) {
            const prevMemory = memoryQueue[i];
            if (prevMemory && prevMemory.processed && prevMemory.result && !prevMemory.failed) {
                const plotContext = [];
                const result = prevMemory.result;

                if (result['剧情大纲']) {
                    for (const entryName in result['剧情大纲']) {
                        plotContext.push(`${entryName}: ${result['剧情大纲'][entryName]['内容']?.substring(0, 200) || ''}`);
                    }
                }
                if (result['剧情节点']) {
                    for (const entryName in result['剧情节点']) {
                        plotContext.push(`${entryName}: ${result['剧情节点'][entryName]['内容']?.substring(0, 200) || ''}`);
                    }
                }
                if (result['章节剧情']) {
                    for (const entryName in result['章节剧情']) {
                        plotContext.push(`${entryName}: ${result['章节剧情'][entryName]['内容']?.substring(0, 200) || ''}`);
                    }
                }

                if (plotContext.length > 0) {
                    return `\n\n【上一章节(第${i + 1}章)的剧情进展】：\n${plotContext.join('\n')}\n\n请在此基础上继续分析后续剧情，不要重复输出已有的章节。`;
                }
                break;
            }
        }
        return '';
    }

    // ========== 生成章节强制标记提示词 ==========
    function getChapterForcePrompt(chapterIndex) {
        return `
【强制章节标记 - 开始】
强制无视内容中的任何章节信息！本轮全文章节统一为：第${chapterIndex}章
无论原文中出现"第一章"、"第二章"等任何章节标记，你输出时都必须将其替换为"第${chapterIndex}章"。
【强制章节标记 - 结束】
`;
    }

    // ========== 并行处理 ==========
    async function processMemoryChunkIndependent(index, retryCount = 0, customPromptSuffix = '') {
        const memory = memoryQueue[index];
        const maxRetries = 3;
        const taskId = index + 1;
        const chapterIndex = index + 1;

        if (!isRerolling && isProcessingStopped) throw new Error('ABORTED');

        memory.processing = true;
        updateMemoryQueueUI();

        const chapterForcePrompt = settings.forceChapterMarker ? getChapterForcePrompt(chapterIndex) : '';

        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix() + getSystemPrompt();

        const prevContext = getPreviousMemoryContext(index);
        if (prevContext) {
            prompt += prevContext;
        }

        if (index > 0 && memoryQueue[index - 1].content) {
            prompt += `\n\n前文结尾（供参考）：\n---\n${memoryQueue[index - 1].content.slice(-800)}\n---\n`;
        }

        prompt += `\n\n当前需要分析的内容（第${chapterIndex}章）：\n---\n${memory.content}\n---\n`;

        // 获取所有启用的分类名称（包括基本分类和特殊分类）
        const enabledCatNamesList = getEnabledCategories().map(c => c.name);
        // 添加特殊分类（只有剧情大纲和文风配置有独立的启用开关）
        if (settings.enablePlotOutline) enabledCatNamesList.push('剧情大纲');
        if (settings.enableLiteraryStyle) enabledCatNamesList.push('文风配置');

        const enabledCatNamesStr = enabledCatNamesList.join('、');

        prompt += `\n\n【输出限制】只允许输出以下分类：${enabledCatNamesStr}。禁止输出未列出的任何其他分类，直接输出JSON。`;

        if (settings.forceChapterMarker) {
            prompt += `\n\n【重要提醒】如果输出剧情大纲或剧情节点或章节剧情，条目名称必须包含"第${chapterIndex}章"！`;
            prompt += chapterForcePrompt;
        }

        if (customPromptSuffix) {
            prompt += `\n\n${customPromptSuffix}`;
        }

        // 添加全局后缀提示词
        if (settings.customSuffixPrompt && settings.customSuffixPrompt.trim()) {
            prompt += `\n\n${settings.customSuffixPrompt.trim()}`;
        }


        updateStreamContent(`\n🔄 [第${chapterIndex}章] 开始处理: ${memory.title}\n`);
        debugLog(`[第${chapterIndex}章] 开始, prompt长度=${prompt.length}字符, 重试=${retryCount}`);

        try {
            debugLog(`[第${chapterIndex}章] 调用API...`);
            const response = await callAPI(prompt, taskId);

            if (!isRerolling && isProcessingStopped) {
                memory.processing = false;
                throw new Error('ABORTED');
            }

            debugLog(`[第${chapterIndex}章] 检查TokenLimit...`);
            if (isTokenLimitError(response)) throw new Error('Token limit exceeded');

            debugLog(`[第${chapterIndex}章] 解析AI响应...`);
            let memoryUpdate = parseAIResponse(response);

            debugLog(`[第${chapterIndex}章] 后处理章节索引...`);
            memoryUpdate = postProcessResultWithChapterIndex(memoryUpdate, chapterIndex);

            debugLog(`[第${chapterIndex}章] 处理完成`);
            updateStreamContent(`✅ [第${chapterIndex}章] 处理完成\n`);
            return memoryUpdate;

        } catch (error) {
            memory.processing = false;
            if (error.message === 'ABORTED') throw error;

            updateStreamContent(`❌ [第${chapterIndex}章] 错误: ${error.message}\n`);

            if (isTokenLimitError(error.message)) throw new Error(`TOKEN_LIMIT:${index}`);

            if (retryCount < maxRetries && !isProcessingStopped) {
                const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateStreamContent(`🔄 [第${chapterIndex}章] ${delay / 1000}秒后重试...\n`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return processMemoryChunkIndependent(index, retryCount + 1, customPromptSuffix);
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

        updateStreamContent(`\n🚀 并行处理 ${tasks.length} 个记忆块 (并发: ${parallelConfig.concurrency})\n${'='.repeat(50)}\n`);
        debugLog(`并行处理开始: ${tasks.length}任务, 并发=${parallelConfig.concurrency}, 范围=${startIndex}-${endIndex}`);

        let completed = 0;
        globalSemaphore = new Semaphore(parallelConfig.concurrency);

        const processOne = async (task) => {
            if (isProcessingStopped) return null;
            try { await globalSemaphore.acquire(); }
            catch (e) { if (e.message === 'ABORTED') return null; throw e; }
            if (isProcessingStopped) { globalSemaphore.release(); return null; }

            activeParallelTasks.add(task.index);

            try {
                debugLog(`[任务${task.index + 1}] 获取信号量成功, 开始处理`);
                updateProgress(((startIndex + completed) / memoryQueue.length) * 100, `🚀 并行处理中 (${completed}/${tasks.length})`);
                const result = await processMemoryChunkIndependent(task.index);

                task.memory.processed = true;
                task.memory.failed = false;
                task.memory.processing = false;
                task.memory.result = result;
                results.set(task.index, result);
                completed++;

                if (result) {
                    debugLog(`[任务${task.index + 1}] 开始合并世界书...`);
                    await mergeWorldbookDataWithHistory(generatedWorldbook, result, task.index, task.memory.title);
                    debugLog(`[任务${task.index + 1}] 保存Roll结果...`);
                    await MemoryHistoryDB.saveRollResult(task.index, result);
                    debugLog(`[任务${task.index + 1}] 合并+保存完成`);
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
        const chapterIndex = index + 1;

        debugLog(`[串行][第${chapterIndex}章] 开始, 重试=${retryCount}`);
        updateProgress(progress, `正在处理: ${memory.title} (第${chapterIndex}章)${retryCount > 0 ? ` (重试 ${retryCount})` : ''}`);

        memory.processing = true;
        updateMemoryQueueUI();

        const chapterForcePrompt = settings.forceChapterMarker ? getChapterForcePrompt(chapterIndex) : '';

        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix() + getSystemPrompt();

        const prevContext = getPreviousMemoryContext(index);
        if (prevContext) {
            prompt += prevContext;
        }

        if (index > 0) {
            prompt += `\n\n上次阅读结尾：\n---\n${memoryQueue[index - 1].content.slice(-500)}\n---\n`;
            prompt += `\n当前世界书：\n${JSON.stringify(generatedWorldbook, null, 2)}\n`;
        }
        prompt += `\n现在阅读的部分（第${chapterIndex}章）：\n---\n${memory.content}\n---\n`;

        if (index === 0 || index === startFromIndex) {
            prompt += `\n请开始分析小说内容。`;
        } else if (incrementalOutputMode) {
            prompt += `\n请增量更新世界书，只输出变更的条目。`;
        } else {
            prompt += `\n请累积补充世界书。`;
        }

        if (settings.forceChapterMarker) {
            prompt += `\n\n【重要提醒】如果输出剧情大纲或剧情节点或章节剧情，条目名称必须包含"第${chapterIndex}章"！`;
            prompt += `\n直接输出JSON格式结果。`;
            prompt += chapterForcePrompt;
        } else {
            prompt += `\n直接输出JSON格式结果。`;
        }

        try {
            debugLog(`[串行][第${chapterIndex}章] 调用API, prompt长度=${prompt.length}`);
            const response = await callAPI(prompt);
            memory.processing = false;

            if (isProcessingStopped) { updateMemoryQueueUI(); return; }

            debugLog(`[串行][第${chapterIndex}章] 检查TokenLimit...`);
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

            debugLog(`[串行][第${chapterIndex}章] 解析AI响应...`);
            let memoryUpdate = parseAIResponse(response);
            memoryUpdate = postProcessResultWithChapterIndex(memoryUpdate, chapterIndex);

            debugLog(`[串行][第${chapterIndex}章] 合并世界书...`);
            await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memory.title);
            debugLog(`[串行][第${chapterIndex}章] 保存Roll结果...`);
            await MemoryHistoryDB.saveRollResult(index, memoryUpdate);
            debugLog(`[串行][第${chapterIndex}章] 完成`);

            memory.processed = true;
            memory.result = memoryUpdate;
            updateMemoryQueueUI();

        } catch (error) {
            memory.processing = false;

            if (isTokenLimitError(error.message || '')) {
                if (useVolumeMode) {
                    startNewVolume();
                    await MemoryHistoryDB.saveState(index);
                    await new Promise(r => setTimeout(r, 500));
                    await processMemoryChunk(index, 0);
                    return;
                }
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(index);
                    await new Promise(r => setTimeout(r, 500));
                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                }
            }

            if (retryCount < maxRetries) {
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateProgress(progress, `处理失败，${retryDelay / 1000}秒后重试`);
                await new Promise(r => setTimeout(r, retryDelay));
                return await processMemoryChunk(index, retryCount + 1);
            }

            memory.processed = true;
            memory.failed = true;
            memory.failedError = error.message;
            if (!failedMemoryQueue.find(m => m.index === index)) {
                failedMemoryQueue.push({ index, memory, error: error.message });
            }
            updateMemoryQueueUI();
        }

        if (memory.processed) await new Promise(r => setTimeout(r, 1000));
    }

    function stopProcessing() {
        isProcessingStopped = true;
        isRerolling = false;
        if (globalSemaphore) globalSemaphore.abort();
        activeParallelTasks.clear();
        memoryQueue.forEach(m => { if (m.processing) m.processing = false; });
        updateMemoryQueueUI();
        updateStreamContent(`\n⏸️ 已暂停\n`);
        updateStopButtonVisibility(true);
    }

    function updateStopButtonVisibility(show) {
        const stopBtn = document.getElementById('ttw-stop-btn');
        if (stopBtn) {
            stopBtn.style.display = 'inline-block';
            stopBtn.disabled = !show;
        }
    }

    // ========== 应用默认世界书条目 ==========
    // ========== 应用默认世界书条目 ==========
    function applyDefaultWorldbookEntries() {
        // 优先使用UI数据
        if (defaultWorldbookEntriesUI && defaultWorldbookEntriesUI.length > 0) {
            for (const entry of defaultWorldbookEntriesUI) {
                if (!entry.category || !entry.name) continue;
                if (!generatedWorldbook[entry.category]) {
                    generatedWorldbook[entry.category] = {};
                }
                generatedWorldbook[entry.category][entry.name] = {
                    '关键词': entry.keywords || [],
                    '内容': entry.content || ''
                };

                // 【新增】同步位置/深度/顺序配置到 entryPositionConfig
                if (entry.position !== undefined || entry.depth !== undefined || entry.order !== undefined) {
                    setEntryConfig(entry.category, entry.name, {
                        position: entry.position ?? 0,
                        depth: entry.depth ?? 4,
                        order: entry.order ?? 100
                    });
                }
            }
            updateStreamContent(`\n📚 已添加 ${defaultWorldbookEntriesUI.length} 个默认世界书条目\n`);
            return true;
        }

        // 兼容旧的JSON格式
        if (!settings.defaultWorldbookEntries?.trim()) return false;

        try {
            const defaultEntries = JSON.parse(settings.defaultWorldbookEntries);
            mergeWorldbookDataIncremental(generatedWorldbook, defaultEntries);
            updateStreamContent(`\n📚 已添加默认世界书条目\n`);
            return true;
        } catch (e) {
            console.error('解析默认世界书条目失败:', e);
            updateStreamContent(`\n⚠️ 默认世界书条目格式错误，跳过\n`);
            return false;
        }
    }


    // ========== 主处理流程 ==========
    async function startAIProcessing() {
        showProgressSection(true);
        isProcessingStopped = false;

        updateStopButtonVisibility(true);

        if (globalSemaphore) globalSemaphore.reset();
        activeParallelTasks.clear();

        updateStreamContent('', true);

        const enabledCatNames = getEnabledCategories().map(c => c.name).join(', ');
        const chainDesc = (settings.promptMessageChain || []).filter(m => m.enabled !== false);
        const chainSummary = chainDesc.length <= 1 ? '默认(单条用户消息)' : `${chainDesc.length}条消息[${chainDesc.map(m => m.role === 'system' ? '系统' : m.role === 'assistant' ? 'AI' : '用户').join('→')}]`;
        updateStreamContent(`🚀 开始处理...\n📊 处理模式: ${parallelConfig.enabled ? `并行 (${parallelConfig.concurrency}并发)` : '串行'}\n🔧 API模式: ${settings.useTavernApi ? '酒馆API' : '自定义API (' + settings.customApiProvider + ')'}\n📌 强制章节标记: ${settings.forceChapterMarker ? '开启' : '关闭'}\n💬 消息链: ${chainSummary}\n🏷️ 启用分类: ${enabledCatNames}\n${'='.repeat(50)}\n`);
        debugLog(`调试模式已开启 - 将记录每步耗时`);

        const effectiveStartIndex = userSelectedStartIndex !== null ? userSelectedStartIndex : startFromIndex;

        if (effectiveStartIndex === 0) {
            const hasProcessedMemories = memoryQueue.some(m => m.processed && !m.failed && m.result);
            if (!hasProcessedMemories) {
                worldbookVolumes = [];
                currentVolumeIndex = 0;
                generatedWorldbook = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
                applyDefaultWorldbookEntries();
            }
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
                        updateProgress((processedCount / memoryQueue.length) * 100, `⏸️ 已暂停`);
                        await MemoryHistoryDB.saveState(processedCount);
                        updateStartButtonState(false);
                        return;
                    }
                    if (tokenLimitIndices.length > 0) {
                        for (const idx of tokenLimitIndices.sort((a, b) => b - a)) {
                            splitMemoryIntoTwo(idx);
                        }
                        updateMemoryQueueUI();
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
                        updateProgress((i / memoryQueue.length) * 100, `⏸️ 已暂停`);
                        await MemoryHistoryDB.saveState(i);
                        updateStartButtonState(false);
                        return;
                    }
                    if (memoryQueue[i].processed && !memoryQueue[i].failed) { i++; continue; }
                    const currentLen = memoryQueue.length;
                    await processMemoryChunk(i);
                    if (memoryQueue.length > currentLen) i += (memoryQueue.length - currentLen);
                    i++;
                    await MemoryHistoryDB.saveState(i);
                }
            }

            if (isProcessingStopped) {
                const processedCount = memoryQueue.filter(m => m.processed).length;
                updateProgress((processedCount / memoryQueue.length) * 100, `⏸️ 已暂停`);
                await MemoryHistoryDB.saveState(processedCount);
                updateStartButtonState(false);
                return;
            }

            if (useVolumeMode && Object.keys(generatedWorldbook).length > 0) {
                worldbookVolumes.push({ volumeIndex: currentVolumeIndex, worldbook: JSON.parse(JSON.stringify(generatedWorldbook)), timestamp: Date.now() });
            }

            const failedCount = memoryQueue.filter(m => m.failed).length;
            if (failedCount > 0) {
                updateProgress(100, `⚠️ 完成，但有 ${failedCount} 个失败`);
            } else {
                updateProgress(100, `✅ 全部完成！`);
            }

            showResultSection(true);
            updateWorldbookPreview();
            updateStreamContent(`\n${'='.repeat(50)}\n✅ 处理完成！\n`);

            await MemoryHistoryDB.saveState(memoryQueue.length);
            await MemoryHistoryDB.clearState();
            updateStartButtonState(false);

        } catch (error) {
            updateProgress(0, `❌ 出错: ${error.message}`);
            updateStreamContent(`\n❌ 错误: ${error.message}\n`);
            updateStartButtonState(false);
        }
    }

    function updateStartButtonState(isProcessing) {
        const startBtn = document.getElementById('ttw-start-btn');
        if (!startBtn) return;

        if (!isProcessing && activeParallelTasks.size > 0) {
            return;
        }

        if (isProcessing) {
            startBtn.disabled = true;
            startBtn.textContent = '转换中...';
        } else {
            startBtn.disabled = false;
            if (userSelectedStartIndex !== null) {
                startBtn.textContent = `▶️ 从第${userSelectedStartIndex + 1}章开始`;
                startFromIndex = userSelectedStartIndex;
                return;
            }
            const firstUnprocessed = memoryQueue.findIndex(m => !m.processed || m.failed);
            if (firstUnprocessed !== -1 && firstUnprocessed < memoryQueue.length) {
                startBtn.textContent = `▶️ 继续转换 (从第${firstUnprocessed + 1}章)`;
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
        const chapterIndex = index + 1;

        const chapterForcePrompt = settings.forceChapterMarker ? getChapterForcePrompt(chapterIndex) : '';

        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix() + `你是世界书生成专家。请提取关键信息。

输出JSON格式：
${generateDynamicJsonTemplate()}
`;

        const prevContext = getPreviousMemoryContext(index);
        if (prevContext) {
            prompt += prevContext;
        }

        if (Object.keys(generatedWorldbook).length > 0) {
            prompt += `当前世界书：\n${JSON.stringify(generatedWorldbook, null, 2)}\n\n`;
        }
        prompt += `阅读内容（第${chapterIndex}章）：\n---\n${memory.content}\n---\n\n请输出JSON。`;

        if (settings.forceChapterMarker) {
            prompt += chapterForcePrompt;
        }

        const response = await callAPI(prompt);
        let memoryUpdate = parseAIResponse(response);
        memoryUpdate = postProcessResultWithChapterIndex(memoryUpdate, chapterIndex);
        await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, `修复-${memory.title}`);
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
            await new Promise(r => setTimeout(r, 1000));
        } catch (error) {
            if (isTokenLimitError(error.message || '')) {
                if (useVolumeMode) {
                    startNewVolume();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(r => setTimeout(r, 500));
                    await repairMemoryWithSplit(memoryIndex, stats);
                    return;
                }
                const splitResult = splitMemoryIntoTwo(memoryIndex);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(r => setTimeout(r, 500));
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
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    async function startRepairFailedMemories() {
        const failedMemories = memoryQueue.filter(m => m.failed);
        if (failedMemories.length === 0) { alert('没有需要修复的记忆'); return; }

        isRepairingMemories = true;
        isProcessingStopped = false;
        showProgressSection(true);
        updateStopButtonVisibility(true);
        updateProgress(0, `修复中 (0/${failedMemories.length})`);

        const stats = { successCount: 0, stillFailedCount: 0 };

        for (let i = 0; i < failedMemories.length; i++) {
            if (isProcessingStopped) break;
            const memory = failedMemories[i];
            const memoryIndex = memoryQueue.indexOf(memory);
            if (memoryIndex === -1) continue;
            updateProgress(((i + 1) / failedMemories.length) * 100, `修复: ${memory.title}`);
            await repairMemoryWithSplit(memoryIndex, stats);
        }

        failedMemoryQueue = failedMemoryQueue.filter(item => memoryQueue[item.index]?.failed);
        updateProgress(100, `修复完成: 成功 ${stats.successCount}, 仍失败 ${stats.stillFailedCount}`);
        await MemoryHistoryDB.saveState(memoryQueue.length);
        isRepairingMemories = false;

        alert(`修复完成！成功: ${stats.successCount}, 仍失败: ${stats.stillFailedCount}`);
        updateMemoryQueueUI();
    }

    // ========== 重Roll功能 ==========
    async function rerollMemory(index, customPrompt = '') {
        const memory = memoryQueue[index];
        if (!memory) return;

        isRerolling = true;
        isProcessingStopped = false;

        updateStopButtonVisibility(true);

        updateStreamContent(`\n🎲 开始重Roll: ${memory.title} (第${index + 1}章)\n`);

        try {
            memory.processing = true;
            updateMemoryQueueUI();

            const result = await processMemoryChunkIndependent(index, 0, customPrompt);

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
            if (error.message !== 'ABORTED') {
                updateStreamContent(`❌ 重Roll失败: ${error.message}\n`);
            }
            updateMemoryQueueUI();
            throw error;
        } finally {
            isRerolling = false;
        }
    }

    // ========== 新增：查找条目来源章节 ==========
    function findEntrySourceMemories(category, entryName) {
        const sources = [];
        for (let i = 0; i < memoryQueue.length; i++) {
            const memory = memoryQueue[i];
            if (!memory.result || memory.failed) continue;
            if (memory.result[category] && memory.result[category][entryName]) {
                sources.push({
                    memoryIndex: i,
                    memory: memory,
                    entry: memory.result[category][entryName]
                });
            }
        }
        return sources;
    }

    // ========== 新增：单独重Roll条目（不影响已整理/合并的其他条目） ==========
    async function rerollSingleEntry(memoryIndex, category, entryName, customPrompt = '') {
        const memory = memoryQueue[memoryIndex];
        if (!memory) {
            throw new Error('找不到对应的章节');
        }

        isRerolling = true;
        isProcessingStopped = false;

        updateStopButtonVisibility(true);

        updateStreamContent(`\n🎯 开始单独重Roll条目: [${category}] ${entryName} (来自第${memoryIndex + 1}章)\n`);

        const chapterIndex = memoryIndex + 1;
        const chapterForcePrompt = settings.forceChapterMarker ? getChapterForcePrompt(chapterIndex) : '';

        // 构建专门针对单个条目的提示词
        let prompt = chapterForcePrompt;
        prompt += getLanguagePrefix();

        // 获取分类的配置信息
        const categoryConfig = customWorldbookCategories.find(c => c.name === category);
        const contentGuide = categoryConfig ? categoryConfig.contentGuide : '';

        prompt += `\n你是一个专业的小说世界书条目生成助手。请根据以下原文内容，专门重新生成指定的条目。\n`;
        prompt += `\n【任务说明】\n`;
        prompt += `- 只需要生成一个条目：分类="${category}"，条目名称="${entryName}"\n`;
        prompt += `- 请基于原文内容重新分析并生成该条目的信息\n`;
        prompt += `- 输出格式必须是JSON，结构为：{ "${category}": { "${entryName}": { "关键词": [...], "内容": "..." } } }\n`;

        if (contentGuide) {
            prompt += `\n【该分类的内容指南】\n${contentGuide}\n`;
        }

        // 添加前文上下文
        const prevContext = getPreviousMemoryContext(memoryIndex);
        if (prevContext) {
            prompt += prevContext;
        }

        if (memoryIndex > 0 && memoryQueue[memoryIndex - 1].content) {
            prompt += `\n\n前文结尾（供参考）：\n---\n${memoryQueue[memoryIndex - 1].content.slice(-500)}\n---\n`;
        }

        prompt += `\n\n需要分析的原文内容（第${chapterIndex}章）：\n---\n${memory.content}\n---\n`;

        // 添加当前条目信息供参考
        const currentEntry = memory.result?.[category]?.[entryName];
        if (currentEntry) {
            prompt += `\n\n【当前条目信息（供参考，请重新分析生成）】\n`;
            prompt += JSON.stringify(currentEntry, null, 2);
        }

        prompt += `\n\n请重新分析原文，生成更准确、更详细的条目信息。`;

        if (customPrompt) {
            prompt += `\n\n【用户额外要求】\n${customPrompt}`;
        }

        if (settings.forceChapterMarker && (category === '剧情大纲' || category === '剧情节点' || category === '章节剧情')) {
            prompt += `\n\n【重要提醒】条目名称必须包含"第${chapterIndex}章"！`;
        }

        // 添加全局后缀提示词
        if (settings.customSuffixPrompt && settings.customSuffixPrompt.trim()) {
            prompt += `\n\n${settings.customSuffixPrompt.trim()}`;
        }

        prompt += `\n\n直接输出JSON格式结果，不要有其他内容。`;

        try {
            memory.processing = true;
            updateMemoryQueueUI();

            const response = await callAPI(prompt, memoryIndex + 1);

            memory.processing = false;

            if (isProcessingStopped) {
                updateMemoryQueueUI();
                throw new Error('ABORTED');
            }

            let entryUpdate = parseAIResponse(response);

            // 验证返回结果
            if (!entryUpdate || !entryUpdate[category] || !entryUpdate[category][entryName]) {
                // 尝试修正：如果返回了其他名称的条目，使用用户指定的名称
                if (entryUpdate && entryUpdate[category]) {
                    const keys = Object.keys(entryUpdate[category]);
                    if (keys.length === 1) {
                        const returnedEntry = entryUpdate[category][keys[0]];
                        entryUpdate[category] = { [entryName]: returnedEntry };
                    }
                }
            }

            if (entryUpdate && entryUpdate[category] && entryUpdate[category][entryName]) {
                // 更新该章节的result
                if (!memory.result) {
                    memory.result = {};
                }
                if (!memory.result[category]) {
                    memory.result[category] = {};
                }
                memory.result[category][entryName] = entryUpdate[category][entryName];

                // 保存到章节历史
                await MemoryHistoryDB.saveRollResult(memoryIndex, memory.result);

                // 【新增】保存到条目级别历史
                await MemoryHistoryDB.saveEntryRollResult(category, entryName, memoryIndex, entryUpdate[category][entryName], customPrompt);

                // 【关键修改】只更新世界书中的该条目，不重建整个世界书
                // 这样可以保留别名合并、整理等操作的结果
                if (!generatedWorldbook[category]) {
                    generatedWorldbook[category] = {};
                }
                generatedWorldbook[category][entryName] = entryUpdate[category][entryName];

                updateStreamContent(`✅ 条目重Roll完成: [${category}] ${entryName}\n`);
                updateMemoryQueueUI();
                updateWorldbookPreview();

                return entryUpdate[category][entryName];
            } else {
                throw new Error('AI返回的结果格式不正确，请重试');
            }

        } catch (error) {
            memory.processing = false;
            if (error.message !== 'ABORTED') {
                updateStreamContent(`❌ 条目重Roll失败: ${error.message}\n`);
            }
            updateMemoryQueueUI();
            throw error;
        } finally {
            isRerolling = false;
        }
    }

    // ========== 新增：显示单独重Roll条目弹窗（v3.0.4 升级版：多选+并发+编辑+历史） ==========
    async function showRerollEntryModal(category, entryName, callback) {
        const existingModal = document.getElementById('ttw-reroll-entry-modal');
        if (existingModal) existingModal.remove();

        // 查找条目来源
        const sources = findEntrySourceMemories(category, entryName);

        // 获取当前条目数据
        const currentEntry = generatedWorldbook[category]?.[entryName] || {};
        const currentKeywords = Array.isArray(currentEntry['关键词'])
            ? currentEntry['关键词'].join(', ')
            : (currentEntry['关键词'] || '');
        const currentContent = currentEntry['内容'] || '';

        // 获取条目Roll历史
        const entryRollHistory = await MemoryHistoryDB.getEntryRollResults(category, entryName);

        let sourcesHtml = '';
        if (sources.length === 0) {
            sourcesHtml = '<div style="color:#e74c3c;font-size:12px;">⚠️ 未找到该条目的来源章节（可能是默认条目或导入条目）</div>';
        } else {
            sourcesHtml = `<div style="font-size:12px;color:#888;margin-bottom:8px;">该条目来自以下章节（可多选）：</div>`;
            sources.forEach(source => {
                sourcesHtml += `
                    <label class="ttw-checkbox-label" style="display:flex;align-items:center;gap:8px;padding:8px;background:rgba(39,174,96,0.1);border-radius:6px;margin-bottom:6px;cursor:pointer;">
                        <input type="checkbox" name="ttw-reroll-source" value="${source.memoryIndex}" ${sources.length === 1 ? 'checked' : ''}>
                        <div style="flex:1;">
                            <div style="font-weight:bold;color:#27ae60;">第${source.memoryIndex + 1}章 - ${source.memory.title}</div>
                            <div style="font-size:11px;color:#888;">${(source.memory.content.length / 1000).toFixed(1)}k字</div>
                        </div>
                    </label>
                `;
            });
        }

        // 构建Roll历史HTML
        let historyHtml = '';
        if (entryRollHistory.length === 0) {
            historyHtml = '<div style="text-align:center;color:#666;padding:15px;font-size:11px;">暂无Roll历史</div>';
        } else {
            historyHtml = '<div style="max-height:150px;overflow-y:auto;">';
            entryRollHistory.forEach((roll, idx) => {
                const time = new Date(roll.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                const promptPreview = roll.customPrompt ? `「${roll.customPrompt.substring(0, 20)}${roll.customPrompt.length > 20 ? '...' : ''}」` : '';
                historyHtml += `
                    <div class="ttw-entry-roll-item" data-roll-id="${roll.id}" style="display:flex;align-items:center;gap:8px;padding:8px;background:rgba(155,89,182,0.1);border-radius:6px;margin-bottom:6px;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(155,89,182,0.25)'" onmouseout="this.style.background='rgba(155,89,182,0.1)'">
                        <div style="flex:1;">
                            <div style="font-size:12px;color:#9b59b6;font-weight:bold;">#${idx + 1} - ${time}</div>
                            <div style="font-size:11px;color:#888;">第${roll.memoryIndex + 1}章 ${promptPreview}</div>
                        </div>
                        <button class="ttw-use-roll-btn" data-roll-id="${roll.id}" style="background:rgba(39,174,96,0.5);border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;color:#fff;">✅ 使用</button>
                    </div>
                `;
            });
            historyHtml += '</div>';
        }

        const modal = document.createElement('div');
        modal.id = 'ttw-reroll-entry-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:700px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🎯 单独重Roll条目 - [${category}] ${entryName}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                    <!-- 当前条目编辑区 -->
                    <div style="margin-bottom:16px;padding:12px;background:rgba(230,126,34,0.15);border-radius:8px;">
                        <div style="font-weight:bold;color:#e67e22;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
                            <span>📝 当前条目内容（可编辑）</span>
                            <button id="ttw-save-entry-edit" class="ttw-btn ttw-btn-small" style="background:rgba(39,174,96,0.5);">💾 保存编辑</button>
                        </div>
                        <div style="margin-bottom:8px;">
                            <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">🔑 关键词（逗号分隔）</label>
                            <input type="text" id="ttw-entry-keywords-edit" value="${currentKeywords.replace(/"/g, '&quot;')}" style="width:100%;padding:8px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;box-sizing:border-box;">
                        </div>
                        <div>
                            <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">📄 内容</label>
                            <textarea id="ttw-entry-content-edit" rows="5" style="width:100%;padding:8px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;resize:vertical;box-sizing:border-box;">${currentContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                        </div>
                    </div>

                    <!-- Roll历史区 -->
                    <div style="margin-bottom:16px;padding:12px;background:rgba(155,89,182,0.1);border-radius:8px;">
                        <div style="font-weight:bold;color:#9b59b6;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
                            <span>📜 Roll历史 (${entryRollHistory.length}条)</span>
                            ${entryRollHistory.length > 0 ? '<button id="ttw-clear-entry-history" class="ttw-btn ttw-btn-small ttw-btn-warning" style="font-size:10px;">🗑️ 清空</button>' : ''}
                        </div>
                        <div id="ttw-entry-roll-history">${historyHtml}</div>
                    </div>

                    <!-- 来源章节选择 -->
                    <div style="margin-bottom:16px;padding:12px;background:rgba(39,174,96,0.1);border-radius:8px;">
                        <label style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:bold;font-size:13px;">
                            <span>📍 选择来源章节重Roll</span>
                            ${sources.length > 1 ? '<button id="ttw-select-all-sources" class="ttw-btn ttw-btn-small" style="font-size:10px;">全选/取消</button>' : ''}
                        </label>
                        <div id="ttw-reroll-sources">${sourcesHtml}</div>
                    </div>

                    <!-- 额外提示词 -->
                    <div style="margin-bottom:16px;">
                        <label style="display:block;margin-bottom:8px;font-weight:bold;font-size:13px;">📝 额外提示词（可选）</label>
                        <textarea id="ttw-reroll-entry-prompt" rows="3" placeholder="例如：请更详细地描述该角色的性格特点、请补充该角色的外貌描写..." class="ttw-textarea" style="width:100%;padding:10px;box-sizing:border-box;"></textarea>
                    </div>

                    <!-- 并发设置 -->
                    <div style="display:flex;align-items:center;gap:10px;padding:10px;background:rgba(52,152,219,0.1);border-radius:6px;">
                        <label style="font-size:12px;color:#3498db;">⚡ 并发数:</label>
                        <input type="number" id="ttw-reroll-concurrency" value="${parallelConfig.concurrency}" min="1" max="10" style="width:60px;padding:4px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;text-align:center;">
                        <span style="font-size:11px;color:#888;">（多选时同时处理的数量）</span>
                    </div>
                </div>
                <div class="ttw-modal-footer" style="display:flex;gap:8px;flex-wrap:wrap;">
                    <div id="ttw-reroll-progress" style="flex:1;font-size:12px;color:#888;display:none;"></div>
                    <button class="ttw-btn" id="ttw-cancel-reroll-entry">取消</button>
                    <button class="ttw-btn ttw-btn-secondary" id="ttw-stop-reroll-entry" style="display:none;">⏸️ 停止</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-confirm-reroll-entry" ${sources.length === 0 ? 'disabled style="opacity:0.5;"' : ''}>🎯 开始重Roll</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // ===== 事件绑定 =====
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-reroll-entry').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // 保存编辑
        modal.querySelector('#ttw-save-entry-edit').addEventListener('click', () => {
            const keywordsInput = modal.querySelector('#ttw-entry-keywords-edit').value;
            const contentInput = modal.querySelector('#ttw-entry-content-edit').value;

            const keywords = keywordsInput.split(/[,，]/).map(k => k.trim()).filter(k => k);

            if (!generatedWorldbook[category]) {
                generatedWorldbook[category] = {};
            }
            generatedWorldbook[category][entryName] = {
                '关键词': keywords,
                '内容': contentInput
            };

            updateWorldbookPreview();

            const btn = modal.querySelector('#ttw-save-entry-edit');
            btn.textContent = '✅ 已保存';
            setTimeout(() => { btn.textContent = '💾 保存编辑'; }, 1500);
        });

        // 全选/取消
        const selectAllBtn = modal.querySelector('#ttw-select-all-sources');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => {
                const checkboxes = modal.querySelectorAll('input[name="ttw-reroll-source"]');
                const allChecked = Array.from(checkboxes).every(cb => cb.checked);
                checkboxes.forEach(cb => cb.checked = !allChecked);
            });
        }

        // 清空历史
        const clearHistoryBtn = modal.querySelector('#ttw-clear-entry-history');
        if (clearHistoryBtn) {
            clearHistoryBtn.addEventListener('click', async () => {
                if (confirm('确定清空该条目的所有Roll历史？')) {
                    await MemoryHistoryDB.clearEntryRollResults(category, entryName);
                    modal.remove();
                    showRerollEntryModal(category, entryName, callback);
                }
            });
        }

        // 使用历史结果
        modal.querySelectorAll('.ttw-use-roll-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const rollId = parseInt(btn.dataset.rollId);
                const roll = await MemoryHistoryDB.getEntryRollById(rollId);
                if (roll && roll.result) {
                    // 更新到编辑区
                    const keywords = Array.isArray(roll.result['关键词'])
                        ? roll.result['关键词'].join(', ')
                        : (roll.result['关键词'] || '');
                    modal.querySelector('#ttw-entry-keywords-edit').value = keywords;
                    modal.querySelector('#ttw-entry-content-edit').value = roll.result['内容'] || '';

                    // 同时更新世界书
                    if (!generatedWorldbook[category]) {
                        generatedWorldbook[category] = {};
                    }
                    generatedWorldbook[category][entryName] = JSON.parse(JSON.stringify(roll.result));
                    updateWorldbookPreview();

                    btn.textContent = '✅ 已应用';
                    setTimeout(() => { btn.textContent = '✅ 使用'; }, 1500);
                }
            });
        });

        // 点击历史项显示详情
        modal.querySelectorAll('.ttw-entry-roll-item').forEach(item => {
            item.addEventListener('click', async (e) => {
                if (e.target.classList.contains('ttw-use-roll-btn')) return;
                const rollId = parseInt(item.dataset.rollId);
                const roll = await MemoryHistoryDB.getEntryRollById(rollId);
                if (roll && roll.result) {
                    const keywords = Array.isArray(roll.result['关键词'])
                        ? roll.result['关键词'].join(', ')
                        : (roll.result['关键词'] || '');
                    // 显示预览
                    alert(`【Roll #${rollId}】\n\n关键词:\n${keywords}\n\n内容:\n${roll.result['内容'] || '(无)'}\n\n提示词: ${roll.customPrompt || '(无)'}`);
                }
            });
        });

        // 开始重Roll（支持多选并发）
        const confirmBtn = modal.querySelector('#ttw-confirm-reroll-entry');
        const stopBtn = modal.querySelector('#ttw-stop-reroll-entry');
        const progressDiv = modal.querySelector('#ttw-reroll-progress');

        let isRerollingEntries = false;

        stopBtn.addEventListener('click', () => {
            isProcessingStopped = true;
            isRerollingEntries = false;
        });

        confirmBtn.addEventListener('click', async () => {
            const selectedCheckboxes = modal.querySelectorAll('input[name="ttw-reroll-source"]:checked');
            if (selectedCheckboxes.length === 0) {
                alert('请至少选择一个来源章节');
                return;
            }

            const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.value));
            const customPrompt = modal.querySelector('#ttw-reroll-entry-prompt').value.trim();
            const concurrency = parseInt(modal.querySelector('#ttw-reroll-concurrency').value) || 3;

            confirmBtn.disabled = true;
            confirmBtn.style.display = 'none';
            stopBtn.style.display = 'inline-block';
            progressDiv.style.display = 'block';
            isRerollingEntries = true;
            isProcessingStopped = false;

            let completed = 0;
            let failed = 0;
            const total = selectedIndices.length;
            let lastResult = null;

            const updateProgress = () => {
                progressDiv.textContent = `进度: ${completed}/${total} 完成${failed > 0 ? `, ${failed} 失败` : ''}`;
            };
            updateProgress();

            // 并发处理
            const processBatch = async (indices, concurrencyLimit) => {
                const results = [];
                let index = 0;

                const worker = async () => {
                    while (index < indices.length && !isProcessingStopped) {
                        const currentIndex = index++;
                        const memoryIndex = indices[currentIndex];
                        try {
                            const result = await rerollSingleEntry(memoryIndex, category, entryName, customPrompt);
                            results.push({ memoryIndex, result, success: true });
                            lastResult = result;
                            completed++;
                        } catch (error) {
                            if (error.message !== 'ABORTED') {
                                results.push({ memoryIndex, error: error.message, success: false });
                                failed++;
                            }
                        }
                        updateProgress();
                    }
                };

                const workers = [];
                for (let i = 0; i < Math.min(concurrencyLimit, indices.length); i++) {
                    workers.push(worker());
                }
                await Promise.all(workers);
                return results;
            };

            try {
                await processBatch(selectedIndices, concurrency);

                if (!isProcessingStopped) {
                    // 更新编辑区显示最后一次结果
                    if (lastResult) {
                        const keywords = Array.isArray(lastResult['关键词'])
                            ? lastResult['关键词'].join(', ')
                            : (lastResult['关键词'] || '');
                        modal.querySelector('#ttw-entry-keywords-edit').value = keywords;
                        modal.querySelector('#ttw-entry-content-edit').value = lastResult['内容'] || '';
                    }

                    progressDiv.textContent = `✅ 完成! ${completed}/${total} 成功${failed > 0 ? `, ${failed} 失败` : ''}`;

                    // 刷新历史列表
                    const newHistory = await MemoryHistoryDB.getEntryRollResults(category, entryName);
                    let newHistoryHtml = '';
                    if (newHistory.length === 0) {
                        newHistoryHtml = '<div style="text-align:center;color:#666;padding:15px;font-size:11px;">暂无Roll历史</div>';
                    } else {
                        newHistoryHtml = '<div style="max-height:150px;overflow-y:auto;">';
                        newHistory.forEach((roll, idx) => {
                            const time = new Date(roll.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                            const promptPreview = roll.customPrompt ? `「${roll.customPrompt.substring(0, 20)}${roll.customPrompt.length > 20 ? '...' : ''}」` : '';
                            newHistoryHtml += `
                                <div class="ttw-entry-roll-item" data-roll-id="${roll.id}" style="display:flex;align-items:center;gap:8px;padding:8px;background:rgba(155,89,182,0.1);border-radius:6px;margin-bottom:6px;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(155,89,182,0.25)'" onmouseout="this.style.background='rgba(155,89,182,0.1)'">
                                    <div style="flex:1;">
                                        <div style="font-size:12px;color:#9b59b6;font-weight:bold;">#${idx + 1} - ${time}</div>
                                        <div style="font-size:11px;color:#888;">第${roll.memoryIndex + 1}章 ${promptPreview}</div>
                                    </div>
                                    <button class="ttw-use-roll-btn" data-roll-id="${roll.id}" style="background:rgba(39,174,96,0.5);border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;color:#fff;">✅ 使用</button>
                                </div>
                            `;
                        });
                        newHistoryHtml += '</div>';
                    }
                    modal.querySelector('#ttw-entry-roll-history').innerHTML = newHistoryHtml;

                    // 重新绑定事件
                    modal.querySelectorAll('.ttw-use-roll-btn').forEach(btn => {
                        btn.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            const rollId = parseInt(btn.dataset.rollId);
                            const roll = await MemoryHistoryDB.getEntryRollById(rollId);
                            if (roll && roll.result) {
                                const keywords = Array.isArray(roll.result['关键词'])
                                    ? roll.result['关键词'].join(', ')
                                    : (roll.result['关键词'] || '');
                                modal.querySelector('#ttw-entry-keywords-edit').value = keywords;
                                modal.querySelector('#ttw-entry-content-edit').value = roll.result['内容'] || '';

                                if (!generatedWorldbook[category]) {
                                    generatedWorldbook[category] = {};
                                }
                                generatedWorldbook[category][entryName] = JSON.parse(JSON.stringify(roll.result));
                                updateWorldbookPreview();

                                btn.textContent = '✅ 已应用';
                                setTimeout(() => { btn.textContent = '✅ 使用'; }, 1500);
                            }
                        });
                    });

                    if (callback) callback();
                }
            } catch (error) {
                if (error.message !== 'ABORTED') {
                    progressDiv.textContent = `❌ 错误: ${error.message}`;
                }
            } finally {
                isRerollingEntries = false;
                confirmBtn.disabled = false;
                confirmBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
            }
        });
    }

    // ========== 新增：批量重Roll多个条目（支持多选不同条目） ==========
    async function showBatchRerollModal(callback) {
        const existingModal = document.getElementById('ttw-batch-reroll-modal');
        if (existingModal) existingModal.remove();

        // 收集所有条目
        const allEntries = [];
        for (const category in generatedWorldbook) {
            for (const entryName in generatedWorldbook[category]) {
                const sources = findEntrySourceMemories(category, entryName);
                if (sources.length > 0) {
                    const entry = generatedWorldbook[category][entryName];
                    const tokenCount = getEntryTotalTokens(entry);
                    allEntries.push({ category, entryName, sources, tokenCount });
                }
            }
        }

        if (allEntries.length === 0) {
            alert('没有可重Roll的条目（没有找到来源章节）');
            return;
        }

        let entriesHtml = '';
        allEntries.forEach((entry, idx) => {
            const tokenStyle = entry.tokenCount < 100 ? 'color:#ef4444;' : 'color:#f1c40f;';
            entriesHtml += `
                <label style="display:flex;align-items:center;gap:8px;padding:6px;background:rgba(230,126,34,0.1);border-radius:4px;margin-bottom:4px;cursor:pointer;">
                    <input type="checkbox" name="ttw-batch-entry" data-category="${entry.category}" data-entry="${entry.entryName}">
                    <span style="font-size:12px;flex:1;"><span style="color:#e67e22;">[${entry.category}]</span> ${entry.entryName}</span>
                    <span style="font-size:10px;${tokenStyle}">${entry.tokenCount}tk</span>
                    <span style="font-size:10px;color:#888;">${entry.sources.length}章</span>
                </label>
            `;
        });

        const modal = document.createElement('div');
        modal.id = 'ttw-batch-reroll-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:600px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🎲 批量重Roll条目</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:60vh;overflow-y:auto;">
                    <div style="margin-bottom:12px;display:flex;gap:8px;">
                        <button id="ttw-select-all-entries" class="ttw-btn ttw-btn-small">全选</button>
                        <button id="ttw-deselect-all-entries" class="ttw-btn ttw-btn-small">取消全选</button>
                    </div>
                    <div id="ttw-batch-entries" style="max-height:300px;overflow-y:auto;">${entriesHtml}</div>
                    <div style="margin-top:12px;">
                        <label style="display:block;margin-bottom:8px;font-weight:bold;font-size:13px;">📝 统一提示词</label>
                        <textarea id="ttw-batch-prompt" rows="3" placeholder="对所有选中条目使用相同的提示词..." style="width:100%;padding:8px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;box-sizing:border-box;">${settings.customBatchRerollPrompt || ''}</textarea>
                    </div>
                    <div style="margin-top:12px;display:flex;align-items:center;gap:10px;">
                        <label style="font-size:12px;color:#3498db;">⚡ 并发数:</label>
                        <input type="number" id="ttw-batch-concurrency" value="${parallelConfig.concurrency}" min="1" max="10" style="width:60px;padding:4px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;text-align:center;">
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <div id="ttw-batch-progress" style="flex:1;font-size:12px;color:#888;"></div>
                    <button class="ttw-btn" id="ttw-cancel-batch">取消</button>
                    <button class="ttw-btn ttw-btn-secondary" id="ttw-stop-batch" style="display:none;">⏸️ 停止</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-confirm-batch">🎲 开始批量重Roll</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-batch').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-select-all-entries').addEventListener('click', () => {
            modal.querySelectorAll('input[name="ttw-batch-entry"]').forEach(cb => cb.checked = true);
        });
        modal.querySelector('#ttw-deselect-all-entries').addEventListener('click', () => {
            modal.querySelectorAll('input[name="ttw-batch-entry"]').forEach(cb => cb.checked = false);
        });

        const confirmBtn = modal.querySelector('#ttw-confirm-batch');
        const stopBtn = modal.querySelector('#ttw-stop-batch');
        const progressDiv = modal.querySelector('#ttw-batch-progress');

        confirmBtn.addEventListener('click', async () => {
            const selectedEntries = [];
            modal.querySelectorAll('input[name="ttw-batch-entry"]:checked').forEach(cb => {
                selectedEntries.push({
                    category: cb.dataset.category,
                    entryName: cb.dataset.entry
                });
            });

            if (selectedEntries.length === 0) {
                alert('请至少选择一个条目');
                return;
            }

            const customPrompt = modal.querySelector('#ttw-batch-prompt').value.trim();
            settings.customBatchRerollPrompt = customPrompt;
            saveCurrentSettings();
            const concurrency = parseInt(modal.querySelector('#ttw-batch-concurrency').value) || 3;

            confirmBtn.disabled = true;
            confirmBtn.style.display = 'none';
            stopBtn.style.display = 'inline-block';
            isProcessingStopped = false;

            let completed = 0;
            let failed = 0;
            const total = selectedEntries.length;

            const updateProgress = () => {
                progressDiv.textContent = `进度: ${completed}/${total}${failed > 0 ? `, ${failed} 失败` : ''}`;
            };
            updateProgress();

            // 并发处理
            let index = 0;
            const worker = async () => {
                while (index < selectedEntries.length && !isProcessingStopped) {
                    const currentIndex = index++;
                    const { category, entryName } = selectedEntries[currentIndex];
                    const sources = findEntrySourceMemories(category, entryName);

                    if (sources.length > 0) {
                        try {
                            await rerollSingleEntry(sources[0].memoryIndex, category, entryName, customPrompt);
                            completed++;
                        } catch (error) {
                            if (error.message !== 'ABORTED') {
                                failed++;
                            }
                        }
                    }
                    updateProgress();
                }
            };

            const workers = [];
            for (let i = 0; i < Math.min(concurrency, selectedEntries.length); i++) {
                workers.push(worker());
            }
            await Promise.all(workers);

            progressDiv.textContent = isProcessingStopped
                ? `已停止: ${completed}/${total} 完成`
                : `✅ 完成: ${completed}/${total}${failed > 0 ? `, ${failed} 失败` : ''}`;

            confirmBtn.disabled = false;
            confirmBtn.style.display = 'inline-block';
            stopBtn.style.display = 'none';

            if (callback) callback();
        });

        stopBtn.addEventListener('click', () => {
            isProcessingStopped = true;
        });
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
            listHtml = '<div style="text-align:center;color:#888;padding:10px;font-size:11px;">暂无历史</div>';
        } else {
            rollResults.forEach((roll, idx) => {
                const time = new Date(roll.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                const entryCount = roll.result ? Object.keys(roll.result).reduce((sum, cat) => sum + (typeof roll.result[cat] === 'object' ? Object.keys(roll.result[cat]).length : 0), 0) : 0;
                const isCurrentSelected = memory.result && JSON.stringify(memory.result) === JSON.stringify(roll.result);
                listHtml += `
                    <div class="ttw-roll-item ${isCurrentSelected ? 'selected' : ''}" data-roll-id="${roll.id}" data-roll-index="${idx}">
                        <div class="ttw-roll-item-header">
                            <span class="ttw-roll-item-title">#${idx + 1}${isCurrentSelected ? ' ✓' : ''}</span>
                            <span class="ttw-roll-item-time">${time}</span>
                        </div>
                        <div class="ttw-roll-item-info">${entryCount}条</div>
                    </div>
                `;
            });
        }

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🎲 ${memory.title} (第${index + 1}章) - Roll历史</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div class="ttw-roll-history-container">
                        <div class="ttw-roll-history-left">
                            <button id="ttw-do-reroll" class="ttw-btn ttw-btn-primary ttw-roll-reroll-btn">🎲 重Roll</button>
                            <div class="ttw-roll-list">${listHtml}</div>
                        </div>
                        <div id="ttw-roll-detail" class="ttw-roll-history-right">
                        </div>


                    </div>
                    <div class="ttw-reroll-prompt-section" style="margin-top:12px;padding:12px;background:rgba(155,89,182,0.15);border-radius:8px;">
                        <div style="font-weight:bold;color:#9b59b6;margin-bottom:8px;font-size:13px;">📝 重Roll自定义提示词</div>
                        <textarea id="ttw-reroll-custom-prompt" rows="3" placeholder="可在此添加额外要求，如：重点提取XX角色的信息、更详细地描述XX事件..." style="width:100%;padding:8px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;resize:vertical;">${settings.customRerollPrompt || ''}</textarea>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-secondary" id="ttw-stop-reroll" style="display:none;">⏸️ 停止</button>
                    <button class="ttw-btn ttw-btn-warning" id="ttw-clear-rolls">🗑️ 清空</button>
                    <button class="ttw-btn" id="ttw-close-roll-history">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        // ===== 初始化右侧：显示当前结果的编辑区 =====
        const initDetailDiv = modal.querySelector('#ttw-roll-detail');
        const currentResultJson = memory.result ? JSON.stringify(memory.result, null, 2) : '{}';
        initDetailDiv.innerHTML = `
            <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #444;">
                <h4 style="color:#27ae60;margin:0 0 6px;font-size:14px;">📝 当前处理结果（第${index + 1}章）</h4>
                <div style="font-size:11px;color:#888;">可直接编辑下方JSON，编辑后点击"保存并应用"</div>
            </div>
            <textarea id="ttw-current-result-editor" style="width:100%;min-height:200px;max-height:300px;padding:10px;background:rgba(0,0,0,0.3);border:1px solid #555;border-radius:6px;color:#fff;font-size:11px;font-family:monospace;line-height:1.5;resize:vertical;box-sizing:border-box;">${currentResultJson}</textarea>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                <button class="ttw-btn ttw-btn-primary ttw-btn-small" id="ttw-save-current-result">💾 保存并应用</button>
                <button class="ttw-btn ttw-btn-small" id="ttw-copy-current-result">📋 复制</button>
            </div>
            <div style="margin-top:12px;padding:10px;background:rgba(155,89,182,0.15);border:1px solid rgba(155,89,182,0.3);border-radius:6px;">
                <div style="font-weight:bold;color:#9b59b6;margin-bottom:6px;font-size:12px;">📋 粘贴JSON导入</div>
                <div style="font-size:11px;color:#888;margin-bottom:6px;">支持标准JSON、带\`\`\`json代码块的、甚至不完整的JSON</div>
                <textarea id="ttw-paste-json-area" rows="4" placeholder="在此粘贴JSON..." style="width:100%;padding:8px;background:rgba(0,0,0,0.3);border:1px solid #555;border-radius:6px;color:#fff;font-size:11px;font-family:monospace;resize:vertical;box-sizing:border-box;"></textarea>
                <button class="ttw-btn ttw-btn-small" id="ttw-parse-and-apply" style="margin-top:8px;background:rgba(155,89,182,0.5);">📋 解析并填入上方</button>
            </div>
        `;

        // 保存并应用当前编辑
        initDetailDiv.querySelector('#ttw-save-current-result').addEventListener('click', async () => {
            const editor = initDetailDiv.querySelector('#ttw-current-result-editor');
            let parsed;
            try {
                parsed = JSON.parse(editor.value);
            } catch (e) {
                alert('JSON格式错误！\n\n' + e.message);
                return;
            }
            memory.result = parsed;
            memory.processed = true;
            memory.failed = false;
            try {
                await MemoryHistoryDB.saveRollResult(index, parsed);
            } catch (dbErr) {
                console.error('保存到数据库失败:', dbErr);
            }
            rebuildWorldbookFromMemories();
            updateMemoryQueueUI();
            updateWorldbookPreview();
            const btn = initDetailDiv.querySelector('#ttw-save-current-result');
            btn.textContent = '✅ 已保存并应用';
            setTimeout(() => { btn.textContent = '💾 保存并应用'; }, 1500);
        });

        // 复制
        initDetailDiv.querySelector('#ttw-copy-current-result').addEventListener('click', () => {
            const editor = initDetailDiv.querySelector('#ttw-current-result-editor');
            navigator.clipboard.writeText(editor.value).then(() => {
                const btn = initDetailDiv.querySelector('#ttw-copy-current-result');
                btn.textContent = '✅ 已复制';
                setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
            });
        });

        // 解析粘贴的JSON
        initDetailDiv.querySelector('#ttw-parse-and-apply').addEventListener('click', () => {
            const pasteArea = initDetailDiv.querySelector('#ttw-paste-json-area');
            const editor = initDetailDiv.querySelector('#ttw-current-result-editor');
            const rawText = pasteArea.value.trim();
            if (!rawText) { alert('请先粘贴JSON内容'); return; }
            let parsed;
            try {
                parsed = parseAIResponse(rawText);
            } catch (e) {
                alert('无法解析！\n\n错误: ' + e.message);
                return;
            }
            if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
                alert('解析结果为空，请检查内容');
                return;
            }
            editor.value = JSON.stringify(parsed, null, 2);
            pasteArea.value = '';
            const btn = initDetailDiv.querySelector('#ttw-parse-and-apply');
            btn.textContent = '✅ 已填入';
            setTimeout(() => { btn.textContent = '📋 解析并填入上方'; }, 1500);
        });
        // ===== 初始化结束 =====

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-roll-history').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const stopRerollBtn = modal.querySelector('#ttw-stop-reroll');

        modal.querySelector('#ttw-do-reroll').addEventListener('click', async () => {
            const btn = modal.querySelector('#ttw-do-reroll');
            const customPrompt = modal.querySelector('#ttw-reroll-custom-prompt').value;
            settings.customRerollPrompt = customPrompt;
            saveCurrentSettings();

            btn.disabled = true;
            btn.textContent = '🔄...';
            stopRerollBtn.style.display = 'inline-block';

            try {
                await rerollMemory(index, customPrompt);
                modal.remove();
                showRollHistorySelector(index);
            } catch (error) {
                btn.disabled = false;
                btn.textContent = '🎲 重Roll';
                stopRerollBtn.style.display = 'none';
                if (error.message !== 'ABORTED') {
                    alert('重Roll失败: ' + error.message);
                }
            }
        });

        stopRerollBtn.addEventListener('click', () => {
            stopProcessing();
            stopRerollBtn.style.display = 'none';
            const btn = modal.querySelector('#ttw-do-reroll');
            btn.disabled = false;
            btn.textContent = '🎲 重Roll';
        });

        modal.querySelector('#ttw-clear-rolls').addEventListener('click', async () => {
            if (confirm(`确定清空 "${memory.title}" 的所有Roll历史？`)) {
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

                modal.querySelectorAll('.ttw-roll-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                const time = new Date(roll.timestamp).toLocaleString('zh-CN');
                detailDiv.innerHTML = `
                    <div class="ttw-roll-detail-header">
                        <h4>Roll #${rollIndex + 1}</h4>
                        <div class="ttw-roll-detail-time">${time}</div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
                            <button class="ttw-btn ttw-btn-primary ttw-btn-small" id="ttw-use-this-roll">✅ 使用此结果</button>
                            <button class="ttw-btn ttw-btn-small" id="ttw-save-edited-roll" style="background:rgba(39,174,96,0.5);">💾 保存编辑</button>
                        </div>
                    </div>
                    <textarea id="ttw-roll-edit-area" style="width:100%;min-height:280px;max-height:400px;padding:10px;background:rgba(0,0,0,0.3);border:1px solid #555;border-radius:6px;color:#fff;font-size:11px;font-family:monospace;line-height:1.5;resize:vertical;box-sizing:border-box;">${JSON.stringify(roll.result, null, 2)}</textarea>
                    <div style="margin-top:10px;padding:10px;background:rgba(155,89,182,0.15);border:1px solid rgba(155,89,182,0.3);border-radius:6px;">
                        <div style="font-weight:bold;color:#9b59b6;margin-bottom:8px;font-size:12px;">📋 粘贴JSON导入</div>
                        <div style="font-size:11px;color:#888;margin-bottom:8px;">将JSON粘贴到上方编辑框后点击"保存编辑"，或粘贴到下方后点击"解析并替换"</div>
                        <textarea id="ttw-roll-paste-area" rows="4" placeholder="在此粘贴JSON格式的世界书数据..." style="width:100%;padding:8px;background:rgba(0,0,0,0.3);border:1px solid #555;border-radius:6px;color:#fff;font-size:11px;font-family:monospace;resize:vertical;box-sizing:border-box;"></textarea>
                        <button class="ttw-btn ttw-btn-small" id="ttw-parse-paste-json" style="margin-top:8px;background:rgba(155,89,182,0.5);">📋 解析并替换到上方</button>
                    </div>
                `;

                // ✅ 使用此结果
                detailDiv.querySelector('#ttw-use-this-roll').addEventListener('click', async () => {
                    // 先读取编辑框当前内容
                    const editArea = detailDiv.querySelector('#ttw-roll-edit-area');
                    let resultToUse;
                    try {
                        resultToUse = JSON.parse(editArea.value);
                    } catch (e) {
                        if (!confirm('编辑框中的JSON格式有误，是否使用原始结果？\n\n点击"取消"可继续编辑修复。')) return;
                        resultToUse = roll.result;
                    }

                    memory.result = resultToUse;
                    memory.processed = true;
                    memory.failed = false;

                    rebuildWorldbookFromMemories();

                    updateMemoryQueueUI();
                    updateWorldbookPreview();
                    modal.remove();
                    alert(`已使用 Roll #${rollIndex + 1}${resultToUse !== roll.result ? '（已编辑）' : ''}`);
                });

                // 💾 保存编辑（保存到当前roll的result，不关闭弹窗）
                detailDiv.querySelector('#ttw-save-edited-roll').addEventListener('click', async () => {
                    const editArea = detailDiv.querySelector('#ttw-roll-edit-area');
                    let parsed;
                    try {
                        parsed = JSON.parse(editArea.value);
                    } catch (e) {
                        alert('JSON格式错误，无法保存！\n\n错误信息: ' + e.message);
                        return;
                    }

                    roll.result = parsed;

                    // 同时保存到数据库
                    try {
                        await MemoryHistoryDB.saveRollResult(index, parsed);
                    } catch (dbErr) {
                        console.error('保存到数据库失败:', dbErr);
                    }

                    const btn = detailDiv.querySelector('#ttw-save-edited-roll');
                    btn.textContent = '✅ 已保存';
                    btn.style.background = 'rgba(39,174,96,0.8)';
                    setTimeout(() => {
                        btn.textContent = '💾 保存编辑';
                        btn.style.background = 'rgba(39,174,96,0.5)';
                    }, 1500);
                });

                // 📋 解析粘贴的JSON并替换到编辑框
                detailDiv.querySelector('#ttw-parse-paste-json').addEventListener('click', () => {
                    const pasteArea = detailDiv.querySelector('#ttw-roll-paste-area');
                    const editArea = detailDiv.querySelector('#ttw-roll-edit-area');
                    const rawText = pasteArea.value.trim();

                    if (!rawText) {
                        alert('请先在下方粘贴JSON内容');
                        return;
                    }

                    let parsed;
                    try {
                        parsed = parseAIResponse(rawText);
                    } catch (e) {
                        alert('无法解析粘贴的内容！\n\n支持的格式:\n1. 标准JSON\n2. 带```json```代码块的JSON\n3. 不完整但可修复的JSON\n\n错误: ' + e.message);
                        return;
                    }

                    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
                        alert('解析结果为空，请检查粘贴的内容是否正确');
                        return;
                    }

                    editArea.value = JSON.stringify(parsed, null, 2);
                    pasteArea.value = '';

                    const btn = detailDiv.querySelector('#ttw-parse-paste-json');
                    btn.textContent = '✅ 已替换到上方';
                    btn.style.background = 'rgba(39,174,96,0.5)';
                    setTimeout(() => {
                        btn.textContent = '📋 解析并替换到上方';
                        btn.style.background = 'rgba(155,89,182,0.5)';
                    }, 1500);
                });

            });

        });
    }

    // ========== 导入JSON合并世界书 ==========
    async function importAndMergeWorldbook() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const content = await file.text();
                const importedData = JSON.parse(content);

                let worldbookToMerge = {};
                let internalDuplicates = [];

                if (importedData.entries) {
                    // ST格式，需要检测内部重复
                    const result = convertSTFormatToInternal(importedData, true);
                    worldbookToMerge = result.worldbook;
                    internalDuplicates = result.duplicates;
                } else if (importedData.merged) {
                    worldbookToMerge = importedData.merged;
                } else {
                    worldbookToMerge = importedData;
                }

                pendingImportData = {
                    worldbook: worldbookToMerge,
                    fileName: file.name,
                    timestamp: Date.now(),
                    internalDuplicates: internalDuplicates
                };

                showMergeOptionsModal(worldbookToMerge, file.name, internalDuplicates);

            } catch (error) {
                console.error('导入失败:', error);
                alert('导入失败: ' + error.message);
            }
        };

        input.click();
    }


    function convertSTFormatToInternal(stData, collectDuplicates = false) {
        const result = {};
        const internalDuplicates = []; // 记录内部重复

        if (!stData.entries) return collectDuplicates ? { worldbook: result, duplicates: internalDuplicates } : result;

        const entriesArray = Array.isArray(stData.entries)
            ? stData.entries
            : Object.values(stData.entries);

        for (const entry of entriesArray) {
            if (!entry || typeof entry !== 'object') continue;

            let category = '未分类';
            let name = '';

            // 从comment解析："分类名 - 条目名"
            if (entry.comment) {
                const parts = entry.comment.split(' - ');
                if (parts.length >= 2) {
                    category = parts[0].trim();
                    name = parts.slice(1).join(' - ').trim();
                } else {
                    name = entry.comment.trim();
                }
            }

            // comment解析不出来，用group
            if (category === '未分类' && entry.group) {
                const underscoreIndex = entry.group.indexOf('_');
                if (underscoreIndex > 0) {
                    category = entry.group.substring(0, underscoreIndex);
                } else {
                    category = entry.group;
                }
            }

            if (!name) {
                name = `条目_${entry.uid || Math.random().toString(36).substr(2, 9)}`;
            }

            if (!result[category]) {
                result[category] = {};
            }

            const newEntry = {
                '关键词': Array.isArray(entry.key) ? entry.key : (entry.key ? [entry.key] : []),
                '内容': entry.content || ''
            };

            // 【关键】如果已存在同名条目，记录为内部重复
            if (result[category][name]) {
                internalDuplicates.push({
                    category,
                    name,
                    existing: result[category][name],  // 第一个遇到的
                    imported: newEntry                  // 后面遇到的
                });
            } else {
                result[category][name] = newEntry;
            }
        }

        console.log(`ST格式转换完成: ${Object.values(result).reduce((sum, cat) => sum + Object.keys(cat).length, 0)} 个条目, ${internalDuplicates.length} 个内部重复`);

        if (collectDuplicates) {
            return { worldbook: result, duplicates: internalDuplicates };
        }
        return result;
    }






    function findDuplicateEntries(existing, imported) {
        const duplicates = [];
        for (const category in imported) {
            if (!existing[category]) continue;
            for (const name in imported[category]) {
                if (existing[category][name]) {
                    const existingStr = JSON.stringify(existing[category][name]);
                    const importedStr = JSON.stringify(imported[category][name]);
                    if (existingStr !== importedStr) {
                        duplicates.push({
                            category,
                            name,
                            existing: existing[category][name],
                            imported: imported[category][name]
                        });
                    }
                }
            }
        }
        return duplicates;
    }

    function findNewEntries(existing, imported) {
        const newEntries = [];
        for (const category in imported) {
            for (const name in imported[category]) {
                if (!existing[category] || !existing[category][name]) {
                    newEntries.push({ category, name, entry: imported[category][name] });
                }
            }
        }
        return newEntries;
    }

    function groupEntriesByCategory(entries) {
        const grouped = {};
        for (const item of entries) {
            if (!grouped[item.category]) {
                grouped[item.category] = [];
            }
            grouped[item.category].push(item);
        }
        return grouped;
    }

    function showMergeOptionsModal(importedWorldbook, fileName, internalDuplicates = []) {
        if (!importedWorldbook && pendingImportData) {
            importedWorldbook = pendingImportData.worldbook;
            fileName = pendingImportData.fileName;
            internalDuplicates = pendingImportData.internalDuplicates || [];
        }

        if (!importedWorldbook) {
            alert('没有可导入的数据');
            return;
        }

        const existingModal = document.getElementById('ttw-merge-modal');
        if (existingModal) existingModal.remove();

        // 与现有世界书的重复检测
        const duplicatesWithExisting = findDuplicateEntries(generatedWorldbook, importedWorldbook);
        const newEntries = findNewEntries(generatedWorldbook, importedWorldbook);

        // 合并：内部重复 + 与现有世界书的重复
        const allDuplicates = [...internalDuplicates, ...duplicatesWithExisting];

        const groupedNew = groupEntriesByCategory(newEntries);
        const groupedDup = groupEntriesByCategory(allDuplicates);

        const modal = document.createElement('div');
        modal.id = 'ttw-merge-modal';
        modal.className = 'ttw-modal-container';

        // 计算条目总数
        const totalEntries = Object.values(importedWorldbook).reduce((sum, cat) => sum + Object.keys(cat).length, 0);

        let newEntriesListHtml = '';
        if (newEntries.length > 0) {
            newEntriesListHtml = `
            <div style="margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-weight:bold;color:#27ae60;">📥 新条目 (${newEntries.length})</span>
                    <label style="font-size:12px;"><input type="checkbox" id="ttw-select-all-new" checked> 全选</label>
                </div>
                <div style="max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;">
        `;

            for (const category in groupedNew) {
                const items = groupedNew[category];
                newEntriesListHtml += `
                <div class="ttw-merge-category-group" style="margin-bottom:10px;">
                    <label style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:rgba(39,174,96,0.2);border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;">
                        <input type="checkbox" class="ttw-new-category-cb" data-category="${category}" checked>
                        <span style="color:#27ae60;">${category}</span>
                        <span style="color:#888;font-weight:normal;">(${items.length})</span>
                    </label>
                    <div style="margin-left:16px;margin-top:4px;">
            `;
                items.forEach((item, localIdx) => {
                    const globalIdx = newEntries.indexOf(item);
                    newEntriesListHtml += `
                    <label style="display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:11px;cursor:pointer;">
                        <input type="checkbox" class="ttw-new-entry-cb" data-index="${globalIdx}" data-category="${category}" checked>
                        <span>${item.name}</span>
                    </label>
                `;
                });
                newEntriesListHtml += `</div></div>`;
            }
            newEntriesListHtml += `</div></div>`;
        }

        let dupEntriesListHtml = '';
        if (allDuplicates.length > 0) {
            dupEntriesListHtml = `
            <div style="margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-weight:bold;color:#e67e22;">🔀 重复条目 (${allDuplicates.length})</span>
                    <label style="font-size:12px;"><input type="checkbox" id="ttw-select-all-dup" checked> 全选</label>
                </div>
                <div style="max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;">
        `;

            for (const category in groupedDup) {
                const items = groupedDup[category];
                dupEntriesListHtml += `
                <div class="ttw-merge-category-group" style="margin-bottom:10px;">
                    <label style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:rgba(230,126,34,0.2);border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;">
                        <input type="checkbox" class="ttw-dup-category-cb" data-category="${category}" checked>
                        <span style="color:#e67e22;">${category}</span>
                        <span style="color:#888;font-weight:normal;">(${items.length})</span>
                    </label>
                    <div style="margin-left:16px;margin-top:4px;">
            `;
                items.forEach((item, localIdx) => {
                    const globalIdx = allDuplicates.indexOf(item);
                    const isInternal = internalDuplicates.includes(item);
                    const badge = isInternal ? '<span style="font-size:9px;color:#9b59b6;margin-left:4px;">(内部重复)</span>' : '';
                    dupEntriesListHtml += `
                    <label style="display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:11px;cursor:pointer;">
                        <input type="checkbox" class="ttw-dup-entry-cb" data-index="${globalIdx}" data-category="${category}" checked>
                        <span>${item.name}${badge}</span>
                    </label>
                `;
                });
                dupEntriesListHtml += `</div></div>`;
            }
            dupEntriesListHtml += `</div></div>`;
        }

        const internalDupCount = internalDuplicates.length;
        const externalDupCount = duplicatesWithExisting.length;

        modal.innerHTML = `
        <div class="ttw-modal" style="max-width:800px;">
            <div class="ttw-modal-header">
                <span class="ttw-modal-title">📥 导入世界书: ${fileName}</span>
                <button class="ttw-modal-close" type="button">✕</button>
            </div>
            <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                <div style="margin-bottom:16px;padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                    <div style="font-weight:bold;color:#3498db;margin-bottom:8px;">📊 导入分析</div>
                    <div style="font-size:13px;color:#ccc;">
                        • 总条目: <span style="color:#3498db;font-weight:bold;">${totalEntries}</span> 个<br>
                        • 新条目: <span style="color:#27ae60;font-weight:bold;">${newEntries.length}</span> 个<br>
                        • 重复条目: <span style="color:#e67e22;font-weight:bold;">${allDuplicates.length}</span> 个
                        ${internalDupCount > 0 ? `<span style="color:#9b59b6;font-size:11px;">(其中 ${internalDupCount} 个为文件内部重复)</span>` : ''}
                        ${externalDupCount > 0 ? `<span style="color:#888;font-size:11px;">(${externalDupCount} 个与现有世界书重复)</span>` : ''}
                    </div>
                </div>

                ${newEntriesListHtml}
                ${dupEntriesListHtml}

                ${allDuplicates.length > 0 ? `
                <div style="margin-bottom:16px;">
                    <div style="font-weight:bold;color:#e67e22;margin-bottom:10px;">🔀 重复条目处理方式</div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <label class="ttw-merge-option">
                            <input type="radio" name="merge-mode" value="ai" checked>
                            <div>
                                <div style="font-weight:bold;">🤖 AI智能合并 (支持并发)</div>
                                <div style="font-size:11px;color:#888;">使用AI合并相同名称的条目，保留所有信息</div>
                            </div>
                        </label>
                        <label class="ttw-merge-option">
                            <input type="radio" name="merge-mode" value="replace">
                            <div>
                                <div style="font-weight:bold;">📝 使用后者覆盖</div>
                                <div style="font-size:11px;color:#888;">用后面的条目覆盖前面的条目</div>
                            </div>
                        </label>
                        <label class="ttw-merge-option">
                            <input type="radio" name="merge-mode" value="keep">
                            <div>
                                <div style="font-weight:bold;">🔒 保留前者</div>
                                <div style="font-size:11px;color:#888;">保留第一个条目，丢弃后面的重复条目</div>
                            </div>
                        </label>
                        <label class="ttw-merge-option">
                            <input type="radio" name="merge-mode" value="rename">
                            <div>
                                <div style="font-weight:bold;">📋 重命名保留</div>
                                <div style="font-size:11px;color:#888;">将重复条目添加为新名称（如 角色名_2）</div>
                            </div>
                        </label>
                        <label class="ttw-merge-option">
                            <input type="radio" name="merge-mode" value="append">
                            <div>
                                <div style="font-weight:bold;">➕ 内容叠加</div>
                                <div style="font-size:11px;color:#888;">将重复条目的内容追加到原条目后面</div>
                            </div>
                        </label>
                    </div>
                </div>

                <div id="ttw-ai-merge-options" style="margin-bottom:16px;padding:12px;background:rgba(155,89,182,0.15);border-radius:8px;">
                    <div style="font-weight:bold;color:#9b59b6;margin-bottom:10px;">🤖 AI合并设置</div>
                    <div style="margin-bottom:10px;">
                        <label style="display:flex;align-items:center;gap:8px;font-size:12px;">
                            <span>并发数:</span>
                            <input type="number" id="ttw-merge-concurrency" value="${parallelConfig.concurrency}" min="1" max="10" style="width:60px;padding:4px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;">
                        </label>
                    </div>
                    <textarea id="ttw-merge-prompt" rows="4" style="width:100%;padding:10px;border:1px solid #555;border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;resize:vertical;" placeholder="留空使用默认提示词...">${settings.customMergePrompt || ''}</textarea>
                    <div style="margin-top:8px;">
                        <button class="ttw-btn ttw-btn-small" id="ttw-preview-merge-prompt">👁️ 预览默认提示词</button>
                    </div>
                </div>
                ` : ''}
            </div>
            <div class="ttw-modal-footer">
                <button class="ttw-btn" id="ttw-cancel-merge">取消</button>
                <button class="ttw-btn ttw-btn-primary" id="ttw-confirm-merge">✅ 确认导入</button>
            </div>
        </div>
    `;

        document.body.appendChild(modal);

        // 事件绑定
        const selectAllNewCb = modal.querySelector('#ttw-select-all-new');
        if (selectAllNewCb) {
            selectAllNewCb.addEventListener('change', (e) => {
                modal.querySelectorAll('.ttw-new-entry-cb').forEach(cb => cb.checked = e.target.checked);
                modal.querySelectorAll('.ttw-new-category-cb').forEach(cb => cb.checked = e.target.checked);
            });
        }

        const selectAllDupCb = modal.querySelector('#ttw-select-all-dup');
        if (selectAllDupCb) {
            selectAllDupCb.addEventListener('change', (e) => {
                modal.querySelectorAll('.ttw-dup-entry-cb').forEach(cb => cb.checked = e.target.checked);
                modal.querySelectorAll('.ttw-dup-category-cb').forEach(cb => cb.checked = e.target.checked);
            });
        }

        modal.querySelectorAll('.ttw-new-category-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const category = e.target.dataset.category;
                modal.querySelectorAll(`.ttw-new-entry-cb[data-category="${category}"]`).forEach(entryCb => {
                    entryCb.checked = e.target.checked;
                });
            });
        });

        modal.querySelectorAll('.ttw-dup-category-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const category = e.target.dataset.category;
                modal.querySelectorAll(`.ttw-dup-entry-cb[data-category="${category}"]`).forEach(entryCb => {
                    entryCb.checked = e.target.checked;
                });
            });
        });

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-merge').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const aiOptions = modal.querySelector('#ttw-ai-merge-options');
        if (aiOptions) {
            modal.querySelectorAll('input[name="merge-mode"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    aiOptions.style.display = radio.value === 'ai' ? 'block' : 'none';
                });
            });
        }

        if (modal.querySelector('#ttw-preview-merge-prompt')) {
            modal.querySelector('#ttw-preview-merge-prompt').addEventListener('click', () => {
                alert('默认合并提示词:\n\n' + defaultMergePrompt);
            });
        }

        modal.querySelector('#ttw-confirm-merge').addEventListener('click', async () => {
            const mergeMode = modal.querySelector('input[name="merge-mode"]:checked')?.value || 'keep';
            const customPrompt = modal.querySelector('#ttw-merge-prompt')?.value || '';
            const mergeConcurrency = parseInt(modal.querySelector('#ttw-merge-concurrency')?.value) || parallelConfig.concurrency;
            settings.customMergePrompt = customPrompt;
            saveCurrentSettings();

            const selectedNewIndices = [...modal.querySelectorAll('.ttw-new-entry-cb:checked')].map(cb => parseInt(cb.dataset.index));
            const selectedDupIndices = [...modal.querySelectorAll('.ttw-dup-entry-cb:checked')].map(cb => parseInt(cb.dataset.index));

            const selectedNew = selectedNewIndices.map(i => newEntries[i]).filter(Boolean);
            const selectedDup = selectedDupIndices.map(i => allDuplicates[i]).filter(Boolean);

            modal.remove();
            await performMergeInternal(importedWorldbook, selectedDup, selectedNew, mergeMode, customPrompt, mergeConcurrency);
        });
    }


    async function performMerge(importedWorldbook, duplicates, newEntries, mergeMode, customPrompt, concurrency = 3) {
        showProgressSection(true);
        isProcessingStopped = false;
        updateProgress(0, '开始合并...');
        updateStreamContent('', true);
        updateStreamContent(`🔀 开始合并世界书\n合并模式: ${mergeMode}\n并发数: ${concurrency}\n${'='.repeat(50)}\n`);

        for (const item of newEntries) {
            if (!generatedWorldbook[item.category]) generatedWorldbook[item.category] = {};
            generatedWorldbook[item.category][item.name] = item.entry;
        }
        updateStreamContent(`✅ 添加了 ${newEntries.length} 个新条目\n`);

        if (duplicates.length > 0) {
            updateStreamContent(`\n🔀 处理 ${duplicates.length} 个重复条目...\n`);

            if (mergeMode === 'ai') {
                const semaphore = new Semaphore(concurrency);
                let completed = 0;
                let failed = 0;

                const processOne = async (dup, index) => {
                    if (isProcessingStopped) return;

                    await semaphore.acquire();
                    if (isProcessingStopped) {
                        semaphore.release();
                        return;
                    }

                    try {
                        updateStreamContent(`📝 [${index + 1}/${duplicates.length}] ${dup.category} - ${dup.name}\n`);
                        const mergedEntry = await mergeEntriesWithAI(dup.existing, dup.imported, customPrompt);
                        generatedWorldbook[dup.category][dup.name] = mergedEntry;
                        completed++;
                        updateProgress((completed / duplicates.length) * 100, `AI合并中 (${completed}/${duplicates.length})`);
                        updateStreamContent(`   ✅ 完成\n`);
                    } catch (error) {
                        failed++;
                        updateStreamContent(`   ❌ 失败: ${error.message}\n`);
                    } finally {
                        semaphore.release();
                    }
                };

                await Promise.allSettled(duplicates.map((dup, i) => processOne(dup, i)));
                updateStreamContent(`\n📦 AI合并完成: 成功 ${completed}, 失败 ${failed}\n`);

            } else {
                for (let i = 0; i < duplicates.length; i++) {
                    if (isProcessingStopped) break;

                    const dup = duplicates[i];
                    updateProgress(((i + 1) / duplicates.length) * 100, `处理: [${dup.category}] ${dup.name}`);
                    updateStreamContent(`\n📝 [${i + 1}/${duplicates.length}] ${dup.category} - ${dup.name}\n`);

                    if (mergeMode === 'replace') {
                        generatedWorldbook[dup.category][dup.name] = dup.imported;
                        updateStreamContent(`   ✅ 已覆盖\n`);
                    } else if (mergeMode === 'keep') {
                        updateStreamContent(`   ⏭️ 保留原有\n`);
                    } else if (mergeMode === 'rename') {
                        const newName = `${dup.name}_导入`;
                        generatedWorldbook[dup.category][newName] = dup.imported;
                        updateStreamContent(`   ✅ 添加为: ${newName}\n`);
                    } else if (mergeMode === 'append') {
                        const existing = generatedWorldbook[dup.category][dup.name];
                        const keywords = [...new Set([...(existing['关键词'] || []), ...(dup.imported['关键词'] || [])])];
                        const content = (existing['内容'] || '') + '\n\n---\n\n' + (dup.imported['内容'] || '');
                        generatedWorldbook[dup.category][dup.name] = { '关键词': keywords, '内容': content };
                        updateStreamContent(`   ✅ 内容已叠加\n`);
                    }
                }
            }
        }

        pendingImportData = null;

        updateProgress(100, '合并完成！');
        updateStreamContent(`\n${'='.repeat(50)}\n✅ 合并完成！\n`);

        showResultSection(true);
        updateWorldbookPreview();
        alert('世界书合并完成！');
    }
    async function performMergeInternal(importedWorldbook, duplicates, newEntries, mergeMode, customPrompt, concurrency = 3) {
        showProgressSection(true);
        isProcessingStopped = false;
        updateProgress(0, '开始处理...');
        updateStreamContent('', true);
        updateStreamContent(`🔀 开始处理世界书\n处理模式: ${mergeMode}\n并发数: ${concurrency}\n${'='.repeat(50)}\n`);

        // 先把导入的世界书作为基础
        const resultWorldbook = JSON.parse(JSON.stringify(importedWorldbook));

        // 添加新条目到现有世界书
        for (const item of newEntries) {
            if (!generatedWorldbook[item.category]) generatedWorldbook[item.category] = {};
            generatedWorldbook[item.category][item.name] = item.entry;
        }
        updateStreamContent(`✅ 添加了 ${newEntries.length} 个新条目到现有世界书\n`);

        if (duplicates.length > 0) {
            updateStreamContent(`\n🔀 处理 ${duplicates.length} 个重复条目...\n`);

            if (mergeMode === 'ai') {
                const semaphore = new Semaphore(concurrency);
                let completed = 0;
                let failed = 0;

                const processOne = async (dup, index) => {
                    if (isProcessingStopped) return;

                    await semaphore.acquire();
                    if (isProcessingStopped) {
                        semaphore.release();
                        return;
                    }

                    try {
                        updateStreamContent(`📝 [${index + 1}/${duplicates.length}] ${dup.category} - ${dup.name}\n`);
                        const mergedEntry = await mergeEntriesWithAI(dup.existing, dup.imported, customPrompt);

                        // 更新到结果世界书
                        if (!resultWorldbook[dup.category]) resultWorldbook[dup.category] = {};
                        resultWorldbook[dup.category][dup.name] = mergedEntry;

                        completed++;
                        updateProgress((completed / duplicates.length) * 100, `AI合并中 (${completed}/${duplicates.length})`);
                        updateStreamContent(`   ✅ 完成\n`);
                    } catch (error) {
                        failed++;
                        updateStreamContent(`   ❌ 失败: ${error.message}\n`);
                    } finally {
                        semaphore.release();
                    }
                };

                await Promise.allSettled(duplicates.map((dup, i) => processOne(dup, i)));
                updateStreamContent(`\n📦 AI合并完成: 成功 ${completed}, 失败 ${failed}\n`);

            } else {
                for (let i = 0; i < duplicates.length; i++) {
                    if (isProcessingStopped) break;

                    const dup = duplicates[i];
                    updateProgress(((i + 1) / duplicates.length) * 100, `处理: [${dup.category}] ${dup.name}`);
                    updateStreamContent(`\n📝 [${i + 1}/${duplicates.length}] ${dup.category} - ${dup.name}\n`);

                    if (!resultWorldbook[dup.category]) resultWorldbook[dup.category] = {};

                    if (mergeMode === 'replace') {
                        resultWorldbook[dup.category][dup.name] = dup.imported;
                        updateStreamContent(`   ✅ 使用后者覆盖\n`);
                    } else if (mergeMode === 'keep') {
                        // 保持第一个，不做改动
                        updateStreamContent(`   ⏭️ 保留前者\n`);
                    } else if (mergeMode === 'rename') {
                        let newName = `${dup.name}_2`;
                        let counter = 2;
                        while (resultWorldbook[dup.category][newName]) {
                            counter++;
                            newName = `${dup.name}_${counter}`;
                        }
                        resultWorldbook[dup.category][newName] = dup.imported;
                        updateStreamContent(`   ✅ 添加为: ${newName}\n`);
                    } else if (mergeMode === 'append') {
                        const existing = resultWorldbook[dup.category][dup.name] || dup.existing;
                        const keywords = [...new Set([...(existing['关键词'] || []), ...(dup.imported['关键词'] || [])])];
                        const content = (existing['内容'] || '') + '\n\n---\n\n' + (dup.imported['内容'] || '');
                        resultWorldbook[dup.category][dup.name] = { '关键词': keywords, '内容': content };
                        updateStreamContent(`   ✅ 内容已叠加\n`);
                    }
                }
            }
        }

        // 把处理结果合并到现有世界书
        for (const category in resultWorldbook) {
            if (!generatedWorldbook[category]) generatedWorldbook[category] = {};
            for (const name in resultWorldbook[category]) {
                generatedWorldbook[category][name] = resultWorldbook[category][name];
            }
        }

        pendingImportData = null;

        updateProgress(100, '处理完成！');
        updateStreamContent(`\n${'='.repeat(50)}\n✅ 处理完成！\n`);

        showResultSection(true);
        updateWorldbookPreview();
        alert('世界书导入完成！');
    }


    async function mergeEntriesWithAI(entryA, entryB, customPrompt) {
        const promptTemplate = customPrompt?.trim() || defaultMergePrompt;
        const prompt = promptTemplate
            .replace('{ENTRY_A}', JSON.stringify(entryA, null, 2))
            .replace('{ENTRY_B}', JSON.stringify(entryB, null, 2));

        const response = await callAPI(getLanguagePrefix() + prompt);

        try {
            const result = parseAIResponse(response);
            if (result['关键词'] || result['内容']) {
                return {
                    '关键词': result['关键词'] || [...(entryA['关键词'] || []), ...(entryB['关键词'] || [])],
                    '内容': result['内容'] || entryA['内容'] || entryB['内容']
                };
            }
            return result;
        } catch (e) {
            return {
                '关键词': [...new Set([...(entryA['关键词'] || []), ...(entryB['关键词'] || [])])],
                '内容': `${entryA['内容'] || ''}\n\n---\n\n${entryB['内容'] || ''}`
            };
        }
    }

    // ========== 条目内容整理功能 - 修改为支持多选分类 ==========
    async function consolidateEntry(category, entryName, promptTemplate) {
        const entry = generatedWorldbook[category]?.[entryName];
        if (!entry || !entry['内容']) return;

        const template = (promptTemplate && promptTemplate.trim()) ? promptTemplate.trim() : defaultConsolidatePrompt;
        const prompt = template.replace('{CONTENT}', entry['内容']);
        let response = await callAPI(getLanguagePrefix() + prompt);

        // 【v3.0.8修复】应用响应过滤标签（移除thinking等）
        response = filterResponseContent(response);

        entry['内容'] = response.trim();
        if (Array.isArray(entry['关键词'])) {
            entry['关键词'] = [...new Set(entry['关键词'])];
        }
    }

    // 显示整理条目选择弹窗（两级：分类→条目，支持失败重试）
    let lastConsolidateFailedEntries = [];

    function showConsolidateCategorySelector() {
        const categories = Object.keys(generatedWorldbook).filter(cat => {
            const entries = generatedWorldbook[cat];
            return entries && typeof entries === 'object' && Object.keys(entries).length > 0;
        });

        if (categories.length === 0) {
            alert('没有可整理的分类');
            return;
        }

        const existingModal = document.getElementById('ttw-consolidate-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-consolidate-modal';
        modal.className = 'ttw-modal-container';

        // 构建分类→条目的两级列表
        let categoriesHtml = '';
        categories.forEach(cat => {
            const entryNames = Object.keys(generatedWorldbook[cat]);
            const entryCount = entryNames.length;

            let entriesListHtml = '';
            entryNames.forEach(name => {
                const isFailed = lastConsolidateFailedEntries.some(e => e.category === cat && e.name === name);
                const failedBadge = isFailed ? '<span style="color:#e74c3c;font-size:9px;margin-left:4px;">❗失败</span>' : '';
                const entryTokens = getEntryTotalTokens(generatedWorldbook[cat][name]);
                entriesListHtml += `
                    <label style="display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:11px;cursor:pointer;">
                        <input type="checkbox" class="ttw-consolidate-entry-cb" data-category="${cat}" data-entry="${name}" ${isFailed ? 'checked' : ''}>
                        <span style="flex:1;">${name}${failedBadge}</span>
                        <span style="color:#888;font-size:10px;white-space:nowrap;">${entryTokens}t</span>
                    </label>
                `;
            });

            const hasFailedInCat = lastConsolidateFailedEntries.some(e => e.category === cat);

            let catTotalTokens = 0;
            entryNames.forEach(name => { catTotalTokens += getEntryTotalTokens(generatedWorldbook[cat][name]); });

            // 构建预设下拉选项
            const presets = settings.consolidatePromptPresets || [];
            const currentPreset = (settings.consolidateCategoryPresetMap || {})[cat] || '默认';
            let presetOptionsHtml = `<option value="默认" ${currentPreset === '默认' ? 'selected' : ''}>默认</option>`;
            presets.forEach(p => {
                presetOptionsHtml += `<option value="${p.name}" ${currentPreset === p.name ? 'selected' : ''}>${p.name}</option>`;
            });

            categoriesHtml += `
                <div class="ttw-consolidate-cat-group" style="margin-bottom:10px;">
                    <div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(52,152,219,0.15);border-radius:6px;cursor:pointer;" data-cat-toggle="${cat}">
                        <input type="checkbox" class="ttw-consolidate-cat-cb" data-category="${cat}" ${hasFailedInCat ? 'checked' : ''}>
                        <span style="font-weight:bold;font-size:12px;flex:1;">${cat}</span>
                        <select class="ttw-consolidate-cat-preset" data-category="${cat}" style="font-size:10px;padding:2px 4px;border:1px solid #666;border-radius:4px;background:rgba(0,0,0,0.4);color:#ccc;max-width:100px;cursor:pointer;" title="选择此分类使用的整理提示词预设" onclick="event.stopPropagation();">${presetOptionsHtml}</select>
                        <span style="color:#888;font-size:11px;">(${entryCount}条 ~${catTotalTokens}t)</span>
                        ${hasFailedInCat ? '<span style="color:#e74c3c;font-size:10px;">有失败</span>' : ''}
                        <span class="ttw-cat-expand-icon" style="font-size:10px;transition:transform 0.2s;">▶</span>
                    </div>
                    <div class="ttw-cat-entries-list" data-cat-list="${cat}" style="display:none;margin-left:20px;margin-top:4px;max-height:200px;overflow-y:auto;">
                        <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:4px;">
                            <button class="ttw-btn-tiny ttw-select-all-entries" data-category="${cat}">全选</button>
                            <button class="ttw-btn-tiny ttw-deselect-all-entries" data-category="${cat}">全不选</button>
                            ${hasFailedInCat ? '<button class="ttw-btn-tiny ttw-select-failed-entries" data-category="' + cat + '" style="color:#e74c3c;">选失败项</button>' : ''}
                        </div>
                        ${entriesListHtml}
                    </div>
                </div>
            `;
        });

        const hasAnyFailed = lastConsolidateFailedEntries.length > 0;

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:600px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🧹 整理条目 - 选择条目</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:65vh;overflow-y:auto;">
                    <div style="margin-bottom:12px;padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                        <div style="font-size:12px;color:#ccc;">展开分类可多选具体条目。AI将去除重复信息并优化格式。</div>
                    </div>
                    <div style="margin-bottom:12px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <span style="font-weight:bold;font-size:12px;color:#e67e22;">📝 整理提示词预设</span>
                            <div style="display:flex;gap:6px;">
                                <button class="ttw-btn ttw-btn-small" id="ttw-consolidate-add-preset" style="font-size:10px;background:rgba(52,152,219,0.5);">➕ 添加预设</button>
                            </div>
                        </div>
                        <div style="font-size:10px;color:#888;margin-bottom:8px;">
                            每个分类可指定不同预设。<code style="background:rgba(0,0,0,0.3);padding:1px 4px;border-radius:3px;color:#f39c12;">{CONTENT}</code> 会被替换为条目原始内容。「默认」预设不可删除。
                        </div>
                        <div id="ttw-consolidate-presets-list" style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;"></div>
                    </div>
                    ${hasAnyFailed ? `
                    <div style="margin-bottom:12px;padding:10px;background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.3);border-radius:6px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <span style="color:#e74c3c;font-weight:bold;font-size:12px;">❗ 上次有 ${lastConsolidateFailedEntries.length} 个条目失败</span>
                            <button class="ttw-btn ttw-btn-small ttw-btn-warning" id="ttw-select-all-failed">🔧 只选失败项</button>
                        </div>
                    </div>
                    ` : ''}
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                        <span style="font-weight:bold;">选择分类和条目 <span id="ttw-consolidate-selected-count" style="color:#888;font-size:11px;font-weight:normal;"></span></span>
                        <div style="display:flex;gap:8px;">
                            <button class="ttw-btn-tiny" id="ttw-check-all-cats">全选所有</button>
                            <button class="ttw-btn-tiny" id="ttw-uncheck-all-cats">全不选</button>
                        </div>
                    </div>
                    <div style="background:rgba(0,0,0,0.2);border-radius:6px;padding:10px;">
                        ${categoriesHtml}
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-consolidate">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-start-consolidate">🧹 开始整理</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // 更新选中计数
        function updateSelectedCount() {
            const count = modal.querySelectorAll('.ttw-consolidate-entry-cb:checked').length;
            const countEl = modal.querySelector('#ttw-consolidate-selected-count');
            if (countEl) countEl.textContent = `(已选 ${count} 条)`;
        }

        // 展开/收起分类
        modal.querySelectorAll('[data-cat-toggle]').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const cat = header.dataset.catToggle;
                const list = modal.querySelector(`[data-cat-list="${cat}"]`);
                const icon = header.querySelector('.ttw-cat-expand-icon');
                if (list.style.display === 'none') {
                    list.style.display = 'block';
                    icon.style.transform = 'rotate(90deg)';
                } else {
                    list.style.display = 'none';
                    icon.style.transform = 'rotate(0deg)';
                }
            });
        });

        // 分类checkbox → 联动所有子条目
        modal.querySelectorAll('.ttw-consolidate-cat-cb').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const cat = e.target.dataset.category;
                modal.querySelectorAll(`.ttw-consolidate-entry-cb[data-category="${cat}"]`).forEach(entryCb => {
                    entryCb.checked = e.target.checked;
                });
                updateSelectedCount();
            });
        });

        // 条目checkbox变化 → 更新计数
        modal.querySelectorAll('.ttw-consolidate-entry-cb').forEach(cb => {
            cb.addEventListener('change', updateSelectedCount);
        });

        // 分类内：全选/全不选/选失败项
        modal.querySelectorAll('.ttw-select-all-entries').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.dataset.category;
                modal.querySelectorAll(`.ttw-consolidate-entry-cb[data-category="${cat}"]`).forEach(cb => cb.checked = true);
                updateSelectedCount();
            });
        });
        modal.querySelectorAll('.ttw-deselect-all-entries').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.dataset.category;
                modal.querySelectorAll(`.ttw-consolidate-entry-cb[data-category="${cat}"]`).forEach(cb => cb.checked = false);
                updateSelectedCount();
            });
        });
        modal.querySelectorAll('.ttw-select-failed-entries').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.dataset.category;
                modal.querySelectorAll(`.ttw-consolidate-entry-cb[data-category="${cat}"]`).forEach(cb => {
                    const isFailed = lastConsolidateFailedEntries.some(e => e.category === cat && e.name === cb.dataset.entry);
                    cb.checked = isFailed;
                });
                updateSelectedCount();
            });
        });

        // 全局：全选所有/全不选
        modal.querySelector('#ttw-check-all-cats').addEventListener('click', () => {
            modal.querySelectorAll('.ttw-consolidate-cat-cb').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change')); });
        });
        modal.querySelector('#ttw-uncheck-all-cats').addEventListener('click', () => {
            modal.querySelectorAll('.ttw-consolidate-cat-cb').forEach(cb => { cb.checked = false; cb.dispatchEvent(new Event('change')); });
        });

        // 只选失败项
        const selectAllFailedBtn = modal.querySelector('#ttw-select-all-failed');
        if (selectAllFailedBtn) {
            selectAllFailedBtn.addEventListener('click', () => {
                // 先全不选
                modal.querySelectorAll('.ttw-consolidate-entry-cb').forEach(cb => cb.checked = false);
                modal.querySelectorAll('.ttw-consolidate-cat-cb').forEach(cb => cb.checked = false);
                // 选中失败项
                lastConsolidateFailedEntries.forEach(failed => {
                    const cb = modal.querySelector(`.ttw-consolidate-entry-cb[data-category="${failed.category}"][data-entry="${failed.name}"]`);
                    if (cb) cb.checked = true;
                });
                updateSelectedCount();
            });
        }

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-consolidate').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // ========== 预设管理 ==========
        function getPresetPromptByName(name) {
            if (!name || name === '默认') return defaultConsolidatePrompt;
            const preset = (settings.consolidatePromptPresets || []).find(p => p.name === name);
            return (preset && preset.prompt && preset.prompt.trim()) ? preset.prompt : defaultConsolidatePrompt;
        }

        function renderPresetsListUI() {
            const container = modal.querySelector('#ttw-consolidate-presets-list');
            if (!container) return;
            const presets = settings.consolidatePromptPresets || [];
            let html = '';

            // 默认预设（不可删除）
            html += `
                <div class="ttw-consolidate-preset-card" style="padding:8px 10px;background:rgba(46,204,113,0.1);border:1px solid rgba(46,204,113,0.3);border-radius:6px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <span style="font-weight:bold;font-size:11px;color:#2ecc71;flex:1;">📌 默认</span>
                        <span style="font-size:10px;color:#888;">内置·不可删除</span>
                        <button class="ttw-btn-tiny ttw-consolidate-toggle-preview" data-preset-index="-1" style="font-size:9px;">展开</button>
                    </div>
                    <div class="ttw-consolidate-preset-preview" data-preview-index="-1" style="display:none;">
                        <textarea rows="3" style="width:100%;padding:6px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#aaa;font-size:10px;resize:vertical;line-height:1.4;" readonly>${defaultConsolidatePrompt}</textarea>
                    </div>
                </div>
            `;

            // 用户自定义预设
            presets.forEach((preset, idx) => {
                html += `
                    <div class="ttw-consolidate-preset-card" style="padding:8px 10px;background:rgba(230,126,34,0.1);border:1px solid rgba(230,126,34,0.3);border-radius:6px;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                            <input type="text" class="ttw-consolidate-preset-name" data-preset-index="${idx}" value="${preset.name}" style="font-weight:bold;font-size:11px;color:#e67e22;background:transparent;border:1px solid transparent;border-radius:3px;padding:2px 4px;flex:1;min-width:0;" title="点击编辑预设名称">
                            <button class="ttw-btn-tiny ttw-consolidate-toggle-preview" data-preset-index="${idx}" style="font-size:9px;">展开</button>
                            <button class="ttw-btn-tiny ttw-consolidate-delete-preset" data-preset-index="${idx}" style="font-size:9px;color:#e74c3c;" title="删除预设">🗑️</button>
                        </div>
                        <div class="ttw-consolidate-preset-preview" data-preview-index="${idx}" style="display:none;">
                            <textarea class="ttw-consolidate-preset-prompt" data-preset-index="${idx}" rows="3" style="width:100%;padding:6px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;font-size:10px;resize:vertical;line-height:1.4;" placeholder="输入提示词...必须包含 {CONTENT} 占位符">${preset.prompt || ''}</textarea>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;

            // 展开/收起预览
            container.querySelectorAll('.ttw-consolidate-toggle-preview').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = btn.dataset.presetIndex;
                    const preview = container.querySelector(`[data-preview-index="${idx}"]`);
                    if (preview) {
                        const isHidden = preview.style.display === 'none';
                        preview.style.display = isHidden ? 'block' : 'none';
                        btn.textContent = isHidden ? '收起' : '展开';
                    }
                });
            });

            // 编辑预设名称
            container.querySelectorAll('.ttw-consolidate-preset-name').forEach(input => {
                input.addEventListener('focus', () => { input.style.borderColor = '#e67e22'; });
                input.addEventListener('blur', () => {
                    input.style.borderColor = 'transparent';
                    const idx = parseInt(input.dataset.presetIndex);
                    const newName = input.value.trim();
                    if (!newName) { input.value = presets[idx].name; return; }
                    if (newName === '默认') { alert('不能使用"默认"作为预设名'); input.value = presets[idx].name; return; }
                    if (presets.some((p, i) => i !== idx && p.name === newName)) { alert('预设名已存在'); input.value = presets[idx].name; return; }
                    const oldName = presets[idx].name;
                    presets[idx].name = newName;
                    // 同步更新分类映射中引用旧名称的
                    const map = settings.consolidateCategoryPresetMap || {};
                    Object.keys(map).forEach(cat => { if (map[cat] === oldName) map[cat] = newName; });
                    settings.consolidatePromptPresets = presets;
                    saveCurrentSettings();
                    refreshCategoryPresetDropdowns();
                });
            });

            // 编辑预设内容
            container.querySelectorAll('.ttw-consolidate-preset-prompt').forEach(textarea => {
                textarea.addEventListener('input', () => {
                    const idx = parseInt(textarea.dataset.presetIndex);
                    presets[idx].prompt = textarea.value;
                    settings.consolidatePromptPresets = presets;
                    saveCurrentSettings();
                });
            });

            // 删除预设
            container.querySelectorAll('.ttw-consolidate-delete-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.presetIndex);
                    const deletedName = presets[idx].name;
                    if (!confirm(`确定删除预设「${deletedName}」？`)) return;
                    presets.splice(idx, 1);
                    // 清理引用该预设的分类映射
                    const map = settings.consolidateCategoryPresetMap || {};
                    Object.keys(map).forEach(cat => { if (map[cat] === deletedName) delete map[cat]; });
                    settings.consolidatePromptPresets = presets;
                    saveCurrentSettings();
                    renderPresetsListUI();
                    refreshCategoryPresetDropdowns();
                });
            });
        }

        // 刷新所有分类的预设下拉
        function refreshCategoryPresetDropdowns() {
            const presets = settings.consolidatePromptPresets || [];
            const map = settings.consolidateCategoryPresetMap || {};
            modal.querySelectorAll('.ttw-consolidate-cat-preset').forEach(select => {
                const cat = select.dataset.category;
                const current = map[cat] || '默认';
                let optionsHtml = `<option value="默认" ${current === '默认' ? 'selected' : ''}>默认</option>`;
                presets.forEach(p => {
                    optionsHtml += `<option value="${p.name}" ${current === p.name ? 'selected' : ''}>${p.name}</option>`;
                });
                select.innerHTML = optionsHtml;
            });
        }

        // 添加预设
        modal.querySelector('#ttw-consolidate-add-preset').addEventListener('click', () => {
            const name = prompt('输入预设名称:');
            if (!name || !name.trim()) return;
            const trimmedName = name.trim();
            if (trimmedName === '默认') { alert('不能使用"默认"作为预设名'); return; }
            if (!settings.consolidatePromptPresets) settings.consolidatePromptPresets = [];
            if (settings.consolidatePromptPresets.some(p => p.name === trimmedName)) { alert('预设名已存在'); return; }
            settings.consolidatePromptPresets.push({ name: trimmedName, prompt: '' });
            saveCurrentSettings();
            renderPresetsListUI();
            refreshCategoryPresetDropdowns();
            // 自动展开新预设的编辑区
            setTimeout(() => {
                const idx = settings.consolidatePromptPresets.length - 1;
                const btn = modal.querySelector(`.ttw-consolidate-toggle-preview[data-preset-index="${idx}"]`);
                if (btn) btn.click();
            }, 100);
        });

        // 分类预设下拉变更 → 保存映射
        modal.querySelectorAll('.ttw-consolidate-cat-preset').forEach(select => {
            select.addEventListener('change', () => {
                const cat = select.dataset.category;
                if (!settings.consolidateCategoryPresetMap) settings.consolidateCategoryPresetMap = {};
                if (select.value === '默认') {
                    delete settings.consolidateCategoryPresetMap[cat];
                } else {
                    settings.consolidateCategoryPresetMap[cat] = select.value;
                }
                saveCurrentSettings();
            });
        });

        renderPresetsListUI();

        modal.querySelector('#ttw-start-consolidate').addEventListener('click', async () => {
            const selectedEntries = [...modal.querySelectorAll('.ttw-consolidate-entry-cb:checked')].map(cb => {
                const cat = cb.dataset.category;
                const presetSelect = modal.querySelector(`.ttw-consolidate-cat-preset[data-category="${cat}"]`);
                const presetName = presetSelect ? presetSelect.value : '默认';
                return {
                    category: cat,
                    name: cb.dataset.entry,
                    promptTemplate: getPresetPromptByName(presetName)
                };
            });
            if (selectedEntries.length === 0) {
                alert('请至少选择一个条目');
                return;
            }
            // 汇总各预设使用情况
            const presetUsage = {};
            selectedEntries.forEach(e => {
                const pSelect = modal.querySelector(`.ttw-consolidate-cat-preset[data-category="${e.category}"]`);
                const pName = pSelect ? pSelect.value : '默认';
                presetUsage[pName] = (presetUsage[pName] || 0) + 1;
            });
            const usageSummary = Object.entries(presetUsage).map(([k, v]) => `「${k}」${v}条`).join('，');
            if (!confirm(`确定要整理 ${selectedEntries.length} 个条目吗？\n\n预设分配：${usageSummary}`)) return;
            modal.remove();
            await consolidateSelectedEntries(selectedEntries);
        });

        updateSelectedCount();
    }


    async function consolidateSelectedCategories(categories) {
        const allEntries = [];
        for (const cat of categories) {
            for (const name of Object.keys(generatedWorldbook[cat] || {})) {
                allEntries.push({ category: cat, name });
            }
        }
        if (allEntries.length === 0) { alert('没有条目'); return; }
        if (!confirm(`确定要整理 ${allEntries.length} 个条目吗？`)) return;
        await consolidateSelectedEntries(allEntries);
    }

    async function consolidateSelectedEntries(entries) {
        showProgressSection(true);
        isProcessingStopped = false;
        updateProgress(0, '开始整理条目...');
        updateStreamContent('', true);
        updateStreamContent(`🧹 开始整理 ${entries.length} 个条目\n${'='.repeat(50)}\n`);

        const semaphore = new Semaphore(parallelConfig.concurrency);
        let completed = 0;
        let failed = 0;
        const failedEntries = [];

        const processOne = async (entry, index) => {
            if (isProcessingStopped) return;

            try {
                await semaphore.acquire();
            } catch (e) {
                if (e.message === 'ABORTED') return;
                throw e;
            }

            if (isProcessingStopped) {
                semaphore.release();
                return;
            }

            try {
                updateStreamContent(`📝 [${index + 1}/${entries.length}] ${entry.category} - ${entry.name}\n`);
                await consolidateEntry(entry.category, entry.name, entry.promptTemplate);
                completed++;
                updateProgress(((completed + failed) / entries.length) * 100, `整理中 (${completed}✅ ${failed}❌ / ${entries.length})`);
                updateStreamContent(`   ✅ 完成\n`);
            } catch (error) {
                failed++;
                failedEntries.push({ category: entry.category, name: entry.name, error: error.message });
                updateProgress(((completed + failed) / entries.length) * 100, `整理中 (${completed}✅ ${failed}❌ / ${entries.length})`);
                updateStreamContent(`   ❌ 失败: ${error.message}\n`);
            } finally {
                semaphore.release();
            }
        };

        await Promise.allSettled(entries.map((entry, i) => processOne(entry, i)));

        // 记录失败条目供下次重试
        lastConsolidateFailedEntries = failedEntries;

        updateProgress(100, `整理完成: 成功 ${completed}, 失败 ${failed}`);
        updateStreamContent(`\n${'='.repeat(50)}\n✅ 整理完成！成功 ${completed}, 失败 ${failed}\n`);

        if (failedEntries.length > 0) {
            updateStreamContent(`\n❗ 失败条目:\n`);
            failedEntries.forEach(f => {
                updateStreamContent(`   • [${f.category}] ${f.name}: ${f.error}\n`);
            });
            updateStreamContent(`\n💡 再次打开"整理条目"可以只选失败项重试\n`);
        }

        updateWorldbookPreview();

        let msg = `条目整理完成！\n成功: ${completed}\n失败: ${failed}`;
        if (failed > 0) {
            msg += `\n\n再次点击"整理条目"可以只选失败项重试`;
        }
        alert(msg);
    }

    // ========== 清除标签功能（不消耗Token） ==========
    function showCleanTagsModal() {
        const existingModal = document.getElementById('ttw-clean-tags-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-clean-tags-modal';
        modal.className = 'ttw-modal-container';

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:750px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🏷️ 清除标签内容（不消耗Token）</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                    <div style="margin-bottom:16px;padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                        <div style="font-size:12px;color:#ccc;">
                            纯本地处理，不调用AI，不消耗Token。<br>
                            扫描后逐条列出匹配，可以单独确认或取消每一条删除。
                        </div>
                    </div>

                    <div style="margin-bottom:16px;">
                        <label style="display:block;margin-bottom:8px;font-size:13px;font-weight:bold;">要清除的标签名（每行一个）</label>
                        <textarea id="ttw-clean-tags-input" rows="4" class="ttw-textarea-small" placeholder="每行一个标签名，例如：
thinking
tucao
tochao">thinking\ntucao\ntochao</textarea>
                    </div>

                    <div style="margin-bottom:16px;padding:12px;background:rgba(230,126,34,0.1);border-radius:6px;">
                        <div style="font-weight:bold;color:#e67e22;margin-bottom:8px;font-size:12px;">📋 匹配规则</div>
                        <ul style="margin:0;padding-left:18px;font-size:11px;color:#ccc;line-height:1.8;">
                            <li><code><tag>内容</tag></code> → 移除标签和标签内的内容</li>
                            <li>文本开头就是 <code>...内容</tag></code> → 移除开头到该结束标签</li>
                            <li>文本末尾有 <code><tag>内容...</code> 无闭合 → 移除该开始标签到末尾</li>
                        </ul>
                        <div style="font-size:11px;color:#f39c12;margin-top:6px;">⚠️ 每条匹配都会显示前后文字，请逐条确认再删除</div>
                    </div>

                    <div style="margin-bottom:16px;">
                        <label class="ttw-checkbox-label">
                            <input type="checkbox" id="ttw-clean-in-worldbook" checked>
                            <span>扫描世界书</span>
                        </label>
                        <label class="ttw-checkbox-label" style="margin-top:8px;">
                            <input type="checkbox" id="ttw-clean-in-results" checked>
                            <span>扫描各章节处理结果</span>
                        </label>
                    </div>

                    <div id="ttw-clean-tags-results" style="display:none;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                            <span id="ttw-clean-scan-summary" style="font-weight:bold;color:#27ae60;"></span>
                            <div style="display:flex;gap:8px;">
                                <button class="ttw-btn-tiny" id="ttw-clean-select-all">全选</button>
                                <button class="ttw-btn-tiny" id="ttw-clean-deselect-all">全不选</button>
                            </div>
                        </div>
                        <div id="ttw-clean-match-list" style="max-height:350px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;"></div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-primary" id="ttw-scan-tags">🔍 扫描</button>
                    <button class="ttw-btn ttw-btn-warning" id="ttw-execute-clean-tags" style="display:none;">🗑️ 删除选中项</button>
                    <button class="ttw-btn" id="ttw-close-clean-tags">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        let scanResults = [];

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-clean-tags').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // 扫描
        modal.querySelector('#ttw-scan-tags').addEventListener('click', () => {
            const tagNames = parseTagNames(modal.querySelector('#ttw-clean-tags-input').value);
            if (tagNames.length === 0) { alert('请输入至少一个标签名'); return; }

            const inWorldbook = modal.querySelector('#ttw-clean-in-worldbook').checked;
            const inResults = modal.querySelector('#ttw-clean-in-results').checked;

            scanResults = scanForTags(tagNames, inWorldbook, inResults);

            const resultsDiv = modal.querySelector('#ttw-clean-tags-results');
            const summaryEl = modal.querySelector('#ttw-clean-scan-summary');
            const listEl = modal.querySelector('#ttw-clean-match-list');
            const execBtn = modal.querySelector('#ttw-execute-clean-tags');

            resultsDiv.style.display = 'block';

            if (scanResults.length === 0) {
                summaryEl.textContent = '未找到匹配的标签内容';
                summaryEl.style.color = '#888';
                listEl.innerHTML = '';
                execBtn.style.display = 'none';
                return;
            }

            summaryEl.textContent = `找到 ${scanResults.length} 处匹配`;
            summaryEl.style.color = '#27ae60';
            execBtn.style.display = 'inline-block';
            execBtn.textContent = `🗑️ 删除选中项 (${scanResults.length})`;

            renderMatchList(listEl, scanResults, execBtn);
        });

        // 全选/全不选
        modal.querySelector('#ttw-clean-select-all').addEventListener('click', () => {
            modal.querySelectorAll('.ttw-clean-match-cb').forEach(cb => cb.checked = true);
            updateExecBtnCount(modal, scanResults);
        });
        modal.querySelector('#ttw-clean-deselect-all').addEventListener('click', () => {
            modal.querySelectorAll('.ttw-clean-match-cb').forEach(cb => cb.checked = false);
            updateExecBtnCount(modal, scanResults);
        });

        // 执行删除
        modal.querySelector('#ttw-execute-clean-tags').addEventListener('click', () => {
            const selectedIndices = [...modal.querySelectorAll('.ttw-clean-match-cb:checked')].map(cb => parseInt(cb.dataset.index));
            if (selectedIndices.length === 0) { alert('请至少选择一项'); return; }

            if (!confirm(`确定要删除选中的 ${selectedIndices.length} 处标签内容吗？\n\n请确认预览无误！此操作不可撤销！`)) return;

            // 按从后往前排序，避免删除偏移
            const toDelete = selectedIndices.map(i => scanResults[i]).filter(Boolean);
            const grouped = groupMatchesBySource(toDelete);

            let deletedCount = 0;
            for (const key in grouped) {
                const matches = grouped[key];
                // 同一个文本内的匹配，从后往前删
                matches.sort((a, b) => b.startInText - a.startInText);

                const textRef = getTextRef(matches[0]);
                if (!textRef) continue;

                let text = textRef.get();
                for (const m of matches) {
                    const before = text.substring(0, m.startInText);
                    const after = text.substring(m.endInText);
                    text = before + after;
                    deletedCount++;
                }
                // 清理多余空行
                text = text.replace(/\n{3,}/g, '\n\n').trim();
                textRef.set(text);
            }

            modal.remove();
            updateWorldbookPreview();
            alert(`清除完成！共删除 ${deletedCount} 处标签内容`);
        });
    }

    function parseTagNames(input) {
        return input.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(line));
    }

    function scanForTags(tagNames, inWorldbook, inResults) {
        const allMatches = [];

        const scanText = (text, source, category, entryName, memoryIndex) => {
            if (!text || typeof text !== 'string') return;

            for (const tag of tagNames) {
                const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // 规则1：完整闭合 <tag>...</tag>
                const fullRegex = new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, 'gi');
                let match;
                while ((match = fullRegex.exec(text)) !== null) {
                    allMatches.push({
                        source, category, entryName, memoryIndex, tag,
                        type: 'full',
                        startInText: match.index,
                        endInText: match.index + match[0].length,
                        matchedText: match[0],
                        fullText: text
                    });
                }

                // 规则2：文本开头到</tag>（不闭合的结束标签）
                // 只在文本前500字符内找</tag>，且前面没有对应的<tag>
                const closeTagRegex = new RegExp(`</${escaped}>`, 'i');
                const closeMatch = text.substring(0, 500).match(closeTagRegex);
                if (closeMatch) {
                    const closePos = closeMatch.index + closeMatch[0].length;
                    const textBefore = text.substring(0, closeMatch.index);
                    const openTagCheck = new RegExp(`<${escaped}[\\s>]`, 'i');
                    // 如果前面没有开始标签，说明是不闭合的
                    if (!openTagCheck.test(textBefore)) {
                        allMatches.push({
                            source, category, entryName, memoryIndex, tag,
                            type: 'close-only',
                            startInText: 0,
                            endInText: closePos,
                            matchedText: text.substring(0, closePos),
                            fullText: text
                        });
                    }
                }

                // 规则3：<tag>到文本末尾（不闭合的开始标签）
                // 只在文本后500字符内找<tag>，且后面没有对应的</tag>
                const tailStart = Math.max(0, text.length - 500);
                const tailText = text.substring(tailStart);
                const openTagRegex = new RegExp(`<${escaped}>`, 'i');
                const openMatch = tailText.match(openTagRegex);
                if (openMatch) {
                    const absPos = tailStart + openMatch.index;
                    const textAfter = text.substring(absPos);
                    const closeTagCheck = new RegExp(`</${escaped}>`, 'i');
                    // 如果后面没有结束标签，说明是不闭合的
                    if (!closeTagCheck.test(textAfter.substring(openMatch[0].length))) {
                        // 排除和规则1重复的（已被完整匹配过）
                        const alreadyMatched = allMatches.some(m =>
                            m.source === source && m.category === category &&
                            m.entryName === entryName && m.memoryIndex === memoryIndex &&
                            m.startInText <= absPos && m.endInText >= text.length
                        );
                        if (!alreadyMatched) {
                            allMatches.push({
                                source, category, entryName, memoryIndex, tag,
                                type: 'open-only',
                                startInText: absPos,
                                endInText: text.length,
                                matchedText: text.substring(absPos),
                                fullText: text
                            });
                        }
                    }
                }
            }
        };

        if (inWorldbook) {
            for (const cat in generatedWorldbook) {
                for (const name in generatedWorldbook[cat]) {
                    const entry = generatedWorldbook[cat][name];
                    if (entry && entry['内容']) {
                        scanText(entry['内容'], 'worldbook', cat, name, -1);
                    }
                }
            }
        }

        if (inResults) {
            for (let i = 0; i < memoryQueue.length; i++) {
                const memory = memoryQueue[i];
                if (!memory.result) continue;
                for (const cat in memory.result) {
                    for (const name in memory.result[cat]) {
                        const entry = memory.result[cat][name];
                        if (entry && entry['内容']) {
                            scanText(entry['内容'], 'memory', cat, name, i);
                        }
                    }
                }
            }
        }

        return allMatches;
    }

    function renderMatchList(container, matches, execBtn) {
        let html = '';
        const CONTEXT_CHARS = 40;

        matches.forEach((m, idx) => {
            const locationStr = m.source === 'worldbook'
                ? `世界书 / ${m.category} / ${m.entryName}`
                : `记忆${m.memoryIndex + 1} / ${m.category} / ${m.entryName}`;

            const typeLabels = { 'full': '完整标签', 'close-only': '开头不闭合', 'open-only': '末尾不闭合' };
            const typeColors = { 'full': '#3498db', 'close-only': '#e67e22', 'open-only': '#9b59b6' };

            // 前文
            const beforeStart = Math.max(0, m.startInText - CONTEXT_CHARS);
            const beforeText = m.fullText.substring(beforeStart, m.startInText);
            const beforePrefix = beforeStart > 0 ? '...' : '';

            // 被删内容（截断显示）
            const deletedFull = m.matchedText;
            const deletedDisplay = deletedFull.length > 200
                ? deletedFull.substring(0, 100) + `\n... (${deletedFull.length}字) ...\n` + deletedFull.substring(deletedFull.length - 80)
                : deletedFull;

            // 后文
            const afterEnd = Math.min(m.fullText.length, m.endInText + CONTEXT_CHARS);
            const afterText = m.fullText.substring(m.endInText, afterEnd);
            const afterSuffix = afterEnd < m.fullText.length ? '...' : '';

            const escapedBefore = (beforePrefix + beforeText).replace(/</g, '<').replace(/>/g, '>').replace(/\n/g, '↵');
            const escapedDeleted = deletedDisplay.replace(/</g, '<').replace(/>/g, '>').replace(/\n/g, '↵');
            const escapedAfter = (afterText + afterSuffix).replace(/</g, '<').replace(/>/g, '>').replace(/\n/g, '↵');

            html += `
                <div style="margin-bottom:10px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;border-left:3px solid ${typeColors[m.type] || '#888'};">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                        <input type="checkbox" class="ttw-clean-match-cb" data-index="${idx}" checked style="width:16px;height:16px;accent-color:#e74c3c;flex-shrink:0;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:10px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${locationStr}">${locationStr}</div>
                            <div style="font-size:10px;margin-top:2px;">
                                <span style="color:${typeColors[m.type]};font-weight:bold;">${typeLabels[m.type]}</span>
                                <span style="color:#888;margin-left:6px;"><${m.tag}> · ${m.matchedText.length}字</span>
                            </div>
                        </div>
                    </div>
                    <div style="font-family:monospace;font-size:11px;line-height:1.6;background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;word-break:break-all;overflow-x:auto;">
                        <span style="color:#888;">${escapedBefore}</span><span style="background:rgba(231,76,60,0.4);color:#ff6b6b;text-decoration:line-through;border:1px dashed #e74c3c;padding:1px 2px;border-radius:2px;">${escapedDeleted}</span><span style="color:#888;">${escapedAfter}</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;

        // 绑定checkbox事件更新计数
        container.querySelectorAll('.ttw-clean-match-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                updateExecBtnCount(container.closest('.ttw-modal-container'), matches);
            });
        });
    }

    function updateExecBtnCount(modal, allMatches) {
        const execBtn = modal.querySelector('#ttw-execute-clean-tags');
        if (!execBtn) return;
        const checkedCount = modal.querySelectorAll('.ttw-clean-match-cb:checked').length;
        execBtn.textContent = `🗑️ 删除选中项 (${checkedCount})`;
    }

    function groupMatchesBySource(matches) {
        const groups = {};
        for (const m of matches) {
            const key = m.source === 'worldbook'
                ? `wb::${m.category}::${m.entryName}`
                : `mem${m.memoryIndex}::${m.category}::${m.entryName}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(m);
        }
        return groups;
    }

    function getTextRef(match) {
        if (match.source === 'worldbook') {
            const entry = generatedWorldbook[match.category]?.[match.entryName];
            if (!entry) return null;
            return {
                get: () => entry['内容'] || '',
                set: (val) => { entry['内容'] = val; }
            };
        } else {
            const memory = memoryQueue[match.memoryIndex];
            if (!memory?.result) return null;
            const entry = memory.result[match.category]?.[match.entryName];
            if (!entry) return null;
            return {
                get: () => entry['内容'] || '',
                set: (val) => { entry['内容'] = val; }
            };
        }
    }


    // ========== 别名识别与合并 ==========
    function findPotentialDuplicateCharacters() {
        return findPotentialDuplicates('角色');
    }

    function findPotentialDuplicates(categoryName) {
        const entries = generatedWorldbook[categoryName];
        if (!entries) return [];

        const names = Object.keys(entries);
        const suspectedGroups = [];
        const processed = new Set();

        for (let i = 0; i < names.length; i++) {
            if (processed.has(names[i])) continue;

            const group = [names[i]];
            const keywordsA = new Set(entries[names[i]]['关键词'] || []);

            for (let j = i + 1; j < names.length; j++) {
                if (processed.has(names[j])) continue;

                const keywordsB = new Set(entries[names[j]]['关键词'] || []);

                const intersection = [...keywordsA].filter(k => keywordsB.has(k));

                const nameContains = names[i].includes(names[j]) || names[j].includes(names[i]);

                const shortNameMatch = checkShortNameMatch(names[i], names[j]);

                if (intersection.length > 0 || nameContains || shortNameMatch) {
                    group.push(names[j]);
                    processed.add(names[j]);
                }
            }

            if (group.length > 1) {
                suspectedGroups.push(group);
                group.forEach(n => processed.add(n));
            }
        }

        return suspectedGroups;
    }

    function checkShortNameMatch(nameA, nameB) {
        const extractName = (fullName) => {
            if (fullName.length <= 3) return fullName;
            return fullName.slice(-2);
        };

        const shortA = extractName(nameA);
        const shortB = extractName(nameB);

        return shortA === shortB || nameA.includes(shortB) || nameB.includes(shortA);
    }

    function generatePairs(group) {
        const pairs = [];
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                pairs.push([group[i], group[j]]);
            }
        }
        return pairs;
    }

    class UnionFind {
        constructor(items) {
            this.parent = {};
            this.rank = {};
            items.forEach(item => {
                this.parent[item] = item;
                this.rank[item] = 0;
            });
        }

        find(x) {
            if (this.parent[x] !== x) {
                this.parent[x] = this.find(this.parent[x]);
            }
            return this.parent[x];
        }

        union(x, y) {
            const rootX = this.find(x);
            const rootY = this.find(y);
            if (rootX === rootY) return;

            if (this.rank[rootX] < this.rank[rootY]) {
                this.parent[rootX] = rootY;
            } else if (this.rank[rootX] > this.rank[rootY]) {
                this.parent[rootY] = rootX;
            } else {
                this.parent[rootY] = rootX;
                this.rank[rootX]++;
            }
        }

        getGroups() {
            const groups = {};
            for (const item in this.parent) {
                const root = this.find(item);
                if (!groups[root]) groups[root] = [];
                groups[root].push(item);
            }
            return Object.values(groups).filter(g => g.length > 1);
        }
    }

    async function verifyDuplicatesWithAI(suspectedGroups, useParallel = true, threshold = 5, categoryName = '角色') {
        if (suspectedGroups.length === 0) return { pairResults: [], mergedGroups: [] };

        const entries = generatedWorldbook[categoryName];

        const allPairs = [];
        const allNames = new Set();

        for (const group of suspectedGroups) {
            const pairs = generatePairs(group);
            pairs.forEach(pair => {
                allPairs.push(pair);
                allNames.add(pair[0]);
                allNames.add(pair[1]);
            });
        }

        if (allPairs.length === 0) return { pairResults: [], mergedGroups: [] };

        // 构建配对内容
        const buildPairContent = (pairs, startIndex = 0) => {
            return pairs.map((pair, i) => {
                const [nameA, nameB] = pair;
                const entryA = entries[nameA];
                const entryB = entries[nameB];

                const keywordsA = entryA?.['关键词']?.join(', ') || '无';
                const keywordsB = entryB?.['关键词']?.join(', ') || '无';
                const contentA = (entryA?.['内容'] || '').substring(0, 300);
                const contentB = (entryB?.['内容'] || '').substring(0, 300);

                return `配对${startIndex + i + 1}: 「${nameA}」vs「${nameB}」
  【${nameA}】关键词: ${keywordsA}
  内容摘要: ${contentA}${contentA.length >= 300 ? '...' : ''}
  【${nameB}】关键词: ${keywordsB}
  内容摘要: ${contentB}${contentB.length >= 300 ? '...' : ''}`;
            }).join('\n\n');
        };

        const categoryLabel = categoryName === '角色' ? '角色' : `「${categoryName}」分类的条目`;
        const buildPrompt = (pairsContent, pairCount) => {
            return getLanguagePrefix() + `你是${categoryName}识别专家。请对以下每一对${categoryLabel}进行判断，判断它们是否为同一${categoryName === '角色' ? '人物' : '事物'}。

## 待判断的${categoryLabel}配对
${pairsContent}

## 判断依据
- 仔细阅读每个条目的关键词和内容摘要
- 根据描述的核心特征、身份、背景等信息判断
- 考虑：全名vs简称、别名、昵称、代号等称呼变化
- 如果内容描述明显指向同一${categoryName === '角色' ? '个人' : '个事物'}，则判定为相同
- 【重要】即使名字相似，如果核心特征明显不同，也要判定为不同

## 要求
- 对每一对分别判断
- 如果是同一${categoryName === '角色' ? '人' : '事物'}，选择更完整/更常用的名称作为mainName
- 如果不是同一${categoryName === '角色' ? '人' : '事物'}，说明原因
- 返回JSON格式

## 输出格式
{
    "results": [
        {"pair": 1, "nameA": "条目A名", "nameB": "条目B名", "isSamePerson": true, "mainName": "保留的名称", "reason": "判断依据"},
        {"pair": 2, "nameA": "条目A名", "nameB": "条目B名", "isSamePerson": false, "reason": "不是同一${categoryName === '角色' ? '人' : '事物'}的原因"}
    ]
}`;
        };

        const pairResults = [];

        if (useParallel && allPairs.length > threshold) {
            // 并发模式：分批处理
            updateStreamContent('\n🚀 并发模式处理配对判断...\n');

            // 将配对分组：每组接近threshold个
            const batches = [];
            for (let i = 0; i < allPairs.length; i += threshold) {
                batches.push({
                    pairs: allPairs.slice(i, Math.min(i + threshold, allPairs.length)),
                    startIndex: i
                });
            }

            updateStreamContent(`📦 分成 ${batches.length} 批，每批约 ${threshold} 对\n`);

            const semaphore = new Semaphore(parallelConfig.concurrency);
            let completed = 0;

            const processBatch = async (batch, batchIndex) => {
                await semaphore.acquire();
                try {
                    updateStreamContent(`🔄 [批次${batchIndex + 1}/${batches.length}] 处理 ${batch.pairs.length} 对...\n`);

                    const pairsContent = buildPairContent(batch.pairs, batch.startIndex);
                    const prompt = buildPrompt(pairsContent, batch.pairs.length);
                    const response = await callAPI(prompt);
                    const aiResult = parseAIResponse(response);

                    for (const result of aiResult.results || []) {
                        const localPairIndex = (result.pair || 1) - 1;
                        const globalPairIndex = batch.startIndex + localPairIndex;

                        if (globalPairIndex < 0 || globalPairIndex >= allPairs.length) continue;

                        const [nameA, nameB] = allPairs[globalPairIndex];
                        pairResults.push({
                            nameA: result.nameA || nameA,
                            nameB: result.nameB || nameB,
                            isSamePerson: result.isSamePerson,
                            mainName: result.mainName,
                            reason: result.reason,
                            _globalIndex: globalPairIndex
                        });
                    }

                    completed++;
                    updateStreamContent(`✅ [批次${batchIndex + 1}] 完成 (${completed}/${batches.length})\n`);
                } catch (error) {
                    updateStreamContent(`❌ [批次${batchIndex + 1}] 失败: ${error.message}\n`);
                } finally {
                    semaphore.release();
                }
            };

            await Promise.allSettled(batches.map((batch, i) => processBatch(batch, i)));

        } else {
            // 单次请求模式
            updateStreamContent('\n🤖 单次请求模式处理配对判断...\n');

            const pairsContent = buildPairContent(allPairs, 0);
            const prompt = buildPrompt(pairsContent, allPairs.length);
            const response = await callAPI(prompt);
            const aiResult = parseAIResponse(response);

            for (const result of aiResult.results || []) {
                const pairIndex = (result.pair || 1) - 1;
                if (pairIndex < 0 || pairIndex >= allPairs.length) continue;

                const [nameA, nameB] = allPairs[pairIndex];
                pairResults.push({
                    nameA: result.nameA || nameA,
                    nameB: result.nameB || nameB,
                    isSamePerson: result.isSamePerson,
                    mainName: result.mainName,
                    reason: result.reason,
                    _globalIndex: pairIndex
                });
            }
        }

        // 使用并查集合并结果
        const uf = new UnionFind([...allNames]);

        for (const result of pairResults) {
            if (result.isSamePerson) {
                const [nameA, nameB] = allPairs[result._globalIndex];
                uf.union(nameA, nameB);
            }
        }

        const mergedGroups = uf.getGroups();

        const finalGroups = mergedGroups.map(group => {
            let mainName = null;
            for (const result of pairResults) {
                if (result.isSamePerson && result.mainName) {
                    if (group.includes(result.nameA) || group.includes(result.nameB)) {
                        if (group.includes(result.mainName)) {
                            mainName = result.mainName;
                            break;
                        }
                    }
                }
            }

            if (!mainName) {
                let maxLen = 0;
                for (const name of group) {
                    const len = (entries[name]?.['内容'] || '').length;
                    if (len > maxLen) {
                        maxLen = len;
                        mainName = name;
                    }
                }
            }

            return { names: group, mainName: mainName || group[0] };
        });

        return {
            pairResults,
            mergedGroups: finalGroups,
            _allPairs: allPairs
        };
    }



    async function mergeConfirmedDuplicates(aiResult, categoryName = '角色') {
        const entries = generatedWorldbook[categoryName];
        let mergedCount = 0;

        const mergedGroups = aiResult.mergedGroups || [];

        for (const groupInfo of mergedGroups) {
            const { names, mainName } = groupInfo;
            if (!names || names.length < 2 || !mainName) continue;

            let mergedKeywords = [];
            let mergedContent = '';

            for (const name of names) {
                if (entries[name]) {
                    mergedKeywords.push(...(entries[name]['关键词'] || []));
                    mergedKeywords.push(name);
                    if (entries[name]['内容']) {
                        mergedContent += entries[name]['内容'] + '\n\n---\n\n';
                    }
                }
            }

            entries[mainName] = {
                '关键词': [...new Set(mergedKeywords)],
                '内容': mergedContent.replace(/\n\n---\n\n$/, '')
            };

            for (const name of names) {
                if (name !== mainName && entries[name]) {
                    delete entries[name];
                }
            }

            mergedCount++;
        }

        return mergedCount;
    }


    // ========== 新增：手动合并条目功能 ==========
    function showManualMergeUI(onMergeComplete) {
        const existingModal = document.getElementById('ttw-manual-merge-modal');
        if (existingModal) existingModal.remove();

        const worldbook = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
        const categories = Object.keys(worldbook).filter(cat => {
            const entries = worldbook[cat];
            return entries && typeof entries === 'object' && Object.keys(entries).length > 0;
        });

        if (categories.length === 0) {
            alert('当前世界书中没有条目，无法进行手动合并');
            return;
        }

        // 构建条目列表HTML
        let entriesHtml = '';
        let totalEntries = 0;
        for (const cat of categories) {
            const entries = worldbook[cat];
            const entryNames = naturalSortEntryNames(Object.keys(entries));
            totalEntries += entryNames.length;

            entriesHtml += `<div class="ttw-mm-category" style="margin-bottom:10px;">
                <div style="background:linear-gradient(135deg,#e67e22,#d35400);padding:8px 12px;border-radius:6px 6px 0 0;cursor:pointer;font-weight:bold;font-size:13px;display:flex;justify-content:space-between;align-items:center;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
                    <span>📁 ${cat} (${entryNames.length})</span>
                    <span style="font-size:11px;color:rgba(255,255,255,0.7);">点击展开/收起</span>
                </div>
                <div style="background:#2d2d2d;border:1px solid #555;border-top:none;border-radius:0 0 6px 6px;display:none;max-height:300px;overflow-y:auto;">`;

            for (const name of entryNames) {
                const entry = entries[name];
                const keywords = Array.isArray(entry?.['关键词']) ? entry['关键词'].slice(0, 4).join(', ') : '';
                const tokenCount = getEntryTotalTokens(entry);
                entriesHtml += `
                    <label class="ttw-mm-entry-label" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #3a3a3a;cursor:pointer;transition:background 0.15s;" onmouseenter="this.style.background='rgba(155,89,182,0.15)'" onmouseleave="this.style.background='transparent'">
                        <input type="checkbox" class="ttw-mm-entry-cb" data-category="${cat}" data-entry="${name}" style="width:16px;height:16px;accent-color:#9b59b6;flex-shrink:0;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:13px;color:#e0e0e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${name}</div>
                            <div style="font-size:11px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${keywords ? '🔑 ' + keywords : ''} <span style="color:#f1c40f;">${tokenCount}tk</span></div>
                        </div>
                    </label>`;
            }
            entriesHtml += `</div></div>`;
        }

        const modal = document.createElement('div');
        modal.id = 'ttw-manual-merge-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:800px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">✋ 手动合并条目</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:12px;padding:10px;background:rgba(52,152,219,0.15);border-radius:6px;font-size:12px;color:#3498db;">
                        💡 勾选2个或更多条目，将它们合并为一个。适用于AI别名识别未能发现的重复条目。<br>
                        <span style="color:#f39c12;">支持跨分类合并，合并后条目将归入您指定的目标分类。</span>
                    </div>

                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <span style="font-size:13px;color:#ccc;">共 ${totalEntries} 个条目</span>
                        <div style="display:flex;gap:8px;align-items:center;">
                            <input type="text" id="ttw-mm-filter" placeholder="筛选条目名..." style="padding:4px 8px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;font-size:12px;width:150px;">
                            <button class="ttw-btn ttw-btn-small" id="ttw-mm-expand-all">全部展开</button>
                        </div>
                    </div>

                    <div id="ttw-mm-entries-container" style="max-height:400px;overflow-y:auto;background:rgba(0,0,0,0.15);border-radius:6px;padding:8px;">
                        ${entriesHtml}
                    </div>

                    <div id="ttw-mm-selected-bar" style="display:none;margin-top:12px;padding:10px;background:rgba(155,89,182,0.2);border:1px solid #9b59b6;border-radius:6px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <span style="font-size:13px;color:#9b59b6;font-weight:bold;">已选: <span id="ttw-mm-selected-count">0</span> 个条目</span>
                            <button class="ttw-btn ttw-btn-small" id="ttw-mm-clear-selection" style="font-size:11px;">清除选择</button>
                        </div>
                        <div id="ttw-mm-selected-list" style="font-size:12px;color:#ccc;max-height:80px;overflow-y:auto;"></div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-mm-cancel">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-mm-next" disabled>下一步 → 配置合并</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // 关闭事件
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-mm-cancel').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // 全部展开
        modal.querySelector('#ttw-mm-expand-all').addEventListener('click', () => {
            const btn = modal.querySelector('#ttw-mm-expand-all');
            const allCatBodies = modal.querySelectorAll('.ttw-mm-category > div:nth-child(2)');
            const anyHidden = [...allCatBodies].some(d => d.style.display === 'none');
            allCatBodies.forEach(d => d.style.display = anyHidden ? 'block' : 'none');
            btn.textContent = anyHidden ? '全部收起' : '全部展开';
        });

        // 筛选
        modal.querySelector('#ttw-mm-filter').addEventListener('input', (e) => {
            const keyword = e.target.value.toLowerCase();
            modal.querySelectorAll('.ttw-mm-entry-label').forEach(label => {
                const entryName = label.querySelector('.ttw-mm-entry-cb').dataset.entry.toLowerCase();
                label.style.display = !keyword || entryName.includes(keyword) ? 'flex' : 'none';
            });
            // 自动展开包含匹配项的分类
            if (keyword) {
                modal.querySelectorAll('.ttw-mm-category').forEach(catDiv => {
                    const body = catDiv.querySelector('div:nth-child(2)');
                    const hasVisible = [...body.querySelectorAll('.ttw-mm-entry-label')].some(l => l.style.display !== 'none');
                    if (hasVisible) body.style.display = 'block';
                });
            }
        });

        // 选择变更处理
        function updateSelection() {
            const checked = [...modal.querySelectorAll('.ttw-mm-entry-cb:checked')];
            const count = checked.length;
            const bar = modal.querySelector('#ttw-mm-selected-bar');
            const nextBtn = modal.querySelector('#ttw-mm-next');

            if (count > 0) {
                bar.style.display = 'block';
                modal.querySelector('#ttw-mm-selected-count').textContent = count;

                let listHtml = checked.map(cb => {
                    const cat = cb.dataset.category;
                    const name = cb.dataset.entry;
                    return `<span style="display:inline-block;padding:2px 8px;background:rgba(155,89,182,0.3);border-radius:4px;margin:2px;font-size:11px;">[${cat}] ${name}</span>`;
                }).join('');
                modal.querySelector('#ttw-mm-selected-list').innerHTML = listHtml;
            } else {
                bar.style.display = 'none';
            }

            nextBtn.disabled = count < 2;
            nextBtn.textContent = count < 2 ? '下一步 → 配置合并（至少选2个）' : `下一步 → 配置合并 (${count}个)`;
        }

        modal.querySelectorAll('.ttw-mm-entry-cb').forEach(cb => {
            cb.addEventListener('change', updateSelection);
        });

        modal.querySelector('#ttw-mm-clear-selection').addEventListener('click', () => {
            modal.querySelectorAll('.ttw-mm-entry-cb:checked').forEach(cb => cb.checked = false);
            updateSelection();
        });

        // 下一步：配置合并
        modal.querySelector('#ttw-mm-next').addEventListener('click', () => {
            const checked = [...modal.querySelectorAll('.ttw-mm-entry-cb:checked')];
            if (checked.length < 2) return;

            const selectedEntries = checked.map(cb => ({
                category: cb.dataset.category,
                name: cb.dataset.entry
            }));

            modal.remove();
            showManualMergeConfigModal(selectedEntries, onMergeComplete);
        });
    }

    function showManualMergeConfigModal(selectedEntries, onMergeComplete) {
        const existingModal = document.getElementById('ttw-mm-config-modal');
        if (existingModal) existingModal.remove();

        const worldbook = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;

        // 收集所有条目信息用于预览
        const entriesInfo = selectedEntries.map(e => {
            const entry = worldbook[e.category]?.[e.name];
            return {
                ...e,
                keywords: entry?.['关键词'] || [],
                content: entry?.['内容'] || '',
                tokens: getEntryTotalTokens(entry)
            };
        });

        // 所有涉及的分类
        const involvedCategories = [...new Set(selectedEntries.map(e => e.category))];
        // 所有可能的名称选项
        const nameOptions = selectedEntries.map(e => e.name);

        // 合并后的预览
        let mergedKeywords = [];
        let mergedContent = '';
        for (const info of entriesInfo) {
            mergedKeywords.push(...info.keywords);
            mergedKeywords.push(info.name);
            if (info.content) {
                mergedContent += (mergedContent ? '\n\n---\n\n' : '') + info.content;
            }
        }
        mergedKeywords = [...new Set(mergedKeywords)];

        // 分类选项HTML
        const allCategories = Object.keys(worldbook);
        let catOptionsHtml = allCategories.map(cat => {
            const selected = cat === involvedCategories[0] ? 'selected' : '';
            return `<option value="${cat}" ${selected}>${cat}</option>`;
        }).join('');

        // 名称选项HTML（radio）
        let nameOptionsHtml = nameOptions.map((name, idx) => {
            const cat = selectedEntries[idx].category;
            return `
                <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:4px;cursor:pointer;">
                    <input type="radio" name="ttw-mm-main-name" value="${name}" ${idx === 0 ? 'checked' : ''} style="accent-color:#27ae60;">
                    <span style="color:#e0e0e0;font-size:13px;">${name}</span>
                    <span style="color:#888;font-size:11px;margin-left:auto;">[${cat}]</span>
                </label>`;
        }).join('');

        // 条目详情HTML
        let detailsHtml = entriesInfo.map((info, idx) => {
            const kwStr = info.keywords.join(', ') || '无';
            const contentPreview = info.content.length > 200 ? info.content.substring(0, 200) + '...' : info.content;
            return `
                <div style="border:1px solid #555;border-radius:6px;margin-bottom:8px;overflow:hidden;">
                    <div style="background:#3a3a3a;padding:8px 12px;font-size:13px;display:flex;justify-content:space-between;cursor:pointer;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
                        <span style="color:#e67e22;">[${info.category}] ${info.name}</span>
                        <span style="color:#f1c40f;font-size:11px;">${info.tokens}tk</span>
                    </div>
                    <div style="display:${idx === 0 ? 'block' : 'none'};padding:10px;background:#1c1c1c;font-size:12px;">
                        <div style="margin-bottom:6px;"><span style="color:#9b59b6;">🔑 关键词:</span> <span style="color:#ccc;">${kwStr}</span></div>
                        <div style="color:#aaa;line-height:1.5;white-space:pre-wrap;max-height:150px;overflow-y:auto;">${contentPreview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                    </div>
                </div>`;
        }).join('');

        const modal = document.createElement('div');
        modal.id = 'ttw-mm-config-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:800px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">✋ 手动合并 - 配置 (${selectedEntries.length}个条目)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display:flex;gap:16px;flex-wrap:wrap;">
                        <div style="flex:1;min-width:300px;">
                            <div style="font-weight:bold;color:#27ae60;margin-bottom:8px;font-size:13px;">📌 选择主条目名称</div>
                            <div style="margin-bottom:12px;padding:8px;background:rgba(0,0,0,0.15);border-radius:6px;max-height:200px;overflow-y:auto;">
                                ${nameOptionsHtml}
                            </div>
                            <div style="margin-bottom:8px;">
                                <label style="font-size:12px;color:#ccc;display:block;margin-bottom:4px;">或输入自定义名称：</label>
                                <input type="text" id="ttw-mm-custom-name" class="ttw-input" placeholder="留空则使用上面选择的名称" style="font-size:12px;">
                            </div>

                            <div style="font-weight:bold;color:#e67e22;margin-bottom:8px;margin-top:16px;font-size:13px;">📂 目标分类</div>
                            <select id="ttw-mm-target-category" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#2d2d2d;color:#fff;font-size:13px;">
                                ${catOptionsHtml}
                            </select>

                            <div style="margin-top:16px;">
                                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#ccc;">
                                    <input type="checkbox" id="ttw-mm-dedup-keywords" checked style="accent-color:#9b59b6;">
                                    合并后关键词去重
                                </label>
                                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#ccc;margin-top:6px;">
                                    <input type="checkbox" id="ttw-mm-add-separator" checked style="accent-color:#9b59b6;">
                                    内容间添加分隔线 (---)
                                </label>
                            </div>
                        </div>

                        <div style="flex:1;min-width:300px;">
                            <div style="font-weight:bold;color:#3498db;margin-bottom:8px;font-size:13px;">📋 待合并条目详情</div>
                            <div style="max-height:400px;overflow-y:auto;">
                                ${detailsHtml}
                            </div>
                        </div>
                    </div>

                    <div style="margin-top:16px;padding:12px;background:rgba(39,174,96,0.15);border:1px solid rgba(39,174,96,0.3);border-radius:6px;">
                        <div style="font-weight:bold;color:#27ae60;margin-bottom:8px;font-size:13px;">🔮 合并预览</div>
                        <div style="font-size:12px;color:#ccc;">
                            <div style="margin-bottom:4px;"><span style="color:#9b59b6;">🔑 合并关键词 (${mergedKeywords.length}):</span> ${mergedKeywords.join(', ')}</div>
                            <div style="margin-bottom:4px;"><span style="color:#f1c40f;">📊 合并后Token:</span> ~${estimateTokenCount(mergedKeywords.join(', ') + mergedContent)} tk</div>
                            <div style="color:#888;font-size:11px;">💡 合并后建议使用「整理条目」功能让AI优化内容、去除重复</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-mm-back">← 返回选择</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-mm-confirm">✅ 确认合并</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // 关闭
        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // 返回
        modal.querySelector('#ttw-mm-back').addEventListener('click', () => {
            modal.remove();
            showManualMergeUI(onMergeComplete);
        });

        // 确认合并
        modal.querySelector('#ttw-mm-confirm').addEventListener('click', () => {
            const customName = modal.querySelector('#ttw-mm-custom-name').value.trim();
            const radioName = modal.querySelector('input[name="ttw-mm-main-name"]:checked')?.value;
            const mainName = customName || radioName || selectedEntries[0].name;
            const targetCategory = modal.querySelector('#ttw-mm-target-category').value;
            const dedupKeywords = modal.querySelector('#ttw-mm-dedup-keywords').checked;
            const addSeparator = modal.querySelector('#ttw-mm-add-separator').checked;

            // 确认弹窗
            const involvedStr = selectedEntries.map(e => `[${e.category}] ${e.name}`).join('\n');
            if (!confirm(`确定将以下 ${selectedEntries.length} 个条目合并为「${mainName}」？\n目标分类: ${targetCategory}\n\n${involvedStr}\n\n⚠️ 原条目将被删除！`)) return;

            // 执行合并
            executeManualMerge(selectedEntries, mainName, targetCategory, dedupKeywords, addSeparator);

            updateStreamContent(`\n✅ 手动合并完成: ${selectedEntries.length} 个条目 → [${targetCategory}] ${mainName}\n`);
            updateWorldbookPreview();
            modal.remove();

            if (typeof onMergeComplete === 'function') onMergeComplete();
            alert(`合并完成！${selectedEntries.length} 个条目已合并为「${mainName}」。\n\n建议使用「整理条目」功能让AI优化合并后的内容。`);
        });
    }

    function executeManualMerge(selectedEntries, mainName, targetCategory, dedupKeywords, addSeparator) {
        const worldbook = generatedWorldbook; // 始终操作原始数据

        let mergedKeywords = [];
        let mergedContent = '';

        // 收集所有关键词和内容
        for (const entry of selectedEntries) {
            const catEntries = worldbook[entry.category];
            if (!catEntries || !catEntries[entry.name]) continue;

            const data = catEntries[entry.name];
            if (data['关键词']) {
                mergedKeywords.push(...(Array.isArray(data['关键词']) ? data['关键词'] : [data['关键词']]));
            }
            mergedKeywords.push(entry.name);

            if (data['内容']) {
                if (mergedContent && addSeparator) {
                    mergedContent += '\n\n---\n\n';
                } else if (mergedContent) {
                    mergedContent += '\n\n';
                }
                mergedContent += data['内容'];
            }
        }

        // 去重关键词
        if (dedupKeywords) {
            mergedKeywords = [...new Set(mergedKeywords)];
        }

        // 确保目标分类存在
        if (!worldbook[targetCategory]) {
            worldbook[targetCategory] = {};
        }

        // 写入合并后的条目
        worldbook[targetCategory][mainName] = {
            '关键词': mergedKeywords,
            '内容': mergedContent
        };

        // 删除原条目（注意：如果主条目名称与某个原条目相同且在同一分类，不要重复删除）
        for (const entry of selectedEntries) {
            if (entry.category === targetCategory && entry.name === mainName) continue; // 跳过目标自身
            const catEntries = worldbook[entry.category];
            if (catEntries && catEntries[entry.name]) {
                delete catEntries[entry.name];
            }
        }

        // 清理空分类
        for (const cat of Object.keys(worldbook)) {
            if (typeof worldbook[cat] === 'object' && Object.keys(worldbook[cat]).length === 0) {
                // 保留空分类，不删除（用户可能需要）
            }
        }

        debugLog(`手动合并: ${selectedEntries.length}个条目 → [${targetCategory}] ${mainName}, ${mergedKeywords.length}个关键词`);
    }

    async function showAliasMergeUI() {
        // ====== 第0步：让用户勾选要扫描的分类 ======
        const availableCategories = Object.keys(generatedWorldbook).filter(cat => {
            const entries = generatedWorldbook[cat];
            return entries && typeof entries === 'object' && Object.keys(entries).length >= 2;
        });

        if (availableCategories.length === 0) {
            alert('当前世界书中没有包含2个以上条目的分类，无法进行别名合并');
            return;
        }

        // 弹出分类选择弹窗
        const selectedCategories = await new Promise((resolve) => {
            const existingModal = document.getElementById('ttw-alias-cat-modal');
            if (existingModal) existingModal.remove();

            const catModal = document.createElement('div');
            catModal.id = 'ttw-alias-cat-modal';
            catModal.className = 'ttw-modal-container';

            let catListHtml = availableCategories.map(cat => {
                const count = Object.keys(generatedWorldbook[cat]).length;
                const isChecked = cat === '角色' ? 'checked' : '';
                return `
                    <label style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(155,89,182,0.1);border-radius:6px;margin-bottom:6px;cursor:pointer;">
                        <input type="checkbox" class="ttw-alias-cat-cb" data-cat="${cat}" ${isChecked} style="width:16px;height:16px;accent-color:#9b59b6;">
                        <span style="color:#e67e22;font-weight:bold;font-size:13px;">${cat}</span>
                        <span style="color:#888;font-size:11px;margin-left:auto;">${count} 个条目</span>
                    </label>
                `;
            }).join('');

            catModal.innerHTML = `
                <div class="ttw-modal" style="max-width:500px;">
                    <div class="ttw-modal-header">
                        <span class="ttw-modal-title">🔗 别名合并 - 选择要扫描的分类</span>
                        <button class="ttw-modal-close" type="button">✕</button>
                    </div>
                    <div class="ttw-modal-body">
                        <div style="margin-bottom:12px;padding:10px;background:rgba(52,152,219,0.15);border-radius:6px;font-size:12px;color:#3498db;">
                            💡 请勾选需要让AI识别别名并合并的分类。将对每个选中的分类独立扫描重复条目。
                        </div>
                        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
                            <label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="ttw-alias-cat-select-all"> 全选</label>
                        </div>
                        <div style="max-height:300px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;">
                            ${catListHtml}
                        </div>
                    </div>
                    <div class="ttw-modal-footer">
                        <button class="ttw-btn" id="ttw-alias-cat-cancel">取消</button>
                        <button class="ttw-btn ttw-btn-primary" id="ttw-alias-cat-confirm">📍 开始扫描</button>
                    </div>
                </div>
            `;

            document.body.appendChild(catModal);

            catModal.querySelector('#ttw-alias-cat-select-all').addEventListener('change', (e) => {
                catModal.querySelectorAll('.ttw-alias-cat-cb').forEach(cb => cb.checked = e.target.checked);
            });

            catModal.querySelector('.ttw-modal-close').addEventListener('click', () => { catModal.remove(); resolve(null); });
            catModal.querySelector('#ttw-alias-cat-cancel').addEventListener('click', () => { catModal.remove(); resolve(null); });
            catModal.addEventListener('click', (e) => { if (e.target === catModal) { catModal.remove(); resolve(null); } });

            catModal.querySelector('#ttw-alias-cat-confirm').addEventListener('click', () => {
                const checked = [...catModal.querySelectorAll('.ttw-alias-cat-cb:checked')].map(cb => cb.dataset.cat);
                catModal.remove();
                resolve(checked.length > 0 ? checked : null);
            });
        });

        if (!selectedCategories || selectedCategories.length === 0) return;

        // ====== 第一阶段：扫描所有选中分类的疑似重复 ======
        updateStreamContent('\n🔍 第一阶段：扫描疑似重复条目...\n');

        // 按分类收集所有疑似组，每组附带分类信息
        const allSuspectedByCategory = {};
        let totalGroups = 0;
        let totalPairs = 0;

        for (const cat of selectedCategories) {
            const suspected = findPotentialDuplicates(cat);
            if (suspected.length > 0) {
                allSuspectedByCategory[cat] = suspected;
                totalGroups += suspected.length;
                for (const group of suspected) {
                    totalPairs += (group.length * (group.length - 1)) / 2;
                }
                updateStreamContent(`  [${cat}] 发现 ${suspected.length} 组疑似重复\n`);
            } else {
                updateStreamContent(`  [${cat}] 未发现重复\n`);
            }
        }

        if (totalGroups === 0) {
            alert('在所有选中的分类中未发现疑似重复条目');
            return;
        }

        updateStreamContent(`共发现 ${totalGroups} 组疑似重复，${totalPairs} 对需要判断\n`);

        const existingModal = document.getElementById('ttw-alias-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-alias-modal';
        modal.className = 'ttw-modal-container';

        // 构建分类分组的显示
        let groupsHtml = '';
        let globalGroupIndex = 0;
        const groupCategoryMap = []; // 记录每个全局index对应的分类和本地index

        for (const cat of Object.keys(allSuspectedByCategory)) {
            const suspected = allSuspectedByCategory[cat];
            const entries = generatedWorldbook[cat];

            groupsHtml += `<div style="margin-bottom:8px;padding:6px 8px;background:rgba(230,126,34,0.15);border-radius:4px;font-size:12px;color:#e67e22;font-weight:bold;">📂 ${cat} (${suspected.length}组)</div>`;

            suspected.forEach((group, localIdx) => {
                const pairCount = (group.length * (group.length - 1)) / 2;
                const groupInfo = group.map(name => {
                    const entry = entries[name];
                    const keywords = (entry?.['关键词'] || []).slice(0, 3).join(', ');
                    return `${name}${keywords ? ` [${keywords}]` : ''}`;
                }).join(' / ');

                groupsHtml += `
                    <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 12px;background:rgba(155,89,182,0.1);border-radius:6px;margin-bottom:6px;cursor:pointer;">
                        <input type="checkbox" class="ttw-alias-group-cb" data-index="${globalGroupIndex}" data-category="${cat}" checked style="margin-top:3px;">
                        <div>
                            <div style="color:#9b59b6;font-weight:bold;font-size:12px;">组${globalGroupIndex + 1} <span style="color:#888;font-weight:normal;">(${group.length}条, ${pairCount}对)</span></div>
                            <div style="font-size:11px;color:#ccc;word-break:break-all;">${groupInfo}</div>
                        </div>
                    </label>
                `;

                groupCategoryMap.push({ category: cat, localIndex: localIdx });
                globalGroupIndex++;
            });
        }

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:750px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🔗 别名识别与合并 (两两判断模式)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                        <div style="font-weight:bold;color:#3498db;margin-bottom:8px;">📊 第一阶段：本地检测结果</div>
                        <div style="font-size:13px;color:#ccc;">
                            扫描了 <span style="color:#e67e22;font-weight:bold;">${selectedCategories.length}</span> 个分类，
                            发现 <span style="color:#9b59b6;font-weight:bold;">${totalGroups}</span> 组疑似重复，
                            共 <span style="color:#e67e22;font-weight:bold;">${totalPairs}</span> 对需要AI判断
                        </div>
                    </div>

                    <div style="margin-bottom:16px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                            <span style="font-weight:bold;">选择要发送给AI判断的组</span>
                            <label style="font-size:12px;"><input type="checkbox" id="ttw-select-all-alias" checked> 全选</label>
                        </div>
                        <div style="max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;">
                            ${groupsHtml}
                        </div>
                    </div>

                           <div style="margin-bottom:16px;padding:10px;background:rgba(230,126,34,0.1);border-radius:6px;font-size:11px;color:#f39c12;">
                        💡 <strong>两两判断模式</strong>：AI会对每一对条目分别判断是否相同，然后自动合并确认的结果。<br>
                        例如：[A,B,C] 会拆成 (A,B) (A,C) (B,C) 三对分别判断，如果A=B且B=C，则A、B、C会被合并。
                    </div>

                    <div style="margin-bottom:16px;padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                        <div style="font-weight:bold;color:#3498db;margin-bottom:10px;">⚙️ 并发设置</div>
                        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
                            <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
                              <input type="checkbox" id="ttw-alias-parallel">
                                <span>启用并发</span>
                            </label>
                            <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
                                <span>配对数阈值:</span>
                                <input type="number" id="ttw-alias-threshold" value="5" min="1" max="50" style="width:60px;padding:4px;border:1px solid #555;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;">
                            </label>
                        </div>
                        <div style="font-size:11px;color:#888;margin-top:8px;">
                            ≥阈值的配对数单独发送，＜阈值的合并发送（合并到接近阈值数量）
                        </div>
                    </div>

                    <div id="ttw-alias-result" style="display:none;margin-bottom:16px;">


                        <div style="padding:12px;background:rgba(155,89,182,0.15);border-radius:8px;margin-bottom:12px;">
                            <div style="font-weight:bold;color:#9b59b6;margin-bottom:8px;">🔍 配对判断结果</div>
                            <div id="ttw-pair-results" style="max-height:150px;overflow-y:auto;"></div>
                        </div>
                        <div style="padding:12px;background:rgba(39,174,96,0.15);border-radius:8px;">
                            <div style="font-weight:bold;color:#27ae60;margin-bottom:8px;">📦 合并方案</div>
                            <div id="ttw-merge-plan"></div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-secondary" id="ttw-stop-alias" style="display:none;">⏸️ 停止</button>
                    <button class="ttw-btn" id="ttw-cancel-alias">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-ai-verify-alias">🤖 AI两两判断</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-confirm-alias" style="display:none;">✅ 确认合并</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // aiResult现在按分类存储: { categoryName: { pairResults, mergedGroups, _allPairs } }
        let aiResultByCategory = {};

        modal.querySelector('#ttw-select-all-alias').addEventListener('change', (e) => {
            modal.querySelectorAll('.ttw-alias-group-cb').forEach(cb => cb.checked = e.target.checked);
        });

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-alias').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-ai-verify-alias').addEventListener('click', async () => {
            // 按分类分组选中的组
            const checkedCbs = [...modal.querySelectorAll('.ttw-alias-group-cb:checked')];
            if (checkedCbs.length === 0) {
                alert('请选择要判断的组');
                return;
            }

            // 按分类归类选中的组
            const selectedByCategory = {};
            for (const cb of checkedCbs) {
                const cat = cb.dataset.category;
                const globalIdx = parseInt(cb.dataset.index);
                const { localIndex } = groupCategoryMap[globalIdx];
                if (!selectedByCategory[cat]) selectedByCategory[cat] = [];
                selectedByCategory[cat].push(allSuspectedByCategory[cat][localIndex]);
            }

            const btn = modal.querySelector('#ttw-ai-verify-alias');
            const stopBtn = modal.querySelector('#ttw-stop-alias');
            btn.disabled = true;
            btn.textContent = '🔄 AI判断中...';
            stopBtn.style.display = 'inline-block';

            try {
                const useParallel = modal.querySelector('#ttw-alias-parallel')?.checked ?? parallelConfig.enabled;
                const threshold = parseInt(modal.querySelector('#ttw-alias-threshold')?.value) || 5;

                updateStreamContent(`\n🤖 第二阶段：两两配对判断...\n并发: ${useParallel ? '开启' : '关闭'}, 阈值: ${threshold}\n`);

                // 对每个分类分别调用AI判断
                aiResultByCategory = {};
                for (const cat of Object.keys(selectedByCategory)) {
                    updateStreamContent(`\n📂 处理分类「${cat}」...\n`);
                    aiResultByCategory[cat] = await verifyDuplicatesWithAI(selectedByCategory[cat], useParallel, threshold, cat);
                }

                const resultDiv = modal.querySelector('#ttw-alias-result');
                const pairResultsDiv = modal.querySelector('#ttw-pair-results');
                const mergePlanDiv = modal.querySelector('#ttw-merge-plan');
                resultDiv.style.display = 'block';

                // 显示所有分类的配对结果
                let pairHtml = '';
                for (const cat of Object.keys(aiResultByCategory)) {
                    const catResult = aiResultByCategory[cat];
                    if (catResult.pairResults && catResult.pairResults.length > 0) {
                        pairHtml += `<div style="font-size:11px;color:#e67e22;font-weight:bold;margin:6px 0 4px;">📂 ${cat}</div>`;
                        for (const result of catResult.pairResults) {
                            const icon = result.isSamePerson ? '✅' : '❌';
                            const color = result.isSamePerson ? '#27ae60' : '#e74c3c';
                            pairHtml += `
                                <div style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;background:rgba(0,0,0,0.2);border-radius:4px;margin:2px;font-size:11px;border-left:2px solid ${color};">
                                    <span style="color:${color};">${icon}</span>
                                    <span>「${result.nameA}」vs「${result.nameB}」</span>
                                    ${result.isSamePerson ? `<span style="color:#888;">→${result.mainName}</span>` : ''}
                                </div>
                            `;
                        }
                    }
                }
                pairResultsDiv.innerHTML = pairHtml || '<div style="color:#888;">无配对结果</div>';

                // 显示所有分类的合并方案
                let mergePlanHtml = '';
                let hasAnyMerge = false;
                let globalMergeGroupIndex = 0;

                // 先统计是否有合并项
                for (const cat of Object.keys(aiResultByCategory)) {
                    if (aiResultByCategory[cat].mergedGroups && aiResultByCategory[cat].mergedGroups.length > 0) {
                        hasAnyMerge = true;
                        break;
                    }
                }

                if (hasAnyMerge) {
                    mergePlanHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:11px;color:#888;">取消勾选可排除不想合并的组</span><label style="font-size:11px;cursor:pointer;"><input type="checkbox" id="ttw-select-all-merge-groups" checked> 全选</label></div>';

                    for (const cat of Object.keys(aiResultByCategory)) {
                        const catResult = aiResultByCategory[cat];
                        if (!catResult.mergedGroups || catResult.mergedGroups.length === 0) continue;

                        mergePlanHtml += `<div style="font-size:11px;color:#e67e22;font-weight:bold;margin:8px 0 4px;">📂 ${cat}</div>`;

                        for (var gi = 0; gi < catResult.mergedGroups.length; gi++) {
                            var group = catResult.mergedGroups[gi];
                            mergePlanHtml += '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:6px;border-left:3px solid #27ae60;cursor:pointer;"><input type="checkbox" class="ttw-merge-group-cb" data-group-index="' + gi + '" data-category="' + cat + '" checked style="margin-top:2px;width:16px;height:16px;accent-color:#27ae60;flex-shrink:0;"><div><div style="color:#27ae60;font-weight:bold;font-size:12px;">→ 合并为「' + group.mainName + '」</div><div style="font-size:11px;color:#ccc;margin-top:4px;">包含: ' + group.names.join(', ') + '</div></div></label>';
                            globalMergeGroupIndex++;
                        }
                    }
                } else {
                    mergePlanHtml = '<div style="color:#888;font-size:12px;">没有需要合并的条目（所有配对都是不同事物）</div>';
                }
                mergePlanDiv.innerHTML = mergePlanHtml;

                var selectAllMergeCb = mergePlanDiv.querySelector('#ttw-select-all-merge-groups');
                if (selectAllMergeCb) {
                    selectAllMergeCb.addEventListener('change', function (e) {
                        var allCbs = mergePlanDiv.querySelectorAll('.ttw-merge-group-cb');
                        for (var ci = 0; ci < allCbs.length; ci++) {
                            allCbs[ci].checked = e.target.checked;
                        }
                    });
                }

                if (hasAnyMerge) {
                    modal.querySelector('#ttw-confirm-alias').style.display = 'inline-block';
                }
                btn.style.display = 'none';
                stopBtn.style.display = 'none';

                updateStreamContent('✅ AI判断完成\n');


            } catch (error) {
                updateStreamContent(`❌ AI判断失败: ${error.message}\n`);
                alert('AI判断失败: ' + error.message);
                btn.disabled = false;
                btn.textContent = '🤖 AI两两判断';
                stopBtn.style.display = 'none';
            }
        });

        modal.querySelector('#ttw-stop-alias').addEventListener('click', () => {
            stopProcessing();
            modal.querySelector('#ttw-ai-verify-alias').disabled = false;
            modal.querySelector('#ttw-ai-verify-alias').textContent = '🤖 AI两两判断';
            modal.querySelector('#ttw-stop-alias').style.display = 'none';
        });

        modal.querySelector('#ttw-confirm-alias').addEventListener('click', async function () {
            // 按分类收集选中的合并组
            var checkedBoxes = modal.querySelectorAll('.ttw-merge-group-cb:checked');
            if (checkedBoxes.length === 0) {
                alert('没有勾选任何合并组');
                return;
            }

            // 按分类归类
            var mergeByCategory = {};
            for (var i = 0; i < checkedBoxes.length; i++) {
                var cat = checkedBoxes[i].getAttribute('data-category');
                var gi = parseInt(checkedBoxes[i].getAttribute('data-group-index'));
                if (!mergeByCategory[cat]) mergeByCategory[cat] = [];
                if (aiResultByCategory[cat] && aiResultByCategory[cat].mergedGroups[gi]) {
                    mergeByCategory[cat].push(aiResultByCategory[cat].mergedGroups[gi]);
                }
            }

            var totalSelected = checkedBoxes.length;
            var categoryList = Object.keys(mergeByCategory).map(c => `${c}(${mergeByCategory[c].length}组)`).join('、');
            if (!confirm('确定合并选中的 ' + totalSelected + ' 组条目？\n涉及分类: ' + categoryList)) return;

            var totalMerged = 0;
            for (var cat in mergeByCategory) {
                var filteredResult = { pairResults: aiResultByCategory[cat].pairResults, mergedGroups: mergeByCategory[cat] };
                var mergedCount = await mergeConfirmedDuplicates(filteredResult, cat);
                totalMerged += mergedCount;
            }

            updateWorldbookPreview();
            modal.remove();
            alert('合并完成！共合并了 ' + totalMerged + ' 组条目。\n\n建议使用"整理条目"功能清理合并后的重复内容。');
        });

    }

    // ========== 新增：查找功能 ==========
    function showSearchModal() {
        const existingModal = document.getElementById('ttw-search-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-search-modal';
        modal.className = 'ttw-modal-container';

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🔍 查找内容</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;">
                        <label style="display:block;margin-bottom:8px;font-size:13px;">输入要查找的字符（如乱码字符 �）</label>
                        <input type="text" id="ttw-search-input" class="ttw-input" placeholder="输入要查找的内容..." value="${searchHighlightKeyword}">
                    </div>
                    <div style="margin-bottom:16px;padding:12px;background:rgba(155,89,182,0.15);border-radius:8px;">
                        <label style="display:block;margin-bottom:8px;font-size:13px;color:#9b59b6;font-weight:bold;">📝 重Roll时附加的提示词（插入到发送给AI的文本最后）</label>
                        <textarea id="ttw-search-suffix-prompt" rows="2" class="ttw-textarea-small" placeholder="例如：请特别注意提取XX信息，修复乱码内容...">${settings.customSuffixPrompt || ''}</textarea>
                    </div>
                    <div class="ttw-search-results-container" style="display:flex;gap:12px;height:400px;">
                        <div id="ttw-search-results" style="flex:1;max-height:400px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:12px;">
                            <div style="text-align:center;color:#888;">输入关键词后点击"查找"</div>
                        </div>
                        <div id="ttw-search-detail" style="flex:1;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:12px;display:none;">
                            <div style="text-align:center;color:#888;padding:20px;">👈 点击左侧条目查看详情</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-clear-search">清除高亮</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-do-search">🔍 查找</button>
                    <button class="ttw-btn ttw-btn-warning" id="ttw-reroll-all-found" style="display:none;">🎲 重Roll所有匹配章节</button>
                    <button class="ttw-btn" id="ttw-close-search">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-search').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // 保存提示词设置
        modal.querySelector('#ttw-search-suffix-prompt').addEventListener('change', (e) => {
            settings.customSuffixPrompt = e.target.value;
            saveCurrentSettings();
        });

        modal.querySelector('#ttw-do-search').addEventListener('click', () => {
            const keyword = modal.querySelector('#ttw-search-input').value;
            if (!keyword) {
                alert('请输入要查找的内容');
                return;
            }
            searchHighlightKeyword = keyword;
            const results = performSearchEnhanced(keyword, modal.querySelector('#ttw-search-results'), modal);

            // 显示/隐藏批量重Roll按钮
            const rerollAllBtn = modal.querySelector('#ttw-reroll-all-found');
            if (results && results.memoryIndices && results.memoryIndices.size > 0) {
                rerollAllBtn.style.display = 'inline-block';
                rerollAllBtn.textContent = `🎲 重Roll所有匹配章节 (${results.memoryIndices.size}章)`;
            } else {
                rerollAllBtn.style.display = 'none';
            }

            // 显示详情面板
            modal.querySelector('#ttw-search-detail').style.display = 'block';
        });

        // 批量重Roll所有匹配章节
        modal.querySelector('#ttw-reroll-all-found').addEventListener('click', async () => {
            const resultsContainer = modal.querySelector('#ttw-search-results');
            const memoryIndicesAttr = resultsContainer.dataset.memoryIndices;
            if (!memoryIndicesAttr) {
                alert('请先进行查找');
                return;
            }

            const memoryIndices = JSON.parse(memoryIndicesAttr);
            if (memoryIndices.length === 0) {
                alert('没有找到匹配的章节');
                return;
            }

            const customPrompt = modal.querySelector('#ttw-search-suffix-prompt').value;
            const useParallel = parallelConfig.enabled && memoryIndices.length > 1;
            const parallelHint = useParallel ? `\n\n将使用并行处理（${parallelConfig.concurrency}并发）` : '';

            if (!confirm(`确定要重Roll ${memoryIndices.length} 个章节吗？\n\n这将使用当前附加提示词重新生成这些章节的世界书条目。${parallelHint}`)) {
                return;
            }

            const btn = modal.querySelector('#ttw-reroll-all-found');
            const stopBtn = document.createElement('button');
            stopBtn.className = 'ttw-btn ttw-btn-secondary';
            stopBtn.textContent = '⏸️ 停止';
            stopBtn.style.marginLeft = '8px';
            btn.parentNode.insertBefore(stopBtn, btn.nextSibling);

            btn.disabled = true;
            btn.textContent = '🔄 重Roll中...';

            let successCount = 0;
            let failCount = 0;
            let stopped = false;

            stopBtn.addEventListener('click', () => {
                stopped = true;
                stopProcessing();
                stopBtn.textContent = '已停止';
                stopBtn.disabled = true;
            });

            showProgressSection(true);
            isProcessingStopped = false;
            isRerolling = true;

            if (useParallel) {
                // 并行处理模式
                updateStreamContent(`\n🚀 批量重Roll开始 (并行模式, ${parallelConfig.concurrency}并发)\n${'='.repeat(50)}\n`);

                const semaphore = new Semaphore(parallelConfig.concurrency);
                let completed = 0;

                const processOne = async (index) => {
                    if (stopped || isProcessingStopped) return null;

                    try {
                        await semaphore.acquire();
                    } catch (e) {
                        if (e.message === 'ABORTED') return null;
                        throw e;
                    }

                    if (stopped || isProcessingStopped) {
                        semaphore.release();
                        return null;
                    }

                    try {
                        updateStreamContent(`🎲 [并行] 第${index + 1}章 开始重Roll...\n`);
                        const result = await processMemoryChunkIndependent(index, 0, customPrompt);

                        if (result) {
                            const memory = memoryQueue[index];
                            memory.result = result;
                            memory.processed = true;
                            memory.failed = false;
                            await mergeWorldbookDataWithHistory(generatedWorldbook, result, index, `${memory.title}-批量重Roll`);
                            await MemoryHistoryDB.saveRollResult(index, result);
                            successCount++;
                            updateStreamContent(`✅ [并行] 第${index + 1}章 完成\n`);
                        }

                        completed++;
                        btn.textContent = `🔄 进度: ${completed}/${memoryIndices.length}`;
                        updateProgress((completed / memoryIndices.length) * 100, `批量重Roll中 (${completed}/${memoryIndices.length})`);

                        return result;
                    } catch (error) {
                        completed++;
                        failCount++;
                        updateStreamContent(`❌ [并行] 第${index + 1}章 失败: ${error.message}\n`);
                        btn.textContent = `🔄 进度: ${completed}/${memoryIndices.length}`;
                        return null;
                    } finally {
                        semaphore.release();
                    }
                };

                await Promise.allSettled(memoryIndices.map(index => processOne(index)));

                updateStreamContent(`\n${'='.repeat(50)}\n📦 批量重Roll完成: 成功 ${successCount}, 失败 ${failCount}\n`);

            } else {
                // 串行处理模式
                updateStreamContent(`\n🔄 批量重Roll开始 (串行模式)\n${'='.repeat(50)}\n`);

                for (let i = 0; i < memoryIndices.length; i++) {
                    if (stopped || isProcessingStopped) break;

                    const index = memoryIndices[i];
                    try {
                        updateStreamContent(`\n🎲 [${i + 1}/${memoryIndices.length}] 第${index + 1}章...\n`);
                        await rerollMemory(index, customPrompt);
                        successCount++;
                        btn.textContent = `🔄 进度: ${i + 1}/${memoryIndices.length}`;
                        updateProgress(((i + 1) / memoryIndices.length) * 100, `批量重Roll中 (${i + 1}/${memoryIndices.length})`);
                    } catch (error) {
                        failCount++;
                        updateStreamContent(`❌ 第${index + 1}章重Roll失败: ${error.message}\n`);
                    }
                }

                updateStreamContent(`\n${'='.repeat(50)}\n📦 批量重Roll完成: 成功 ${successCount}, 失败 ${failCount}\n`);
            }

            isRerolling = false;
            btn.disabled = false;
            btn.textContent = `🎲 重Roll所有匹配章节 (${memoryIndices.length}章)`;
            stopBtn.remove();

            updateProgress(100, `批量重Roll完成: 成功 ${successCount}, 失败 ${failCount}`);
            updateMemoryQueueUI();

            alert(`批量重Roll完成！\n成功: ${successCount}\n失败: ${failCount}${stopped ? '\n(已手动停止)' : ''}`);

            // 重新搜索刷新结果
            modal.querySelector('#ttw-do-search').click();
            updateWorldbookPreview();
        });

        modal.querySelector('#ttw-clear-search').addEventListener('click', () => {
            searchHighlightKeyword = '';
            modal.querySelector('#ttw-search-input').value = '';
            modal.querySelector('#ttw-search-results').innerHTML = '<div style="text-align:center;color:#888;">已清除高亮</div>';
            modal.querySelector('#ttw-search-detail').style.display = 'none';
            modal.querySelector('#ttw-reroll-all-found').style.display = 'none';
            updateWorldbookPreview();
        });

        // 回车搜索
        modal.querySelector('#ttw-search-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                modal.querySelector('#ttw-do-search').click();
            }
        });
    }




    function performSearchEnhanced(keyword, resultsContainer, modal) {
        const results = [];
        const memoryIndicesSet = new Set();

        // 搜索每个记忆当前使用的result
        for (let i = 0; i < memoryQueue.length; i++) {
            const memory = memoryQueue[i];
            if (!memory.result || memory.failed) continue;

            const currentResult = memory.result;

            for (const category in currentResult) {
                for (const entryName in currentResult[category]) {
                    const entry = currentResult[category][entryName];
                    if (!entry || typeof entry !== 'object') continue;

                    const keywordsStr = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : '';
                    const content = entry['内容'] || '';

                    const matches = [];

                    if (entryName.includes(keyword)) {
                        matches.push({ field: '条目名', text: entryName });
                    }
                    if (keywordsStr.includes(keyword)) {
                        matches.push({ field: '关键词', text: keywordsStr });
                    }
                    if (content.includes(keyword)) {
                        const idx = content.indexOf(keyword);
                        const start = Math.max(0, idx - 30);
                        const end = Math.min(content.length, idx + keyword.length + 30);
                        const context = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
                        matches.push({ field: '内容', text: context });
                    }

                    if (matches.length > 0) {
                        const alreadyExists = results.some(r =>
                            r.memoryIndex === i && r.category === category && r.entryName === entryName
                        );

                        if (!alreadyExists) {
                            results.push({
                                category,
                                entryName,
                                memoryIndex: i,
                                matches,
                                fromMemoryResult: true
                            });
                        }
                        memoryIndicesSet.add(i);
                    }
                }
            }
        }

        // 搜索合并后的世界书
        for (const category in generatedWorldbook) {
            for (const entryName in generatedWorldbook[category]) {
                const alreadyFoundInMemory = results.some(r => r.category === category && r.entryName === entryName);
                if (alreadyFoundInMemory) continue;

                const entry = generatedWorldbook[category][entryName];
                if (!entry || typeof entry !== 'object') continue;

                const keywordsStr = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : '';
                const content = entry['内容'] || '';

                const matches = [];

                if (entryName.includes(keyword)) {
                    matches.push({ field: '条目名', text: entryName });
                }
                if (keywordsStr.includes(keyword)) {
                    matches.push({ field: '关键词', text: keywordsStr });
                }
                if (content.includes(keyword)) {
                    const idx = content.indexOf(keyword);
                    const start = Math.max(0, idx - 30);
                    const end = Math.min(content.length, idx + keyword.length + 30);
                    const context = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
                    matches.push({ field: '内容', text: context });
                }

                if (matches.length > 0) {
                    results.push({
                        category,
                        entryName,
                        memoryIndex: -1,
                        matches,
                        fromMemoryResult: false
                    });
                }
            }
        }

        // 保存找到的记忆索引
        resultsContainer.dataset.memoryIndices = JSON.stringify([...memoryIndicesSet]);

        if (results.length === 0) {
            resultsContainer.innerHTML = `<div style="text-align:center;color:#888;padding:20px;">未找到包含"${keyword}"的内容</div>`;
            return { results: [], memoryIndices: memoryIndicesSet };
        }

        // 高亮函数
        const highlightKw = (text) => {
            if (!text) return '';
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return text.replace(new RegExp(escaped, 'g'),
                `<span style="background:#f1c40f;color:#000;padding:1px 2px;border-radius:2px;">${keyword}</span>`);
        };

        // 生成HTML
        let html = `<div style="margin-bottom:12px;font-size:13px;color:#27ae60;">找到 ${results.length} 个匹配项，涉及 ${memoryIndicesSet.size} 个章节</div>`;

        for (let idx = 0; idx < results.length; idx++) {
            const result = results[idx];
            const memoryLabel = result.memoryIndex >= 0 ? `记忆${result.memoryIndex + 1}` : '默认/导入';
            const memoryColor = result.memoryIndex >= 0 ? '#3498db' : '#888';
            const sourceTag = result.fromMemoryResult
                ? '<span style="font-size:9px;color:#27ae60;margin-left:4px;">✓当前结果</span>'
                : '<span style="font-size:9px;color:#f39c12;margin-left:4px;">⚠合并数据</span>';

            const matchTexts = result.matches.slice(0, 2).map(m => {
                const fieldText = m.field || '';
                const matchText = (m.text || '').substring(0, 80);
                return '<span style="color:#888;">' + fieldText + ':</span> ' + highlightKw(matchText) + (m.text && m.text.length > 80 ? '...' : '');
            }).join('<br>');

            html += '<div class="ttw-search-result-item" data-result-index="' + idx + '" style="background:rgba(0,0,0,0.2);border-radius:6px;padding:10px;margin-bottom:8px;border-left:3px solid #f1c40f;cursor:pointer;transition:background 0.2s;">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
            html += '<span style="font-weight:bold;color:#e67e22;">[' + result.category + '] ' + highlightKw(result.entryName) + '</span>';
            html += '<div style="display:flex;align-items:center;gap:8px;">';
            html += '<span style="font-size:11px;color:' + memoryColor + ';background:rgba(52,152,219,0.2);padding:2px 6px;border-radius:3px;">📍 ' + memoryLabel + '</span>';
            html += sourceTag;
            if (result.memoryIndex >= 0) {
                html += '<button class="ttw-btn-tiny ttw-reroll-single" data-memory-idx="' + result.memoryIndex + '" title="重Roll此章节">🎲</button>';
            }
            html += '</div></div>';
            html += '<div style="font-size:12px;color:#ccc;">' + matchTexts + '</div>';
            html += '</div>';
        }

        resultsContainer.innerHTML = html;


        // ====== 关键修复：在innerHTML之后绑定事件 ======

        // 绑定单个重Roll按钮
        resultsContainer.querySelectorAll('.ttw-reroll-single').forEach(btn => {
            btn.onclick = async function (e) {
                e.stopPropagation();
                const memoryIndex = parseInt(this.dataset.memoryIdx);
                const customPrompt = modal.querySelector('#ttw-search-suffix-prompt')?.value || '';

                if (!confirm(`确定要重Roll 第${memoryIndex + 1}章 吗？`)) return;

                this.disabled = true;
                this.textContent = '🔄';

                try {
                    await rerollMemory(memoryIndex, customPrompt);
                    alert(`第${memoryIndex + 1}章 重Roll完成！`);
                    modal.querySelector('#ttw-do-search')?.click();
                    updateWorldbookPreview();
                } catch (error) {
                    alert(`重Roll失败: ${error.message}`);
                } finally {
                    this.disabled = false;
                    this.textContent = '🎲';
                }
            };
        });

        // 绑定条目点击 - 显示详情
        const allItems = resultsContainer.querySelectorAll('.ttw-search-result-item');
        console.log('📌 绑定点击事件，共', allItems.length, '个条目');

        allItems.forEach((item, loopIndex) => {
            const resultIndex = parseInt(item.dataset.resultIndex);
            console.log(`📌 绑定第${loopIndex}个item, data-result-index=${resultIndex}`);

            item.onclick = function (e) {
                console.log('🖱️ 点击触发！loopIndex=', loopIndex, 'resultIndex=', resultIndex);
                console.log('🖱️ this.dataset.resultIndex=', this.dataset.resultIndex);
                console.log('🖱️ results数组长度=', results.length);

                // 如果点击的是按钮，不处理
                if (e.target.closest('.ttw-reroll-single')) {
                    console.log('🖱️ 点击的是按钮，跳过');
                    return;
                }

                const idx = parseInt(this.dataset.resultIndex);
                console.log('🖱️ 解析的idx=', idx);

                const result = results[idx];
                console.log('🖱️ 获取的result=', result);

                if (!result) {
                    console.error('❌ 找不到result! idx=', idx, 'results=', results);
                    alert('调试：找不到result，idx=' + idx + '，results长度=' + results.length);
                    return;
                }

                const detailDiv = modal.querySelector('#ttw-search-detail');
                if (!detailDiv) {
                    console.error('❌ 找不到detailDiv!');
                    return;
                }

                // 更新选中样式
                resultsContainer.querySelectorAll('.ttw-search-result-item').forEach(i => {
                    i.style.background = 'rgba(0,0,0,0.2)';
                });
                this.style.background = 'rgba(0,0,0,0.4)';

                // 获取条目数据
                let entry = null;
                let dataSource = '';

                if (result.memoryIndex >= 0) {
                    const mem = memoryQueue[result.memoryIndex];
                    if (mem && mem.result && mem.result[result.category]) {
                        entry = mem.result[result.category][result.entryName];
                        dataSource = `来自: 记忆${result.memoryIndex + 1} 的当前处理结果`;
                    }
                }

                if (!entry) {
                    entry = generatedWorldbook[result.category]?.[result.entryName];
                    dataSource = '来自: 合并后的世界书';
                }

                console.log('🖱️ 获取的entry=', entry);

                const memoryLabel = result.memoryIndex >= 0
                    ? `记忆${result.memoryIndex + 1} (第${result.memoryIndex + 1}章)`
                    : '默认/导入条目';

                let contentHtml = '';
                if (entry) {
                    const keywordsStr = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : '';
                    let content = (entry['内容'] || '').replace(/</g, '<').replace(/>/g, '>');
                    content = highlightKw(content).replace(/\n/g, '<br>');

                    contentHtml = `
                        <div style="margin-bottom:8px;font-size:11px;color:#888;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;">${dataSource}</div>
                        <div style="margin-bottom:12px;padding:10px;background:rgba(155,89,182,0.1);border-radius:6px;">
                            <div style="color:#9b59b6;font-size:11px;margin-bottom:4px;">🔑 关键词</div>
                            <div style="font-size:12px;">${highlightKw(keywordsStr)}</div>
                        </div>
                        <div style="padding:10px;background:rgba(39,174,96,0.1);border-radius:6px;max-height:250px;overflow-y:auto;">
                            <div style="color:#27ae60;font-size:11px;margin-bottom:4px;">📝 内容</div>
                            <div style="font-size:12px;line-height:1.6;">${content}</div>
                        </div>
                    `;
                } else {
                    contentHtml = '<div style="color:#888;text-align:center;padding:20px;">无法获取条目详情</div>';
                }

                detailDiv.innerHTML = `
                    <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #444;">
                        <h4 style="color:#e67e22;margin:0 0 8px;font-size:14px;">[${result.category}] ${result.entryName}</h4>
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <span style="font-size:12px;color:#3498db;">📍 来源: ${memoryLabel}</span>
                            ${result.memoryIndex >= 0 ? `<button class="ttw-btn ttw-btn-small ttw-btn-warning" id="ttw-detail-reroll-btn" data-mem-idx="${result.memoryIndex}">🎲 重Roll此章节</button>` : ''}
                        </div>
                    </div>
                    ${contentHtml}
                `;

                console.log('✅ 详情已更新');

                // 绑定详情页重Roll按钮
                const detailRerollBtn = detailDiv.querySelector('#ttw-detail-reroll-btn');
                if (detailRerollBtn) {
                    detailRerollBtn.onclick = async function () {
                        const memIdx = parseInt(this.dataset.memIdx);
                        const customPrompt = modal.querySelector('#ttw-search-suffix-prompt')?.value || '';

                        if (!confirm(`确定要重Roll 第${memIdx + 1}章 吗？`)) return;

                        this.disabled = true;
                        this.textContent = '🔄 重Roll中...';

                        try {
                            await rerollMemory(memIdx, customPrompt);
                            alert(`第${memIdx + 1}章 重Roll完成！`);
                            modal.querySelector('#ttw-do-search')?.click();
                            updateWorldbookPreview();
                        } catch (error) {
                            alert(`重Roll失败: ${error.message}`);
                        } finally {
                            this.disabled = false;
                            this.textContent = '🎲 重Roll此章节';
                        }
                    };
                }
            };
        });


        return { results, memoryIndices: memoryIndicesSet };
    }



    // ========== 新增：替换功能 ==========
    function showReplaceModal() {
        const existingModal = document.getElementById('ttw-replace-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'ttw-replace-modal';
        modal.className = 'ttw-modal-container';

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:600px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">🔄 批量替换</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;">
                        <label style="display:block;margin-bottom:8px;font-size:13px;">查找内容</label>
                        <input type="text" id="ttw-replace-find" class="ttw-input" placeholder="输入要查找的词语...">
                    </div>
                    <div style="margin-bottom:16px;">
                        <label style="display:block;margin-bottom:8px;font-size:13px;">替换为（留空则删除该词语）</label>
                        <input type="text" id="ttw-replace-with" class="ttw-input" placeholder="输入替换内容，留空则删除...">
                    </div>
                    <div style="margin-bottom:16px;padding:12px;background:rgba(230,126,34,0.1);border-radius:6px;">
                        <label class="ttw-checkbox-label">
                            <input type="checkbox" id="ttw-replace-in-worldbook" checked>
                            <span>替换世界书中的内容</span>
                        </label>
                        <label class="ttw-checkbox-label" style="margin-top:8px;">
                            <input type="checkbox" id="ttw-replace-in-results" checked>
                            <span>替换各章节处理结果中的内容</span>
                        </label>
                    </div>
                    <div id="ttw-replace-preview" style="display:none;max-height:400px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:12px;margin-bottom:16px;">
                    </div>

                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-preview-replace">👁️ 预览</button>
                    <button class="ttw-btn ttw-btn-warning" id="ttw-do-replace">🔄 执行替换</button>
                    <button class="ttw-btn" id="ttw-close-replace">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-close-replace').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-preview-replace').addEventListener('click', () => {
            const findText = modal.querySelector('#ttw-replace-find').value;
            const replaceWith = modal.querySelector('#ttw-replace-with').value;
            const inWorldbook = modal.querySelector('#ttw-replace-in-worldbook').checked;
            const inResults = modal.querySelector('#ttw-replace-in-results').checked;

            if (!findText) {
                alert('请输入要查找的内容');
                return;
            }

            const preview = previewReplace(findText, replaceWith, inWorldbook, inResults);
            const previewDiv = modal.querySelector('#ttw-replace-preview');
            previewDiv.style.display = 'block';

            // 移除高度限制，允许滚动查看全部
            previewDiv.style.maxHeight = '350px';

            if (preview.count === 0) {
                previewDiv.innerHTML = `<div style="color:#888;text-align:center;padding:20px;">未找到"${findText}"</div>`;
            } else {
                const highlightText = (text) => {
                    return text.replace(new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                        `<span style="background:#f1c40f;color:#000;padding:1px 2px;border-radius:2px;">${findText}</span>`);
                };

                let itemsHtml = preview.allMatches.map((match, idx) => `
                    <div class="ttw-replace-item" data-index="${idx}" style="font-size:11px;margin-bottom:8px;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;border-left:3px solid #e67e22;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                            <div style="color:#888;font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${match.location}">${match.locationShort}</div>
                            <button class="ttw-btn-tiny ttw-replace-single-btn" data-index="${idx}" style="background:rgba(230,126,34,0.5);flex-shrink:0;margin-left:8px;">替换此项</button>
                        </div>
                        <div style="color:#e74c3c;text-decoration:line-through;word-break:break-all;margin-bottom:4px;">${highlightText(match.before.replace(/</g, '<').replace(/>/g, '>'))}</div>
                        <div style="color:#27ae60;word-break:break-all;">${match.after.replace(/</g, '<').replace(/>/g, '>')}</div>
                    </div>
                `).join('');

                previewDiv.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #444;">
                        <span style="color:#27ae60;font-weight:bold;">找到 ${preview.allMatches.length} 处匹配</span>
                        <span style="color:#888;font-size:11px;">点击"替换此项"可单独替换</span>
                    </div>
                    <div style="max-height:280px;overflow-y:auto;">
                        ${itemsHtml}
                    </div>
                `;

                // 绑定单项替换按钮事件
                previewDiv.querySelectorAll('.ttw-replace-single-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const matchIndex = parseInt(btn.dataset.index);
                        const matchInfo = preview.allMatches[matchIndex];

                        if (!matchInfo) return;

                        const action = replaceWith ? `替换为"${replaceWith}"` : '删除';
                        if (!confirm(`确定要${action}此处的"${findText}"吗？\n\n位置: ${matchInfo.location}`)) return;

                        const success = executeSingleReplace(findText, replaceWith, matchInfo);

                        if (success) {
                            // 移除已替换的项
                            const itemDiv = btn.closest('.ttw-replace-item');
                            if (itemDiv) {
                                itemDiv.style.opacity = '0.3';
                                itemDiv.style.pointerEvents = 'none';
                                btn.textContent = '✓ 已替换';
                                btn.disabled = true;
                            }

                            updateWorldbookPreview();
                        } else {
                            alert('替换失败，可能条目已被修改');
                        }
                    });
                });
            }
        });

        modal.querySelector('#ttw-do-replace').addEventListener('click', () => {
            const findText = modal.querySelector('#ttw-replace-find').value;
            const replaceWith = modal.querySelector('#ttw-replace-with').value;
            const inWorldbook = modal.querySelector('#ttw-replace-in-worldbook').checked;
            const inResults = modal.querySelector('#ttw-replace-in-results').checked;

            if (!findText) {
                alert('请输入要查找的内容');
                return;
            }

            const preview = previewReplace(findText, replaceWith, inWorldbook, inResults);
            if (preview.count === 0) {
                alert(`未找到"${findText}"`);
                return;
            }

            const action = replaceWith ? `替换为"${replaceWith}"` : '删除';
            if (!confirm(`确定要${action} ${preview.count} 处"${findText}"吗？\n\n此操作不可撤销！`)) {
                return;
            }

            const result = executeReplace(findText, replaceWith, inWorldbook, inResults);
            updateWorldbookPreview();

            // 刷新预览区域，显示替换结果而非关闭UI
            const previewDiv = modal.querySelector('#ttw-replace-preview');
            previewDiv.style.display = 'block';
            previewDiv.innerHTML = `
                <div style="text-align:center;padding:20px;">
                    <div style="color:#27ae60;font-weight:bold;font-size:14px;margin-bottom:8px;">✅ 替换完成！共替换了 ${result.count} 处</div>
                    <div style="color:#888;font-size:12px;">可继续输入新的查找/替换内容</div>
                </div>
            `;
        });
    }

    function previewReplace(findText, replaceWith, inWorldbook, inResults) {
        const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        let count = 0;
        const allMatches = [];

        if (inWorldbook) {
            for (const category in generatedWorldbook) {
                for (const entryName in generatedWorldbook[category]) {
                    const entry = generatedWorldbook[category][entryName];

                    // 检查条目名称
                    if (entryName.includes(findText)) {
                        count++;
                        allMatches.push({
                            source: 'worldbook',
                            category,
                            entryName,
                            field: 'entryName',
                            fieldIndex: -1,
                            location: `世界书/${category}/${entryName}/条目名称`,
                            locationShort: `[${category}] ${entryName} - 条目名称`,
                            before: entryName,
                            after: entryName.replace(regex, replaceWith)
                        });
                    }

                    // 检查关键词
                    if (Array.isArray(entry['关键词'])) {
                        entry['关键词'].forEach((kw, kwIndex) => {
                            if (kw.includes(findText)) {
                                count++;
                                allMatches.push({
                                    source: 'worldbook',
                                    category,
                                    entryName,
                                    field: 'keyword',
                                    fieldIndex: kwIndex,
                                    location: `世界书/${category}/${entryName}/关键词[${kwIndex}]`,
                                    locationShort: `[${category}] ${entryName} - 关键词`,
                                    before: kw,
                                    after: kw.replace(regex, replaceWith)
                                });
                            }
                        });
                    }

                    // 检查内容
                    if (entry['内容'] && entry['内容'].includes(findText)) {
                        const matches = entry['内容'].match(regex);
                        const matchCount = matches ? matches.length : 0;
                        count += matchCount;

                        const idx = entry['内容'].indexOf(findText);
                        const start = Math.max(0, idx - 20);
                        const end = Math.min(entry['内容'].length, idx + findText.length + 20);
                        const context = (start > 0 ? '...' : '') + entry['内容'].substring(start, end) + (end < entry['内容'].length ? '...' : '');

                        allMatches.push({
                            source: 'worldbook',
                            category,
                            entryName,
                            field: 'content',
                            fieldIndex: -1,
                            location: `世界书/${category}/${entryName}/内容 (${matchCount}处)`,
                            locationShort: `[${category}] ${entryName} - 内容(${matchCount}处)`,
                            before: context,
                            after: context.replace(regex, replaceWith)
                        });
                    }
                }
            }
        }

        if (inResults) {
            for (let i = 0; i < memoryQueue.length; i++) {
                const memory = memoryQueue[i];
                if (!memory.result) continue;

                for (const category in memory.result) {
                    for (const entryName in memory.result[category]) {
                        const entry = memory.result[category][entryName];

                        // 检查条目名称
                        if (entryName.includes(findText)) {
                            count++;
                            allMatches.push({
                                source: 'memory',
                                memoryIndex: i,
                                category,
                                entryName,
                                field: 'entryName',
                                fieldIndex: -1,
                                location: `记忆${i + 1}/${category}/${entryName}/条目名称`,
                                locationShort: `记忆${i + 1} [${category}] ${entryName} - 条目名称`,
                                before: entryName,
                                after: entryName.replace(regex, replaceWith)
                            });
                        }

                        if (Array.isArray(entry['关键词'])) {
                            entry['关键词'].forEach((kw, kwIndex) => {
                                if (kw.includes(findText)) {
                                    count++;
                                    allMatches.push({
                                        source: 'memory',
                                        memoryIndex: i,
                                        category,
                                        entryName,
                                        field: 'keyword',
                                        fieldIndex: kwIndex,
                                        location: `记忆${i + 1}/${category}/${entryName}/关键词[${kwIndex}]`,
                                        locationShort: `记忆${i + 1} [${category}] ${entryName} - 关键词`,
                                        before: kw,
                                        after: kw.replace(regex, replaceWith)
                                    });
                                }
                            });
                        }

                        if (entry['内容'] && entry['内容'].includes(findText)) {
                            const matches = entry['内容'].match(regex);
                            const matchCount = matches ? matches.length : 0;
                            count += matchCount;

                            const idx = entry['内容'].indexOf(findText);
                            const start = Math.max(0, idx - 20);
                            const end = Math.min(entry['内容'].length, idx + findText.length + 20);
                            const context = (start > 0 ? '...' : '') + entry['内容'].substring(start, end) + (end < entry['内容'].length ? '...' : '');

                            allMatches.push({
                                source: 'memory',
                                memoryIndex: i,
                                category,
                                entryName,
                                field: 'content',
                                fieldIndex: -1,
                                location: `记忆${i + 1}/${category}/${entryName}/内容 (${matchCount}处)`,
                                locationShort: `记忆${i + 1} [${category}] ${entryName} - 内容(${matchCount}处)`,
                                before: context,
                                after: context.replace(regex, replaceWith)
                            });
                        }
                    }
                }
            }
        }

        return { count, allMatches };
    }


    function executeSingleReplace(findText, replaceWith, matchInfo) {
        const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

        if (matchInfo.source === 'worldbook') {
            if (matchInfo.field === 'entryName') {
                const catData = generatedWorldbook[matchInfo.category];
                if (!catData || !catData[matchInfo.entryName]) return false;
                const newName = matchInfo.entryName.replace(regex, replaceWith);
                if (!newName || newName === matchInfo.entryName) return false;
                const finalName = catData[newName] ? newName + '_重命名' : newName;
                catData[finalName] = catData[matchInfo.entryName];
                delete catData[matchInfo.entryName];
                // 同步entryPositionConfig
                const oldKey = `${matchInfo.category}::${matchInfo.entryName}`;
                const newKey = `${matchInfo.category}::${finalName}`;
                if (entryPositionConfig[oldKey]) {
                    entryPositionConfig[newKey] = entryPositionConfig[oldKey];
                    delete entryPositionConfig[oldKey];
                }
                return true;
            }

            const entry = generatedWorldbook[matchInfo.category]?.[matchInfo.entryName];
            if (!entry) return false;

            if (matchInfo.field === 'keyword' && Array.isArray(entry['关键词'])) {
                const newValue = entry['关键词'][matchInfo.fieldIndex].replace(regex, replaceWith);
                if (newValue) {
                    entry['关键词'][matchInfo.fieldIndex] = newValue;
                } else {
                    entry['关键词'].splice(matchInfo.fieldIndex, 1);
                }
                return true;
            } else if (matchInfo.field === 'content') {
                entry['内容'] = entry['内容'].replace(regex, replaceWith);
                return true;
            }
        } else if (matchInfo.source === 'memory') {
            const memory = memoryQueue[matchInfo.memoryIndex];
            if (!memory?.result) return false;

            if (matchInfo.field === 'entryName') {
                const catData = memory.result[matchInfo.category];
                if (!catData || !catData[matchInfo.entryName]) return false;
                const newName = matchInfo.entryName.replace(regex, replaceWith);
                if (!newName || newName === matchInfo.entryName) return false;
                const finalName = catData[newName] ? newName + '_重命名' : newName;
                catData[finalName] = catData[matchInfo.entryName];
                delete catData[matchInfo.entryName];
                return true;
            }

            const entry = memory.result[matchInfo.category]?.[matchInfo.entryName];
            if (!entry) return false;

            if (matchInfo.field === 'keyword' && Array.isArray(entry['关键词'])) {
                const newValue = entry['关键词'][matchInfo.fieldIndex].replace(regex, replaceWith);
                if (newValue) {
                    entry['关键词'][matchInfo.fieldIndex] = newValue;
                } else {
                    entry['关键词'].splice(matchInfo.fieldIndex, 1);
                }
                return true;
            } else if (matchInfo.field === 'content') {
                entry['内容'] = entry['内容'].replace(regex, replaceWith);
                return true;
            }
        }

        return false;
    }



    function executeReplace(findText, replaceWith, inWorldbook, inResults) {
        const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        let count = 0;

        if (inWorldbook) {
            // 先收集需要重命名的条目名称（避免遍历中修改对象）
            const renameList = [];
            for (const category in generatedWorldbook) {
                for (const entryName in generatedWorldbook[category]) {
                    if (entryName.includes(findText)) {
                        const newName = entryName.replace(regex, replaceWith);
                        if (newName && newName !== entryName) {
                            renameList.push({ category, oldName: entryName, newName });
                            count++;
                        }
                    }
                }
            }
            // 执行重命名
            for (const item of renameList) {
                const catData = generatedWorldbook[item.category];
                const finalName = catData[item.newName] ? item.newName + '_重命名' : item.newName;
                catData[finalName] = catData[item.oldName];
                delete catData[item.oldName];
                // 同步entryPositionConfig
                const oldKey = `${item.category}::${item.oldName}`;
                const newKey = `${item.category}::${finalName}`;
                if (entryPositionConfig[oldKey]) {
                    entryPositionConfig[newKey] = entryPositionConfig[oldKey];
                    delete entryPositionConfig[oldKey];
                }
            }

            for (const category in generatedWorldbook) {
                for (const entryName in generatedWorldbook[category]) {
                    const entry = generatedWorldbook[category][entryName];

                    if (Array.isArray(entry['关键词'])) {
                        entry['关键词'] = entry['关键词'].map(kw => {
                            if (kw.includes(findText)) {
                                count++;
                                return kw.replace(regex, replaceWith);
                            }
                            return kw;
                        }).filter(kw => kw);
                    }

                    if (entry['内容'] && entry['内容'].includes(findText)) {
                        const matches = entry['内容'].match(regex);
                        count += matches ? matches.length : 0;
                        entry['内容'] = entry['内容'].replace(regex, replaceWith);
                    }
                }
            }
        }

        if (inResults) {
            for (let i = 0; i < memoryQueue.length; i++) {
                const memory = memoryQueue[i];
                if (!memory.result) continue;

                // 先收集需要重命名的
                const renameList = [];
                for (const category in memory.result) {
                    for (const entryName in memory.result[category]) {
                        if (entryName.includes(findText)) {
                            const newName = entryName.replace(regex, replaceWith);
                            if (newName && newName !== entryName) {
                                renameList.push({ category, oldName: entryName, newName });
                                count++;
                            }
                        }
                    }
                }
                // 执行重命名
                for (const item of renameList) {
                    const catData = memory.result[item.category];
                    const finalName = catData[item.newName] ? item.newName + '_重命名' : item.newName;
                    catData[finalName] = catData[item.oldName];
                    delete catData[item.oldName];
                }

                for (const category in memory.result) {
                    for (const entryName in memory.result[category]) {
                        const entry = memory.result[category][entryName];

                        if (Array.isArray(entry['关键词'])) {
                            entry['关键词'] = entry['关键词'].map(kw => {
                                if (kw.includes(findText)) {
                                    count++;
                                    return kw.replace(regex, replaceWith);
                                }
                                return kw;
                            }).filter(kw => kw);
                        }

                        if (entry['内容'] && entry['内容'].includes(findText)) {
                            const matches = entry['内容'].match(regex);
                            count += matches ? matches.length : 0;
                            entry['内容'] = entry['内容'].replace(regex, replaceWith);
                        }
                    }
                }
            }
        }

        return { count };
    }


    // ========== 新增：条目配置弹窗 ==========
    function showEntryConfigModal(category, entryName) {
        const existingModal = document.getElementById('ttw-entry-config-modal');
        if (existingModal) existingModal.remove();

        const config = getEntryConfig(category, entryName);

        const modal = document.createElement('div');
        modal.id = 'ttw-entry-config-modal';
        modal.className = 'ttw-modal-container';

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:500px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">⚙️ 条目配置: ${entryName}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                        <div style="font-size:12px;color:#ccc;">配置此条目在导出为SillyTavern格式时的位置、深度和顺序</div>
                    </div>

                    <div class="ttw-form-group">
                        <label>位置 (Position)</label>
                        <select id="ttw-entry-position" class="ttw-select">
    <option value="0" ${config.position === 0 ? 'selected' : ''}>在角色定义之前</option>
    <option value="1" ${config.position === 1 ? 'selected' : ''}>在角色定义之后</option>
    <option value="2" ${config.position === 2 ? 'selected' : ''}>在作者注释之前</option>
    <option value="3" ${config.position === 3 ? 'selected' : ''}>在作者注释之后</option>
    <option value="4" ${config.position === 4 ? 'selected' : ''}>自定义深度</option>
</select>

                    </div>

                    <div class="ttw-form-group">
                        <label>深度 (Depth) - 仅Position=4时有效</label>
                        <input type="number" id="ttw-entry-depth" class="ttw-input" value="${config.depth}" min="0" max="999">
                    </div>

                    <div class="ttw-form-group">
                        <label>顺序 (Order) - 数字越小越靠前</label>
                        <input type="number" id="ttw-entry-order" class="ttw-input" value="${config.order}" min="0" max="9999">
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-entry-config">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-save-entry-config">💾 保存</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-entry-config').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-save-entry-config').addEventListener('click', () => {
            const position = parseInt(modal.querySelector('#ttw-entry-position').value);
            const depth = parseInt(modal.querySelector('#ttw-entry-depth').value) || 4;
            const order = parseInt(modal.querySelector('#ttw-entry-order').value) || 100;

            setEntryConfig(category, entryName, { position, depth, order });
            modal.remove();
            alert('配置已保存');
        });
    }
    // 新增：显示剧情大纲导出配置弹窗
    function showPlotOutlineConfigModal() {
        const existingModal = document.getElementById('ttw-plot-config-modal');
        if (existingModal) existingModal.remove();

        const config = plotOutlineExportConfig;

        const modal = document.createElement('div');
        modal.id = 'ttw-plot-config-modal';
        modal.className = 'ttw-modal-container';

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:500px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">⚙️ 剧情大纲 - 导出时的默认配置</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;padding:12px;background:rgba(155,89,182,0.15);border-radius:8px;">
                        <div style="font-size:12px;color:#ccc;">设置"剧情大纲"分类在导出为SillyTavern格式时的默认位置/深度/顺序。此配置会随"导出配置"一起保存。</div>
                    </div>

                    <div class="ttw-form-group">
                        <label>默认位置 (Position)</label>
                        <select id="ttw-plot-config-position" class="ttw-select">
                            <option value="0" ${(config.position || 0) === 0 ? 'selected' : ''}>在角色定义之前</option>
                            <option value="1" ${config.position === 1 ? 'selected' : ''}>在角色定义之后</option>
                            <option value="2" ${config.position === 2 ? 'selected' : ''}>在作者注释之前</option>
                            <option value="3" ${config.position === 3 ? 'selected' : ''}>在作者注释之后</option>
                            <option value="4" ${config.position === 4 ? 'selected' : ''}>自定义深度</option>
                        </select>
                    </div>

                    <div class="ttw-form-group">
                        <label>默认深度 (Depth) - 仅Position=4时有效</label>
                        <input type="number" id="ttw-plot-config-depth" class="ttw-input" value="${config.depth || 4}" min="0" max="999">
                    </div>

                    <div class="ttw-form-group">
                        <label>默认起始顺序 (Order)</label>
                        <input type="number" id="ttw-plot-config-order" class="ttw-input" value="${config.order || 100}" min="0" max="9999">
                    </div>

                    <div style="margin-top:12px;">
                        <label class="ttw-checkbox-label" style="padding:10px;background:rgba(39,174,96,0.15);border-radius:6px;">
                            <input type="checkbox" id="ttw-plot-config-auto-increment" ${config.autoIncrementOrder ? 'checked' : ''}>
                            <div>
                                <span style="color:#27ae60;font-weight:bold;">📈 顺序自动递增</span>
                                <div class="ttw-setting-hint">勾选后剧情大纲下的条目顺序会从起始值开始递增（100,101,102...）</div>
                            </div>
                        </label>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-plot-config">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-save-plot-config">💾 保存</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-plot-config').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-save-plot-config').addEventListener('click', () => {
            plotOutlineExportConfig = {
                position: parseInt(modal.querySelector('#ttw-plot-config-position').value) || 0,
                depth: parseInt(modal.querySelector('#ttw-plot-config-depth').value) || 4,
                order: parseInt(modal.querySelector('#ttw-plot-config-order').value) || 100,
                autoIncrementOrder: modal.querySelector('#ttw-plot-config-auto-increment').checked
            };

            // 同步到 categoryDefaultConfig
            setCategoryDefaultConfig('剧情大纲', plotOutlineExportConfig);

            saveCurrentSettings();
            modal.remove();
            alert('剧情大纲导出配置已保存！');
        });
    }

    // ========== 新增：分类配置弹窗 ==========
    function showCategoryConfigModal(category) {
        const existingModal = document.getElementById('ttw-category-config-modal');
        if (existingModal) existingModal.remove();

        // 获取当前配置，优先从categoryDefaultConfig，其次从customWorldbookCategories
        let config = categoryDefaultConfig[category];
        if (!config) {
            const catConfig = customWorldbookCategories.find(c => c.name === category);
            if (catConfig) {
                config = {
                    position: catConfig.defaultPosition || 0,
                    depth: catConfig.defaultDepth || 4,
                    order: catConfig.defaultOrder || 100,
                    autoIncrementOrder: catConfig.autoIncrementOrder || false
                };
            } else {
                config = { position: 0, depth: 4, order: 100, autoIncrementOrder: false };
            }
        }

        const modal = document.createElement('div');
        modal.id = 'ttw-category-config-modal';
        modal.className = 'ttw-modal-container';

        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:500px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">⚙️ 分类默认配置: ${category}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;padding:12px;background:rgba(155,89,182,0.15);border-radius:8px;">
                        <div style="font-size:12px;color:#ccc;">设置此分类下所有条目的默认位置/深度/顺序。单个条目的配置会覆盖分类默认配置。</div>
                    </div>

                    <div class="ttw-form-group">
                        <label>默认位置 (Position)</label>
                        <select id="ttw-cat-position" class="ttw-select">
                            <option value="0" ${(config.position || 0) === 0 ? 'selected' : ''}>在角色定义之前</option>
                            <option value="1" ${config.position === 1 ? 'selected' : ''}>在角色定义之后</option>
                            <option value="2" ${config.position === 2 ? 'selected' : ''}>在作者注释之前</option>
                            <option value="3" ${config.position === 3 ? 'selected' : ''}>在作者注释之后</option>
                            <option value="4" ${config.position === 4 ? 'selected' : ''}>自定义深度</option>
                        </select>
                    </div>

                    <div class="ttw-form-group">
                        <label>默认深度 (Depth)</label>
                        <input type="number" id="ttw-cat-depth" class="ttw-input" value="${config.depth || 4}" min="0" max="999">
                    </div>

                    <div class="ttw-form-group">
                        <label>默认起始顺序 (Order)</label>
                        <input type="number" id="ttw-cat-order" class="ttw-input" value="${config.order || 100}" min="0" max="9999">
                    </div>

                    <div style="margin-top:12px;">
                        <label class="ttw-checkbox-label" style="padding:10px;background:rgba(39,174,96,0.15);border-radius:6px;">
                            <input type="checkbox" id="ttw-cat-auto-increment" ${config.autoIncrementOrder ? 'checked' : ''}>
                            <div>
                                <span style="color:#27ae60;font-weight:bold;">📈 顺序自动递增</span>
                                <div class="ttw-setting-hint">勾选后同分类下的条目顺序会从起始值开始递增（100,101,102...）</div>
                            </div>
                        </label>
                    </div>

                    <div style="margin-top:16px;padding:12px;background:rgba(230,126,34,0.1);border-radius:6px;">
                        <label class="ttw-checkbox-label">
                            <input type="checkbox" id="ttw-apply-to-existing">
                            <span>同时应用到该分类下已有的所有条目</span>
                        </label>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-cat-config">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-save-cat-config">💾 保存</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-cat-config').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-save-cat-config').addEventListener('click', () => {
            const position = parseInt(modal.querySelector('#ttw-cat-position').value);
            const depth = parseInt(modal.querySelector('#ttw-cat-depth').value) || 4;
            const order = parseInt(modal.querySelector('#ttw-cat-order').value) || 100;
            const autoIncrementOrder = modal.querySelector('#ttw-cat-auto-increment').checked;
            const applyToExisting = modal.querySelector('#ttw-apply-to-existing').checked;

            setCategoryDefaultConfig(category, { position, depth, order, autoIncrementOrder });

            if (applyToExisting && generatedWorldbook[category]) {
                for (const entryName in generatedWorldbook[category]) {
                    setEntryConfig(category, entryName, { position, depth, order });
                }
            }

            // 如果是修改自定义分类，同步更新
            const catIndex = customWorldbookCategories.findIndex(c => c.name === category);
            if (catIndex !== -1) {
                customWorldbookCategories[catIndex].defaultPosition = position;
                customWorldbookCategories[catIndex].defaultDepth = depth;
                customWorldbookCategories[catIndex].defaultOrder = order;
                customWorldbookCategories[catIndex].autoIncrementOrder = autoIncrementOrder;
                saveCustomCategories();
            }

            modal.remove();
            updateWorldbookPreview();
            alert('配置已保存');
        });
    }



    // ========== 导出功能 - 修改为使用条目配置 ==========
    function convertToSillyTavernFormat(worldbook) {
        const entries = [];
        let entryId = 0;

        // 按分类统计条目索引，用于顺序递增
        const categoryEntryIndex = {};

        for (const [category, categoryData] of Object.entries(worldbook)) {
            if (typeof categoryData !== 'object' || categoryData === null) continue;

            const isGreenLight = getCategoryLightState(category);
            const autoIncrement = getCategoryAutoIncrement(category);
            const baseOrder = getCategoryBaseOrder(category);

            // 初始化分类计数器
            if (!categoryEntryIndex[category]) {
                categoryEntryIndex[category] = 0;
            }

            for (const [itemName, itemData] of naturalSortEntryNames(Object.keys(categoryData)).map(name => [name, categoryData[name]])) {
                if (typeof itemData !== 'object' || itemData === null) continue;
                if (itemData.关键词 && itemData.内容) {
                    let keywords = Array.isArray(itemData.关键词) ? itemData.关键词 : [itemData.关键词];
                    // 修复：不要过度清理关键词，保留原始格式以便匹配
                    keywords = keywords.map(k => String(k).trim()).filter(k => k.length > 0 && k.length <= 50);
                    if (keywords.length === 0) keywords.push(itemName);

                    // 获取条目配置
                    const config = getEntryConfig(category, itemName);

                    // 计算实际顺序：如果启用自动递增，则使用 baseOrder + index
                    let actualOrder;
                    if (autoIncrement) {
                        actualOrder = baseOrder + categoryEntryIndex[category];
                        categoryEntryIndex[category]++;
                    } else {
                        actualOrder = config.order !== undefined ? config.order : baseOrder;
                    }

                    entries.push({
                        uid: entryId++,
                        key: [...new Set(keywords)],
                        keysecondary: [],
                        comment: `${category} - ${itemName}`,  // 显示分类-名称，合并时看这个
                        content: String(itemData.内容).trim(),
                        constant: !isGreenLight,
                        selective: isGreenLight,
                        selectiveLogic: 0,
                        addMemo: true,
                        order: actualOrder,
                        position: config.position !== undefined ? config.position : 0,
                        disable: false,
                        excludeRecursion: !settings.allowRecursion,
                        preventRecursion: !settings.allowRecursion,
                        delayUntilRecursion: false,
                        probability: 100,
                        depth: config.depth !== undefined ? config.depth : 4,

                        // ======= 【修复】=======
                        group: `${category}_${itemName}`,  // 每个条目独立group！
                        groupOverride: false,
                        groupWeight: 100,
                        useGroupScoring: null,
                        // =======================

                        scanDepth: null,
                        caseSensitive: false,
                        matchWholeWords: false,
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

        return {
            entries,
            originalData: { name: '小说转换的世界书', description: '由TXT转世界书功能生成', version: 1, author: 'TxtToWorldbook' }
        };
    }


    // 【新增】统一获取导出基础名：优先用UI输入框的小说名 > currentFile > fallback
    function getExportBaseName(fallback) {
        // 1. 优先使用用户手动输入的小说名称
        if (savedNovelName && savedNovelName.trim()) {
            return savedNovelName.trim();
        }
        // 2. 其次使用原始文件对象
        if (currentFile) {
            return currentFile.name.replace(/\.[^/.]+$/, '');
        }
        // 3. 再看UI输入框（可能还没同步到savedNovelName）
        const inputEl = document.getElementById('ttw-novel-name-input');
        if (inputEl && inputEl.value.trim()) {
            return inputEl.value.trim();
        }
        // 4. 最后用fallback
        return fallback || '未命名';
    }


    function exportCharacterCard() {
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');

        const baseName = getExportBaseName('角色卡');

        try {
            const worldbookToExport = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
            const stWorldbook = convertToSillyTavernFormat(worldbookToExport);

            // 将ST内部格式条目转换为V2 spec的character_book entries
            const v2Entries = stWorldbook.entries.map((entry, index) => ({
                id: index,
                keys: Array.isArray(entry.key) ? entry.key : [entry.key],
                secondary_keys: Array.isArray(entry.keysecondary) ? entry.keysecondary : [],
                comment: entry.comment || '',
                content: entry.content || '',
                constant: !!entry.constant,
                selective: !!entry.selective,
                insertion_order: entry.order !== undefined ? entry.order : 100,
                enabled: !entry.disable,
                position: entry.position === 1 ? 'after_char' : 'before_char',
                case_sensitive: !!entry.caseSensitive,
                name: entry.comment || `条目${index}`,
                priority: 10,
                extensions: {
                    position: entry.position !== undefined ? entry.position : 0,
                    exclude_recursion: !!entry.excludeRecursion,
                    prevent_recursion: !!entry.preventRecursion,
                    delay_until_recursion: !!entry.delayUntilRecursion,
                    depth: entry.depth !== undefined ? entry.depth : 4,
                    selectiveLogic: entry.selectiveLogic !== undefined ? entry.selectiveLogic : 0,
                    group: entry.group || '',
                    group_override: !!entry.groupOverride,
                    group_weight: entry.groupWeight !== undefined ? entry.groupWeight : 100,
                    use_group_scoring: entry.useGroupScoring !== undefined ? entry.useGroupScoring : null,
                    automation_id: entry.automationId || '',
                    role: entry.role !== undefined ? entry.role : 0,
                    vectorized: !!entry.vectorized,
                    display_index: index,
                    probability: entry.probability !== undefined ? entry.probability : 100,
                    sticky: entry.sticky !== undefined ? entry.sticky : null,
                    cooldown: entry.cooldown !== undefined ? entry.cooldown : null,
                    delay: entry.delay !== undefined ? entry.delay : null,
                    addMemo: entry.addMemo !== undefined ? entry.addMemo : true,
                    scan_depth: entry.scanDepth !== undefined ? entry.scanDepth : null,
                    match_whole_words: entry.matchWholeWords !== undefined ? entry.matchWholeWords : false
                }
            }));

            // 构建V2 spec角色卡
            const characterCard = {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: {
                    name: baseName,
                    description: '',
                    personality: '',
                    scenario: '',
                    first_mes: '',
                    mes_example: '',
                    creator_notes: '由TXT转世界书功能生成的角色卡，世界书已绑定',
                    system_prompt: '',
                    post_history_instructions: '',
                    alternate_greetings: [],
                    character_book: {
                        name: `${baseName}-世界书`,
                        description: '由TXT转世界书功能生成',
                        scan_depth: 2,
                        token_budget: 2048,
                        recursive_scanning: !!settings.allowRecursion,
                        extensions: {},
                        entries: v2Entries
                    },
                    tags: ['TxtToWorldbook', '自动生成'],
                    creator: 'TxtToWorldbook',
                    character_version: '1.0',
                    extensions: {
                        talkativeness: '0.5',
                        fav: false,
                        world: '',
                        depth_prompt: {
                            prompt: '',
                            depth: 4,
                            role: 'system'
                        }
                    }
                }
            };

            const fileName = `${baseName}-角色卡-${timeString}`;
            const blob = new Blob([JSON.stringify(characterCard, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName + '.json';
            a.click();
            URL.revokeObjectURL(url);
            alert('已导出SillyTavern角色卡（世界书已绑定到角色卡）');
        } catch (error) {
            alert('导出角色卡失败：' + error.message);
        }
    }


    function exportToSillyTavern() {
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        try {
            const worldbookToExport = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
            const sillyTavernWorldbook = convertToSillyTavernFormat(worldbookToExport);

            const baseName = getExportBaseName('世界书');

            const fileName = `${baseName}-世界书-${timeString}`;
            const blob = new Blob([JSON.stringify(sillyTavernWorldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName + '.json';
            a.click();
            URL.revokeObjectURL(url);
            alert('已导出世界书');
        } catch (error) {
            alert('转换失败：' + error.message);
        }
    }


    function exportVolumes() {
        if (worldbookVolumes.length === 0) { alert('没有分卷数据'); return; }
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        for (let i = 0; i < worldbookVolumes.length; i++) {
            const volume = worldbookVolumes[i];
            const fileName = `${getExportBaseName('世界书')}-世界书-卷${i + 1}-${timeString}.json`;
            const blob = new Blob([JSON.stringify(volume.worldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        }
        alert(`已导出 ${worldbookVolumes.length} 卷`);
    }

    async function exportTaskState() {
        const state = {
            version: '2.9.0',
            timestamp: Date.now(),
            memoryQueue,
            generatedWorldbook,
            worldbookVolumes,
            currentVolumeIndex,
            fileHash: currentFileHash,
            settings,
            parallelConfig,
            categoryLightSettings,
            customWorldbookCategories,
            chapterRegexSettings,
            defaultWorldbookEntriesUI,
            categoryDefaultConfig,
            entryPositionConfig,
            originalFileName: currentFile ? currentFile.name : null,
            novelName: savedNovelName || '' // 【新增】保存小说名称
        };
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');

        const baseName = getExportBaseName('任务状态');
        const fileName = `${baseName}-任务状态-${timeString}.json`;

        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        const processedCount = memoryQueue.filter(m => m.processed).length;
        alert(`任务状态已导出！已处理: ${processedCount}/${memoryQueue.length}`);
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
                if (state.categoryLightSettings) categoryLightSettings = { ...categoryLightSettings, ...state.categoryLightSettings };
                if (state.customWorldbookCategories) customWorldbookCategories = state.customWorldbookCategories;
                if (state.chapterRegexSettings) chapterRegexSettings = state.chapterRegexSettings;
                if (state.defaultWorldbookEntriesUI) defaultWorldbookEntriesUI = state.defaultWorldbookEntriesUI;
                if (state.categoryDefaultConfig) categoryDefaultConfig = state.categoryDefaultConfig;
                if (state.entryPositionConfig) entryPositionConfig = state.entryPositionConfig;
                // 恢复小说名称：优先用novelName字段，其次从originalFileName提取
                if (state.novelName) {
                    savedNovelName = state.novelName;
                } else if (state.originalFileName) {
                    savedNovelName = state.originalFileName.replace(/\.[^/.]+$/, '');
                }
                // 恢复文件名显示
                const fileNameEl = document.getElementById('ttw-file-name');
                if (fileNameEl && state.originalFileName) {
                    fileNameEl.textContent = state.originalFileName;
                }
                // 恢复小说名输入框
                const novelNameInput = document.getElementById('ttw-novel-name-input');
                if (novelNameInput && savedNovelName) {
                    novelNameInput.value = savedNovelName;
                }
                // 显示小说名行
                const novelNameRow = document.getElementById('ttw-novel-name-row');
                if (novelNameRow) novelNameRow.style.display = 'flex';


                if (Object.keys(generatedWorldbook).length === 0) {
                    rebuildWorldbookFromMemories();
                }

                const firstUnprocessed = memoryQueue.findIndex(m => !m.processed || m.failed);
                startFromIndex = firstUnprocessed !== -1 ? firstUnprocessed : 0;
                userSelectedStartIndex = null;
                showQueueSection(true);
                updateMemoryQueueUI();
                if (useVolumeMode) updateVolumeIndicator();
                updateStartButtonState(false);
                updateSettingsUI();
                renderCategoriesList();
                renderDefaultWorldbookEntriesUI();
                updateChapterRegexUI();

                if (Object.keys(generatedWorldbook).length > 0) {
                    showResultSection(true);
                    updateWorldbookPreview();
                }

                const processedCount = memoryQueue.filter(m => m.processed).length;
                alert(`导入成功！已处理: ${processedCount}/${memoryQueue.length}`);
                document.getElementById('ttw-start-btn').disabled = false;
            } catch (error) {
                alert('导入失败: ' + error.message);
            }
        };
        input.click();
    }

    function rebuildWorldbookFromMemories() {
        generatedWorldbook = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
        for (const memory of memoryQueue) {
            if (memory.processed && memory.result && !memory.failed) {
                mergeWorldbookDataIncremental(generatedWorldbook, memory.result);
            }
        }
        applyDefaultWorldbookEntries();
        updateStreamContent(`\n📚 从已处理记忆重建了世界书\n`);
    }

    // 修改：导出配置 - 包含默认世界书条目UI
    function exportSettings() {
        saveCurrentSettings();

        const exportData = {
            version: '2.9.0',
            type: 'settings',
            timestamp: Date.now(),
            settings: { ...settings },
            categoryLightSettings,
            parallelConfig,
            customWorldbookCategories,
            chapterRegexSettings,
            defaultWorldbookEntriesUI,
            categoryDefaultConfig,
            entryPositionConfig,
            prompts: {
                worldbookPrompt: settings.customWorldbookPrompt,
                plotPrompt: settings.customPlotPrompt,
                stylePrompt: settings.customStylePrompt,
                mergePrompt: settings.customMergePrompt,
                rerollPrompt: settings.customRerollPrompt,
                batchRerollPrompt: settings.customBatchRerollPrompt,
                defaultWorldbookEntries: settings.defaultWorldbookEntries
            },
            consolidatePromptPresets: settings.consolidatePromptPresets,
            consolidateCategoryPresetMap: settings.consolidateCategoryPresetMap,
            promptMessageChain: settings.promptMessageChain
        };
        const timeString = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[:/\s]/g, '').replace(/,/g, '-');
        const fileName = `TxtToWorldbook-配置-${timeString}.json`;
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        alert('配置已导出！（包含提示词配置、整理条目预设和默认世界书条目）');
    }

    // 修改：导入配置 - 包含默认世界书条目UI
    function importSettings() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const content = await file.text();
                const data = JSON.parse(content);
                if (data.type !== 'settings') throw new Error('不是有效的配置文件');

                if (data.settings) {
                    settings = { ...defaultSettings, ...data.settings };
                }
                if (data.parallelConfig) {
                    parallelConfig = { ...parallelConfig, ...data.parallelConfig };
                }
                if (data.categoryLightSettings) {
                    categoryLightSettings = { ...categoryLightSettings, ...data.categoryLightSettings };
                }
                if (data.customWorldbookCategories) {
                    customWorldbookCategories = data.customWorldbookCategories;
                    await saveCustomCategories();
                }
                if (data.chapterRegexSettings) {
                    chapterRegexSettings = data.chapterRegexSettings;
                }
                if (data.defaultWorldbookEntriesUI) {
                    defaultWorldbookEntriesUI = data.defaultWorldbookEntriesUI;
                }
                if (data.categoryDefaultConfig) {
                    categoryDefaultConfig = data.categoryDefaultConfig;
                }
                if (data.entryPositionConfig) {
                    entryPositionConfig = data.entryPositionConfig;
                }
                // 新增：导入剧情大纲导出配置
                if (data.plotOutlineExportConfig) {
                    plotOutlineExportConfig = data.plotOutlineExportConfig;
                }
                // 新增：导入消息链配置
                if (data.promptMessageChain) {
                    settings.promptMessageChain = data.promptMessageChain;
                }
                // 新增：导入整理条目预设配置
                if (data.consolidatePromptPresets) {
                    settings.consolidatePromptPresets = data.consolidatePromptPresets;
                }
                if (data.consolidateCategoryPresetMap) {
                    settings.consolidateCategoryPresetMap = data.consolidateCategoryPresetMap;
                }

                if (data.prompts) {
                    if (data.prompts.worldbookPrompt !== undefined) {
                        settings.customWorldbookPrompt = data.prompts.worldbookPrompt;
                    }
                    if (data.prompts.plotPrompt !== undefined) {
                        settings.customPlotPrompt = data.prompts.plotPrompt;
                    }
                    if (data.prompts.stylePrompt !== undefined) {
                        settings.customStylePrompt = data.prompts.stylePrompt;
                    }
                    if (data.prompts.mergePrompt !== undefined) {
                        settings.customMergePrompt = data.prompts.mergePrompt;
                    }
                    if (data.prompts.rerollPrompt !== undefined) {
                        settings.customRerollPrompt = data.prompts.rerollPrompt;
                    }
                    if (data.prompts.batchRerollPrompt !== undefined) {
                        settings.customBatchRerollPrompt = data.prompts.batchRerollPrompt;
                    }
                    // 旧版兼容：单个整理提示词迁移为预设
                    if (data.prompts.consolidatePrompt && data.prompts.consolidatePrompt.trim()) {
                        if (!settings.consolidatePromptPresets) settings.consolidatePromptPresets = [];
                        if (!settings.consolidatePromptPresets.some(p => p.name === '旧版自定义')) {
                            settings.consolidatePromptPresets.push({ name: '旧版自定义', prompt: data.prompts.consolidatePrompt });
                        }
                    }
                    if (data.prompts.defaultWorldbookEntries !== undefined) {
                        settings.defaultWorldbookEntries = data.prompts.defaultWorldbookEntries;
                    }
                }

                updateSettingsUI();
                renderCategoriesList();
                renderDefaultWorldbookEntriesUI();
                updateChapterRegexUI();
                saveCurrentSettings();

                alert('配置导入成功！');
            } catch (error) {
                alert('导入失败: ' + error.message);
            }
        };
        input.click();
    }


    // ========== 消息链编辑器UI渲染 ==========
    function renderMessageChainUI() {
        const container = document.getElementById('ttw-message-chain-list');
        if (!container) return;

        const chain = settings.promptMessageChain || [{ role: 'user', content: '{PROMPT}', enabled: true }];

        const roleColors = { system: '#3498db', user: '#27ae60', assistant: '#f39c12' };
        const roleLabels = { system: '🔷 系统', user: '🟢 用户', assistant: '🟡 AI助手' };

        let html = '';
        chain.forEach((msg, idx) => {
            const borderColor = roleColors[msg.role] || '#888';
            const isEnabled = msg.enabled !== false;
            html += `
            <div class="ttw-chain-msg-item" data-chain-index="${idx}" style="margin-bottom:8px;padding:10px;border-left:3px solid ${borderColor};background:rgba(0,0,0,0.2);border-radius:0 6px 6px 0;opacity:${isEnabled ? 1 : 0.5};">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
                    <select class="ttw-chain-role" data-chain-index="${idx}" style="padding:4px 8px;border-radius:4px;background:rgba(0,0,0,0.3);color:#fff;border:1px solid ${borderColor};font-size:12px;cursor:pointer;">
                        <option value="system" ${msg.role === 'system' ? 'selected' : ''}>${roleLabels.system}</option>
                        <option value="user" ${msg.role === 'user' ? 'selected' : ''}>${roleLabels.user}</option>
                        <option value="assistant" ${msg.role === 'assistant' ? 'selected' : ''}>${roleLabels.assistant}</option>
                    </select>
                    <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#aaa;cursor:pointer;">
                        <input type="checkbox" class="ttw-chain-enabled" data-chain-index="${idx}" ${isEnabled ? 'checked' : ''}> 启用
                    </label>
                    <div style="margin-left:auto;display:flex;gap:4px;">
                        ${idx > 0 ? `<button class="ttw-chain-move-up" data-chain-index="${idx}" style="background:none;border:1px solid #555;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;color:#aaa;" title="上移">⬆️</button>` : ''}
                        ${idx < chain.length - 1 ? `<button class="ttw-chain-move-down" data-chain-index="${idx}" style="background:none;border:1px solid #555;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;color:#aaa;" title="下移">⬇️</button>` : ''}
                        <button class="ttw-chain-delete" data-chain-index="${idx}" style="background:rgba(231,76,60,0.3);border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;color:#e74c3c;" title="删除">🗑️</button>
                    </div>
                </div>
                <textarea class="ttw-chain-content ttw-textarea-small" data-chain-index="${idx}" rows="3" placeholder="消息内容。使用 {PROMPT} 作为原始提示词占位符" style="width:100%;box-sizing:border-box;font-size:12px;">${(msg.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            </div>`;
        });

        if (chain.length === 0) {
            html = '<div style="text-align:center;color:#888;padding:10px;font-size:11px;">暂无消息，点击「➕ 添加消息」开始配置</div>';
        }

        container.innerHTML = html;

        // 绑定事件
        container.querySelectorAll('.ttw-chain-role').forEach(sel => {
            sel.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.chainIndex);
                chain[idx].role = e.target.value;
                settings.promptMessageChain = chain;
                renderMessageChainUI();
                saveCurrentSettings();
                handleUseTavernApiChange(); // 更新酒馆API警告
            });
        });

        container.querySelectorAll('.ttw-chain-enabled').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.chainIndex);
                chain[idx].enabled = e.target.checked;
                settings.promptMessageChain = chain;
                renderMessageChainUI();
                saveCurrentSettings();
                handleUseTavernApiChange(); // 更新酒馆API警告
            });
        });

        container.querySelectorAll('.ttw-chain-content').forEach(ta => {
            ta.addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.chainIndex);
                chain[idx].content = e.target.value;
                settings.promptMessageChain = chain;
                saveCurrentSettings();
            });
        });

        container.querySelectorAll('.ttw-chain-move-up').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.chainIndex);
                if (idx > 0) { [chain[idx], chain[idx - 1]] = [chain[idx - 1], chain[idx]]; }
                settings.promptMessageChain = chain;
                renderMessageChainUI();
                saveCurrentSettings();
            });
        });

        container.querySelectorAll('.ttw-chain-move-down').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.chainIndex);
                if (idx < chain.length - 1) { [chain[idx], chain[idx + 1]] = [chain[idx + 1], chain[idx]]; }
                settings.promptMessageChain = chain;
                renderMessageChainUI();
                saveCurrentSettings();
            });
        });

        container.querySelectorAll('.ttw-chain-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.chainIndex);
                chain.splice(idx, 1);
                settings.promptMessageChain = chain;
                renderMessageChainUI();
                saveCurrentSettings();
            });
        });
    }

    function updateSettingsUI() {
        const chunkSizeEl = document.getElementById('ttw-chunk-size');
        if (chunkSizeEl) chunkSizeEl.value = settings.chunkSize;

        const apiTimeoutEl = document.getElementById('ttw-api-timeout');
        if (apiTimeoutEl) apiTimeoutEl.value = Math.round((settings.apiTimeout || 120000) / 1000);

        const incrementalModeEl = document.getElementById('ttw-incremental-mode');
        if (incrementalModeEl) incrementalModeEl.checked = incrementalOutputMode;

        const volumeModeEl = document.getElementById('ttw-volume-mode');
        if (volumeModeEl) {
            volumeModeEl.checked = useVolumeMode;
            const indicator = document.getElementById('ttw-volume-indicator');
            if (indicator) indicator.style.display = useVolumeMode ? 'block' : 'none';
        }

        const enablePlotEl = document.getElementById('ttw-enable-plot');
        if (enablePlotEl) enablePlotEl.checked = settings.enablePlotOutline;

        const enableStyleEl = document.getElementById('ttw-enable-style');
        if (enableStyleEl) enableStyleEl.checked = settings.enableLiteraryStyle;

        const worldbookPromptEl = document.getElementById('ttw-worldbook-prompt');
        if (worldbookPromptEl) worldbookPromptEl.value = settings.customWorldbookPrompt || '';

        const plotPromptEl = document.getElementById('ttw-plot-prompt');
        if (plotPromptEl) plotPromptEl.value = settings.customPlotPrompt || '';

        const stylePromptEl = document.getElementById('ttw-style-prompt');
        if (stylePromptEl) stylePromptEl.value = settings.customStylePrompt || '';

        const parallelEnabledEl = document.getElementById('ttw-parallel-enabled');
        if (parallelEnabledEl) parallelEnabledEl.checked = parallelConfig.enabled;

        const parallelConcurrencyEl = document.getElementById('ttw-parallel-concurrency');
        if (parallelConcurrencyEl) parallelConcurrencyEl.value = parallelConfig.concurrency;

        const parallelModeEl = document.getElementById('ttw-parallel-mode');
        if (parallelModeEl) parallelModeEl.value = parallelConfig.mode;

        const useTavernApiEl = document.getElementById('ttw-use-tavern-api');
        if (useTavernApiEl) {
            useTavernApiEl.checked = settings.useTavernApi;
            handleUseTavernApiChange();
        }

        const apiProviderEl = document.getElementById('ttw-api-provider');
        if (apiProviderEl) apiProviderEl.value = settings.customApiProvider;

        const apiKeyEl = document.getElementById('ttw-api-key');
        if (apiKeyEl) apiKeyEl.value = settings.customApiKey;

        const apiEndpointEl = document.getElementById('ttw-api-endpoint');
        if (apiEndpointEl) apiEndpointEl.value = settings.customApiEndpoint;

        const apiModelEl = document.getElementById('ttw-api-model');
        if (apiModelEl) apiModelEl.value = settings.customApiModel;

        const forceChapterMarkerEl = document.getElementById('ttw-force-chapter-marker');
        if (forceChapterMarkerEl) forceChapterMarkerEl.checked = settings.forceChapterMarker;
        const suffixPromptEl = document.getElementById('ttw-suffix-prompt');
        if (suffixPromptEl) suffixPromptEl.value = settings.customSuffixPrompt || '';

        // 渲染消息链编辑器
        renderMessageChainUI();

        handleProviderChange();
        const allowRecursionEl = document.getElementById('ttw-allow-recursion');
        if (allowRecursionEl) allowRecursionEl.checked = settings.allowRecursion;

        const filterTagsEl = document.getElementById('ttw-filter-tags');
        if (filterTagsEl) filterTagsEl.value = settings.filterResponseTags || 'thinking,/think';

        const debugModeEl = document.getElementById('ttw-debug-mode');
        if (debugModeEl) {
            debugModeEl.checked = settings.debugMode || false;
            const copyBtn = document.getElementById('ttw-copy-stream');
            if (copyBtn) copyBtn.style.display = settings.debugMode ? 'inline-block' : 'none';
        }

    }

    function updateChapterRegexUI() {
        const regexInput = document.getElementById('ttw-chapter-regex');
        if (regexInput) {
            regexInput.value = chapterRegexSettings.pattern;
        }
    }

    // ========== 渲染分类列表 ==========
    function renderCategoriesList() {
        const listContainer = document.getElementById('ttw-categories-list');
        if (!listContainer) return;

        listContainer.innerHTML = '';

        customWorldbookCategories.forEach((cat, index) => {
            const hasDefault = DEFAULT_WORLDBOOK_CATEGORIES.some(c => c.name === cat.name);

            const item = document.createElement('div');
            item.className = 'ttw-category-item';
            item.innerHTML = `
                <input type="checkbox" class="ttw-category-cb" data-index="${index}" ${cat.enabled ? 'checked' : ''}>
                <span class="ttw-category-name">${cat.name}${cat.isBuiltin ? ' <span style="color:#888;font-size:10px;">(内置)</span>' : ''}</span>
                <div class="ttw-category-actions">
                    <button class="ttw-btn-tiny ttw-edit-cat" data-index="${index}" title="编辑">✏️</button>
                    <button class="ttw-btn-tiny ttw-reset-single-cat" data-index="${index}" title="重置此项" ${hasDefault ? '' : 'style="opacity:0.3;" disabled'}>🔄</button>
                    <button class="ttw-btn-tiny ttw-delete-cat" data-index="${index}" title="删除" ${cat.isBuiltin ? 'disabled style="opacity:0.3;"' : ''}>🗑️</button>
                </div>
            `;
            listContainer.appendChild(item);
        });

        listContainer.querySelectorAll('.ttw-category-cb').forEach(cb => {
            cb.addEventListener('change', async (e) => {
                const index = parseInt(e.target.dataset.index);
                customWorldbookCategories[index].enabled = e.target.checked;
                await saveCustomCategories();
            });
        });

        listContainer.querySelectorAll('.ttw-edit-cat').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                showEditCategoryModal(index);
            });
        });

        listContainer.querySelectorAll('.ttw-reset-single-cat').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const index = parseInt(e.target.dataset.index);
                const cat = customWorldbookCategories[index];
                if (confirm(`确定重置"${cat.name}"为默认配置吗？`)) {
                    await resetSingleCategory(index);
                    renderCategoriesList();
                }
            });
        });

        listContainer.querySelectorAll('.ttw-delete-cat').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const index = parseInt(e.target.dataset.index);
                const cat = customWorldbookCategories[index];
                if (cat.isBuiltin) return;
                if (confirm(`确定删除分类"${cat.name}"吗？`)) {
                    customWorldbookCategories.splice(index, 1);
                    await saveCustomCategories();
                    renderCategoriesList();
                }
            });
        });
    }

    function showAddCategoryModal() {
        showEditCategoryModal(null);
    }

    function showEditCategoryModal(editIndex) {
        const existingModal = document.getElementById('ttw-category-modal');
        if (existingModal) existingModal.remove();

        const isEdit = editIndex !== null;
        const cat = isEdit ? customWorldbookCategories[editIndex] : {
            name: '',
            enabled: true,
            isBuiltin: false,
            entryExample: '',
            keywordsExample: [],
            contentGuide: '',
            defaultPosition: 0,
            defaultDepth: 4,
            defaultOrder: 100,
            autoIncrementOrder: false
        };

        const modal = document.createElement('div');
        modal.id = 'ttw-category-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
            <div class="ttw-modal" style="max-width:550px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">${isEdit ? '✏️ 编辑分类' : '➕ 添加分类'}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:70vh;overflow-y:auto;">
                    <div class="ttw-form-group">
                        <label>分类名称 *</label>
                        <input type="text" id="ttw-cat-name" value="${cat.name}" placeholder="如：道具、玩法" class="ttw-input">
                    </div>
                    <div class="ttw-form-group">
                        <label>条目名称示例</label>
                        <input type="text" id="ttw-cat-entry-example" value="${cat.entryExample}" placeholder="如：道具名称" class="ttw-input">
                    </div>
                    <div class="ttw-form-group">
                        <label>关键词示例（逗号分隔）</label>
                        <input type="text" id="ttw-cat-keywords" value="${cat.keywordsExample.join(', ')}" placeholder="如：道具名, 别名" class="ttw-input">
                    </div>
                    <div class="ttw-form-group">
                        <label>内容提取指南</label>
                        <textarea id="ttw-cat-content-guide" rows="4" class="ttw-textarea-small" placeholder="描述AI应该提取哪些信息...">${cat.contentGuide}</textarea>
                    </div>

                    <div style="margin-top:16px;padding:12px;background:rgba(155,89,182,0.15);border:1px solid rgba(155,89,182,0.3);border-radius:8px;">
                        <div style="font-weight:bold;color:#9b59b6;margin-bottom:12px;">⚙️ 导出时的默认配置</div>
                        <div class="ttw-form-group">
                            <label>默认位置 (Position)</label>
                            <select id="ttw-cat-default-position" class="ttw-select">
                                <option value="0" ${(cat.defaultPosition || 0) === 0 ? 'selected' : ''}>在角色定义之前</option>
                                <option value="1" ${cat.defaultPosition === 1 ? 'selected' : ''}>在角色定义之后</option>
                                <option value="2" ${cat.defaultPosition === 2 ? 'selected' : ''}>在作者注释之前</option>
                                <option value="3" ${cat.defaultPosition === 3 ? 'selected' : ''}>在作者注释之后</option>
                                <option value="4" ${cat.defaultPosition === 4 ? 'selected' : ''}>自定义深度</option>
                            </select>
                        </div>
                        <div class="ttw-form-group">
                            <label>默认深度 (Depth) - 仅Position=4时有效</label>
                            <input type="number" id="ttw-cat-default-depth" class="ttw-input" value="${cat.defaultDepth || 4}" min="0" max="999">
                        </div>
                        <div class="ttw-form-group">
                            <label>默认起始顺序 (Order)</label>
                            <input type="number" id="ttw-cat-default-order" class="ttw-input" value="${cat.defaultOrder || 100}" min="0" max="9999">
                        </div>
                        <div style="margin-top:10px;">
                            <label class="ttw-checkbox-label" style="padding:8px;background:rgba(39,174,96,0.15);border-radius:6px;">
                                <input type="checkbox" id="ttw-cat-auto-increment" ${cat.autoIncrementOrder ? 'checked' : ''}>
                                <div>
                                    <span style="color:#27ae60;font-weight:bold;">📈 顺序自动递增</span>
                                    <div class="ttw-setting-hint">勾选后同分类下的条目顺序会从起始值开始递增（100,101,102...）</div>
                                </div>
                            </label>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-cancel-cat">取消</button>
                    <button class="ttw-btn ttw-btn-primary" id="ttw-save-cat">💾 保存</button>
                </div>
            </div>
        `;


        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-cat').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-save-cat').addEventListener('click', async () => {
            const name = document.getElementById('ttw-cat-name').value.trim();
            if (!name) { alert('请输入分类名称'); return; }

            const duplicateIndex = customWorldbookCategories.findIndex((c, i) => c.name === name && i !== editIndex);
            if (duplicateIndex !== -1) { alert('该分类名称已存在'); return; }

            const entryExample = document.getElementById('ttw-cat-entry-example').value.trim();
            const keywordsStr = document.getElementById('ttw-cat-keywords').value.trim();
            const contentGuide = document.getElementById('ttw-cat-content-guide').value.trim();
            const defaultPosition = parseInt(document.getElementById('ttw-cat-default-position').value) || 0;
            const defaultDepth = parseInt(document.getElementById('ttw-cat-default-depth').value) || 4;
            const defaultOrder = parseInt(document.getElementById('ttw-cat-default-order').value) || 100;
            const autoIncrementOrder = document.getElementById('ttw-cat-auto-increment').checked;

            const keywordsExample = keywordsStr ? keywordsStr.split(/[,，]/).map(k => k.trim()).filter(k => k) : [];

            const newCat = {
                name,
                enabled: isEdit ? cat.enabled : true,
                isBuiltin: isEdit ? cat.isBuiltin : false,
                entryExample: entryExample || name + '名称',
                keywordsExample: keywordsExample.length > 0 ? keywordsExample : [name + '名'],
                contentGuide: contentGuide || `基于原文的${name}描述`,
                defaultPosition,
                defaultDepth,
                defaultOrder,
                autoIncrementOrder
            };

            if (isEdit) {
                customWorldbookCategories[editIndex] = newCat;
            } else {
                customWorldbookCategories.push(newCat);
            }

            // 同步更新 categoryDefaultConfig
            setCategoryDefaultConfig(name, {
                position: defaultPosition,
                depth: defaultDepth,
                order: defaultOrder,
                autoIncrementOrder
            });

            await saveCustomCategories();
            renderCategoriesList();
            modal.remove();
        });

    }

    // ========== 新增：默认世界书条目UI ==========
    function renderDefaultWorldbookEntriesUI() {
        const container = document.getElementById('ttw-default-entries-list');
        if (!container) return;

        container.innerHTML = '';

        if (defaultWorldbookEntriesUI.length === 0) {
            container.innerHTML = '<div style="text-align:center;color:#888;padding:10px;font-size:11px;">暂无默认条目，点击"添加"按钮创建</div>';
            return;
        }

        defaultWorldbookEntriesUI.forEach((entry, index) => {
            const item = document.createElement('div');
            item.className = 'ttw-default-entry-item';
            item.innerHTML = `
                <div class="ttw-default-entry-header">
                    <span class="ttw-default-entry-title">[${entry.category || '未分类'}] ${entry.name || '未命名'}</span>
                    <div class="ttw-default-entry-actions">
                        <button class="ttw-btn-tiny ttw-edit-default-entry" data-index="${index}" title="编辑">✏️</button>
                        <button class="ttw-btn-tiny ttw-delete-default-entry" data-index="${index}" title="删除">🗑️</button>
                    </div>
                </div>
                <div class="ttw-default-entry-info">
                    <span style="color:#9b59b6;">关键词:</span> ${(entry.keywords || []).join(', ') || '无'}
                </div>
            `;
            container.appendChild(item);
        });

        container.querySelectorAll('.ttw-edit-default-entry').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                showEditDefaultEntryModal(index);
            });
        });

        container.querySelectorAll('.ttw-delete-default-entry').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                if (confirm(`确定删除此默认条目吗？`)) {
                    defaultWorldbookEntriesUI.splice(index, 1);
                    saveDefaultWorldbookEntriesUI();
                    renderDefaultWorldbookEntriesUI();
                }
            });
        });
    }

    function showAddDefaultEntryModal() {
        showEditDefaultEntryModal(null);
    }

    function showEditDefaultEntryModal(editIndex) {
        const existingModal = document.getElementById('ttw-default-entry-modal');
        if (existingModal) existingModal.remove();

        const isEdit = editIndex !== null;
        const entry = isEdit ? defaultWorldbookEntriesUI[editIndex] : {
            category: '',
            name: '',
            keywords: [],
            content: '',
            position: 0,
            depth: 4,
            order: 100
        };

        const modal = document.createElement('div');
        modal.id = 'ttw-default-entry-modal';
        modal.className = 'ttw-modal-container';
        modal.innerHTML = `
        <div class="ttw-modal" style="max-width:550px;">
            <div class="ttw-modal-header">
                <span class="ttw-modal-title">${isEdit ? '✏️ 编辑默认条目' : '➕ 添加默认条目'}</span>
                <button class="ttw-modal-close" type="button">✕</button>
            </div>
            <div class="ttw-modal-body">
                <div class="ttw-form-group">
                    <label>分类 *</label>
                    <input type="text" id="ttw-default-entry-category" value="${entry.category}" placeholder="如：角色、地点、系统" class="ttw-input">
                </div>
                <div class="ttw-form-group">
                    <label>条目名称 *</label>
                    <input type="text" id="ttw-default-entry-name" value="${entry.name}" placeholder="条目名称" class="ttw-input">
                </div>
                <div class="ttw-form-group">
                    <label>关键词（逗号分隔）</label>
                    <input type="text" id="ttw-default-entry-keywords" value="${(entry.keywords || []).join(', ')}" placeholder="关键词1, 关键词2" class="ttw-input">
                </div>
                <div class="ttw-form-group">
                    <label>内容</label>
                    <textarea id="ttw-default-entry-content" rows="6" class="ttw-textarea-small" placeholder="条目内容...">${entry.content || ''}</textarea>
                </div>
                <div class="ttw-form-group">
                    <label>位置</label>
                    <select id="ttw-default-entry-position" class="ttw-select">
                        <option value="0" ${(entry.position || 0) === 0 ? 'selected' : ''}>在角色定义之前</option>
                        <option value="1" ${entry.position === 1 ? 'selected' : ''}>在角色定义之后</option>
                        <option value="2" ${entry.position === 2 ? 'selected' : ''}>在作者注释之前</option>
                        <option value="3" ${entry.position === 3 ? 'selected' : ''}>在作者注释之后</option>
                        <option value="4" ${entry.position === 4 ? 'selected' : ''}>自定义深度</option>
                    </select>
                </div>
                <div class="ttw-form-group">
                    <label>深度（仅位置为"自定义深度"时有效）</label>
                    <input type="number" id="ttw-default-entry-depth" class="ttw-input" value="${entry.depth || 4}" min="0" max="999">
                </div>
                <div class="ttw-form-group">
                    <label>顺序（数字越小越靠前）</label>
                    <input type="number" id="ttw-default-entry-order" class="ttw-input" value="${entry.order || 100}" min="0" max="9999">
                </div>
            </div>
            <div class="ttw-modal-footer">
                <button class="ttw-btn" id="ttw-cancel-default-entry">取消</button>
                <button class="ttw-btn ttw-btn-primary" id="ttw-save-default-entry">💾 保存</button>
            </div>
        </div>
    `;

        document.body.appendChild(modal);

        modal.querySelector('.ttw-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#ttw-cancel-default-entry').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#ttw-save-default-entry').addEventListener('click', () => {
            const category = document.getElementById('ttw-default-entry-category').value.trim();
            const name = document.getElementById('ttw-default-entry-name').value.trim();
            const keywordsStr = document.getElementById('ttw-default-entry-keywords').value.trim();
            const content = document.getElementById('ttw-default-entry-content').value;
            const position = parseInt(document.getElementById('ttw-default-entry-position').value) || 0;
            const depth = parseInt(document.getElementById('ttw-default-entry-depth').value) || 4;
            const order = parseInt(document.getElementById('ttw-default-entry-order').value) || 100;

            if (!category) { alert('请输入分类'); return; }
            if (!name) { alert('请输入条目名称'); return; }

            const keywords = keywordsStr ? keywordsStr.split(/[,，]/).map(k => k.trim()).filter(k => k) : [];

            const newEntry = { category, name, keywords, content, position, depth, order };

            if (isEdit) {
                defaultWorldbookEntriesUI[editIndex] = newEntry;
            } else {
                defaultWorldbookEntriesUI.push(newEntry);
            }

            saveDefaultWorldbookEntriesUI();
            renderDefaultWorldbookEntriesUI();
            modal.remove();
        });
    }


    function saveDefaultWorldbookEntriesUI() {
        settings.defaultWorldbookEntriesUI = defaultWorldbookEntriesUI;
        saveCurrentSettings();
    }

    // ========== 章回检测功能 ==========
    function detectChaptersWithRegex(content, regexPattern) {
        try {
            const regex = new RegExp(regexPattern, 'g');
            const matches = [...content.matchAll(regex)];
            return matches;
        } catch (e) {
            console.error('正则表达式错误:', e);
            return [];
        }
    }

    function testChapterRegex() {
        if (!currentFile && memoryQueue.length === 0) {
            alert('请先上传文件');
            return;
        }

        const regexInput = document.getElementById('ttw-chapter-regex');
        const pattern = regexInput?.value || chapterRegexSettings.pattern;

        const content = memoryQueue.length > 0 ? memoryQueue.map(m => m.content).join('') : '';
        if (!content) {
            alert('请先上传并加载文件');
            return;
        }

        const matches = detectChaptersWithRegex(content, pattern);

        if (matches.length === 0) {
            alert(`未检测到章节！\n\n当前正则: ${pattern}\n\n建议:\n1. 尝试使用快速选择按钮\n2. 检查正则表达式是否正确`);
        } else {
            const previewChapters = matches.slice(0, 10).map(m => m[0]).join('\n');
            alert(`检测到 ${matches.length} 个章节\n\n前10个章节:\n${previewChapters}${matches.length > 10 ? '\n...' : ''}`);
        }
    }

    function rechunkMemories() {
        if (memoryQueue.length === 0) {
            alert('没有可重新分块的内容');
            return;
        }

        const processedCount = memoryQueue.filter(m => m.processed && !m.failed).length;

        if (processedCount > 0) {
            const confirmMsg = `⚠️ 警告：当前有 ${processedCount} 个已处理的章节。\n\n重新分块将会：\n1. 清除所有已处理状态\n2. 需要重新从头开始转换\n3. 但不会清除已生成的世界书数据\n\n确定要重新分块吗？`;
            if (!confirm(confirmMsg)) return;
        }

        const allContent = memoryQueue.map(m => m.content).join('');

        splitContentIntoMemory(allContent);

        startFromIndex = 0;
        userSelectedStartIndex = null;

        updateMemoryQueueUI();
        updateStartButtonState(false);

        alert(`重新分块完成！\n当前共 ${memoryQueue.length} 个章节`);
    }

    // ========== 帮助弹窗 ==========
    function showHelpModal() {
        const existingHelp = document.getElementById('ttw-help-modal');
        if (existingHelp) existingHelp.remove();

        const helpModal = document.createElement('div');
        helpModal.id = 'ttw-help-modal';
        helpModal.className = 'ttw-modal-container';
        helpModal.innerHTML = `
        <div class="ttw-modal" style="max-width:700px;">
            <div class="ttw-modal-header">
                <span class="ttw-modal-title">❓ TXT转世界书 v3.2.0 帮助</span>
                <button class="ttw-modal-close" type="button">✕</button>
            </div>
            <div class="ttw-modal-body" style="max-height:75vh;overflow-y:auto;">

                <div style="margin-bottom:16px;">
                    <h4 style="color:#e67e22;margin:0 0 10px;">📌 基本功能</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>将TXT小说转换为SillyTavern世界书格式</li>
                        <li>自动检测文件编码（UTF-8/GBK/GB2312/GB18030/Big5）</li>
                        <li>基于正则的<strong>章回自动检测</strong>和智能分块（支持自定义正则、快速预设、重新分块）</li>
                        <li>支持<strong>并行/串行</strong>处理，并行支持独立模式和分批模式，可配置并发数</li>
                        <li><strong>增量输出</strong>：只输出变更条目，减少重复</li>
                        <li><strong>分卷模式</strong>：上下文超限时自动分卷</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#3498db;margin:0 0 10px;">🔧 API模式</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li><strong>酒馆API</strong>：使用SillyTavern当前连接的AI（注意：消息角色会被酒馆后处理覆盖，且可能注入预设JB内容）</li>
                        <li><strong>自定义API</strong>：直连API，消息链角色设置完全生效，不受酒馆干预</li>
                        <li>支持 <strong>Gemini / Gemini代理 / DeepSeek / OpenAI兼容</strong> 多种直连和代理模式</li>
                        <li>支持<strong>拉取模型列表</strong>、<strong>快速测试连接</strong>、<strong>自动限流重试</strong></li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#9b59b6;margin:0 0 10px;">🏷️ 自定义提取分类</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>内置分类：<strong>角色、地点、组织</strong>；预设分类：<strong>道具、玩法、章节剧情、角色内心</strong></li>
                        <li>支持添加/编辑/删除自定义分类，每个分类可配置名称、条目示例、关键词示例、内容提取指南</li>
                        <li>每个分类可配置<strong>默认导出位置/深度/顺序/自动递增</strong></li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#27ae60;margin:0 0 10px;">📝 提示词系统</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li><strong>世界书词条提示词</strong>（核心，含 <code>{DYNAMIC_JSON_TEMPLATE}</code> 占位符）</li>
                        <li>可选：<strong>剧情大纲</strong>、<strong>文风配置</strong>、<strong>后缀提示词</strong></li>
                        <li><strong>💬消息链配置</strong>：将提示词按对话补全预设格式发送，每条消息可指定角色（🔷系统/🟢用户/🟡AI助手）</li>
                        <li>消息链中使用 <code>{PROMPT}</code> 占位符代表实际组装好的提示词内容</li>
                        <li>酒馆API优先使用 <code>generateRaw</code> 消息数组格式（ST 1.13.2+），自动兼容旧版</li>
                        <li>所有提示词支持恢复默认和预览，支持<strong>导出/导入配置</strong></li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#e67e22;margin:0 0 10px;">📚 默认世界书条目</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>可视化添加/编辑/删除默认条目，每个条目可配置分类、名称、关键词、内容、位置/深度/顺序</li>
                        <li>转换时<strong>自动添加</strong>到世界书，也可<strong>立即应用</strong>到当前世界书</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#1abc9c;margin:0 0 10px;">📋 章节管理</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>点击章节查看/编辑原文，支持复制、合并（⬆️⬇️）、删除、多选批量删除</li>
                        <li><strong>📍选择起始</strong>：从任意章节开始处理</li>
                        <li><strong>📊已处理</strong>：左右分栏查看各章节处理结果</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#e74c3c;margin:0 0 10px;">🎲 处理控制与重Roll</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li><strong>⏸️暂停/继续</strong>、<strong>🔧修复失败</strong>（自动重试，Token超限自动分裂）</li>
                        <li><strong>🎲重Roll章节</strong> / <strong>🎯单独重Roll条目</strong>（支持多选来源、并发、自定义提示词）</li>
                        <li><strong>🎲批量重Roll</strong>：一次选择多个条目重Roll，显示Token数</li>
                        <li><strong>Roll历史</strong>：每个条目独立历史记录，可选择任意版本、在线编辑JSON、粘贴导入</li>
                        <li>当前处理结果支持<strong>直接编辑</strong>并保存</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#2ecc71;margin:0 0 10px;">🧹 世界书工具</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li><strong>🔍查找</strong>：搜索关键词高亮定位</li>
                        <li><strong>🔄替换</strong>：批量查找替换内容</li>
                        <li><strong>🏷️清除标签</strong>：清理AI输出的thinking等无用标签</li>
                        <li><strong>🧹整理条目</strong>：AI优化指定分类的条目内容，支持多预设提示词（按分类指定不同预设）</li>
                        <li><strong>🔗别名合并</strong>：AI识别同一事物的不同名称并自动合并</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#9b59b6;margin:0 0 10px;">⚙️ 导出配置</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li><strong>🔵蓝灯/🟢绿灯</strong>：蓝灯=常驻（constant）/ 绿灯=触发式（selective）</li>
                        <li>条目位置/深度/顺序可按分类默认配置或单个条目覆盖</li>
                        <li>支持<strong>📈顺序自动递增</strong>和<strong>🔄允许条目递归</strong></li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#f1c40f;margin:0 0 10px;">🔢 Token计数</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>每个条目/分类/全局显示Token数，支持<strong>阈值高亮</strong>快速发现截断条目</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#95a5a6;margin:0 0 10px;">📜 修改历史</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>自动记录变更，左右分栏查看，支持<strong>⏪回退到任意版本</strong>，数据存IndexedDB不丢失</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#e74c3c;margin:0 0 10px;">📥 导入合并世界书</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li>支持SillyTavern格式和内部JSON格式，自动检测重复</li>
                        <li>重复处理：<strong>AI智能合并</strong> / 覆盖 / 保留 / 重命名 / 内容叠加</li>
                    </ul>
                </div>

                <div style="margin-bottom:16px;">
                    <h4 style="color:#e67e22;margin:0 0 10px;">💾 导入导出</h4>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
                        <li><strong>导出JSON / SillyTavern格式</strong>，支持分卷导出</li>
                        <li><strong>导出/导入任务</strong>：保存完整进度，支持换设备继续</li>
                        <li><strong>导出/导入配置</strong>：保存提示词、分类、默认条目等所有设置</li>
                    </ul>
                </div>

                <div style="padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
                    <div style="font-weight:bold;color:#3498db;margin-bottom:8px;">💡 使用技巧</div>
                    <ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;font-size:12px;">
                        <li>长篇小说建议开启<strong>并行模式</strong>（独立模式最快）</li>
                        <li>遇到乱码？<strong>🔍查找</strong>定位 → <strong>🎲批量重Roll</strong>修复</li>
                        <li>某条目不满意？点<strong>🎯</strong>单独重Roll，可添加提示词指导</li>
                        <li>AI输出thinking标签？<strong>🏷️清除标签</strong>一键清理</li>
                        <li>消息链角色不生效？切换<strong>自定义API模式</strong>（酒馆API会覆盖角色设置）</li>
                        <li>同一事物多个名字？<strong>🔗别名合并</strong>自动识别</li>
                        <li>担心进度丢失？随时<strong>📤导出任务</strong>保存</li>
                        <li>导出时控制位置？点分类或条目旁的<strong>⚙️</strong>按钮配置</li>
                        <li>主UI只能通过右上角<strong>✕按钮</strong>关闭，防止误触退出</li>
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
        helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.remove(); });
    }



    // ========== 选择起始记忆 ==========
    function showStartFromSelector() {
        if (memoryQueue.length === 0) { alert('请先上传文件'); return; }

        const existingModal = document.getElementById('ttw-start-selector-modal');
        if (existingModal) existingModal.remove();

        let optionsHtml = '';
        memoryQueue.forEach((memory, index) => {
            const status = memory.processed ? (memory.failed ? '❗' : '✅') : '⏳';
            const currentSelected = userSelectedStartIndex !== null ? userSelectedStartIndex : startFromIndex;
            optionsHtml += `<option value="${index}" ${index === currentSelected ? 'selected' : ''}>${status} 第${index + 1}章 - ${memory.title} (${memory.content.length.toLocaleString()}字)</option>`;
        });

        const selectorModal = document.createElement('div');
        selectorModal.id = 'ttw-start-selector-modal';
        selectorModal.className = 'ttw-modal-container';
        selectorModal.innerHTML = `
            <div class="ttw-modal" style="max-width:500px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📍 选择起始位置</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="margin-bottom:16px;">
                        <label style="display:block;margin-bottom:8px;font-size:13px;">从哪一章开始：</label>
                        <select id="ttw-start-from-select" class="ttw-select">${optionsHtml}</select>
                    </div>
                    <div style="padding:12px;background:rgba(230,126,34,0.1);border-radius:6px;font-size:12px;color:#f39c12;">⚠️ 从中间开始时，之前的世界书数据不会自动加载。</div>
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
            const startBtn = document.getElementById('ttw-start-btn');
            if (startBtn) startBtn.textContent = `▶️ 从第${selectedIndex + 1}章开始`;
            selectorModal.remove();
        });
        selectorModal.addEventListener('click', (e) => { if (e.target === selectorModal) selectorModal.remove(); });
    }

    // ========== 查看/编辑记忆内容 ==========
    function showMemoryContentModal(index) {
        const memory = memoryQueue[index];
        if (!memory) return;

        const existingModal = document.getElementById('ttw-memory-content-modal');
        if (existingModal) existingModal.remove();

        const statusText = memory.processing ? '🔄 处理中' : (memory.processed ? (memory.failed ? '❗ 失败' : '✅ 完成') : '⏳ 等待');
        const statusColor = memory.processing ? '#3498db' : (memory.processed ? (memory.failed ? '#e74c3c' : '#27ae60') : '#f39c12');

        let resultHtml = '';
        if (memory.processed && memory.result && !memory.failed) {
            resultHtml = `
                <div style="margin-top:16px;">
                    <h4 style="color:#9b59b6;margin:0 0 10px;">📊 处理结果</h4>
                    <pre style="max-height:150px;overflow-y:auto;background:rgba(0,0,0,0.3);padding:12px;border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-all;">${JSON.stringify(memory.result, null, 2)}</pre>
                </div>
            `;
        }

        const contentModal = document.createElement('div');
        contentModal.id = 'ttw-memory-content-modal';
        contentModal.className = 'ttw-modal-container';
        contentModal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📄 ${memory.title} (第${index + 1}章)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height:75vh;overflow-y:auto;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;">
                        <div>
                            <span style="color:${statusColor};font-weight:bold;">${statusText}</span>
                            <span style="margin-left:16px;color:#888;">字数: <span id="ttw-char-count">${memory.content.length.toLocaleString()}</span></span>
                        </div>
                        <div style="display:flex;gap:8px;">
                            <button id="ttw-copy-memory-content" class="ttw-btn ttw-btn-small">📋 复制</button>
                            <button id="ttw-roll-history-btn" class="ttw-btn ttw-btn-small" style="background:rgba(155,89,182,0.3);">🎲 Roll历史</button>
                            <button id="ttw-delete-memory-btn" class="ttw-btn ttw-btn-warning ttw-btn-small">🗑️ 删除</button>
                        </div>
                    </div>
                    ${memory.failedError ? `<div style="margin-bottom:16px;padding:10px;background:rgba(231,76,60,0.2);border-radius:6px;color:#e74c3c;font-size:12px;">❌ ${memory.failedError}</div>` : ''}
                    <div>
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                            <h4 style="color:#3498db;margin:0;">📝 原文内容 <span style="font-size:12px;font-weight:normal;color:#888;">(可编辑)</span></h4>
                            <div style="display:flex;gap:8px;">
                                <button id="ttw-append-to-prev" class="ttw-btn ttw-btn-small" ${index === 0 ? 'disabled style="opacity:0.5;"' : ''} title="追加到上一章末尾，并删除当前章">⬆️ 合并到上一章</button>
                                <button id="ttw-append-to-next" class="ttw-btn ttw-btn-small" ${index === memoryQueue.length - 1 ? 'disabled style="opacity:0.5;"' : ''} title="追加到下一章开头，并删除当前章">⬇️ 合并到下一章</button>
                            </div>
                        </div>
                        <textarea id="ttw-memory-content-editor" class="ttw-textarea">${memory.content.replace(/</g, '<').replace(/>/g, '>')}</textarea>
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
            if (confirm(`将当前内容合并到 "${prevMemory.title}" 的末尾？\n\n⚠️ 合并后当前章将被删除！`)) {
                prevMemory.content += '\n\n' + editor.value;
                prevMemory.processed = false;
                prevMemory.failed = false;
                prevMemory.result = null;
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
                contentModal.remove();
                alert(`已合并到 "${prevMemory.title}"，当前章已删除`);
            }
        });

        contentModal.querySelector('#ttw-append-to-next').addEventListener('click', () => {
            if (index === memoryQueue.length - 1) return;
            const nextMemory = memoryQueue[index + 1];
            if (confirm(`将当前内容合并到 "${nextMemory.title}" 的开头？\n\n⚠️ 合并后当前章将被删除！`)) {
                nextMemory.content = editor.value + '\n\n' + nextMemory.content;
                nextMemory.processed = false;
                nextMemory.failed = false;
                nextMemory.result = null;
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
                contentModal.remove();
                alert(`已合并到 "${nextMemory.title}"，当前章已删除`);
            }
        });
    }

    // ========== 查看已处理结果 ==========
    function showProcessedResults() {
        const processedMemories = memoryQueue.filter(m => m.processed && !m.failed && m.result);
        if (processedMemories.length === 0) { alert('暂无已处理的结果'); return; }

        const existingModal = document.getElementById('ttw-processed-results-modal');
        if (existingModal) existingModal.remove();

        let listHtml = '';
        processedMemories.forEach((memory) => {
            const realIndex = memoryQueue.indexOf(memory);
            const entryCount = memory.result ? Object.keys(memory.result).reduce((sum, cat) => sum + (typeof memory.result[cat] === 'object' ? Object.keys(memory.result[cat]).length : 0), 0) : 0;
            listHtml += `
                <div class="ttw-processed-item" data-index="${realIndex}" style="padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:4px;cursor:pointer;border-left:2px solid #27ae60;">
                    <div style="font-size:11px;font-weight:bold;color:#27ae60;">✅ 第${realIndex + 1}章</div>
                    <div style="font-size:9px;color:#888;">${entryCount}条 | ${(memory.content.length / 1000).toFixed(1)}k字</div>
                </div>
            `;
        });

        const resultsModal = document.createElement('div');
        resultsModal.id = 'ttw-processed-results-modal';
        resultsModal.className = 'ttw-modal-container';
        resultsModal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📊 已处理结果 (${processedMemories.length}/${memoryQueue.length})</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div class="ttw-processed-results-container" style="display:flex;gap:10px;height:450px;">
                        <div class="ttw-processed-results-left" style="width:100px;min-width:100px;max-width:100px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:8px;padding:8px;">${listHtml}</div>
                        <div id="ttw-result-detail" style="flex:1;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:8px;padding:15px;">
                            <div style="text-align:center;color:#888;padding:40px;font-size:12px;">👈 点击左侧章节查看结果</div>
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
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                            <h4 style="color:#27ae60;margin:0;font-size:14px;">第${index + 1}章 - ${memory.title}</h4>
                            <button class="ttw-btn ttw-btn-small" id="ttw-copy-result">📋 复制</button>
                        </div>
                        <pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;">${JSON.stringify(memory.result, null, 2)}</pre>
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

    // ========== UI ==========
    let modalContainer = null;

    function handleUseTavernApiChange() {
        const useTavernApi = document.getElementById('ttw-use-tavern-api')?.checked ?? true;
        const customApiSection = document.getElementById('ttw-custom-api-section');
        if (customApiSection) {
            customApiSection.style.display = useTavernApi ? 'none' : 'block';
        }
        settings.useTavernApi = useTavernApi;
        // 显示/隐藏消息链酒馆API警告
        const chainWarning = document.getElementById('ttw-chain-tavern-warning');
        if (chainWarning) {
            const chain = settings.promptMessageChain || [];
            const hasNonUserRole = chain.some(m => m.enabled !== false && m.role !== 'user');
            chainWarning.style.display = (useTavernApi && hasNonUserRole) ? 'block' : 'none';
        }
    }

    function handleProviderChange() {
        const provider = document.getElementById('ttw-api-provider')?.value || 'gemini';
        const endpointContainer = document.getElementById('ttw-endpoint-container');
        const modelActionsContainer = document.getElementById('ttw-model-actions');
        const modelSelectContainer = document.getElementById('ttw-model-select-container');
        const modelInputContainer = document.getElementById('ttw-model-input-container');

        if (provider === 'gemini-proxy' || provider === 'openai-compatible') {
            if (endpointContainer) endpointContainer.style.display = 'block';
        } else {
            if (endpointContainer) endpointContainer.style.display = 'none';
        }

        if (provider === 'openai-compatible') {
            if (modelActionsContainer) modelActionsContainer.style.display = 'flex';
            if (modelInputContainer) modelInputContainer.style.display = 'block';
            if (modelSelectContainer) modelSelectContainer.style.display = 'none';
        } else {
            if (modelActionsContainer) modelActionsContainer.style.display = 'none';
            if (modelSelectContainer) modelSelectContainer.style.display = 'none';
            if (modelInputContainer) modelInputContainer.style.display = 'block';
        }

        updateModelStatus('', '');
    }

    function updateModelStatus(text, type) {
        const statusEl = document.getElementById('ttw-model-status');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'ttw-model-status';
        if (type) {
            statusEl.classList.add(type);
        }
    }

    async function handleFetchModels() {
        const fetchBtn = document.getElementById('ttw-fetch-models');
        const modelSelect = document.getElementById('ttw-model-select');
        const modelSelectContainer = document.getElementById('ttw-model-select-container');
        const modelInputContainer = document.getElementById('ttw-model-input-container');

        saveCurrentSettings();

        if (fetchBtn) {
            fetchBtn.disabled = true;
            fetchBtn.textContent = '⏳ 拉取中...';
        }
        updateModelStatus('正在拉取模型列表...', 'loading');

        try {
            const models = await fetchModelList();

            if (models.length === 0) {
                updateModelStatus('❌ 未拉取到模型', 'error');
                if (modelInputContainer) modelInputContainer.style.display = 'block';
                if (modelSelectContainer) modelSelectContainer.style.display = 'none';
                return;
            }

            if (modelSelect) {
                modelSelect.innerHTML = '<option value="">-- 请选择模型 --</option>';
                models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    modelSelect.appendChild(option);
                });
            }

            if (modelInputContainer) modelInputContainer.style.display = 'none';
            if (modelSelectContainer) modelSelectContainer.style.display = 'block';

            const currentModel = document.getElementById('ttw-api-model')?.value;
            if (models.includes(currentModel)) {
                if (modelSelect) modelSelect.value = currentModel;
            } else if (models.length > 0) {
                if (modelSelect) modelSelect.value = models[0];
                const modelInput = document.getElementById('ttw-api-model');
                if (modelInput) modelInput.value = models[0];
                saveCurrentSettings();
            }

            updateModelStatus(`✅ 找到 ${models.length} 个模型`, 'success');

        } catch (error) {
            console.error('拉取模型列表失败:', error);
            updateModelStatus(`❌ ${error.message}`, 'error');
            if (modelInputContainer) modelInputContainer.style.display = 'block';
            if (modelSelectContainer) modelSelectContainer.style.display = 'none';
        } finally {
            if (fetchBtn) {
                fetchBtn.disabled = false;
                fetchBtn.textContent = '🔄 拉取模型';
            }
        }
    }

    async function handleQuickTest() {
        const testBtn = document.getElementById('ttw-quick-test');

        saveCurrentSettings();

        if (testBtn) {
            testBtn.disabled = true;
            testBtn.textContent = '⏳ 测试中...';
        }
        updateModelStatus('正在测试连接...', 'loading');

        try {
            const result = await quickTestModel();
            updateModelStatus(`✅ 测试成功 (${result.elapsed}ms)`, 'success');
            if (result.response) {
                console.log('快速测试响应:', result.response);
            }
        } catch (error) {
            console.error('快速测试失败:', error);
            updateModelStatus(`❌ ${error.message}`, 'error');
        } finally {
            if (testBtn) {
                testBtn.disabled = false;
                testBtn.textContent = '⚡ 快速测试';
            }
        }
    }

    function createModal() {
        if (modalContainer) modalContainer.remove();

        modalContainer = document.createElement('div');
        modalContainer.id = 'txt-to-worldbook-modal';
        modalContainer.className = 'ttw-modal-container';
        modalContainer.innerHTML = `
            <div class="ttw-modal">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📚 TXT转世界书 v3.2.0 </span>
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
                            <!-- API 模式选择 -->
                            <div class="ttw-setting-card ttw-setting-card-green">
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-use-tavern-api" checked>
                                    <div>
                                        <span style="font-weight:bold;color:#27ae60;">🍺 使用酒馆API</span>
                                        <div class="ttw-setting-hint">勾选后使用酒馆当前连接的AI，不勾选则使用下方自定义API</div>
                                    </div>
                                </label>
                            </div>

                            <!-- 自定义API配置区域 -->
                            <div id="ttw-custom-api-section" style="display:none;margin-bottom:16px;padding:12px;border:1px solid rgba(52,152,219,0.3);border-radius:8px;background:rgba(52,152,219,0.1);">
                                <div style="font-weight:bold;color:#3498db;margin-bottom:12px;">🔧 自定义API配置</div>
                                <div class="ttw-setting-item">
                                    <label>API提供商</label>
                                    <select id="ttw-api-provider">
                                        <option value="gemini">Gemini</option>
                                        <option value="gemini-proxy">Gemini代理</option>
                                        <option value="deepseek">DeepSeek</option>
                                        <option value="openai-compatible">OpenAI兼容</option>
                                    </select>
                                </div>
                                <div class="ttw-setting-item">
                                    <label>API Key <span style="opacity:0.6;font-size:11px;">(本地模型可留空)</span></label>
                                    <input type="password" id="ttw-api-key" placeholder="输入API Key">
                                </div>
                                <div class="ttw-setting-item" id="ttw-endpoint-container" style="display:none;">
                                    <label>API Endpoint</label>
                                    <input type="text" id="ttw-api-endpoint" placeholder="https://... 或 http://127.0.0.1:5000/v1">
                                </div>
                                <div class="ttw-setting-item" id="ttw-model-input-container">
                                    <label>模型</label>
                                    <input type="text" id="ttw-api-model" value="gemini-2.5-flash" placeholder="模型名称">
                                </div>
                                <div class="ttw-setting-item" id="ttw-model-select-container" style="display:none;">
                                    <label>模型</label>
                                    <select id="ttw-model-select">
                                        <option value="">-- 请先拉取模型列表 --</option>
                                    </select>
                                </div>
                                <div class="ttw-model-actions" id="ttw-model-actions" style="display:none;">
                                    <button id="ttw-fetch-models" class="ttw-btn ttw-btn-small">🔄 拉取模型</button>
                                    <button id="ttw-quick-test" class="ttw-btn ttw-btn-small">⚡ 快速测试</button>
                                    <span id="ttw-model-status" class="ttw-model-status"></span>
                                </div>
                            </div>

                            <div class="ttw-setting-card ttw-setting-card-blue">
                                <div style="font-weight:bold;color:#3498db;margin-bottom:10px;">🚀 并行处理</div>
                                <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
                                    <label class="ttw-checkbox-label">
                                        <input type="checkbox" id="ttw-parallel-enabled" checked>
                                        <span>启用</span>
                                    </label>
                                    <label style="font-size:12px;display:flex;align-items:center;gap:6px;">
                                        并发数
                                        <input type="number" id="ttw-parallel-concurrency" value="3" min="1" max="10" class="ttw-input-small">
                                    </label>
                                </div>
                                <div style="margin-top:10px;">
                                    <select id="ttw-parallel-mode" class="ttw-select">
                                        <option value="independent">🚀 独立模式 - 最快，每章独立提取后合并</option>
                                        <option value="batch">📦 分批模式 - 批次间累积上下文，更连贯</option>
                                    </select>
                                </div>
                            </div>

                            <!-- 章回正则设置 -->
                            <div class="ttw-setting-card" style="background:rgba(230,126,34,0.1);border:1px solid rgba(230,126,34,0.3);">
                                <div style="font-weight:bold;color:#e67e22;margin-bottom:10px;">📖 章回正则设置</div>
                                <div class="ttw-setting-hint" style="margin-bottom:8px;">自定义章节检测正则表达式</div>
                                <input type="text" id="ttw-chapter-regex" class="ttw-input" value="第[零一二三四五六七八九十百千万0-9]+[章回卷节部篇]" style="margin-bottom:8px;">
                                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                                    <button class="ttw-btn ttw-btn-small ttw-chapter-preset" data-regex="第[零一二三四五六七八九十百千万0-9]+[章回卷节部篇]">中文通用</button>
                                    <button class="ttw-btn ttw-btn-small ttw-chapter-preset" data-regex="Chapter\\s*\\d+">英文Chapter</button>
                                    <button class="ttw-btn ttw-btn-small ttw-chapter-preset" data-regex="第\\d+章">数字章节</button>
                                    <button id="ttw-test-chapter-regex" class="ttw-btn ttw-btn-small" style="background:#e67e22;">🔍 检测</button>
                                </div>
                            </div>

                            <div style="display:flex;gap:12px;margin-bottom:12px;align-items:flex-end;">
                                <div style="flex:1;">
                                    <label class="ttw-label">每块字数</label>
                                    <input type="number" id="ttw-chunk-size" value="15000" min="1000" max="500000" class="ttw-input">
                                </div>
                                <div style="flex:1;">
                                    <label class="ttw-label">API超时(秒)</label>
                                    <input type="number" id="ttw-api-timeout" value="120" min="30" max="600" class="ttw-input">
                                </div>
                                <div>
                                    <button id="ttw-rechunk-btn" class="ttw-btn ttw-btn-small" style="background:rgba(230,126,34,0.5);" title="修改字数后点击重新分块">🔄 重新分块</button>
                                </div>
                            </div>
                            <div style="display:flex;flex-direction:column;gap:8px;">
                                <label class="ttw-checkbox-label ttw-checkbox-with-hint">
                                    <input type="checkbox" id="ttw-incremental-mode" checked>
                                    <div>
                                        <span>📝 增量输出模式</span>
                                        <div class="ttw-setting-hint">只输出变更的条目，减少重复内容</div>
                                    </div>
                                </label>
                                <label class="ttw-checkbox-label ttw-checkbox-with-hint ttw-checkbox-purple">
                                    <input type="checkbox" id="ttw-volume-mode">
                                    <div>
                                        <span>📦 分卷模式</span>
                                        <div class="ttw-setting-hint">上下文超限时自动分卷，避免记忆分裂</div>
                                    </div>
                                </label>
                                <label class="ttw-checkbox-label ttw-checkbox-with-hint" style="background:rgba(230,126,34,0.15);border:1px solid rgba(230,126,34,0.3);">
                                    <input type="checkbox" id="ttw-force-chapter-marker" checked>
                                    <div>
                                        <span style="color:#e67e22;">📌 强制记忆为章节</span>
                                        <div class="ttw-setting-hint">开启后会在提示词中强制AI将每个记忆块视为对应章节</div>
                                    </div>
                                </label>

                                <label class="ttw-checkbox-label ttw-checkbox-with-hint" style="background:rgba(52,152,219,0.15);border:1px solid rgba(52,152,219,0.3);">
    <input type="checkbox" id="ttw-allow-recursion">
    <div>
        <span style="color:#3498db;">🔄 允许条目递归</span>
        <div class="ttw-setting-hint">勾选后条目可被其他条目激活，并可触发进一步递归</div>
    </div>
</label>

                                <!-- 响应过滤标签配置 -->
                                <div style="margin-top:12px;padding:10px;background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.3);border-radius:6px;">
                                    <div style="font-weight:bold;color:#e74c3c;margin-bottom:6px;font-size:12px;">🧹 响应过滤标签</div>
                                    <div class="ttw-setting-hint" style="margin-bottom:8px;font-size:11px;">
                                        用逗号分隔。<code>thinking</code>=移除&lt;thinking&gt;内容&lt;/thinking&gt;；<code>/think</code>=移除开头到&lt;/think&gt;的内容
                                    </div>
                                    <input type="text" id="ttw-filter-tags" class="ttw-input" value="thinking,/think" placeholder="例如: thinking,/think,tucao" style="font-size:12px;">
                                </div>

                                <!-- 调试模式 -->
                                <div style="margin-top:10px;">
<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;">
    <input type="checkbox" id="ttw-debug-mode">
    <span>🔍 调试模式</span>
    <span style="color:#888;font-size:11px;">（在实时输出中打印每步操作和耗时）</span>
</label>
                                </div>

                                
                            </div>
                            <div id="ttw-volume-indicator" class="ttw-volume-indicator"></div>

                            <!-- 默认世界书条目配置 - UI化 -->
                            <div class="ttw-prompt-section" style="margin-top:16px;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:8px;overflow:hidden;">
                                <div class="ttw-prompt-header ttw-prompt-header-green" data-target="ttw-default-entries-content">
                                    <div style="display:flex;align-items:center;gap:8px;">
                                        <span>📚</span><span style="font-weight:500;">默认世界书条目</span>
                                        <span class="ttw-badge ttw-badge-gray">可选</span>
                                    </div>
                                    <span class="ttw-collapse-icon">▶</span>
                                </div>
                                <div id="ttw-default-entries-content" class="ttw-prompt-content">
                                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                                        <div class="ttw-setting-hint" style="font-size:11px;">每次转换完成后自动添加的世界书条目</div>
                                        <div style="display:flex;gap:6px;">
                                            <button id="ttw-add-default-entry" class="ttw-btn ttw-btn-small" style="background:#27ae60;">➕ 添加</button>
                                            <button id="ttw-apply-default-entries" class="ttw-btn ttw-btn-small">🔄 立即应用</button>
                                        </div>
                                    </div>
                                    <div id="ttw-default-entries-list" class="ttw-default-entries-list"></div>
                                </div>
                            </div>

                            <div class="ttw-prompt-config">
                                <div class="ttw-prompt-config-header">
                                    <span>📝 提示词配置</span>
                                    <div style="display:flex;gap:8px;">
                                       <button id="ttw-export-settings" class="ttw-btn ttw-btn-small">📤 导出</button>
                                       <button id="ttw-import-settings" class="ttw-btn ttw-btn-small">📥 导入</button>
                                        <button id="ttw-preview-prompt" class="ttw-btn ttw-btn-small">👁️ 预览</button>
                                    </div>
                                </div>
                                <div class="ttw-prompt-section">
                                    <div class="ttw-prompt-header ttw-prompt-header-blue" data-target="ttw-worldbook-content">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <span>📚</span><span style="font-weight:500;">世界书词条</span>
                                            <span class="ttw-badge ttw-badge-blue">必需</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-worldbook-content" class="ttw-prompt-content">
                                        <div class="ttw-setting-hint" style="margin-bottom:10px;">核心提示词。留空使用默认。</div>
                                        <div class="ttw-placeholder-hint" style="margin-bottom:10px;padding:8px;background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.4);border-radius:6px;">
                                            <span style="color:#e74c3c;font-weight:bold;">⚠️ 必须包含占位符：</span>
                                            <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:3px;color:#f39c12;font-family:monospace;">{DYNAMIC_JSON_TEMPLATE}</code>
                                            <div style="font-size:11px;color:#888;margin-top:4px;">此占位符会被自动替换为根据启用分类生成的JSON模板</div>
                                        </div>
                                        <textarea id="ttw-worldbook-prompt" rows="6" placeholder="留空使用默认..." class="ttw-textarea-small"></textarea>
                                        <div style="margin-top:8px;"><button class="ttw-btn ttw-btn-small ttw-reset-prompt" data-type="worldbook">🔄 恢复默认</button></div>
                                    </div>
                                </div>
                                <div class="ttw-prompt-section">
                                    <div class="ttw-prompt-header ttw-prompt-header-purple" data-target="ttw-plot-content">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                                                <input type="checkbox" id="ttw-enable-plot">
                                                <span>📖</span><span style="font-weight:500;">剧情大纲</span>
                                            </label>
                                            <span class="ttw-badge ttw-badge-gray">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-plot-content" class="ttw-prompt-content">
                                        <textarea id="ttw-plot-prompt" rows="4" placeholder="留空使用默认..." class="ttw-textarea-small"></textarea>
                                        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
                                            <button class="ttw-btn ttw-btn-small ttw-reset-prompt" data-type="plot">🔄 恢复默认</button>
                                            <button class="ttw-btn ttw-btn-small" id="ttw-plot-export-config" style="background:rgba(155,89,182,0.3);">⚙️ 导出时的默认配置</button>
                                        </div>
                                    </div>
                                </div>

                                <div class="ttw-prompt-section">
                                    <div class="ttw-prompt-header ttw-prompt-header-green" data-target="ttw-style-content">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                                                <input type="checkbox" id="ttw-enable-style">
                                                <span>🎨</span><span style="font-weight:500;">文风配置</span>
                                            </label>
                                            <span class="ttw-badge ttw-badge-gray">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-style-content" class="ttw-prompt-content">
                                        <textarea id="ttw-style-prompt" rows="4" placeholder="留空使用默认..." class="ttw-textarea-small"></textarea>
                                        <div style="margin-top:8px;"><button class="ttw-btn ttw-btn-small ttw-reset-prompt" data-type="style">🔄 恢复默认</button></div>
                                    </div>
                                </div>
                                <!-- 消息链配置 + 后缀提示词 -->
                                <div class="ttw-prompt-section">
                                    <div class="ttw-prompt-header" style="background:rgba(230,126,34,0.15);" data-target="ttw-suffix-content">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <span>💬</span><span style="font-weight:500;color:#e67e22;">消息链配置</span>
                                            <span class="ttw-badge ttw-badge-gray">可选</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-suffix-content" class="ttw-prompt-content">
                                        <div style="margin-bottom:12px;padding:10px;background:rgba(230,126,34,0.1);border-radius:6px;">
                                            <label style="font-size:12px;color:#e67e22;font-weight:bold;">📌 后缀提示词（追加到提示词末尾，在消息链转换之前生效）</label>
                                            <textarea id="ttw-suffix-prompt" rows="2" placeholder="例如：请特别注意提取XX信息，修复乱码内容，注意区分同名角色..." class="ttw-textarea-small" style="margin-top:6px;"></textarea>
                                        </div>
                                        <div style="border-top:1px solid rgba(255,255,255,0.1);padding-top:12px;">
                                            <div class="ttw-setting-hint" style="margin-bottom:8px;line-height:1.6;">
                                                💬 配置发送给AI的消息链（类似对话补全预设）。每条消息可指定角色。<br>
                                                <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:3px;font-size:11px;">{PROMPT}</code> 占位符会被替换为实际组装好的提示词内容。
                                            </div>
                                            <div id="ttw-chain-tavern-warning" style="display:none;margin-bottom:8px;padding:8px 10px;background:rgba(231,76,60,0.15);border-left:3px solid #e74c3c;border-radius:0 6px 6px 0;font-size:11px;color:#e74c3c;line-height:1.6;">
                                                ⚠️ <strong>酒馆API模式下</strong>，消息角色（system/assistant）会被酒馆的提示词后处理覆盖，且可能注入预设JB内容。<br>
                                                要让角色设置完全生效，请切换到<strong>自定义API模式</strong>（直连API，不经过酒馆处理）。
                                            </div>
                                            <div id="ttw-message-chain-list" style="margin-bottom:8px;"></div>
                                            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                                                <button id="ttw-add-chain-msg" class="ttw-btn ttw-btn-small" style="background:rgba(52,152,219,0.5);">➕ 添加消息</button>
                                                <button id="ttw-import-st-preset" class="ttw-btn ttw-btn-small" style="background:rgba(155,89,182,0.6);">📥 导入酒馆预设</button>
                                                <button id="ttw-reset-chain" class="ttw-btn ttw-btn-small">🔄 恢复默认</button>
                                                <input type="file" id="ttw-st-preset-file" accept=".json,application/json" style="display:none;">
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- 自定义提取分类 - 修改按钮布局 -->
                                <div class="ttw-prompt-section">
                                    <div class="ttw-prompt-header" style="background:rgba(155,89,182,0.15);" data-target="ttw-categories-content">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <span>🏷️</span><span style="font-weight:500;color:#9b59b6;">自定义提取分类</span>
                                        </div>
                                        <span class="ttw-collapse-icon">▶</span>
                                    </div>
                                    <div id="ttw-categories-content" class="ttw-prompt-content">
                                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                                            <div class="ttw-setting-hint" style="font-size:11px;flex:1;">勾选要提取的分类</div>
                                            <div style="display:flex;gap:6px;">
                                                <button id="ttw-add-category" class="ttw-btn ttw-btn-small" style="background:#9b59b6;">➕ 添加</button>
                                                <button id="ttw-reset-categories" class="ttw-btn ttw-btn-small">🔄 重置</button>
                                            </div>
                                        </div>
                                        <div id="ttw-categories-list" class="ttw-categories-list"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- 文件上传 -->
                    <div class="ttw-section">
                        <div class="ttw-section-header">
                            <span>📄 文件上传</span>
                            <div style="display:flex;gap:8px;">
                                <button id="ttw-import-json" class="ttw-btn-small" title="导入已有世界书JSON进行合并">📥 合并世界书</button>
                                <button id="ttw-import-task" class="ttw-btn-small">📥 导入任务</button>
                                <button id="ttw-export-task" class="ttw-btn-small">📤 导出任务</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-upload-area" id="ttw-upload-area">
                                <div style="font-size:48px;margin-bottom:12px;">📁</div>
                                <div style="font-size:14px;opacity:0.8;">点击或拖拽TXT文件到此处</div>
                                <input type="file" id="ttw-file-input" accept=".txt" style="display:none;">
                            </div>
                            <div id="ttw-file-info" class="ttw-file-info">
                                <span id="ttw-file-name"></span>
                                <span id="ttw-file-size"></span>
                                <button id="ttw-clear-file" class="ttw-btn-small">清除</button>
                            </div>
                            <div id="ttw-novel-name-row" style="display:none;margin-top:6px;padding:6px 10px;background:rgba(52,152,219,0.1);border-radius:6px;border:1px solid rgba(52,152,219,0.25);align-items:center;gap:8px;">
                                <span style="font-size:12px;color:#3498db;white-space:nowrap;">📖 导出名称:</span>
                                <input type="text" id="ttw-novel-name-input" placeholder="输入小说名（用于导出文件名）" style="flex:1;min-width:0;background:rgba(0,0,0,0.3);border:1px solid #555;border-radius:4px;padding:4px 8px;color:#eee;font-size:12px;outline:none;box-sizing:border-box;" />
                            </div>
                        </div>
                    </div>
                    <!-- 记忆队列 -->
                    <div class="ttw-section" id="ttw-queue-section" style="display:none;">
                        <div class="ttw-section-header">
                            <span>📋 章节队列</span>
                            <div style="display:flex;gap:8px;margin-left:auto;">
                                <button id="ttw-import-update-chapters" class="ttw-btn-small" style="background:rgba(39,174,96,0.4);" title="导入更新的TXT，只把新增章节追加到队列末尾，不影响已处理和已整理的条目">📗 导入更新章节</button>
                                <button id="ttw-view-processed" class="ttw-btn-small">📊 已处理</button>
                                <button id="ttw-select-start" class="ttw-btn-small">📍 选择起始</button>
                                <button id="ttw-multi-delete-btn" class="ttw-btn-small ttw-btn-warning">🗑️ 多选删除</button>
                            </div>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-setting-hint" style="margin-bottom:8px;">💡 点击章节可<strong>查看/编辑/复制</strong>，支持<strong>🎲重Roll</strong></div>
                            <div id="ttw-multi-select-bar" style="display:none;margin-bottom:8px;padding:8px;background:rgba(231,76,60,0.15);border-radius:6px;border:1px solid rgba(231,76,60,0.3);">
                                <div style="display:flex;justify-content:space-between;align-items:center;">
                                    <span style="color:#e74c3c;font-weight:bold;">🗑️ 多选删除模式</span>
                                    <div style="display:flex;gap:8px;">
                                        <span id="ttw-selected-count" style="color:#888;">已选: 0</span>
                                        <button id="ttw-confirm-multi-delete" class="ttw-btn ttw-btn-small ttw-btn-warning">确认删除</button>
                                        <button id="ttw-cancel-multi-select" class="ttw-btn ttw-btn-small">取消</button>
                                    </div>
                                </div>
                            </div>
                            <div id="ttw-memory-queue" class="ttw-memory-queue"></div>
                        </div>
                    </div>
                    <!-- 进度 -->
                    <div class="ttw-section" id="ttw-progress-section" style="display:none;">
                        <div class="ttw-section-header"><span>⏳ 处理进度</span></div>
                        <div class="ttw-section-content">
                            <div class="ttw-progress-bar">
                                <div id="ttw-progress-fill" class="ttw-progress-fill"></div>
                            </div>
                            <div id="ttw-progress-text" class="ttw-progress-text">准备中...</div>
                            <div class="ttw-progress-controls">
                                <button id="ttw-stop-btn" class="ttw-btn ttw-btn-secondary">⏸️ 暂停</button>
                                <button id="ttw-repair-btn" class="ttw-btn ttw-btn-warning" style="display:none;">🔧 修复失败</button>
                                <button id="ttw-toggle-stream" class="ttw-btn ttw-btn-small">👁️ 实时输出</button>
                            </div>
                            <div id="ttw-stream-container" class="ttw-stream-container">
                                <div class="ttw-stream-header">
                                    <span>📤 实时输出</span>
                                    <div style="display:flex;gap:6px;">
                                        <button id="ttw-copy-stream" class="ttw-btn-small" style="display:none;">📋 复制全部</button>
                                        <button id="ttw-clear-stream" class="ttw-btn-small">清空</button>
                                    </div>
                                </div>
                                <pre id="ttw-stream-content" class="ttw-stream-content"></pre>
                            </div>
                        </div>
                    </div>
                    <!-- 结果 -->
                    <div class="ttw-section" id="ttw-result-section" style="display:none;">
                        <div class="ttw-section-header"><span>📊 生成结果</span></div>
                        <div class="ttw-section-content">
                            <div id="ttw-result-preview" class="ttw-result-preview"></div>
                            <div class="ttw-result-actions">
                                <button id="ttw-search-btn" class="ttw-btn">🔍 查找</button>
                                <button id="ttw-replace-btn" class="ttw-btn">🔄 替换</button>
                                <button id="ttw-view-worldbook" class="ttw-btn">📖 查看世界书</button>
                                <button id="ttw-view-history" class="ttw-btn">📜 修改历史</button>
                                 <button id="ttw-consolidate-entries" class="ttw-btn" title="用AI整理条目，去除重复信息">🧹 整理条目</button>
                                <button id="ttw-clean-tags" class="ttw-btn" title="清除条目中的标签内容（不消耗Token）">🏷️ 清除标签</button>
                                <button id="ttw-alias-merge" class="ttw-btn" title="识别各分类中同一事物的不同称呼并合并">🔗 别名合并</button>
                                <button id="ttw-export-json" class="ttw-btn ttw-btn-primary">🃏 导出角色卡</button>
                                <button id="ttw-export-volumes" class="ttw-btn" style="display:none;">📦 分卷导出</button>
                                <button id="ttw-export-st" class="ttw-btn ttw-btn-primary">📥 导出世界书</button>
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
        loadCategoryLightSettings();
        loadCustomCategories().then(() => {
            renderCategoriesList();
            renderDefaultWorldbookEntriesUI();
        });
        checkAndRestoreState();
        restoreExistingState().catch(e => console.error('恢复状态失败:', e));
    }

    async function restoreExistingState() {
        if (memoryQueue.length > 0) {
            document.getElementById('ttw-upload-area').style.display = 'none';
            document.getElementById('ttw-file-info').style.display = 'flex';
            document.getElementById('ttw-file-name').textContent = currentFile ? currentFile.name : '已加载的文件';
            const totalChars = memoryQueue.reduce((sum, m) => sum + m.content.length, 0);
            document.getElementById('ttw-file-size').textContent = `(${(totalChars / 1024).toFixed(1)} KB, ${memoryQueue.length}章)`;
            // 【新增】恢复小说名输入框
            if (savedNovelName) {
                const novelNameRow = document.getElementById('ttw-novel-name-row');
                if (novelNameRow) novelNameRow.style.display = 'flex';
                const novelNameInput = document.getElementById('ttw-novel-name-input');
                if (novelNameInput) novelNameInput.value = savedNovelName;
            }

            // 【修复】确保每个已处理的memory都有result
            for (let i = 0; i < memoryQueue.length; i++) {
                const memory = memoryQueue[i];
                if (memory.processed && !memory.failed && !memory.result) {
                    try {
                        const rollResults = await MemoryHistoryDB.getRollResults(i);
                        if (rollResults.length > 0) {
                            const latestRoll = rollResults[rollResults.length - 1];
                            memory.result = latestRoll.result;
                            console.log(`✅ 恢复第${i + 1}章的result`);
                        }
                    } catch (e) {
                        console.error(`恢复第${i + 1}章result失败:`, e);
                    }
                }
            }

            showQueueSection(true);
            updateMemoryQueueUI();

            document.getElementById('ttw-start-btn').disabled = false;
            updateStartButtonState(false);

            if (useVolumeMode) updateVolumeIndicator();

            // 【修复】如果世界书为空但有已处理的记忆，重建世界书
            if (Object.keys(generatedWorldbook).length === 0) {
                const hasProcessedWithResult = memoryQueue.some(m => m.processed && !m.failed && m.result);
                if (hasProcessedWithResult) {
                    rebuildWorldbookFromMemories();
                }
            }

            if (Object.keys(generatedWorldbook).length > 0) {
                showResultSection(true);
                updateWorldbookPreview();
            }
        }
    }


    function addModalStyles() {
        if (document.getElementById('ttw-styles')) return;
        const styles = document.createElement('style');
        styles.id = 'ttw-styles';
        styles.textContent = `
            .ttw-modal-container{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;box-sizing:border-box;}
            .ttw-modal{background:var(--SmartThemeBlurTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:12px;width:100%;max-width:750px;max-height:calc(100vh - 40px);display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4);overflow:hidden;}
            .ttw-modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);background:rgba(0,0,0,0.2);}
            .ttw-modal-title{font-weight:bold;font-size:15px;color:#e67e22;}
            .ttw-header-actions{display:flex;align-items:center;gap:12px;}
            .ttw-help-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(231,76,60,0.2);color:#e74c3c;font-size:14px;cursor:pointer;transition:all 0.2s;border:1px solid rgba(231,76,60,0.4);}
            .ttw-help-btn:hover{background:rgba(231,76,60,0.4);transform:scale(1.1);}
            .ttw-modal-close{background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:18px;width:36px;height:36px;border-radius:6px;cursor:pointer;transition:all 0.2s;}
            .ttw-modal-close:hover{background:rgba(255,100,100,0.3);color:#ff6b6b;}
            .ttw-modal-body{flex:1;overflow-y:auto;padding:16px;}
            .ttw-modal-footer{padding:16px 20px;border-top:1px solid var(--SmartThemeBorderColor,#444);background:rgba(0,0,0,0.2);display:flex;justify-content:flex-end;gap:10px;}
            .ttw-section{background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:12px;overflow:hidden;}
            .ttw-section-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:rgba(0,0,0,0.3);cursor:pointer;font-weight:bold;font-size:14px;}
            .ttw-section-content{padding:16px;}
            .ttw-collapse-icon{font-size:10px;transition:transform 0.2s;}
            .ttw-section.collapsed .ttw-collapse-icon{transform:rotate(-90deg);}
            .ttw-section.collapsed .ttw-section-content{display:none;}
            .ttw-input,.ttw-select,.ttw-textarea,.ttw-textarea-small,.ttw-input-small{background:rgba(0,0,0,0.3);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;}
            .ttw-input{width:100%;padding:10px 12px;}
            .ttw-input-small{width:60px;padding:6px 8px;text-align:center;}
            .ttw-select{width:100%;padding:8px 10px;}
            .ttw-textarea{width:100%;min-height:250px;padding:12px;line-height:1.6;resize:vertical;font-family:inherit;}
            .ttw-textarea-small{width:100%;min-height:80px;padding:10px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;}
            .ttw-input:focus,.ttw-select:focus,.ttw-textarea:focus,.ttw-textarea-small:focus{outline:none;border-color:#e67e22;}
            .ttw-label{display:block;margin-bottom:6px;font-size:12px;opacity:0.9;}
            .ttw-setting-hint{font-size:11px;color:#888;margin-top:4px;}
            .ttw-setting-card{margin-bottom:16px;padding:12px;border-radius:8px;}
            .ttw-setting-card-green{background:rgba(39,174,96,0.1);border:1px solid rgba(39,174,96,0.3);}
            .ttw-setting-card-blue{background:rgba(52,152,219,0.15);border:1px solid rgba(52,152,219,0.3);}
            .ttw-checkbox-label{display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;}
            .ttw-checkbox-label input[type="checkbox"]{width:18px;height:18px;accent-color:#e67e22;flex-shrink:0;}
            .ttw-checkbox-with-hint{padding:8px 12px;background:rgba(0,0,0,0.15);border-radius:6px;}
            .ttw-checkbox-purple{background:rgba(155,89,182,0.15);border:1px solid rgba(155,89,182,0.3);}
            .ttw-volume-indicator{display:none;margin-top:12px;padding:8px 12px;background:rgba(155,89,182,0.2);border-radius:6px;font-size:12px;color:#bb86fc;}
            .ttw-prompt-config{margin-top:16px;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:8px;overflow:hidden;}
            .ttw-prompt-config-header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:rgba(230,126,34,0.15);border-bottom:1px solid var(--SmartThemeBorderColor,#444);font-weight:500;flex-wrap:wrap;gap:8px;}
            .ttw-prompt-section{border-bottom:1px solid var(--SmartThemeBorderColor,#333);}
            .ttw-prompt-section:last-child{border-bottom:none;}
            .ttw-prompt-header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;font-size:13px;transition:background 0.2s;}
            .ttw-prompt-header:hover{filter:brightness(1.1);}
            .ttw-prompt-header-blue{background:rgba(52,152,219,0.1);}
            .ttw-prompt-header-purple{background:rgba(155,89,182,0.1);}
            .ttw-prompt-header-green{background:rgba(46,204,113,0.1);}
            .ttw-prompt-content{display:none;padding:12px 14px;background:rgba(0,0,0,0.15);}
            .ttw-badge{font-size:10px;padding:2px 6px;border-radius:10px;font-weight:500;}
            .ttw-badge-blue{background:rgba(52,152,219,0.3);color:#5dade2;}
            .ttw-badge-gray{background:rgba(149,165,166,0.3);color:#bdc3c7;}
            .ttw-upload-area{border:2px dashed var(--SmartThemeBorderColor,#555);border-radius:8px;padding:40px 20px;text-align:center;cursor:pointer;transition:all 0.2s;}
            .ttw-upload-area:hover{border-color:#e67e22;background:rgba(230,126,34,0.1);}
            .ttw-file-info{display:none;align-items:center;gap:12px;padding:12px;background:rgba(0,0,0,0.3);border-radius:6px;margin-top:12px;}
            .ttw-memory-queue{max-height:200px;overflow-y:auto;}
            .ttw-memory-item{padding:8px 12px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:6px;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:background 0.2s;}
            .ttw-memory-item:hover{background:rgba(0,0,0,0.4);}
            .ttw-memory-item.multi-select-mode{cursor:default;}
            .ttw-memory-item.selected-for-delete{background:rgba(231,76,60,0.3);border:1px solid rgba(231,76,60,0.5);}
            .ttw-progress-bar{width:100%;height:8px;background:rgba(0,0,0,0.3);border-radius:4px;overflow:hidden;margin-bottom:12px;}
            .ttw-progress-fill{height:100%;background:linear-gradient(90deg,#e67e22,#f39c12);border-radius:4px;transition:width 0.3s;width:0%;}
            .ttw-progress-text{font-size:13px;text-align:center;margin-bottom:12px;}
            .ttw-progress-controls{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
            .ttw-stream-container{display:none;margin-top:12px;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:6px;overflow:hidden;}
            .ttw-stream-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(0,0,0,0.3);font-size:12px;}
            .ttw-stream-content{max-height:200px;overflow-y:auto;padding:12px;background:rgba(0,0,0,0.2);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0;font-family:monospace;}
            .ttw-result-preview{max-height:300px;overflow-y:auto;background:rgba(0,0,0,0.3);border-radius:6px;padding:12px;margin-bottom:12px;font-size:12px;}
            .ttw-result-actions{display:flex;flex-wrap:wrap;gap:10px;}
            .ttw-btn{padding:10px 16px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;background:rgba(255,255,255,0.1);color:#fff;font-size:13px;cursor:pointer;transition:all 0.2s;}
            .ttw-btn:hover{background:rgba(255,255,255,0.2);}
            .ttw-btn:disabled{opacity:0.5;cursor:not-allowed;}
            .ttw-btn-primary{background:linear-gradient(135deg,#e67e22,#d35400);border-color:#e67e22;}
            .ttw-btn-primary:hover{background:linear-gradient(135deg,#f39c12,#e67e22);}
            .ttw-btn-secondary{background:rgba(108,117,125,0.5);}
            .ttw-btn-warning{background:rgba(255,107,53,0.5);border-color:#ff6b35;}
            .ttw-btn-small{padding:6px 12px;font-size:12px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:4px;background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;transition:all 0.2s;}
            .ttw-btn-small:hover{background:rgba(255,255,255,0.2);}
            .ttw-btn-tiny{padding:3px 6px;font-size:11px;border:none;background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;border-radius:3px;}
            .ttw-btn-tiny:hover{background:rgba(255,255,255,0.2);}
            .ttw-btn-tiny:disabled{opacity:0.3;cursor:not-allowed;}
            .ttw-categories-list{max-height:180px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;}
            .ttw-category-item{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,0,0,0.15);border-radius:4px;margin-bottom:4px;}
            .ttw-category-item input[type="checkbox"]{width:16px;height:16px;accent-color:#9b59b6;}
            .ttw-category-name{flex:1;font-size:12px;}
            .ttw-category-actions{display:flex;gap:4px;}
            .ttw-default-entries-list{max-height:180px;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;}
            .ttw-default-entry-item{padding:8px 10px;background:rgba(0,0,0,0.15);border-radius:4px;margin-bottom:6px;border-left:3px solid #27ae60;}
            .ttw-default-entry-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
            .ttw-default-entry-title{font-size:12px;font-weight:bold;color:#27ae60;}
            .ttw-default-entry-actions{display:flex;gap:4px;}
            .ttw-default-entry-info{font-size:11px;color:#888;}
            .ttw-form-group{margin-bottom:12px;}
            .ttw-form-group>label{display:block;margin-bottom:6px;font-size:12px;color:#ccc;}
            .ttw-merge-option{display:flex;align-items:center;gap:8px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;cursor:pointer;}
            .ttw-merge-option input{width:18px;height:18px;}
            .ttw-roll-history-container{display:flex;gap:10px;height:400px;}
            .ttw-roll-history-left{width:100px;min-width:100px;max-width:100px;display:flex;flex-direction:column;gap:8px;overflow:hidden;}
            .ttw-roll-history-right{flex:1;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:8px;padding:12px;}
            .ttw-roll-reroll-btn{width:100%;padding:8px 4px !important;font-size:11px !important;}
            .ttw-roll-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;}
            .ttw-roll-item{padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;cursor:pointer;border-left:2px solid #9b59b6;transition:all 0.2s;}
            .ttw-roll-item:hover,.ttw-roll-item.active{background:rgba(0,0,0,0.4);}
            .ttw-roll-item.selected{border-left-color:#27ae60;background:rgba(39,174,96,0.15);}
            .ttw-roll-item-header{display:flex;justify-content:space-between;align-items:center;gap:4px;}
            .ttw-roll-item-title{font-size:11px;font-weight:bold;color:#e67e22;white-space:nowrap;}
            .ttw-roll-item-time{font-size:9px;color:#888;white-space:nowrap;}
            .ttw-roll-item-info{font-size:9px;color:#aaa;margin-top:2px;}
            .ttw-roll-detail-header{margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #444;}
            .ttw-roll-detail-header h4{color:#e67e22;margin:0 0 6px 0;font-size:14px;}
            .ttw-roll-detail-time{font-size:11px;color:#888;margin-bottom:8px;}
            .ttw-roll-detail-content{white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;max-height:280px;overflow-y:auto;background:rgba(0,0,0,0.2);padding:10px;border-radius:6px;}
            .ttw-light-toggle{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:14px;transition:all 0.2s;border:none;margin-left:8px;}
            .ttw-light-toggle.blue{background:rgba(52,152,219,0.3);color:#3498db;}
            .ttw-light-toggle.blue:hover{background:rgba(52,152,219,0.5);}
            .ttw-light-toggle.green{background:rgba(39,174,96,0.3);color:#27ae60;}
            .ttw-light-toggle.green:hover{background:rgba(39,174,96,0.5);}
            .ttw-config-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;cursor:pointer;font-size:12px;transition:all 0.2s;border:none;margin-left:4px;background:rgba(155,89,182,0.3);color:#9b59b6;}
            .ttw-config-btn:hover{background:rgba(155,89,182,0.5);}
            .ttw-history-container{display:flex;gap:10px;height:400px;}
            .ttw-history-left{width:100px;min-width:100px;max-width:100px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;}
            .ttw-history-right{flex:1;overflow-y:auto;background:rgba(0,0,0,0.2);border-radius:8px;padding:12px;}
            .ttw-history-item{padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;cursor:pointer;border-left:2px solid #9b59b6;transition:all 0.2s;}
            .ttw-history-item:hover,.ttw-history-item.active{background:rgba(0,0,0,0.4);}
            .ttw-history-item-title{font-size:10px;font-weight:bold;color:#e67e22;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
            .ttw-history-item-time{font-size:9px;color:#888;}
            .ttw-history-item-info{font-size:9px;color:#aaa;}
            .ttw-model-actions{display:flex;gap:10px;align-items:center;margin-top:12px;padding:10px;background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.3);border-radius:6px;}
            .ttw-model-status{font-size:12px;margin-left:auto;}
            .ttw-model-status.success{color:#27ae60;}
            .ttw-model-status.error{color:#e74c3c;}
            .ttw-model-status.loading{color:#f39c12;}
            .ttw-setting-item{margin-bottom:12px;}
            .ttw-setting-item>label{display:block;margin-bottom:6px;font-size:12px;opacity:0.9;}
            .ttw-setting-item input,.ttw-setting-item select{width:100%;padding:10px 12px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;background:rgba(0,0,0,0.3);color:#fff;font-size:13px;box-sizing:border-box;}
            .ttw-setting-item select option{background:#2a2a2a;}
            .ttw-placeholder-hint code{user-select:all;}
            .ttw-consolidate-category-item{display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,0,0,0.15);border-radius:6px;margin-bottom:6px;cursor:pointer;}
            .ttw-consolidate-category-item input{width:18px;height:18px;accent-color:#3498db;}
            @media (max-width: 768px) {
                .ttw-roll-history-container,.ttw-history-container{flex-direction:column;height:auto;}
                .ttw-roll-history-left,.ttw-history-left{width:100%;max-width:100%;flex-direction:row;flex-wrap:wrap;height:auto;max-height:120px;}
                .ttw-roll-reroll-btn{width:auto;flex-shrink:0;}
                .ttw-roll-list{flex-direction:row;flex-wrap:wrap;gap:4px;}
                .ttw-roll-item,.ttw-history-item{flex:0 0 auto;padding:4px 8px;}
                .ttw-roll-history-right,.ttw-history-right{min-height:250px;}
                .ttw-processed-results-container{flex-direction:column !important;height:auto !important;}
                .ttw-processed-results-left{width:100% !important;max-width:100% !important;max-height:150px !important;flex-direction:row !important;flex-wrap:wrap !important;}
            }
        `;
        document.head.appendChild(styles);
    }

    function bindModalEvents() {
        const modal = modalContainer.querySelector('.ttw-modal');
        modal.addEventListener('click', (e) => e.stopPropagation());
        modal.addEventListener('mousedown', (e) => e.stopPropagation());

        modalContainer.querySelector('.ttw-modal-close').addEventListener('click', closeModal);
        modalContainer.querySelector('.ttw-help-btn').addEventListener('click', showHelpModal);
        // 误触保护：主模态框不响应背景点击关闭，只能通过右上角关闭按钮退出
        // modalContainer.addEventListener('click', (e) => { if (e.target === modalContainer) closeModal(); });
        document.addEventListener('keydown', handleEscKey, true);

        document.getElementById('ttw-use-tavern-api').addEventListener('change', () => {
            handleUseTavernApiChange();
            saveCurrentSettings();
        });

        document.getElementById('ttw-api-provider').addEventListener('change', () => {
            handleProviderChange();
            saveCurrentSettings();
        });

        ['ttw-api-key', 'ttw-api-endpoint', 'ttw-api-model'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });

        document.getElementById('ttw-model-select').addEventListener('change', (e) => {
            if (e.target.value) {
                document.getElementById('ttw-api-model').value = e.target.value;
                saveCurrentSettings();
            }
        });

        document.getElementById('ttw-fetch-models').addEventListener('click', handleFetchModels);
        document.getElementById('ttw-quick-test').addEventListener('click', handleQuickTest);

        ['ttw-chunk-size', 'ttw-api-timeout'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });
        ['ttw-incremental-mode', 'ttw-volume-mode', 'ttw-enable-plot', 'ttw-enable-style', 'ttw-force-chapter-marker', 'ttw-allow-recursion'].forEach(id => {

            const el = document.getElementById(id);
            if (el) el.addEventListener('change', saveCurrentSettings);
        });
        document.getElementById('ttw-parallel-enabled').addEventListener('change', (e) => { parallelConfig.enabled = e.target.checked; saveCurrentSettings(); });
        document.getElementById('ttw-parallel-concurrency').addEventListener('change', (e) => { parallelConfig.concurrency = Math.max(1, Math.min(10, parseInt(e.target.value) || 3)); e.target.value = parallelConfig.concurrency; saveCurrentSettings(); });
        document.getElementById('ttw-parallel-mode').addEventListener('change', (e) => { parallelConfig.mode = e.target.value; saveCurrentSettings(); });
        document.getElementById('ttw-volume-mode').addEventListener('change', (e) => { useVolumeMode = e.target.checked; const indicator = document.getElementById('ttw-volume-indicator'); if (indicator) indicator.style.display = useVolumeMode ? 'block' : 'none'; });

        document.getElementById('ttw-rechunk-btn').addEventListener('click', rechunkMemories);

        document.getElementById('ttw-add-category').addEventListener('click', showAddCategoryModal);
        document.getElementById('ttw-reset-categories').addEventListener('click', async () => {
            if (confirm('确定重置为默认分类配置吗？这将清除所有自定义分类。')) {
                await resetToDefaultCategories();
                renderCategoriesList();
            }
        });

        // 默认世界书条目UI事件
        document.getElementById('ttw-add-default-entry').addEventListener('click', showAddDefaultEntryModal);
        document.getElementById('ttw-apply-default-entries').addEventListener('click', () => {
            saveDefaultWorldbookEntriesUI();
            const applied = applyDefaultWorldbookEntries();
            if (applied) {
                showResultSection(true);
                updateWorldbookPreview();
                alert('默认世界书条目已应用！');
            } else {
                alert('没有默认世界书条目');
            }
        });

        const categoriesHeader = document.querySelector('[data-target="ttw-categories-content"]');
        if (categoriesHeader) {
            categoriesHeader.addEventListener('click', () => {
                const content = document.getElementById('ttw-categories-content');
                const icon = categoriesHeader.querySelector('.ttw-collapse-icon');
                if (content.style.display === 'none' || !content.style.display) {
                    content.style.display = 'block';
                    icon.textContent = '▼';
                } else {
                    content.style.display = 'none';
                    icon.textContent = '▶';
                }
            });
        }

        document.getElementById('ttw-chapter-regex').addEventListener('change', (e) => {
            chapterRegexSettings.pattern = e.target.value;
            saveCurrentSettings();
        });

        document.querySelectorAll('.ttw-chapter-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const regex = btn.dataset.regex;
                document.getElementById('ttw-chapter-regex').value = regex;
                chapterRegexSettings.pattern = regex;
                saveCurrentSettings();
            });
        });

        document.getElementById('ttw-test-chapter-regex').addEventListener('click', testChapterRegex);

        const defaultEntriesHeader = document.querySelector('[data-target="ttw-default-entries-content"]');
        if (defaultEntriesHeader) {
            defaultEntriesHeader.addEventListener('click', () => {
                const content = document.getElementById('ttw-default-entries-content');
                const icon = defaultEntriesHeader.querySelector('.ttw-collapse-icon');
                if (content.style.display === 'none' || !content.style.display) { content.style.display = 'block'; icon.textContent = '▼'; }
                else { content.style.display = 'none'; icon.textContent = '▶'; }
            });
        }

        document.querySelectorAll('.ttw-prompt-header[data-target]').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                const targetId = header.getAttribute('data-target');
                if (targetId === 'ttw-default-entries-content' || targetId === 'ttw-categories-content') return;
                const content = document.getElementById(targetId);
                const icon = header.querySelector('.ttw-collapse-icon');
                if (content.style.display === 'none' || !content.style.display) { content.style.display = 'block'; icon.textContent = '▼'; }
                else { content.style.display = 'none'; icon.textContent = '▶'; }
            });
        });

        ['ttw-worldbook-prompt', 'ttw-plot-prompt', 'ttw-style-prompt', 'ttw-suffix-prompt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', saveCurrentSettings);
        });


        document.querySelectorAll('.ttw-reset-prompt').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.getAttribute('data-type');
                const textarea = document.getElementById(`ttw-${type}-prompt`);
                if (textarea) { textarea.value = ''; saveCurrentSettings(); }
            });
        });

        // ========== 消息链编辑器 ==========
        renderMessageChainUI();
        document.getElementById('ttw-add-chain-msg').addEventListener('click', () => {
            if (!settings.promptMessageChain) settings.promptMessageChain = [];
            settings.promptMessageChain.push({ role: 'user', content: '', enabled: true });
            renderMessageChainUI();
            saveCurrentSettings();
        });
        document.getElementById('ttw-reset-chain').addEventListener('click', () => {
            if (confirm('确定恢复默认消息链？')) {
                settings.promptMessageChain = [{ role: 'user', content: '{PROMPT}', enabled: true }];
                settings.presetTemperature = 0.3;
                settings.presetMaxTokens = null;
                settings.presetTopP = null;
                settings.presetFreqPenalty = null;
                settings.presetPresPenalty = null;
                settings.importedPresetName = '';
                renderMessageChainUI();
                saveCurrentSettings();
            }
        });

        // ===== 导入酒馆对话补全预设 =====
        document.getElementById('ttw-import-st-preset').addEventListener('click', () => {
            document.getElementById('ttw-st-preset-file').click();
        });
        document.getElementById('ttw-st-preset-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            e.target.value = '';
            try {
                const text = await file.text();
                const json = JSON.parse(text);
                const parsed = parseTavernPreset(json);
                const name = file.name.replace(/\.json$/i, '');
                const s = parsed.stats;

                let msg = '预设「' + name + '」解析结果：\n\n';
                msg += '· 条目 ' + s.used + ' 条（启用 ' + s.enabled + ' 条）\n';
                msg += '· 丢弃占位符 ' + s.droppedMarkers + ' 个（角色卡/世界书/示例对话，本插件无对应物）\n';
                msg += '· 跳过空内容 ' + s.skippedEmpty + ' 条\n';
                msg += '· 正文槽位：' + (s.hadPromptSlot ? '来自「聊天记录」占位符' : '预设中无聊天记录，已自动追加到末尾') + '\n';
                if (parsed.params.temperature !== null) msg += '· temperature = ' + parsed.params.temperature + '\n';
                if (parsed.params.maxTokens !== null) msg += '· max_tokens = ' + parsed.params.maxTokens + '\n';
                msg += '\n导入会覆盖当前消息链，确认？';

                if (!confirm(msg)) return;

                applyTavernPreset(parsed, name);
                alert('✅ 预设「' + name + '」已导入');

                if (settings.useTavernApi) {
                    alert('⚠️ 当前是酒馆API模式，system/assistant 角色会被压平成纯文本，预设排布不会真正生效。\n请在上方切换到自定义API模式。');
                }
            } catch (err) {
                alert('预设导入失败：' + err.message);
            }
        });

        document.getElementById('ttw-preview-prompt').addEventListener('click', showPromptPreview);
        document.getElementById('ttw-plot-export-config').addEventListener('click', showPlotOutlineConfigModal);
        document.getElementById('ttw-import-json').addEventListener('click', importAndMergeWorldbook);
        document.getElementById('ttw-import-task').addEventListener('click', importTaskState);
        document.getElementById('ttw-export-task').addEventListener('click', exportTaskState);

        document.getElementById('ttw-export-settings').addEventListener('click', exportSettings);
        document.getElementById('ttw-import-settings').addEventListener('click', importSettings);

        const uploadArea = document.getElementById('ttw-upload-area');
        const fileInput = document.getElementById('ttw-file-input');
        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#e67e22'; uploadArea.style.background = 'rgba(230,126,34,0.1)'; });
        uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = '#555'; uploadArea.style.background = 'transparent'; });
        uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#555'; uploadArea.style.background = 'transparent'; if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]); });
        fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFileSelect(e.target.files[0]); });

        document.getElementById('ttw-clear-file').addEventListener('click', clearFile);
        // 【新增】小说名称输入框事件 - 实时同步到全局变量
        document.getElementById('ttw-novel-name-input').addEventListener('input', (e) => {
            savedNovelName = e.target.value.trim();
        });
        document.getElementById('ttw-start-btn').addEventListener('click', startConversion);
        document.getElementById('ttw-stop-btn').addEventListener('click', stopProcessing);
        document.getElementById('ttw-repair-btn').addEventListener('click', startRepairFailedMemories);
        document.getElementById('ttw-select-start').addEventListener('click', showStartFromSelector);
        document.getElementById('ttw-view-processed').addEventListener('click', showProcessedResults);
        document.getElementById('ttw-import-update-chapters').addEventListener('click', importUpdateChapters);

        document.getElementById('ttw-multi-delete-btn').addEventListener('click', toggleMultiSelectMode);
        document.getElementById('ttw-confirm-multi-delete').addEventListener('click', deleteSelectedMemories);
        document.getElementById('ttw-cancel-multi-select').addEventListener('click', () => {
            isMultiSelectMode = false;
            selectedMemoryIndices.clear();
            updateMemoryQueueUI();
        });

        document.getElementById('ttw-toggle-stream').addEventListener('click', () => { const container = document.getElementById('ttw-stream-container'); container.style.display = container.style.display === 'none' ? 'block' : 'none'; });
        document.getElementById('ttw-clear-stream').addEventListener('click', () => updateStreamContent('', true));
        // 【新增】复制实时输出按钮
        document.getElementById('ttw-copy-stream').addEventListener('click', () => {
            const streamEl = document.getElementById('ttw-stream-content');
            if (streamEl && streamEl.textContent) {
                navigator.clipboard.writeText(streamEl.textContent).then(() => {
                    const btn = document.getElementById('ttw-copy-stream');
                    const orig = btn.textContent;
                    btn.textContent = '✅ 已复制';
                    setTimeout(() => { btn.textContent = orig; }, 1500);
                }).catch(() => {
                    // fallback
                    const ta = document.createElement('textarea');
                    ta.value = streamEl.textContent;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    const btn = document.getElementById('ttw-copy-stream');
                    const orig = btn.textContent;
                    btn.textContent = '✅ 已复制';
                    setTimeout(() => { btn.textContent = orig; }, 1500);
                });
            }
        });
        // 【新增】调试模式勾选变化时，切换复制按钮可见性
        document.getElementById('ttw-debug-mode').addEventListener('change', (e) => {
            const copyBtn = document.getElementById('ttw-copy-stream');
            if (copyBtn) copyBtn.style.display = e.target.checked ? 'inline-block' : 'none';
        });

        // 新增：查找和替换按钮
        document.getElementById('ttw-search-btn').addEventListener('click', showSearchModal);
        document.getElementById('ttw-replace-btn').addEventListener('click', showReplaceModal);

        document.getElementById('ttw-view-worldbook').addEventListener('click', showWorldbookView);
        document.getElementById('ttw-view-history').addEventListener('click', showHistoryView);
        document.getElementById('ttw-consolidate-entries').addEventListener('click', showConsolidateCategorySelector);
        document.getElementById('ttw-clean-tags').addEventListener('click', showCleanTagsModal);
        document.getElementById('ttw-alias-merge').addEventListener('click', showAliasMergeUI);
        document.getElementById('ttw-export-json').addEventListener('click', exportCharacterCard);
        document.getElementById('ttw-export-volumes').addEventListener('click', exportVolumes);
        document.getElementById('ttw-export-st').addEventListener('click', exportToSillyTavern);
        document.querySelector('[data-section="settings"]').addEventListener('click', () => { document.querySelector('.ttw-settings-section').classList.toggle('collapsed'); });
    }

    function toggleMultiSelectMode() {
        isMultiSelectMode = !isMultiSelectMode;
        selectedMemoryIndices.clear();

        const multiSelectBar = document.getElementById('ttw-multi-select-bar');
        if (multiSelectBar) {
            multiSelectBar.style.display = isMultiSelectMode ? 'block' : 'none';
        }

        updateMemoryQueueUI();
    }

    function handleEscKey(e) {
        if (e.key === 'Escape') {
            // 误触保护：ESC只关闭子模态框（世界书预览、历史记录等），不关闭主UI
            const subModals = document.querySelectorAll('.ttw-modal-container:not(#txt-to-worldbook-modal)');
            if (subModals.length > 0) {
                e.stopPropagation(); e.preventDefault();
                subModals[subModals.length - 1].remove(); // 关闭最顶层的子模态框
            }
            // 主模态框不响应ESC，只能通过右上角关闭按钮退出
        }
    }

    function saveCurrentSettings() {
        settings.chunkSize = parseInt(document.getElementById('ttw-chunk-size')?.value) || 15000;
        settings.apiTimeout = (parseInt(document.getElementById('ttw-api-timeout')?.value) || 120) * 1000;
        incrementalOutputMode = document.getElementById('ttw-incremental-mode')?.checked ?? true;
        useVolumeMode = document.getElementById('ttw-volume-mode')?.checked ?? false;
        settings.useVolumeMode = useVolumeMode;
        settings.enablePlotOutline = document.getElementById('ttw-enable-plot')?.checked ?? false;
        settings.enableLiteraryStyle = document.getElementById('ttw-enable-style')?.checked ?? false;
        settings.customWorldbookPrompt = document.getElementById('ttw-worldbook-prompt')?.value || '';
        settings.customPlotPrompt = document.getElementById('ttw-plot-prompt')?.value || '';
        settings.customStylePrompt = document.getElementById('ttw-style-prompt')?.value || '';
        settings.useTavernApi = document.getElementById('ttw-use-tavern-api')?.checked ?? true;
        settings.parallelEnabled = parallelConfig.enabled;
        settings.parallelConcurrency = parallelConfig.concurrency;
        settings.parallelMode = parallelConfig.mode;
        settings.categoryLightSettings = { ...categoryLightSettings };
        settings.forceChapterMarker = document.getElementById('ttw-force-chapter-marker')?.checked ?? true;
        settings.chapterRegexPattern = document.getElementById('ttw-chapter-regex')?.value || chapterRegexSettings.pattern;
        settings.defaultWorldbookEntriesUI = defaultWorldbookEntriesUI;
        settings.categoryDefaultConfig = categoryDefaultConfig;
        settings.entryPositionConfig = entryPositionConfig;

        settings.customSuffixPrompt = document.getElementById('ttw-suffix-prompt')?.value || '';

        // 消息链配置已通过renderMessageChainUI内的事件实时保存到settings.promptMessageChain

        settings.customApiProvider = document.getElementById('ttw-api-provider')?.value || 'gemini';
        settings.customApiKey = document.getElementById('ttw-api-key')?.value || '';
        settings.customApiEndpoint = document.getElementById('ttw-api-endpoint')?.value || '';

        const modelSelectContainer = document.getElementById('ttw-model-select-container');
        const modelSelect = document.getElementById('ttw-model-select');
        const modelInput = document.getElementById('ttw-api-model');
        if (modelSelectContainer && modelSelectContainer.style.display !== 'none' && modelSelect?.value) {
            settings.customApiModel = modelSelect.value;
            if (modelInput) modelInput.value = modelSelect.value;
        } else {
            settings.customApiModel = modelInput?.value || 'gemini-2.5-flash';
        }

        try { localStorage.setItem('txtToWorldbookSettings', JSON.stringify(settings)); } catch (e) { }
        settings.allowRecursion = document.getElementById('ttw-allow-recursion')?.checked ?? false;

        settings.filterResponseTags = document.getElementById('ttw-filter-tags')?.value || 'thinking,/think';

        settings.debugMode = document.getElementById('ttw-debug-mode')?.checked ?? false;

        settings.plotOutlineExportConfig = plotOutlineExportConfig;

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
                if (settings.chapterRegexPattern) {
                    chapterRegexSettings.pattern = settings.chapterRegexPattern;
                }
                if (settings.defaultWorldbookEntriesUI) {
                    defaultWorldbookEntriesUI = settings.defaultWorldbookEntriesUI;
                }
                if (settings.categoryDefaultConfig) {
                    categoryDefaultConfig = settings.categoryDefaultConfig;
                }
                if (settings.entryPositionConfig) {
                    entryPositionConfig = settings.entryPositionConfig;
                }
                if (settings.plotOutlineExportConfig) {
                    plotOutlineExportConfig = settings.plotOutlineExportConfig;
                }

            }
        } catch (e) { }

        updateSettingsUI();
        updateChapterRegexUI();
    }

    function showPromptPreview() {
        const prompt = getSystemPrompt();
        const chapterForce = settings.forceChapterMarker ? getChapterForcePrompt(1) : '(已关闭)';
        const apiMode = settings.useTavernApi ? '酒馆API' : `自定义API (${settings.customApiProvider})`;
        const enabledCats = getEnabledCategories().map(c => c.name).join(', ');
        const chain = settings.promptMessageChain || [{ role: 'user', content: '{PROMPT}', enabled: true }];
        const enabledChain = chain.filter(m => m.enabled !== false);
        const chainInfo = enabledChain.map((m, i) => {
            const roleLabel = m.role === 'system' ? '🔷系统' : m.role === 'assistant' ? '🟡AI助手' : '🟢用户';
            const preview = m.content.length > 60 ? m.content.substring(0, 60) + '...' : m.content;
            return `  ${i + 1}. [${roleLabel}] ${preview}`;
        }).join('\n');
        alert(`当前提示词预览:\n\nAPI模式: ${apiMode}\n并行模式: ${parallelConfig.enabled ? parallelConfig.mode : '关闭'}\n强制章节标记: ${settings.forceChapterMarker ? '开启' : '关闭'}\n启用分类: ${enabledCats}\n\n【消息链 (${enabledChain.length}条消息)】\n${chainInfo}\n\n【章节强制标记示例】\n${chapterForce}\n\n【系统提示词】\n${prompt.substring(0, 1500)}${prompt.length > 1500 ? '...' : ''}`);
    }

    async function checkAndRestoreState() {
        try {
            const savedState = await MemoryHistoryDB.loadState();
            if (savedState && savedState.memoryQueue && savedState.memoryQueue.length > 0) {
                const processedCount = savedState.memoryQueue.filter(m => m.processed).length;
                if (confirm(`检测到未完成任务\n已处理: ${processedCount}/${savedState.memoryQueue.length}\n\n是否恢复？`)) {
                    memoryQueue = savedState.memoryQueue;
                    generatedWorldbook = savedState.generatedWorldbook || {};
                    worldbookVolumes = savedState.worldbookVolumes || [];
                    currentVolumeIndex = savedState.currentVolumeIndex || 0;
                    currentFileHash = savedState.fileHash;
                    // 【新增】从DB恢复小说名称
                    if (savedState.novelName) savedNovelName = savedState.novelName;
                    if (Object.keys(generatedWorldbook).length === 0) {
                        rebuildWorldbookFromMemories();
                    }

                    startFromIndex = memoryQueue.findIndex(m => !m.processed || m.failed);
                    if (startFromIndex === -1) startFromIndex = memoryQueue.length;
                    userSelectedStartIndex = null;
                    showQueueSection(true);
                    updateMemoryQueueUI();
                    if (useVolumeMode) updateVolumeIndicator();
                    if (startFromIndex >= memoryQueue.length || Object.keys(generatedWorldbook).length > 0) {
                        showResultSection(true);
                        updateWorldbookPreview();
                    }
                    updateStartButtonState(false);
                    updateSettingsUI();
                    document.getElementById('ttw-start-btn').disabled = false;

                    document.getElementById('ttw-upload-area').style.display = 'none';
                    document.getElementById('ttw-file-info').style.display = 'flex';
                    document.getElementById('ttw-file-name').textContent = '已恢复的任务';
                    const totalChars = memoryQueue.reduce((sum, m) => sum + m.content.length, 0);
                    document.getElementById('ttw-file-size').textContent = `(${(totalChars / 1024).toFixed(1)} KB, ${memoryQueue.length}章)`;
                    // 【新增】恢复小说名输入框
                    const novelNameRow = document.getElementById('ttw-novel-name-row');
                    if (novelNameRow) novelNameRow.style.display = 'flex';
                    const novelNameInput = document.getElementById('ttw-novel-name-input');
                    if (novelNameInput && savedNovelName) novelNameInput.value = savedNovelName;
                } else {
                    await MemoryHistoryDB.clearState();
                }
            }
        } catch (e) {
            console.error('恢复状态失败:', e);
        }
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
                if (historyList.length > 0 && confirm(`检测到新文件，是否清空旧历史？\n当前有 ${historyList.length} 条记录。`)) {
                    await MemoryHistoryDB.clearAllHistory();
                    await MemoryHistoryDB.clearAllRolls();
                    await MemoryHistoryDB.clearState();
                }
            }
            currentFileHash = newHash;
            await MemoryHistoryDB.saveFileHash(newHash);
            document.getElementById('ttw-upload-area').style.display = 'none';
            document.getElementById('ttw-file-info').style.display = 'flex';
            document.getElementById('ttw-file-name').textContent = file.name;
            document.getElementById('ttw-file-size').textContent = `(${(content.length / 1024).toFixed(1)} KB, ${encoding})`;
            // 【新增】自动提取文件名作为小说名
            savedNovelName = file.name.replace(/\.[^/.]+$/, '');
            const novelNameInput = document.getElementById('ttw-novel-name-input');
            if (novelNameInput) novelNameInput.value = savedNovelName;
            const novelNameRow = document.getElementById('ttw-novel-name-row');
            if (novelNameRow) novelNameRow.style.display = 'flex';
            splitContentIntoMemory(content);
            showQueueSection(true);
            updateMemoryQueueUI();
            document.getElementById('ttw-start-btn').disabled = false;
            startFromIndex = 0;
            userSelectedStartIndex = null;

            generatedWorldbook = { 地图环境: {}, 剧情节点: {}, 角色: {}, 知识书: {} };
            applyDefaultWorldbookEntries();
            if (Object.keys(generatedWorldbook).length > 0) {
                showResultSection(true);
                updateWorldbookPreview();
            }

            updateStartButtonState(false);
        } catch (error) {
            alert('文件处理失败: ' + error.message);
        }
    }

    function splitContentIntoMemory(content) {
        const chunkSize = settings.chunkSize;
        const minChunkSize = Math.max(chunkSize * 0.3, 5000);
        memoryQueue = [];

        const chapterRegex = new RegExp(chapterRegexSettings.pattern, 'g');
        const matches = [...content.matchAll(chapterRegex)];

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
                    } else {
                        if (pendingChapter.content.length >= minChunkSize) {
                            mergedChapters.push(pendingChapter);
                            pendingChapter = chapter;
                        } else {
                            pendingChapter.content += chapter.content;
                            pendingChapter.title += '+' + chapter.title;
                        }
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
                        memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                        currentChunk = '';
                        chunkIndex++;
                    }

                    let remaining = chapter.content;
                    while (remaining.length > 0) {
                        let endPos = Math.min(chunkSize, remaining.length);
                        if (endPos < remaining.length) {
                            const pb = remaining.lastIndexOf('\n\n', endPos);
                            if (pb > endPos * 0.5) endPos = pb + 2;
                            else {
                                const sb = remaining.lastIndexOf('。', endPos);
                                if (sb > endPos * 0.5) endPos = sb + 1;
                            }
                        }
                        memoryQueue.push({ title: `记忆${chunkIndex}`, content: remaining.slice(0, endPos), processed: false, failed: false, processing: false });
                        remaining = remaining.slice(endPos);
                        chunkIndex++;
                    }
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
                if (currentChunk.length < minChunkSize && memoryQueue.length > 0) {
                    const lastMemory = memoryQueue[memoryQueue.length - 1];
                    if (lastMemory.content.length + currentChunk.length <= chunkSize * 1.2) {
                        lastMemory.content += currentChunk;
                    } else {
                        memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                    }
                } else {
                    memoryQueue.push({ title: `记忆${chunkIndex}`, content: currentChunk, processed: false, failed: false, processing: false });
                }
            }
        } else {
            let i = 0, chunkIndex = 1;
            while (i < content.length) {
                let endIndex = Math.min(i + chunkSize, content.length);
                if (endIndex < content.length) {
                    const pb = content.lastIndexOf('\n\n', endIndex);
                    if (pb > i + chunkSize * 0.5) endIndex = pb + 2;
                    else {
                        const sb = content.lastIndexOf('。', endIndex);
                        if (sb > i + chunkSize * 0.5) endIndex = sb + 1;
                    }
                }
                memoryQueue.push({ title: `记忆${chunkIndex}`, content: content.slice(i, endIndex), processed: false, failed: false, processing: false });
                i = endIndex;
                chunkIndex++;
            }
        }

        for (let i = memoryQueue.length - 1; i > 0; i--) {
            if (memoryQueue[i].content.length < minChunkSize) {
                const prevMemory = memoryQueue[i - 1];
                if (prevMemory.content.length + memoryQueue[i].content.length <= chunkSize * 1.2) {
                    prevMemory.content += memoryQueue[i].content;
                    memoryQueue.splice(i, 1);
                }
            }
        }

        memoryQueue.forEach((memory, index) => { memory.title = `记忆${index + 1}`; });
    }

    // 新增：纯分块函数，返回内容数组（供"导入更新章节"复用）
    function splitContentIntoChunks(content) {
        const backup = memoryQueue;
        memoryQueue = [];
        splitContentIntoMemory(content);
        const chunks = memoryQueue.map(m => m.content);
        memoryQueue = backup;
        return chunks;
    }

    // ========== 新增：导入更新章节（支持两种模式，不影响已处理/已整理/已合并的条目） ==========
    async function importUpdateChapters() {
        if (memoryQueue.length === 0) {
            alert('请先加载原始文件后再导入更新章节');
            return;
        }

        // 先让用户选择导入模式
        const mode = await new Promise((resolve) => {
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

            m.querySelector('.ttw-modal-close').addEventListener('click', () => { m.remove(); resolve(null); });
            m.querySelector('#ttw-update-mode-cancel').addEventListener('click', () => { m.remove(); resolve(null); });
            m.addEventListener('click', (e) => { if (e.target === m) { m.remove(); resolve(null); } });
            m.querySelector('#ttw-update-mode-confirm').addEventListener('click', () => {
                const val = m.querySelector('input[name="ttw-update-mode"]:checked')?.value || 'append-only';
                m.remove();
                resolve(val);
            });
        });

        if (!mode) return;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const { content } = await detectBestEncoding(file);

                let newPart = '';

                if (mode === 'append-only') {
                    newPart = content.replace(/^\s+/, '');
                    if (!newPart || newPart.trim().length === 0) {
                        alert('导入的文件内容为空');
                        return;
                    }
                } else {
                    const oldContent = memoryQueue.map(m => m.content).join('');
                    const oldLen = oldContent.length;

                    if (content.length <= oldLen) {
                        if (!confirm('导入的文件长度不大于当前内容，可能没有新增章节。仍要继续吗？')) return;
                    }

                    const anchorLen = Math.min(2000, oldLen);
                    if (anchorLen > 0) {
                        const anchor = oldContent.slice(oldLen - anchorLen);
                        const anchorPos = content.indexOf(anchor);
                        if (anchorPos !== -1) {
                            newPart = content.slice(anchorPos + anchor.length);
                        } else {
                            newPart = content.slice(oldLen);
                        }
                    } else {
                        newPart = content.slice(oldLen);
                    }
                    newPart = newPart.replace(/^\s+/, '');

                    if (!newPart || newPart.trim().length === 0) {
                        alert('未检测到新增章节内容。\n\n如果你导入的是"只含新增部分"的文件，请改用「➕ 仅新增模式」。');
                        return;
                    }
                }

                const modeLabel = mode === 'append-only' ? '仅新增模式' : '完整文件模式';
                if (!confirm(`[${modeLabel}] 检测到约 ${(newPart.length / 1000).toFixed(1)}k 字的新增内容。\n\n将分块后追加到章节队列末尾，已处理/已整理/已合并的条目保持不变。\n\n确定导入吗？`)) {
                    return;
                }

                const prevQueueLen = memoryQueue.length;

                const newChunks = splitContentIntoChunks(newPart);
                if (newChunks.length === 0) {
                    alert('新增内容分块结果为空');
                    return;
                }

                for (const chunk of newChunks) {
                    memoryQueue.push({
                        title: '',
                        content: chunk,
                        processed: false,
                        failed: false,
                        processing: false
                    });
                }

                memoryQueue.forEach((m, i) => { m.title = `记忆${i + 1}`; });

                const totalChars = memoryQueue.reduce((sum, m) => sum + m.content.length, 0);
                const sizeEl = document.getElementById('ttw-file-size');
                if (sizeEl) sizeEl.textContent = `(${(totalChars / 1024).toFixed(1)} KB, ${memoryQueue.length}章)`;

                startFromIndex = prevQueueLen;
                userSelectedStartIndex = null;

                updateMemoryQueueUI();
                updateStartButtonState(false);

                try { await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length); } catch (err) { }

                alert(`已追加 ${newChunks.length} 个新章节（第${prevQueueLen + 1}~${memoryQueue.length}章）。\n\n点击"开始/继续转换"将只处理新增章节，已整理和别名合并的条目不会被刷新。`);

            } catch (error) {
                alert('导入更新章节失败: ' + error.message);
            }
        };
        input.click();
    }

    async function clearFile() {
        currentFile = null;
        savedNovelName = '';
        memoryQueue = [];
        generatedWorldbook = {};
        worldbookVolumes = [];
        currentVolumeIndex = 0;
        startFromIndex = 0;
        userSelectedStartIndex = null;
        currentFileHash = null;
        isMultiSelectMode = false;
        selectedMemoryIndices.clear();

        try {
            await MemoryHistoryDB.clearAllHistory();
            await MemoryHistoryDB.clearAllRolls();
            await MemoryHistoryDB.clearState();
            await MemoryHistoryDB.clearFileHash();
            console.log('已清空所有历史记录');
        } catch (e) {
            console.error('清空历史失败:', e);
        }

        document.getElementById('ttw-upload-area').style.display = 'block';
        document.getElementById('ttw-file-info').style.display = 'none';
        document.getElementById('ttw-file-input').value = '';
        // 【新增】清空小说名输入框
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

    async function startConversion() {
        saveCurrentSettings();
        if (memoryQueue.length === 0) { alert('请先上传文件'); return; }

        if (!settings.useTavernApi) {
            const provider = settings.customApiProvider;
            if ((provider === 'gemini' || provider === 'deepseek' || provider === 'gemini-proxy') && !settings.customApiKey) {
                alert('请先设置 API Key');
                return;
            }
            if ((provider === 'gemini-proxy' || provider === 'openai-compatible') && !settings.customApiEndpoint) {
                alert('请先设置 API Endpoint');
                return;
            }
        }

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
        const failedCount = memoryQueue.filter(m => m.failed).length;
        const repairBtn = document.getElementById('ttw-repair-btn');
        if (failedCount > 0) { repairBtn.style.display = 'inline-block'; repairBtn.textContent = `🔧 修复失败 (${failedCount})`; }
        else { repairBtn.style.display = 'none'; }
    }

    function updateMemoryQueueUI() {
        const container = document.getElementById('ttw-memory-queue');
        if (!container) return;
        container.innerHTML = '';

        const multiSelectBar = document.getElementById('ttw-multi-select-bar');
        if (multiSelectBar) {
            multiSelectBar.style.display = isMultiSelectMode ? 'block' : 'none';
        }

        const selectedCountEl = document.getElementById('ttw-selected-count');
        if (selectedCountEl) {
            selectedCountEl.textContent = `已选: ${selectedMemoryIndices.size}`;
        }

        memoryQueue.forEach((memory, index) => {
            const item = document.createElement('div');
            item.className = 'ttw-memory-item';

            if (isMultiSelectMode) {
                item.classList.add('multi-select-mode');
                if (selectedMemoryIndices.has(index)) {
                    item.classList.add('selected-for-delete');
                }
            }

            if (memory.processing) {
                item.style.borderLeft = '3px solid #3498db';
                item.style.background = 'rgba(52,152,219,0.15)';
            } else if (memory.processed && !memory.failed) {
                item.style.opacity = '0.6';
            } else if (memory.failed) {
                item.style.borderLeft = '3px solid #e74c3c';
            }

            let statusIcon = '⏳';
            if (memory.processing) statusIcon = '🔄';
            else if (memory.processed && !memory.failed) statusIcon = '✅';
            else if (memory.failed) statusIcon = '❗';

            if (isMultiSelectMode) {
                const isSelected = selectedMemoryIndices.has(index);
                item.innerHTML = `
                    <input type="checkbox" class="ttw-memory-checkbox" data-index="${index}" ${isSelected ? 'checked' : ''} style="width:16px;height:16px;accent-color:#e74c3c;">
                    <span>${statusIcon}</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">第${index + 1}章</span>
                    <small style="font-size:11px;color:#888;">${(memory.content.length / 1000).toFixed(1)}k</small>
                    ${memory.failed ? `<small style="color:#e74c3c;font-size:11px;">错误</small>` : ''}
                `;

                const checkbox = item.querySelector('.ttw-memory-checkbox');
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (e.target.checked) {
                        selectedMemoryIndices.add(index);
                        item.classList.add('selected-for-delete');
                    } else {
                        selectedMemoryIndices.delete(index);
                        item.classList.remove('selected-for-delete');
                    }
                    if (selectedCountEl) {
                        selectedCountEl.textContent = `已选: ${selectedMemoryIndices.size}`;
                    }
                });

                item.addEventListener('click', (e) => {
                    if (e.target.type !== 'checkbox') {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                    }
                });
            } else {
                item.innerHTML = `<span>${statusIcon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">第${index + 1}章</span><small style="font-size:11px;color:#888;">${(memory.content.length / 1000).toFixed(1)}k</small>${memory.failed ? `<small style="color:#e74c3c;font-size:11px;">错误</small>` : ''}`;
                item.addEventListener('click', () => showMemoryContentModal(index));
            }

            container.appendChild(item);
        });
    }

    function updateWorldbookPreview() {
        const container = document.getElementById('ttw-result-preview');
        const worldbookToShow = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
        let headerInfo = '';
        if (useVolumeMode && worldbookVolumes.length > 0) {
            headerInfo = `<div style="margin-bottom:12px;padding:10px;background:rgba(155,89,182,0.2);border-radius:6px;font-size:12px;color:#bb86fc;">📦 分卷模式 | 共 ${worldbookVolumes.length} 卷</div>`;
        }
        container.innerHTML = headerInfo + formatWorldbookAsCards(worldbookToShow);
        bindLightToggleEvents(container);
        bindConfigButtonEvents(container);
        bindEntryRerollEvents(container);
        bindEntryDeleteEvents(container);
    }

    function formatWorldbookAsCards(worldbook) {
        if (!worldbook || Object.keys(worldbook).length === 0) {
            return '<div style="text-align:center;color:#888;padding:20px;">暂无世界书数据</div>';
        }
        let html = '';
        let totalEntries = 0;
        let totalTokens = 0;
        let belowThresholdCount = 0;

        for (const category in worldbook) {
            const entries = worldbook[category];
            const entryCount = typeof entries === 'object' ? Object.keys(entries).length : 0;
            if (entryCount === 0) continue;
            totalEntries += entryCount;

            const isGreen = getCategoryLightState(category);
            const lightClass = isGreen ? 'green' : 'blue';
            const lightIcon = isGreen ? '🟢' : '🔵';
            const lightTitle = isGreen ? '绿灯(触发式) - 点击切换为蓝灯' : '蓝灯(常驻) - 点击切换为绿灯';

            // 计算分类token总数
            let categoryTokens = 0;
            for (const entryName in entries) {
                categoryTokens += getEntryTotalTokens(entries[entryName]);
            }
            totalTokens += categoryTokens;

            html += `<div style="margin-bottom:12px;border:1px solid #e67e22;border-radius:8px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#e67e22,#d35400);padding:10px 14px;cursor:pointer;font-weight:bold;display:flex;justify-content:space-between;align-items:center;" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
                    <span style="display:flex;align-items:center;">📁 ${category}<button class="ttw-light-toggle ${lightClass}" data-category="${category}" title="${lightTitle}" onclick="event.stopPropagation();">${lightIcon}</button><button class="ttw-config-btn" data-category="${category}" title="配置分类默认位置/深度" onclick="event.stopPropagation();">⚙️</button><button class="ttw-cat-delete-btn" data-category="${category}" title="删除整个分类" onclick="event.stopPropagation();" style="margin-left:4px;background:rgba(231,76,60,0.35);border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px;color:#fff;">🗑️</button></span>
                    <span style="font-size:12px;">${entryCount} 条目 | <span style="color:#f1c40f;">~${categoryTokens} tk</span></span>
                </div>
                <div style="background:#2d2d2d;display:none;">`;

            for (const entryName of naturalSortEntryNames(Object.keys(entries))) {
                const entry = entries[entryName];
                const config = getEntryConfig(category, entryName);
                const autoIncrement = getCategoryAutoIncrement(category);
                const baseOrder = getCategoryBaseOrder(category);

                // 计算实际显示顺序（基于自然排序后的索引）
                let displayOrder = config.order;
                if (autoIncrement) {
                    const sortedNames = naturalSortEntryNames(Object.keys(entries));
                    const entryIndex = sortedNames.indexOf(entryName);
                    displayOrder = baseOrder + entryIndex;
                }

                // 计算条目token数
                const entryTokens = getEntryTotalTokens(entry);

                // 判断是否低于阈值需要高亮
                const isBelowThreshold = tokenHighlightThreshold > 0 && entryTokens < tokenHighlightThreshold;
                if (isBelowThreshold) belowThresholdCount++;

                const highlightStyle = isBelowThreshold ? 'background:#7f1d1d;border-left:3px solid #ef4444;' : 'border-left:3px solid #3498db;';
                const tokenStyle = isBelowThreshold ? 'color:#ef4444;font-weight:bold;' : 'color:#f1c40f;';
                const warningIcon = isBelowThreshold ? '⚠️ ' : '';

                html += `<div style="margin:8px;border:1px solid #555;border-radius:6px;overflow:hidden;">
        <div style="background:#3a3a3a;padding:8px 12px;cursor:pointer;display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;${highlightStyle}" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
            <span style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${warningIcon}📄 ${entryName}<button class="ttw-entry-config-btn ttw-config-btn" data-category="${category}" data-entry="${entryName}" title="配置位置/深度/顺序" onclick="event.stopPropagation();">⚙️</button><button class="ttw-entry-reroll-btn" data-category="${category}" data-entry="${entryName}" title="单独重Roll此条目" onclick="event.stopPropagation();" style="background:rgba(155,89,182,0.4);border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;color:#fff;">🎯</button><button class="ttw-entry-delete-btn" data-category="${category}" data-entry="${entryName}" title="删除此条目" onclick="event.stopPropagation();" style="background:rgba(231,76,60,0.35);border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;color:#fff;">🗑️</button></span>
            <span style="font-size:9px;color:#888;display:flex;gap:4px;align-items:center;">
                <span style="${tokenStyle}">${entryTokens}tk</span>
                <span>D${config.depth}O${displayOrder}${autoIncrement ? '↗' : ''}</span>
            </span>
        </div>
        <div style="display:none;background:#1c1c1c;padding:12px;">`;

                if (entry && typeof entry === 'object') {
                    if (entry['关键词']) {
                        const keywords = Array.isArray(entry['关键词']) ? entry['关键词'].join(', ') : entry['关键词'];
                        const keywordTokens = estimateTokenCount(keywords);
                        html += `<div style="margin-bottom:8px;padding:8px;background:#252525;border-left:3px solid #9b59b6;border-radius:4px;">
                <div style="color:#9b59b6;font-size:11px;margin-bottom:4px;display:flex;justify-content:space-between;">
                    <span>🔑 关键词</span>
                    <span style="color:#888;">~${keywordTokens} tk</span>
                </div>
                <div style="font-size:13px;">${keywords}</div>
            </div>`;
                    }
                    if (entry['内容']) {
                        let content = String(entry['内容']).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*(.+?)\*\*/g, '<strong style="color:#3498db;">$1</strong>').replace(/\n/g, '<br>');
                        const contentTokens = estimateTokenCount(entry['内容']);
                        // 如果有搜索关键词，高亮显示
                        if (searchHighlightKeyword) {
                            const regex = new RegExp(searchHighlightKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                            content = content.replace(regex, `<span style="background:#f1c40f;color:#000;padding:1px 2px;border-radius:2px;">${searchHighlightKeyword}</span>`);
                        }
                        html += `<div style="padding:8px;background:#252525;border-left:3px solid #27ae60;border-radius:4px;line-height:1.6;">
                <div style="color:#27ae60;font-size:11px;margin-bottom:4px;display:flex;justify-content:space-between;">
                    <span>📝 内容</span>
                    <span style="color:#888;">~${contentTokens} tk</span>
                </div>
                <div style="font-size:13px;">${content}</div>
            </div>`;
                    }
                }
                html += `</div></div>`;
            }
            html += `</div></div>`;
        }

        // 统计信息
        const thresholdInfo = tokenHighlightThreshold > 0
            ? ` | <span style="color:#ef4444;">⚠️ ${belowThresholdCount}个条目低于${tokenHighlightThreshold}tk</span>`
            : '';

        return `<div style="margin-bottom:12px;font-size:13px;">共 ${Object.keys(worldbook).filter(k => Object.keys(worldbook[k]).length > 0).length} 个分类, ${totalEntries} 个条目 | <span style="color:#f1c40f;">总计 ~${totalTokens} tk</span>${thresholdInfo}</div>` + html;
    }

    function bindLightToggleEvents(container) {
        container.querySelectorAll('.ttw-light-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const category = btn.dataset.category;
                const currentState = getCategoryLightState(category);
                const newState = !currentState;
                setCategoryLightState(category, newState);

                btn.className = `ttw-light-toggle ${newState ? 'green' : 'blue'}`;
                btn.textContent = newState ? '🟢' : '🔵';
                btn.title = newState ? '绿灯(触发式) - 点击切换为蓝灯' : '蓝灯(常驻) - 点击切换为绿灯';
            });
        });
    }

    function bindConfigButtonEvents(container) {
        // 分类配置按钮
        container.querySelectorAll('.ttw-config-btn[data-category]:not([data-entry])').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const category = btn.dataset.category;
                showCategoryConfigModal(category);
            });
        });

        // 条目配置按钮
        container.querySelectorAll('.ttw-entry-config-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const category = btn.dataset.category;
                const entryName = btn.dataset.entry;
                showEntryConfigModal(category, entryName);
            });
        });
    }

    // ========== 新增：绑定条目重Roll按钮事件 ==========
    function bindEntryRerollEvents(container) {
        container.querySelectorAll('.ttw-entry-reroll-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const category = btn.dataset.category;
                const entryName = btn.dataset.entry;
                showRerollEntryModal(category, entryName, () => {
                    // 重Roll完成后刷新视图
                    updateWorldbookPreview();
                    const viewModal = document.getElementById('ttw-worldbook-view-modal');
                    if (viewModal) {
                        const worldbookToShow = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
                        const bodyContainer = viewModal.querySelector('#ttw-worldbook-view-body');
                        if (bodyContainer) {
                            bodyContainer.innerHTML = formatWorldbookAsCards(worldbookToShow);
                            bindLightToggleEvents(bodyContainer);
                            bindConfigButtonEvents(bodyContainer);
                            bindEntryRerollEvents(bodyContainer);
                        }
                    }
                });
            });
        });
    }

    // ========== 新增：绑定条目/分类删除按钮事件 ==========
    function bindEntryDeleteEvents(container, refreshCallback) {
        const doRefresh = () => {
            updateWorldbookPreview();
            if (typeof refreshCallback === 'function') refreshCallback();
        };

        // 删除单个条目
        container.querySelectorAll('.ttw-entry-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const category = btn.dataset.category;
                const entryName = btn.dataset.entry;
                if (!confirm(`确定删除条目「${entryName}」吗？\n\n（仅从世界书中删除，不影响原文章节）`)) return;

                if (generatedWorldbook[category] && generatedWorldbook[category][entryName]) {
                    delete generatedWorldbook[category][entryName];
                }
                const cfgKey = `${category}::${entryName}`;
                if (entryPositionConfig[cfgKey]) {
                    delete entryPositionConfig[cfgKey];
                    settings.entryPositionConfig = entryPositionConfig;
                    saveCurrentSettings();
                }
                doRefresh();
            });
        });

        // 删除整个分类
        container.querySelectorAll('.ttw-cat-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const category = btn.dataset.category;
                const count = generatedWorldbook[category] ? Object.keys(generatedWorldbook[category]).length : 0;
                if (!confirm(`确定删除整个分类「${category}」及其 ${count} 个条目吗？\n\n（仅从世界书中删除，不影响原文章节）`)) return;

                if (generatedWorldbook[category]) {
                    for (const entryName in generatedWorldbook[category]) {
                        const cfgKey = `${category}::${entryName}`;
                        if (entryPositionConfig[cfgKey]) delete entryPositionConfig[cfgKey];
                    }
                    delete generatedWorldbook[category];
                    settings.entryPositionConfig = entryPositionConfig;
                    saveCurrentSettings();
                }
                doRefresh();
            });
        });
    }

    function showWorldbookView() {
        const existingModal = document.getElementById('ttw-worldbook-view-modal');
        if (existingModal) existingModal.remove();
        const worldbookToShow = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
        const viewModal = document.createElement('div');
        viewModal.id = 'ttw-worldbook-view-modal';
        viewModal.className = 'ttw-modal-container';
        viewModal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📖 世界书详细视图${useVolumeMode ? ` (${worldbookVolumes.length}卷合并)` : ''}</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div style="padding:10px 15px;background:#1a1a1a;border-bottom:1px solid #444;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <span style="font-size:12px;color:#888;">🔍 Token阈值:</span>
                    <input type="number" id="ttw-token-threshold-input" value="${tokenHighlightThreshold}" min="0" step="50" style="width:80px;padding:4px 8px;border-radius:4px;border:1px solid #555;background:#2d2d2d;color:#fff;font-size:12px;" placeholder="0">
                    <button class="ttw-btn ttw-btn-small" id="ttw-apply-threshold">应用</button>
                    <span style="font-size:11px;color:#666;">低于此值的条目将红色高亮（0=关闭）</span>
                </div>
                <div class="ttw-modal-body" id="ttw-worldbook-view-body">${formatWorldbookAsCards(worldbookToShow)}</div>
                <div class="ttw-modal-footer">
                    <div style="font-size:11px;color:#888;margin-right:auto;">💡 点击⚙️配置，点击🎯单独重Roll条目，点击灯图标切换蓝/绿灯</div>
                    <button class="ttw-btn ttw-btn-secondary" id="ttw-manual-merge-btn" title="手动选择条目进行合并（AI识别不到时使用）">✋ 手动合并</button>
                    <button class="ttw-btn ttw-btn-secondary" id="ttw-batch-reroll-btn" title="批量选择多个条目重Roll">🎲 批量重Roll</button>
                    <button class="ttw-btn" id="ttw-close-worldbook-view">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(viewModal);

        // 绑定手动合并按钮
        viewModal.querySelector('#ttw-manual-merge-btn').addEventListener('click', () => {
            showManualMergeUI(() => {
                // 合并完成后刷新视图
                const bodyContainer = viewModal.querySelector('#ttw-worldbook-view-body');
                const worldbookToRefresh = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
                bodyContainer.innerHTML = formatWorldbookAsCards(worldbookToRefresh);
                bindLightToggleEvents(bodyContainer);
                bindConfigButtonEvents(bodyContainer);
                bindEntryRerollEvents(bodyContainer);
                bindEntryDeleteEvents(bodyContainer, _refreshWbView);
            });
        });

        // 绑定批量重Roll按钮
        viewModal.querySelector('#ttw-batch-reroll-btn').addEventListener('click', () => {
            showBatchRerollModal(() => {
                // 刷新视图
                const bodyContainer = viewModal.querySelector('#ttw-worldbook-view-body');
                const worldbookToRefresh = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
                bodyContainer.innerHTML = formatWorldbookAsCards(worldbookToRefresh);
                bindLightToggleEvents(bodyContainer);
                bindConfigButtonEvents(bodyContainer);
                bindEntryRerollEvents(bodyContainer);
                bindEntryDeleteEvents(bodyContainer, _refreshWbView);
            });
        });

        // 绑定阈值应用事件
        viewModal.querySelector('#ttw-apply-threshold').addEventListener('click', () => {
            const input = viewModal.querySelector('#ttw-token-threshold-input');
            tokenHighlightThreshold = parseInt(input.value) || 0;
            // 重新渲染内容
            const bodyContainer = viewModal.querySelector('#ttw-worldbook-view-body');
            bodyContainer.innerHTML = formatWorldbookAsCards(worldbookToShow);
            bindLightToggleEvents(bodyContainer);
            bindConfigButtonEvents(bodyContainer);
            bindEntryRerollEvents(bodyContainer);
            bindEntryDeleteEvents(bodyContainer, _refreshWbView);
        });

        // 支持回车键应用
        viewModal.querySelector('#ttw-token-threshold-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                viewModal.querySelector('#ttw-apply-threshold').click();
            }
        });

        const _wbBody = viewModal.querySelector('#ttw-worldbook-view-body');
        const _refreshWbView = () => {
            const wb = useVolumeMode ? getAllVolumesWorldbook() : generatedWorldbook;
            _wbBody.innerHTML = formatWorldbookAsCards(wb);
            bindLightToggleEvents(_wbBody);
            bindConfigButtonEvents(_wbBody);
            bindEntryRerollEvents(_wbBody);
            bindEntryDeleteEvents(_wbBody, _refreshWbView);
        };
        bindLightToggleEvents(_wbBody);
        bindConfigButtonEvents(_wbBody);
        bindEntryRerollEvents(_wbBody);
        bindEntryDeleteEvents(_wbBody, _refreshWbView);
        viewModal.querySelector('.ttw-modal-close').addEventListener('click', () => viewModal.remove());
        viewModal.querySelector('#ttw-close-worldbook-view').addEventListener('click', () => viewModal.remove());
        viewModal.addEventListener('click', (e) => { if (e.target === viewModal) viewModal.remove(); });
    }

    async function showHistoryView() {
        const existingModal = document.getElementById('ttw-history-modal');
        if (existingModal) existingModal.remove();
        let historyList = [];
        try { await MemoryHistoryDB.cleanDuplicateHistory(); historyList = await MemoryHistoryDB.getAllHistory(); } catch (e) { }

        const historyModal = document.createElement('div');
        historyModal.id = 'ttw-history-modal';
        historyModal.className = 'ttw-modal-container';

        let listHtml = historyList.length === 0 ? '<div style="text-align:center;color:#888;padding:10px;font-size:11px;">暂无历史</div>' : '';
        if (historyList.length > 0) {
            const sortedList = [...historyList].sort((a, b) => b.timestamp - a.timestamp);
            sortedList.forEach((history) => {
                const time = new Date(history.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                const changeCount = history.changedEntries?.length || 0;
                const shortTitle = (history.memoryTitle || `第${history.memoryIndex + 1}章`).substring(0, 8);
                listHtml += `
                    <div class="ttw-history-item" data-history-id="${history.id}">
                        <div class="ttw-history-item-title" title="${history.memoryTitle}">${shortTitle}</div>
                        <div class="ttw-history-item-time">${time}</div>
                        <div class="ttw-history-item-info">${changeCount}项</div>
                    </div>
                `;
            });
        }

        historyModal.innerHTML = `
            <div class="ttw-modal" style="max-width:900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📜 修改历史 (${historyList.length}条)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div class="ttw-history-container">
                        <div class="ttw-history-left">${listHtml}</div>
                        <div id="ttw-history-detail" class="ttw-history-right">
                            <div style="text-align:center;color:#888;padding:20px;font-size:12px;">👈 点击左侧查看详情</div>
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
            if (confirm('确定清空所有历史记录？')) { await MemoryHistoryDB.clearAllHistory(); historyModal.remove(); showHistoryView(); }
        });
        historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.remove(); });

        historyModal.querySelectorAll('.ttw-history-item').forEach(item => {
            item.addEventListener('click', async () => {
                const historyId = parseInt(item.dataset.historyId);
                const history = await MemoryHistoryDB.getHistoryById(historyId);
                const detailContainer = historyModal.querySelector('#ttw-history-detail');
                historyModal.querySelectorAll('.ttw-history-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                if (!history) { detailContainer.innerHTML = '<div style="text-align:center;color:#e74c3c;padding:40px;">找不到记录</div>'; return; }
                const time = new Date(history.timestamp).toLocaleString('zh-CN');
                let html = `
                    <div style="margin-bottom:15px;padding-bottom:15px;border-bottom:1px solid #444;">
                        <h4 style="color:#e67e22;margin:0 0 10px;font-size:14px;">📝 ${history.memoryTitle}</h4>
                        <div style="font-size:11px;color:#888;">时间: ${time}</div>
                        <div style="margin-top:10px;"><button class="ttw-btn ttw-btn-small ttw-btn-warning" onclick="window.TxtToWorldbook._rollbackToHistory(${historyId})">⏪ 回退到此版本前</button></div>
                    </div>
                    <div style="font-size:13px;font-weight:bold;color:#9b59b6;margin-bottom:10px;">变更 (${history.changedEntries?.length || 0}项)</div>
                `;
                if (history.changedEntries && history.changedEntries.length > 0) {
                    history.changedEntries.forEach(change => {
                        const typeIcon = change.type === 'add' ? '➕' : change.type === 'modify' ? '✏️' : '❌';
                        const typeColor = change.type === 'add' ? '#27ae60' : change.type === 'modify' ? '#3498db' : '#e74c3c';
                        html += `<div style="background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;margin-bottom:6px;border-left:3px solid ${typeColor};font-size:12px;">
                            <span style="color:${typeColor};">${typeIcon}</span>
                            <span style="color:#e67e22;margin-left:6px;">[${change.category}] ${change.entryName}</span>
                        </div>`;
                    });
                } else { html += '<div style="color:#888;text-align:center;padding:20px;font-size:12px;">无变更记录</div>'; }
                detailContainer.innerHTML = html;
            });
        });
    }

    async function rollbackToHistory(historyId) {
        if (!confirm('确定回退到此版本？页面将刷新。')) return;
        try {
            const history = await MemoryHistoryDB.rollbackToHistory(historyId);
            for (let i = 0; i < memoryQueue.length; i++) {
                if (i < history.memoryIndex) memoryQueue[i].processed = true;
                else { memoryQueue[i].processed = false; memoryQueue[i].failed = false; }
            }
            await MemoryHistoryDB.saveState(history.memoryIndex);
            alert('回退成功！页面将刷新。');
            location.reload();
        } catch (error) { alert('回退失败: ' + error.message); }
    }

    function closeModal() {
        isProcessingStopped = true;
        isRerolling = false;
        if (globalSemaphore) globalSemaphore.abort();
        activeParallelTasks.clear();
        memoryQueue.forEach(m => { if (m.processing) m.processing = false; });

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
        exportSettings,
        importSettings,
        getParallelConfig: () => parallelConfig,
        rerollMemory,
        rerollSingleEntry,
        findEntrySourceMemories,
        showRerollEntryModal,
        showBatchRerollModal, // 新增：批量重Roll多条目
        showRollHistory: showRollHistorySelector,
        importAndMerge: importAndMergeWorldbook,
        getCategoryLightSettings: () => categoryLightSettings,
        setCategoryLight: setCategoryLightState,
        rebuildWorldbook: rebuildWorldbookFromMemories,
        applyDefaultWorldbook: applyDefaultWorldbookEntries,
        getSettings: () => settings,
        callCustomAPI,
        callSillyTavernAPI,
        showConsolidateCategorySelector,
        showAliasMergeUI,
        showManualMergeUI,
        getCustomCategories: () => customWorldbookCategories,
        getEnabledCategories,
        getChapterRegexSettings: () => chapterRegexSettings,
        rechunkMemories,
        showSearchModal,
        showReplaceModal,
        getEntryConfig,
        setEntryConfig,
        setCategoryDefaultConfig,
        getDefaultWorldbookEntriesUI: () => defaultWorldbookEntriesUI,
        // 新增：条目Roll历史相关
        getEntryRollHistory: (cat, entry) => MemoryHistoryDB.getEntryRollResults(cat, entry),
        clearEntryRollHistory: (cat, entry) => MemoryHistoryDB.clearEntryRollResults(cat, entry)
    };

    console.log('📚 TxtToWorldbook v3.2.0 已加载 - 新增: 导入更新章节(两种模式)+条目/分类删除');
})();
