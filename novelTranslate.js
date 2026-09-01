// ============================================================
// novelTranslate.js - 小说翻译模块
// 功能：导入TXT小说，并发翻译成中文，导出带目录的EPUB或TXT
//
// 设计要点：
// - 单文件，不依赖 txtToWorldbook，API 配置独立
// - 译文用 <译文></译文> 包裹，靠标签闭合判断是否被截断
// - 术语表保证并发时人名地名统一（前N章串行预热 + 逐章滚动补充）
// - 断点续传：IndexedDB 存原文和译文，刷新/崩溃后可恢复
// ============================================================

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const DB_NAME = 'NovelTranslateDB';
    const DB_VERSION = 1;
    const STORE_STATE = 'translateState';

    // ============================================
    // 默认配置
    // ============================================
    const DEFAULT_PROMPT = `你是专业的小说翻译。请把下面的小说正文完整翻译成简体中文。

## 翻译要求
- **完整翻译**：不得省略、概括或跳过原文的任何内容，逐句翻译
- **只输出译文**：不要添加解释、注释、说明或任何原文
- **保持格式**：原文的分段、换行、对话格式全部保留
- **自然流畅**：符合中文小说的表达习惯，不要生硬直译
- **章节标题也要翻译**成中文
- 不要输出 JSON、不要输出 Markdown 代码块，直接输出小说正文

## 输出格式
把译文完整包裹在标签里：
<译文>
（这里是翻译好的正文）
</译文>`;

    const DEFAULT_CHAPTER_REGEX = '第([0-9一二三四五六七八九十百千零\\d]+)话[ \\t：:]*(.*)';

    const CHAPTER_REGEX_PRESETS = [
        { label: '第X话：标题', value: '第([0-9一二三四五六七八九十百千零\\d]+)话[ \\t：:]*(.*)' },
        { label: '第X话（可无标题）', value: '第([0-9一二三四五六七八九十百千零\\d]+)话[ \\t：:]*(.*)$' },
        { label: '第X章：标题', value: '第([0-9一二三四五六七八九十百千零\\d]+)章[ \\t：:]*(.*)' },
        { label: '第X節/节', value: '第([0-9一二三四五六七八九十百千零\\d]+)[节節][ \\t：:]*(.*)' },
        { label: 'Chapter X', value: 'Chapter\\s+([0-9]+)[\\s.:：]*(.*)' },
        { label: '纯数字标题行', value: '^\\s*([0-9]+)\\s*$()' },
    ];

    const defaultSettings = {
        // API
        apiProvider: 'openai-compatible',
        apiKey: '',
        apiEndpoint: '',
        apiModel: '',
        apiTimeout: 300000, // 无响应超时，翻译输出长，给宽一些
        temperature: 0.3,
        maxTokens: null,

        // 分块（始终按长度切，不再按正则切）
        blockAsChapter: false, // true=强制「一个记忆块 = 一章」；false=块内保留原文自身的话数/章数
        chunkTokens: 30000,
        chapterRegex: DEFAULT_CHAPTER_REGEX,
        exportSplitByRegex: true, // 导出时用正则在译文里重新划分章节，做出正确目录

        // 并发与衔接
        concurrency: 3,
        warmupChapters: 3, // 前N章串行，用于建立术语表
        contextPrevChars: 300,
        contextNextChars: 300,

        // 提示词
        customPrompt: DEFAULT_PROMPT,
        promptMessageChain: [{ role: 'user', content: '{PROMPT}', enabled: true }],
        importedPresetName: '',

        // 术语表
        glossaryEnabled: true,
        glossary: [], // [{ source: '原文', target: '中文', note: '' }]

        // 导出
        bookTitle: '',
        bookAuthor: '',
        txtTitleFormat: 'original', // original | arabic | chinese
    };

    // ============================================
    // 运行时状态
    // ============================================
    const State = {
        settings: { ...defaultSettings },
        file: { name: '', hash: '' },
        chapters: [], // { index, num, rawTitle, title, source, translated, status, error }
        status: 'idle', // idle | running | stopped
        isStopped: false,
        stats: { done: 0, failed: 0, total: 0 },
        timings: [],
        activeStreamOwner: null,
        streamAutoScroll: true,
        streamContent: '',
        db: null,
    };

    const STATUS = {
        PENDING: 'pending',
        RUNNING: 'running',
        DONE: 'done',
        FAILED: 'failed',
    };

    // ============================================
    // 小工具
    // ============================================
    function esc(s) {
        const d = document.createElement('span');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function escXml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function log(msg, type = 'info') {
        const p = { info: '📘', ok: '✅', warn: '⚠️', err: '❌' }[type] || 'ℹ️';
        console.log(`[NovelTranslate] ${p} ${msg}`);
    }

    /**
     * 粗略估算 token 数。
     * 中日韩字符约 1 字 = 1 token，拉丁字母约 4 字符 = 1 token。
     * 只用于分块决策，不需要精确。
     */
    function estimateTokens(text) {
        if (!text) return 0;
        const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef\uac00-\ud7af]/g) || []).length;
        const rest = text.length - cjk;
        return Math.ceil(cjk + rest / 4);
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /**
     * 中文数字转阿拉伯数字，用于统一章节编号显示
     */
    function cnNumToInt(str) {
        const s = String(str).trim();
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        const units = { 十: 10, 百: 100, 千: 1000 };
        let total = 0;
        let current = 0;
        for (const ch of s) {
            if (map[ch] !== undefined) {
                current = map[ch];
            } else if (units[ch]) {
                total += (current || 1) * units[ch];
                current = 0;
            }
        }
        return total + current || NaN;
    }

    function intToCn(n) {
        if (!Number.isFinite(n)) return String(n);
        const digits = '零一二三四五六七八九';
        if (n < 10) return digits[n];
        if (n < 20) return '十' + (n % 10 ? digits[n % 10] : '');
        if (n < 100) {
            return digits[Math.floor(n / 10)] + '十' + (n % 10 ? digits[n % 10] : '');
        }
        return String(n);
    }

    // ============================================
    // 文件编码检测
    // ============================================
    async function detectBestEncoding(file) {
        const buffer = await file.arrayBuffer();
        const encodings = ['utf-8', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];
        let best = { encoding: 'utf-8', content: '', score: -Infinity };

        for (const enc of encodings) {
            try {
                const decoder = new TextDecoder(enc, { fatal: false });
                const text = decoder.decode(buffer);
                // 替换字符越少越好；可读字符越多越好
                const bad = (text.match(/\ufffd/g) || []).length;
                const readable = (text.match(/[\u3000-\u9fff\uff00-\uffef\uac00-\ud7af\w\s]/g) || []).length;
                const score = readable - bad * 50;
                if (score > best.score) best = { encoding: enc, content: text, score };
            } catch (e) {
                /* 该编码不支持，跳过 */
            }
        }
        return { encoding: best.encoding, content: best.content };
    }

    async function hashText(text) {
        try {
            const buf = new TextEncoder().encode(text.slice(0, 200000));
            const digest = await crypto.subtle.digest('SHA-1', buf);
            return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            // 非安全上下文没有 crypto.subtle，退化为长度+片段
            return `${text.length}_${text.slice(0, 50).replace(/\s/g, '')}`;
        }
    }

    // ============================================
    // IndexedDB：断点续传
    // ============================================
    function openDB() {
        return new Promise((resolve, reject) => {
            if (State.db) return resolve(State.db);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_STATE)) {
                    db.createObjectStore(STORE_STATE, { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => {
                State.db = e.target.result;
                resolve(State.db);
            };
            req.onerror = (e) => reject(e.target.error || new Error('打开数据库失败'));
        });
    }

    async function dbPut(key, value) {
        try {
            const db = await openDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE_STATE], 'readwrite');
                tx.objectStore(STORE_STATE).put({ key, value, timestamp: Date.now() });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            log(`保存状态失败: ${e.message}`, 'warn');
        }
    }

    async function dbGet(key) {
        try {
            const db = await openDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE_STATE], 'readonly');
                const req = tx.objectStore(STORE_STATE).get(key);
                req.onsuccess = () => resolve(req.result ? req.result.value : null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return null;
        }
    }

    async function dbDelete(key) {
        try {
            const db = await openDB();
            await new Promise((resolve) => {
                const tx = db.transaction([STORE_STATE], 'readwrite');
                tx.objectStore(STORE_STATE).delete(key);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch (e) {
            /* 忽略 */
        }
    }

    /** 保存当前进度，供刷新后恢复 */
    async function saveProgress() {
        await dbPut('current', {
            version: VERSION,
            fileName: State.file.name,
            fileHash: State.file.hash,
            chapters: State.chapters.map((c) => ({
                index: c.index,
                num: c.num,
                rawTitle: c.rawTitle,
                title: c.title,
                source: c.source,
                translated: c.translated,
                status: c.status === STATUS.RUNNING ? STATUS.PENDING : c.status,
                error: c.error,
            })),
            glossary: State.settings.glossary,
            savedAt: Date.now(),
        });
    }

    let autoSaveTimer = null;
    function startAutoSave() {
        stopAutoSave();
        autoSaveTimer = setInterval(() => {
            if (State.status === 'running') saveProgress();
        }, 60000);
        window.addEventListener('beforeunload', saveProgress);
    }
    function stopAutoSave() {
        if (autoSaveTimer) clearInterval(autoSaveTimer);
        autoSaveTimer = null;
    }

    // ============================================
    // 设置持久化
    // ============================================
    function loadSettings() {
        try {
            const raw = localStorage.getItem('novelTranslateSettings');
            if (raw) {
                const saved = JSON.parse(raw);
                State.settings = { ...defaultSettings, ...saved };
                // 数组字段防止被旧数据污染成非数组
                if (!Array.isArray(State.settings.glossary)) State.settings.glossary = [];
                if (!Array.isArray(State.settings.promptMessageChain)) {
                    State.settings.promptMessageChain = [{ role: 'user', content: '{PROMPT}', enabled: true }];
                }
                // 旧版本的 forceChunkMode 已废弃：现在恒为按长度切块。
                // 旧值 true（无视原文章节）对应新的「块即章节」，语义上最接近。
                if (Object.prototype.hasOwnProperty.call(saved, 'forceChunkMode')) {
                    if (typeof saved.blockAsChapter !== 'boolean') {
                        State.settings.blockAsChapter = !!saved.forceChunkMode;
                    }
                    delete State.settings.forceChunkMode;
                }
            }
        } catch (e) {
            log(`读取设置失败，使用默认值: ${e.message}`, 'warn');
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem('novelTranslateSettings', JSON.stringify(State.settings));
        } catch (e) {
            log(`保存设置失败: ${e.message}`, 'warn');
        }
    }

    // ============================================
    // 章节切分
    // ============================================

    /**
     * 按正则识别原文章节。
     *
     * 捕获组约定：组1=话数/章数，组2=标题（可为空，走兜底）。
     * 匹配不到任何章节时返回 null，由调用方决定是否退化为按大小切。
     *
     * @param {string} content 全文
     * @param {string} regexStr 用户填写的正则
     * @returns {Array|null}
     */
    function splitByChapterRegex(content, regexStr) {
        let re;
        try {
            re = new RegExp(regexStr, 'gm');
        } catch (e) {
            throw new Error(`章节正则无效: ${e.message}`);
        }

        const marks = [];
        let m;
        let guard = 0;
        while ((m = re.exec(content)) !== null && guard++ < 100000) {
            // 防止零宽匹配死循环
            if (m.index === re.lastIndex) re.lastIndex++;

            let matched = m[0];
            let titleRaw = m[2] !== undefined ? String(m[2]) : '';

            // 关键修正：常见写法里的 [\s：:]+ 中 \s 是包含换行的。
            // 遇到「第12话」后面直接换行、本话没有标题时，正则会吃掉换行，
            // 把下一行正文误当成标题——标题错了，正文还少一行。
            // 这里把匹配串截断到第一行，标题也只取第一行，多余部分还给正文。
            const nlInMatch = matched.indexOf('\n');
            if (nlInMatch !== -1) {
                matched = matched.slice(0, nlInMatch);
                // 标题若来自换行之后，说明本话根本没有标题
                const nlInTitle = titleRaw.indexOf('\n');
                titleRaw = nlInTitle !== -1 ? titleRaw.slice(0, nlInTitle) : '';
                if (!matched.includes(titleRaw)) titleRaw = '';
            }

            const numRaw = m[1] !== undefined ? m[1] : String(marks.length + 1);
            marks.push({
                start: m.index,
                headerEnd: m.index + matched.length,
                numRaw,
                titleRaw: titleRaw.trim(),
                fullMatch: matched.trim(),
            });
        }

        if (marks.length === 0) return null;

        const chapters = [];
        // 第一个章节标记之前的内容（序章、前言）单独成章，避免丢失
        if (marks[0].start > 0) {
            const pre = content.slice(0, marks[0].start).trim();
            if (pre.length > 0) {
                chapters.push({
                    index: 0,
                    num: '',
                    rawTitle: '前言',
                    title: '前言',
                    source: pre,
                    translated: '',
                    status: STATUS.PENDING,
                    error: '',
                });
            }
        }

        marks.forEach((mark, i) => {
            const end = i + 1 < marks.length ? marks[i + 1].start : content.length;
            const body = content.slice(mark.headerEnd, end).trim();
            // 兜底：正则没抓到标题时，用整个匹配串当标题（例如只有「第12话」）
            const displayTitle = mark.titleRaw || mark.fullMatch;
            chapters.push({
                index: chapters.length,
                num: mark.numRaw,
                rawTitle: displayTitle,
                title: displayTitle,
                source: body,
                translated: '',
                status: STATUS.PENDING,
                error: '',
            });
        });

        // 重排 index 保证连续
        chapters.forEach((c, i) => (c.index = i));
        return chapters;
    }

    /**
     * 无视原文章节，按 token 上限硬切。
     * 尽量在段落边界切开，避免把句子劈断。
     */
    function splitBySize(content, maxTokens) {
        const paragraphs = content.split(/\n{2,}/);
        const chunks = [];
        let buf = '';

        const flush = () => {
            const t = buf.trim();
            if (t) chunks.push(t);
            buf = '';
        };

        for (const para of paragraphs) {
            const candidate = buf ? buf + '\n\n' + para : para;
            if (estimateTokens(candidate) > maxTokens && buf) {
                flush();
                buf = para;
            } else {
                buf = candidate;
            }
            // 单个段落本身就超限，按行再切
            while (estimateTokens(buf) > maxTokens) {
                const lines = buf.split('\n');
                let part = '';
                let rest = [];
                for (let i = 0; i < lines.length; i++) {
                    const next = part ? part + '\n' + lines[i] : lines[i];
                    if (estimateTokens(next) > maxTokens && part) {
                        rest = lines.slice(i);
                        break;
                    }
                    part = next;
                }
                if (!part) break;
                chunks.push(part.trim());
                buf = rest.join('\n');
                if (!rest.length) break;
            }
        }
        flush();

        return chunks.map((text, i) => ({
            index: i,
            num: String(i + 1),
            rawTitle: `第${i + 1}部分`,
            title: `第${i + 1}部分`,
            source: text,
            translated: '',
            status: STATUS.PENDING,
            error: '',
        }));
    }

    /**
     * 单章超过 token 上限时，把它拆成多个片段分别翻译，再拼回。
     * 对用户透明：界面上仍然是一章。
     */
    function splitOversizedChapter(source, maxTokens) {
        const pieces = splitBySize(source, maxTokens);
        return pieces.map((p) => p.source);
    }

    // ============================================
    // 术语表
    // ============================================

    /** 术语表转成提示词片段。空表返回空串，不浪费 token。 */
    function buildGlossaryBlock() {
        const g = State.settings.glossary;
        if (!State.settings.glossaryEnabled || !Array.isArray(g) || g.length === 0) return '';
        const lines = g
            .filter((it) => it && it.source && it.target)
            .map((it) => `- ${it.source} → ${it.target}${it.note ? `（${it.note}）` : ''}`);
        if (lines.length === 0) return '';
        return `\n## 专有名词对照表（必须严格遵守，不得改译）\n${lines.join('\n')}\n`;
    }

    /**
     * 把 AI 回报的新术语并入表中。
     * 已存在的原文不覆盖，避免后面的章节把前面定好的译名改掉。
     */
    function mergeGlossary(items) {
        if (!Array.isArray(items) || items.length === 0) return 0;
        const g = State.settings.glossary;
        const known = new Set(g.map((it) => String(it.source).trim()));
        let added = 0;
        for (const it of items) {
            if (!it) continue;
            const source = String(it.source || it['原文'] || '').trim();
            const target = String(it.target || it['译名'] || '').trim();
            if (!source || !target || known.has(source)) continue;
            g.push({ source, target, note: String(it.note || it['说明'] || '').trim() });
            known.add(source);
            added++;
        }
        if (added > 0) saveSettings();
        return added;
    }

    /** 从译文中解析 AI 附带回报的新术语 */
    function extractReportedTerms(rawResponse) {
        const m = rawResponse.match(/<新术语>([\s\S]*?)<\/新术语>/);
        if (!m) return [];
        const body = m[1].trim();
        if (!body || body === '无') return [];
        const out = [];
        for (const line of body.split('\n')) {
            // 支持「原文 → 译名（说明）」和「原文 -> 译名」
            const mm = line.match(/^\s*[-*·]?\s*(.+?)\s*(?:→|->|=>)\s*(.+?)\s*(?:（(.*)）|\((.*)\))?\s*$/);
            if (!mm) continue;
            out.push({ source: mm[1].trim(), target: mm[2].trim(), note: (mm[3] || mm[4] || '').trim() });
        }
        return out;
    }

    // ============================================
    // 提示词组装
    // ============================================

    /**
     * 为某一章构造完整提示词。
     *
     * @param {object} chapter 当前章
     * @param {string} pieceText 实际要翻译的文本（可能是超长章的某一段）
     * @param {object} opts { prevTail, nextHead, pieceInfo }
     */
    function buildPrompt(chapter, pieceText, opts = {}) {
        const s = State.settings;
        const parts = [s.customPrompt.trim()];

        // 章节纪律：取决于「强制记忆块为章节」开关
        if (s.blockAsChapter) {
            parts.push(
                `\n## 章节纪律（重要）\n` +
                    `下面给出的这一整块正文，请**当作完整的第 ${chapter.index + 1} 章**来处理。\n` +
                    `- 整块合起来就是一章，**不要在块内部再划分章节**\n` +
                    `- 即使原文中间出现「第X话」「第X章」之类的字样，也不要据此另起新章\n` +
                    `- 不要自行添加额外的章节标题、编号或分隔线\n` +
                    `- 只翻译下面给出的这一块内容`,
            );
        } else {
            parts.push(
                `\n## 章节纪律（重要）\n` +
                    `下面给出的正文是按长度切出来的一块，**不代表章节边界**，` +
                    `块内可能包含原文的多话/多章，也可能只是某一话的一部分。\n` +
                    `- 必须**严格沿用原文自身的话数/章数**，原文是第几话就翻成第几话\n` +
                    `- **不得合并**多话为一话，**不得拆分**一话为多话\n` +
                    `- **不要**把这一块当成一章，也**不要**自行添加原文没有的章节编号\n` +
                    `- 原文里的章节标题行照常翻译并**单独成行**保留`,
            );
        }

        const glossary = buildGlossaryBlock();
        if (glossary) parts.push(glossary);

        if (opts.prevTail) {
            parts.push(
                `\n## 上文结尾（仅供衔接参考，**不要翻译这部分**）\n<上文>\n${opts.prevTail}\n</上文>`,
            );
        }
        if (opts.nextHead) {
            parts.push(
                `\n## 下文开头（仅供衔接参考，**不要翻译这部分**）\n<下文>\n${opts.nextHead}\n</下文>`,
            );
        }

        if (opts.pieceInfo) {
            parts.push(
                `\n## 注意\n本章较长，已拆分处理。当前是第 ${opts.pieceInfo.current}/${opts.pieceInfo.total} 部分，` +
                    `请只翻译下面这一部分，不要重复其他部分的内容，也不要添加额外的开头结尾。`,
            );
        }

        if (State.settings.glossaryEnabled) {
            parts.push(
                `\n## 附带任务\n翻译完成后，如果本章出现了对照表里**没有**的人名、地名、组织名、特殊称谓，` +
                    `请在译文标签之后另起一段列出，格式如下（没有新词就写「无」）：\n` +
                    `<新术语>\n原文 → 译名（可选说明）\n</新术语>`,
            );
        }

        const titleLine = s.blockAsChapter ? `本块编号：第 ${chapter.index + 1} 块（即第 ${chapter.index + 1} 章）\n` : '';
        parts.push(`\n## 待翻译正文\n${titleLine}<原文>\n${pieceText}\n</原文>`);

        return parts.join('\n');
    }

    /** 把提示词按消息链展开成 messages 数组 */
    function applyMessageChain(prompt) {
        const chain = State.settings.promptMessageChain;
        if (!Array.isArray(chain) || chain.length === 0) {
            return [{ role: 'user', content: prompt }];
        }
        const enabled = chain.filter((m) => m && m.enabled !== false);
        if (enabled.length === 0) return [{ role: 'user', content: prompt }];
        return enabled
            .map((m) => ({
                role: m.role || 'user',
                content: (m.content || '').replace(/\{PROMPT\}/g, prompt),
            }))
            .filter((m) => m.content.trim().length > 0);
    }

    // ============================================
    // 酒馆预设导入（与世界书模块同一套解析规则）
    // ============================================
    const ST_MARKER_MAP = {
        chatHistory: '{PROMPT}',
        worldInfoBefore: null,
        worldInfoAfter: null,
        charDescription: null,
        charPersonality: null,
        scenario: null,
        personaDescription: null,
        dialogueExamples: null,
    };

    function parseTavernPreset(json) {
        if (!json || !Array.isArray(json.prompts)) {
            throw new Error('不是有效的酒馆对话补全预设（缺少 prompts 数组）');
        }
        const byId = {};
        for (const p of json.prompts) if (p && p.identifier) byId[p.identifier] = p;

        let order = null;
        if (Array.isArray(json.prompt_order) && json.prompt_order.length) {
            const global =
                json.prompt_order.find((o) => o.character_id === 100001) ||
                json.prompt_order[json.prompt_order.length - 1];
            order = Array.isArray(global && global.order) ? global.order : null;
        }
        if (!order) order = json.prompts.map((p) => ({ identifier: p.identifier, enabled: p.enabled !== false }));

        const chain = [];
        const depthInjections = [];
        let dropped = 0;
        let skippedEmpty = 0;
        let hasSlot = false;

        for (const item of order) {
            const p = byId[item.identifier];
            if (!p) continue;
            const enabled = item.enabled !== false;

            if (p.marker === true || Object.prototype.hasOwnProperty.call(ST_MARKER_MAP, p.identifier)) {
                if (ST_MARKER_MAP[p.identifier] === '{PROMPT}') {
                    chain.push({ role: 'user', content: '{PROMPT}', enabled });
                    hasSlot = true;
                } else dropped++;
                continue;
            }

            const content = (p.content || '').trim();
            if (!content) {
                skippedEmpty++;
                continue;
            }
            let role = p.role || 'system';
            if (!['system', 'user', 'assistant'].includes(role)) role = 'system';
            const entry = { role, content, enabled };

            if (p.injection_position === 1) {
                entry.__depth = typeof p.injection_depth === 'number' ? p.injection_depth : 4;
                depthInjections.push(entry);
            } else chain.push(entry);
        }

        if (depthInjections.length) {
            depthInjections.sort((a, b) => b.__depth - a.__depth);
            const slotIdx = chain.findIndex((m) => m.content === '{PROMPT}');
            chain.splice(slotIdx >= 0 ? slotIdx + 1 : chain.length, 0, ...depthInjections);
        }
        if (!hasSlot) chain.push({ role: 'user', content: '{PROMPT}', enabled: true });

        let final = chain;
        if (json.squash_system_messages === true) {
            final = [];
            for (const m of chain) {
                const prev = final[final.length - 1];
                if (prev && prev.role === 'system' && m.role === 'system' && m.content !== '{PROMPT}') {
                    prev.content += '\n\n' + m.content;
                } else final.push({ role: m.role, content: m.content, enabled: m.enabled });
            }
        } else {
            final = chain.map((m) => ({ role: m.role, content: m.content, enabled: m.enabled }));
        }

        const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);
        return {
            chain: final,
            params: {
                temperature: num(json.temperature),
                maxTokens: num(json.openai_max_tokens) !== null ? num(json.openai_max_tokens) : num(json.max_tokens),
            },
            stats: { used: final.length, dropped, skippedEmpty, hasSlot },
        };
    }

    // ============================================
    // API 调用层
    // 独立于世界书模块，配置不共用
    // ============================================

    const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
    const RETRYABLE_KEYWORDS = [
        'overloaded', 'rate limit', 'too many requests', 'timeout', 'timed out',
        'econnreset', 'bad gateway', 'service unavailable', 'temporarily',
        'socket hang up', 'network', 'fetch failed',
    ];

    function isRetryable(error) {
        if (!error) return false;
        if (error.status && RETRYABLE_STATUS.has(error.status)) return true;
        const msg = String(error.message || '').toLowerCase();
        return RETRYABLE_KEYWORDS.some((k) => msg.includes(k));
    }

    function buildChatUrl(endpoint) {
        let base = (endpoint || '').trim();
        if (!base) return 'https://api.openai.com/v1/chat/completions';
        if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
        base = base.replace(/\/+$/, '');
        if (/\/chat\/completions$/i.test(base)) return base;
        return base + '/chat/completions';
    }

    /**
     * 把消息数组转成 Gemini 的 contents 结构。
     * Gemini 不接受 system 角色，统一并入第一条 user。
     */
    function toGeminiContents(messages) {
        const systemParts = [];
        const contents = [];
        for (const m of messages) {
            if (m.role === 'system') {
                systemParts.push(m.content);
                continue;
            }
            contents.push({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
            });
        }
        if (systemParts.length) {
            const head = systemParts.join('\n\n');
            if (contents.length && contents[0].role === 'user') {
                contents[0].parts[0].text = head + '\n\n' + contents[0].parts[0].text;
            } else {
                contents.unshift({ role: 'user', parts: [{ text: head }] });
            }
        }
        if (!contents.length) contents.push({ role: 'user', parts: [{ text: '请开始。' }] });
        return { contents };
    }

    /** Anthropic 要求 system 提到顶层，messages 以 user 开头且同角色相邻需合并 */
    function toAnthropicMessages(messages) {
        const systemParts = [];
        const rest = [];
        for (const m of messages) {
            if (m.role === 'system') {
                if (m.content) systemParts.push(m.content);
            } else {
                rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
            }
        }
        const merged = [];
        for (const m of rest) {
            const prev = merged[merged.length - 1];
            if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
            else merged.push({ ...m });
        }
        if (!merged.length) merged.push({ role: 'user', content: '请开始。' });
        else if (merged[0].role !== 'user') merged.unshift({ role: 'user', content: '请翻译以下内容。' });
        return { system: systemParts.join('\n\n'), messages: merged };
    }

    /**
     * @param {Array} messages
     * @param {object} opts { stream=true, maxTokens } —— 快速测试走非流式，输出上限也另给
     */
    function buildRequest(messages, opts = {}) {
        const s = State.settings;
        const wantStream = opts.stream !== false;
        const provider = ['openai-compatible', 'gemini', 'anthropic'].includes(s.apiProvider)
            ? s.apiProvider
            : 'openai-compatible';
        const openaiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

        if (provider === 'anthropic') {
            if (!s.apiKey) throw new Error('Anthropic API Key 未设置');
            let base = (s.apiEndpoint || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
            const url = base.includes('/v1/messages') ? base : base + '/v1/messages';
            const { system, messages: am } = toAnthropicMessages(messages);
            const body = {
                model: s.apiModel || 'claude-sonnet-4-20250514',
                messages: am,
                temperature: s.temperature,
                max_tokens: opts.maxTokens || s.maxTokens || 8192,
                stream: wantStream,
            };
            if (system) body.system = system;
            return {
                url,
                options: {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': s.apiKey,
                        'anthropic-version': '2023-06-01',
                        // 浏览器直连必须声明，否则被 CORS 拦掉
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify(body),
                },
            };
        }

        if (provider === 'gemini') {
            if (!s.apiKey) throw new Error('Gemini API Key 未设置');
            const model = s.apiModel || 'gemini-2.5-flash';
            let url;
            if (s.apiEndpoint) {
                let base = s.apiEndpoint.trim();
                if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
                base = base.replace(/\/+$/, '');
                const sep = base.includes('?') ? '&' : '?';
                url = wantStream
                    ? `${base}/${model}:streamGenerateContent${sep}alt=sse&key=${s.apiKey}`
                    : `${base}/${model}:generateContent${sep}key=${s.apiKey}`;
            } else {
                const g = 'https://generativelanguage.googleapis.com/v1beta/models/';
                url = wantStream
                    ? `${g}${model}:streamGenerateContent?alt=sse&key=${s.apiKey}`
                    : `${g}${model}:generateContent?key=${s.apiKey}`;
            }
            return {
                url,
                options: {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...toGeminiContents(messages),
                        generationConfig: {
                            maxOutputTokens: opts.maxTokens || s.maxTokens || 65536,
                            temperature: s.temperature,
                        },
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                        ],
                    }),
                },
            };
        }

        const headers = { 'Content-Type': 'application/json' };
        if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
        const body = {
            model: s.apiModel || 'local-model',
            messages: openaiMessages,
            temperature: s.temperature,
            stream: wantStream,
        };
        if (opts.maxTokens || s.maxTokens) body.max_tokens = opts.maxTokens || s.maxTokens;
        return { url: buildChatUrl(s.apiEndpoint), options: { method: 'POST', headers, body: JSON.stringify(body) } };
    }

    /**
     * 构造 OpenAI 兼容接口的 /models 地址。
     * 规则与世界书模块一致：以 /chat/completions 结尾则替换，已是 /models 则不动，否则追加。
     */
    function buildModelsUrl(endpoint) {
        let url = (endpoint || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        if (/\/chat\/completions$/i.test(url)) url = url.replace(/\/chat\/completions$/i, '/models');
        else if (!/\/models$/i.test(url)) url += '/models';
        return url;
    }

    /** 带超时的 GET/POST JSON，模型拉取和快速测试共用 */
    async function fetchJSON(url, options = {}, timeout = 30000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        let resp;
        try {
            resp = await fetch(url, { ...options, signal: controller.signal });
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error(`请求超时 (${timeout / 1000}秒)`);
            throw new Error(`网络错误: ${e.message}`);
        }
        clearTimeout(timer);
        const text = await resp.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (e) {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
            throw new Error('返回的不是合法 JSON: ' + text.slice(0, 200));
        }
        if (!resp.ok) {
            const msg = data?.error?.message || data?.message || text.slice(0, 200) || resp.statusText;
            const err = new Error(`HTTP ${resp.status}: ${msg}`);
            err.status = resp.status;
            throw err;
        }
        return data;
    }

    /**
     * 拉取当前提供商的可用模型列表。
     * 三家的接口和返回结构都不一样，这里各走各的。
     */
    async function fetchModelList() {
        const s = State.settings;
        const provider = s.apiProvider;

        if (provider === 'anthropic') {
            let base = (s.apiEndpoint || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
            base = base.replace(/\/v1\/messages$/i, '');
            if (!s.apiKey) throw new Error('请先填写 API Key');
            const data = await fetchJSON(base + '/v1/models', {
                method: 'GET',
                headers: {
                    'x-api-key': s.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
            });
            return (data?.data || []).map((m) => m.id || m.name).filter(Boolean);
        }

        if (provider === 'gemini') {
            if (!s.apiKey) throw new Error('请先填写 API Key');
            let base = (s.apiEndpoint || 'https://generativelanguage.googleapis.com/v1beta').trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
            base = base.replace(/\/models$/i, '');
            const data = await fetchJSON(`${base}/models?key=${encodeURIComponent(s.apiKey)}&pageSize=200`, {
                method: 'GET',
            });
            return (data?.models || [])
                .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
                .map((m) => String(m.name || '').replace(/^models\//, ''))
                .filter(Boolean);
        }

        const url = buildModelsUrl(s.apiEndpoint);
        const headers = { 'Content-Type': 'application/json' };
        if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
        const data = await fetchJSON(url, { method: 'GET', headers });
        if (Array.isArray(data?.data)) return data.data.map((m) => m.id || m.name || m).filter(Boolean);
        if (Array.isArray(data)) return data.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
        if (Array.isArray(data?.models)) {
            return data.models.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
        }
        return [];
    }

    /**
     * 发一条最短的请求验证「地址 + Key + 模型」这条链路通不通。
     * 走非流式，省得为了测试再解析一遍 SSE。
     */
    async function quickTestModel() {
        const s = State.settings;
        if (!s.apiModel) throw new Error('请先填写或选择模型');

        const messages = [{ role: 'user', content: '回复「OK」两个字即可。' }];
        const { url, options } = buildRequest(messages, { stream: false, maxTokens: 64 });

        const started = Date.now();
        const data = await fetchJSON(url, options, 60000);
        const elapsed = Date.now() - started;

        let reply = '';
        if (Array.isArray(data?.choices) && data.choices.length) {
            reply = data.choices[0]?.message?.content || data.choices[0]?.text || '';
        } else if (Array.isArray(data?.content)) {
            reply = data.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
        } else if (Array.isArray(data?.candidates)) {
            const parts = data.candidates[0]?.content?.parts;
            if (Array.isArray(parts)) reply = parts.map((p) => p?.text || '').join('');
        }

        if (!reply) {
            const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
            if (blocked && blocked !== 'STOP') throw new Error(`接口通了但没返回内容 (${blocked})`);
        }
        return { elapsed, reply: String(reply || '').trim() };
    }

    /** 从一条 SSE 负载里抽取增量文本，兼容三家格式 */
    function extractDelta(parsed) {
        if (!parsed || typeof parsed !== 'object') return '';
        const oa = parsed.choices?.[0]?.delta?.content;
        if (typeof oa === 'string' && oa) return oa;
        const oaMsg = parsed.choices?.[0]?.message?.content;
        if (typeof oaMsg === 'string' && oaMsg) return oaMsg;
        if (parsed.type === 'content_block_delta') {
            const t = parsed.delta?.text;
            if (typeof t === 'string' && t) return t;
        }
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
            if (text) return text;
        }
        return '';
    }

    function extractStreamError(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.type === 'error' && parsed.error) return parsed.error.message || '未知错误';
        if (parsed.error) return parsed.error.message || '未知错误';
        if (parsed.promptFeedback?.blockReason) return `内容被安全策略拦截 (${parsed.promptFeedback.blockReason})`;
        return null;
    }

    /**
     * 发起一次翻译请求。
     *
     * 超时策略是「无数据活动超时」：只要还在传字就不中断。
     * 翻译输出很长，用总时长做超时必然误杀。
     */
    async function callAPI(messages, onChunk) {
        const timeout = State.settings.apiTimeout || 300000;
        const { url, options } = buildRequest(messages);

        const controller = new AbortController();
        let headerTimer = setTimeout(() => controller.abort(), timeout);

        let response;
        try {
            response = await fetch(url, { ...options, signal: controller.signal });
        } catch (e) {
            clearTimeout(headerTimer);
            if (e.name === 'AbortError') {
                const err = new Error(`请求超时：${Math.round(timeout / 1000)}秒内没有响应`);
                err.status = 408;
                throw err;
            }
            throw e;
        }
        clearTimeout(headerTimer);

        if (!response.ok) {
            let detail = '';
            try {
                detail = (await response.text()).slice(0, 300);
            } catch (e) {
                /* 读不出正文就算了 */
            }
            const err = new Error(`API 返回 ${response.status}${detail ? ': ' + detail : ''}`);
            err.status = response.status;
            throw err;
        }
        if (!response.body) throw new Error('流式响应不可用');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        let buffer = '';
        let idleTimer = null;
        let timedOut = false;
        let streamError = null;

        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                timedOut = true;
                try {
                    reader.cancel();
                } catch (e) {
                    /* 已关闭 */
                }
            }, timeout);
        };

        const consume = (line) => {
            const t = line.trim();
            if (!t || t.startsWith(':') || !t.startsWith('data:')) return;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') return;
            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch (e) {
                return;
            }
            const err = extractStreamError(parsed);
            if (err && !streamError) streamError = err;
            const delta = extractDelta(parsed);
            if (delta) {
                full += delta;
                if (typeof onChunk === 'function') {
                    try {
                        onChunk(delta, full);
                    } catch (e) {
                        /* 界面异常不该中断读流 */
                    }
                }
            }
        };

        resetIdle();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                resetIdle();
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) consume(line);
            }
        } finally {
            if (idleTimer) clearTimeout(idleTimer);
        }
        if (buffer.trim()) consume(buffer);

        if (timedOut) {
            const err = new Error(`响应中断：${Math.round(timeout / 1000)}秒内没有收到新数据`);
            err.status = 408;
            throw err;
        }
        if (streamError && !full) throw new Error(`流式响应错误: ${streamError}`);
        return full;
    }

    /** 指数退避重试 */
    async function withRetry(task, retries = 3, onRetry) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (State.isStopped) throw new Error('ABORTED');
            try {
                return await task(attempt);
            } catch (e) {
                lastError = e;
                if (e.message === 'ABORTED') throw e;
                if (attempt >= retries || !isRetryable(e)) throw e;
                const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
                if (typeof onRetry === 'function') onRetry(e, attempt + 1, delay);
                await sleep(delay);
            }
        }
        throw lastError;
    }

    // ============================================
    // 译文校验与提取
    // ============================================

    /**
     * 从 AI 回复里提取译文。
     *
     * 靠 <译文></译文> 标签闭合判断是否被截断——这比看长度可靠得多：
     * 输出被 max_tokens 砍掉时，闭合标签一定不在。
     *
     * @returns {{ok:boolean, text:string, reason:string}}
     */
    function extractTranslation(raw) {
        if (!raw || !raw.trim()) {
            return { ok: false, text: '', reason: '返回内容为空' };
        }

        const open = raw.indexOf('<译文>');
        const close = raw.lastIndexOf('</译文>');

        if (open === -1 && close === -1) {
            // AI 没按格式来，但内容可能是完整的。
            // 剥掉可能的 markdown 代码块后当作译文，交给长度检查兜底。
            const cleaned = raw
                .replace(/^```[a-zA-Z]*\s*/m, '')
                .replace(/```\s*$/m, '')
                .replace(/<新术语>[\s\S]*?<\/新术语>/g, '')
                .trim();
            if (!cleaned) return { ok: false, text: '', reason: '返回内容为空' };
            return { ok: true, text: cleaned, reason: '未使用标签，已按纯文本处理' };
        }

        if (open !== -1 && close === -1) {
            return { ok: false, text: '', reason: '译文标签未闭合，输出被截断' };
        }
        if (open === -1 && close !== -1) {
            // 只有闭标签，取它之前的内容
            const text = raw.slice(0, close).replace(/<新术语>[\s\S]*?<\/新术语>/g, '').trim();
            return text
                ? { ok: true, text, reason: '缺少开标签，已按位置截取' }
                : { ok: false, text: '', reason: '译文内容为空' };
        }
        if (close < open) {
            return { ok: false, text: '', reason: '译文标签顺序错乱' };
        }

        const text = raw.slice(open + 4, close).trim();
        if (!text) return { ok: false, text: '', reason: '译文标签内没有内容' };
        return { ok: true, text, reason: '' };
    }

    /**
     * 长度合理性检查。
     *
     * 中文译文通常比日文原文短、比英文原文短不少，所以阈值放得很宽，
     * 只拦截明显异常（比如只翻了个开头就断了）。
     */
    function checkLength(source, translated) {
        const st = estimateTokens(source);
        const tt = estimateTokens(translated);
        if (st === 0) return { ok: true };
        const ratio = tt / st;
        if (ratio < 0.25) {
            return {
                ok: false,
                reason: `译文明显过短（约为原文的 ${Math.round(ratio * 100)}%），疑似被截断或漏译`,
            };
        }
        return { ok: true };
    }

    // ============================================
    // 翻译流水线
    // ============================================

    /** 取上一章结尾 / 下一章开头，用于衔接 */
    function getContextAround(index) {
        const s = State.settings;
        const prev = State.chapters[index - 1];
        const next = State.chapters[index + 1];
        const prevTail =
            prev && s.contextPrevChars > 0 ? String(prev.source || '').slice(-s.contextPrevChars).trim() : '';
        const nextHead =
            next && s.contextNextChars > 0 ? String(next.source || '').slice(0, s.contextNextChars).trim() : '';
        return { prevTail, nextHead };
    }

    /**
     * 翻译单个章节。超长时自动拆成多段，分别翻译后拼回。
     *
     * @param {object} chapter
     * @param {boolean} allowLiveStream 是否允许把流式内容打到界面（并发时只给一个任务）
     */
    async function translateChapter(chapter, allowLiveStream) {
        const s = State.settings;
        const { prevTail, nextHead } = getContextAround(chapter.index);

        const sourceTokens = estimateTokens(chapter.source);
        const limit = s.chunkTokens;
        const pieces =
            sourceTokens > limit ? splitOversizedChapter(chapter.source, limit) : [chapter.source];

        if (pieces.length > 1) {
            appendStream(`\n📎 「${chapter.rawTitle}」较长(约${sourceTokens}tk)，拆成 ${pieces.length} 段处理\n`);
        }

        const outputs = [];
        for (let i = 0; i < pieces.length; i++) {
            if (State.isStopped) throw new Error('ABORTED');

            const opts = {
                // 只有第一段带上文，只有最后一段带下文，中间段不需要
                prevTail: i === 0 ? prevTail : '',
                nextHead: i === pieces.length - 1 ? nextHead : '',
                pieceInfo: pieces.length > 1 ? { current: i + 1, total: pieces.length } : null,
            };
            const prompt = buildPrompt(chapter, pieces[i], opts);
            const messages = applyMessageChain(prompt);

            const result = await withRetry(
                async () => {
                    let live = false;
                    if (allowLiveStream && State.activeStreamOwner === null) {
                        State.activeStreamOwner = chapter.index;
                        live = true;
                    } else if (allowLiveStream && State.activeStreamOwner === chapter.index) {
                        live = true;
                    }

                    let headerShown = false;
                    const onChunk = live
                        ? (delta) => {
                              if (!headerShown) {
                                  appendStream(`\n💬 正在翻译「${chapter.rawTitle}」：\n`);
                                  headerShown = true;
                              }
                              appendStream(delta);
                          }
                        : null;

                    try {
                        const raw = await callAPI(messages, onChunk);
                        const extracted = extractTranslation(raw);
                        if (!extracted.ok) {
                            const err = new Error(extracted.reason);
                            err.status = 408; // 当作可重试：多半是截断
                            throw err;
                        }
                        const lenCheck = checkLength(pieces[i], extracted.text);
                        if (!lenCheck.ok) {
                            const err = new Error(lenCheck.reason);
                            err.status = 408;
                            throw err;
                        }
                        // 顺带收集新术语
                        if (s.glossaryEnabled) {
                            const added = mergeGlossary(extractReportedTerms(raw));
                            if (added > 0) appendStream(`\n📖 新增 ${added} 条术语\n`);
                        }
                        return extracted.text;
                    } finally {
                        if (live && State.activeStreamOwner === chapter.index) State.activeStreamOwner = null;
                    }
                },
                3,
                (err, attempt, delay) => {
                    appendStream(`\n⏳ 「${chapter.rawTitle}」第${attempt}次重试（${err.message}），${delay / 1000}秒后...\n`);
                },
            );

            outputs.push(result);
        }

        return outputs.join('\n\n');
    }

    /** 信号量，控制并发 */
    class Semaphore {
        constructor(max) {
            this.max = Math.max(1, max);
            this.count = 0;
            this.queue = [];
        }
        acquire() {
            if (this.count < this.max) {
                this.count++;
                return Promise.resolve();
            }
            return new Promise((resolve) => this.queue.push(resolve));
        }
        release() {
            const next = this.queue.shift();
            if (next) next();
            else this.count = Math.max(0, this.count - 1);
        }
    }

    function formatETA(ms) {
        const sec = Math.round(ms / 1000);
        if (sec < 60) return `约${sec}秒`;
        const min = Math.floor(sec / 60);
        const s = sec % 60;
        if (min < 60) return s > 0 ? `约${min}分${s}秒` : `约${min}分钟`;
        const h = Math.floor(min / 60);
        return `约${h}小时${min % 60}分`;
    }

    function getETA(remaining) {
        if (State.timings.length === 0 || remaining <= 0) return '';
        const recent = State.timings.slice(-10);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        return formatETA(avg * remaining);
    }

    /** 记录耗时。并发时单章墙钟耗时约为等效串行的 N 倍，故除以并发数。 */
    function recordTiming(ms, concurrency = 1) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        State.timings.push(ms / Math.max(1, concurrency));
    }

    /**
     * 主流程。
     *
     * 前 warmupChapters 章串行跑，目的是先把术语表建起来——
     * 否则一上来就并发，各章互相看不到对方发现的人名，译名会打架。
     */
    async function startTranslation(fromIndex = 0) {
        if (State.status === 'running') return;
        if (State.chapters.length === 0) {
            alert('请先导入TXT文件');
            return;
        }
        const s = State.settings;
        if (s.apiProvider !== 'openai-compatible' && !s.apiKey) {
            alert(`使用 ${s.apiProvider} 需要先填写 API Key`);
            return;
        }

        State.status = 'running';
        State.isStopped = false;
        State.timings = [];
        State.activeStreamOwner = null;
        setRunningUI(true);
        startAutoSave();

        const pending = State.chapters.filter((c, i) => i >= fromIndex && c.status !== STATUS.DONE);
        State.stats.total = State.chapters.length;

        appendStream(
            `\n${'='.repeat(50)}\n` +
                `🚀 开始翻译\n` +
                `📖 ${State.file.name}\n` +
                `📊 待翻译 ${pending.length} 章（共 ${State.chapters.length} 章）\n` +
                `🔧 ${s.apiProvider} / ${s.apiModel || '默认模型'}\n` +
                `⚙️ 章节纪律: ${s.blockAsChapter ? '一块 = 一章（强制）' : '沿用原文话数/章数'}\n` +
                `🔀 并发 ${s.concurrency}，前 ${s.warmupChapters} 章串行建立术语表\n` +
                `📖 术语表: ${s.glossaryEnabled ? `启用（当前 ${s.glossary.length} 条）` : '关闭'}\n` +
                `${'='.repeat(50)}\n`,
        );

        const warmupCount = Math.max(0, Math.min(s.warmupChapters, pending.length));

        try {
            // ---- 阶段一：串行预热，建立术语表 ----
            for (let i = 0; i < warmupCount; i++) {
                if (State.isStopped) break;
                const chapter = pending[i];
                await runOne(chapter, 1, true);
                updateProgress();
                renderChapterList();
                refreshGlossaryCount();
                await saveProgress();
            }

            // ---- 阶段二：并发 ----
            const rest = pending.slice(warmupCount);
            if (rest.length > 0 && !State.isStopped) {
                appendStream(
                    `\n${'='.repeat(50)}\n🔀 术语表已就绪（${s.glossary.length} 条），转入并发翻译\n${'='.repeat(50)}\n`,
                );
                const sem = new Semaphore(s.concurrency);
                await Promise.allSettled(
                    rest.map(async (chapter) => {
                        await sem.acquire();
                        try {
                            if (State.isStopped) return;
                            await runOne(chapter, s.concurrency, true);
                            updateProgress();
                            renderChapterList();
                        } finally {
                            sem.release();
                        }
                    }),
                );
            }
        } catch (e) {
            appendStream(`\n❌ 翻译流程出错: ${e.message}\n`);
        }

        State.status = State.isStopped ? 'stopped' : 'idle';
        setRunningUI(false);
        stopAutoSave();
        await saveProgress();
        updateProgress();
        renderChapterList();
        refreshGlossaryCount();

        const done = State.chapters.filter((c) => c.status === STATUS.DONE).length;
        const failed = State.chapters.filter((c) => c.status === STATUS.FAILED).length;
        appendStream(
            `\n${'='.repeat(50)}\n` +
                (State.isStopped ? '⏹️ 已停止\n' : '✅ 翻译完成\n') +
                `成功 ${done} 章，失败 ${failed} 章\n${'='.repeat(50)}\n`,
        );
        if (!State.isStopped && failed === 0 && done > 0) {
            showExportSection(true);
        } else if (done > 0) {
            showExportSection(true);
        }
    }

    /** 跑单章并处理成功/失败状态 */
    async function runOne(chapter, concurrency, allowLiveStream) {
        if (State.isStopped) return;
        chapter.status = STATUS.RUNNING;
        chapter.error = '';
        renderChapterList();

        const startedAt = Date.now();
        const remaining = State.chapters.filter((c) => c.status !== STATUS.DONE).length;
        const eta = getETA(remaining);
        updateProgress(eta);

        try {
            const text = await translateChapter(chapter, allowLiveStream);
            chapter.translated = text;
            chapter.status = STATUS.DONE;
            recordTiming(Date.now() - startedAt, concurrency);
            appendStream(`\n✅ 「${chapter.rawTitle}」完成（${text.length}字）\n`);
        } catch (e) {
            if (e.message === 'ABORTED') {
                chapter.status = STATUS.PENDING;
                return;
            }
            chapter.status = STATUS.FAILED;
            chapter.error = e.message;
            appendStream(`\n❌ 「${chapter.rawTitle}」失败: ${e.message}\n`);
        }
    }

    /** 只重跑失败的章节 */
    async function repairFailed() {
        const failed = State.chapters.filter((c) => c.status === STATUS.FAILED);
        if (failed.length === 0) {
            alert('没有失败的章节');
            return;
        }
        if (!confirm(`将重新翻译 ${failed.length} 个失败章节，确定吗？`)) return;

        State.status = 'running';
        State.isStopped = false;
        setRunningUI(true);
        startAutoSave();
        appendStream(`\n🔧 开始修复 ${failed.length} 个失败章节...\n`);

        const sem = new Semaphore(State.settings.concurrency);
        await Promise.allSettled(
            failed.map(async (chapter) => {
                await sem.acquire();
                try {
                    if (State.isStopped) return;
                    await runOne(chapter, State.settings.concurrency, true);
                    updateProgress();
                    renderChapterList();
                } finally {
                    sem.release();
                }
            }),
        );

        State.status = 'idle';
        setRunningUI(false);
        stopAutoSave();
        await saveProgress();
        renderChapterList();
        updateProgress();
        const stillFailed = State.chapters.filter((c) => c.status === STATUS.FAILED).length;
        appendStream(`\n🔧 修复完成，仍有 ${stillFailed} 章失败\n`);
    }

    // ============================================
    // 导出：EPUB / TXT
    // ============================================

    async function ensureJSZip() {
        if (window.JSZip) return;
        appendStream('\n📦 正在加载 EPUB 打包组件...\n');
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('JSZip 加载失败，请检查网络'));
            document.head.appendChild(script);
        });
    }

    function getExportChapters() {
        return State.chapters.filter((c) => c.status === STATUS.DONE && c.translated && c.translated.trim());
    }

    /**
     * 把已完成的「块」整理成导出用的章节单元。
     *
     * 正文是按长度切的，块边界和章节边界没有关系，所以目录不能直接按块来做。
     * 这里把译文拼回整篇，再用章节正则重新划分，划出来的才是真正的章节。
     * 正则一个都匹配不到时退回「一块一章」，至少不会导出失败。
     *
     * @returns {{units: Array, mode: string, blockCount: number}}
     */
    function buildExportUnits() {
        const blocks = getExportChapters();
        if (blocks.length === 0) return { units: [], mode: 'empty', blockCount: 0 };

        if (State.settings.exportSplitByRegex) {
            const full = blocks.map((b) => String(b.translated).trim()).join('\n\n');
            let parts = null;
            try {
                parts = splitByChapterRegex(full, State.settings.chapterRegex);
            } catch (e) {
                log(`导出时章节正则无效，退回按块导出: ${e.message}`, 'warn');
            }
            if (parts && parts.length > 0) {
                return {
                    units: parts.map((p) => ({ num: p.num, title: p.title, text: p.source })),
                    mode: 'regex',
                    blockCount: blocks.length,
                };
            }
        }

        return {
            units: blocks.map((b, i) => ({ num: '', title: b.title || `第${i + 1}部分`, text: b.translated })),
            mode: 'block',
            blockCount: blocks.length,
        };
    }

    /**
     * 生成章节显示标题。
     *
     * 编号沿用原文（用户要求）——只翻译了中间几章时编号也不会乱。
     */
    function buildDisplayTitle(chapter, fallbackIndex = 0) {
        const s = State.settings;
        if (!chapter.num) return chapter.title || `第${fallbackIndex + 1}章`;

        const n = cnNumToInt(chapter.num);
        let numText = chapter.num;
        if (s.txtTitleFormat === 'arabic' && Number.isFinite(n)) numText = String(n);
        else if (s.txtTitleFormat === 'chinese' && Number.isFinite(n)) numText = intToCn(n);

        const title = chapter.title || '';
        // 标题里若已包含「第X话」样式，直接用标题，避免出现「第1话 第1话 相遇」
        if (/^第.{1,8}[话話章节節]/.test(title)) return title;
        return `第${numText}话 ${title}`.trim();
    }

    /** 正文转 XHTML 段落。译文是自然语言，这里只做分段和转义。 */
    function textToXhtmlParagraphs(text) {
        return String(text)
            .split(/\n+/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => `<p>${escXml(line)}</p>`)
            .join('\n');
    }

    async function exportEPUB() {
        const { units: chapters, mode, blockCount } = buildExportUnits();
        if (chapters.length === 0) {
            alert('没有已完成的内容可以导出');
            return;
        }

        try {
            await ensureJSZip();
        } catch (e) {
            alert(e.message);
            return;
        }

        const title = State.settings.bookTitle || State.file.name.replace(/\.txt$/i, '') || '翻译作品';
        const author = State.settings.bookAuthor || '';
        const uuid = `urn:uuid:ntr-${Date.now()}`;
        const safeTitle = escXml(title);
        const safeAuthor = escXml(author);

        const zip = new JSZip();
        // mimetype 必须是第一个文件且不压缩，否则部分阅读器不认
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        zip.folder('META-INF').file(
            'container.xml',
            `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        );

        const oebps = zip.folder('OEBPS');
        const css = `body{font-family:serif;padding:5%;line-height:1.8;}
p{text-indent:2em;margin:0.6em 0;}
h2{text-align:center;margin:1.5em 0 1em;font-size:1.3em;border-bottom:1px solid #ccc;padding-bottom:0.4em;}`;
        oebps.file('style.css', css);

        const coverXhtml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面</title>
<style>body{text-align:center;margin-top:30%;font-family:serif;}</style></head>
<body><h1 style="font-size:2.2em;margin-bottom:0.6em;">${safeTitle}</h1>${
            safeAuthor ? `<p style="font-size:1.3em;color:#555;">${safeAuthor}</p>` : ''
        }</body></html>`;
        oebps.file('cover.xhtml', coverXhtml);

        let manifest =
            `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
            `<item id="css" href="style.css" media-type="text/css"/>` +
            `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
        let spine = `<itemref idref="cover"/>`;
        let navMap =
            `<navPoint id="nav_cover" playOrder="0"><navLabel><text>封面</text></navLabel><content src="cover.xhtml"/></navPoint>`;

        chapters.forEach((ch, idx) => {
            const chId = `ch${idx + 1}`;
            const filename = `chapter${idx + 1}.xhtml`;
            const displayTitle = buildDisplayTitle(ch, idx);
            const safeChTitle = escXml(displayTitle);
            const xhtml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${safeChTitle}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2>${safeChTitle}</h2>
${textToXhtmlParagraphs(ch.text)}
</body></html>`;

            manifest += `<item id="${chId}" href="${filename}" media-type="application/xhtml+xml"/>`;
            spine += `<itemref idref="${chId}"/>`;
            // 每章一个 navPoint —— 这就是阅读器里的目录书签
            navMap += `<navPoint id="nav_${chId}" playOrder="${idx + 1}"><navLabel><text>${safeChTitle}</text></navLabel><content src="${filename}"/></navPoint>`;
            oebps.file(filename, xhtml);
        });

        const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${safeTitle}</dc:title>
<dc:creator>${safeAuthor || '未知'}</dc:creator>
<dc:language>zh-CN</dc:language>
<dc:identifier id="BookID">${uuid}</dc:identifier>
</metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`;
        oebps.file('content.opf', opf);
        oebps.file(
            'toc.ncx',
            `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uuid}"/></head>
<docTitle><text>${safeTitle}</text></docTitle>
<navMap>${navMap}</navMap></ncx>`,
        );

        // JSZip 默认产出的 Blob 类型是 application/zip，浏览器按 MIME 存盘就成了 .zip。
        // 这里两道保险：生成时指定 mimeType，下载时再显式包一层。
        const blob = await zip.generateAsync({
            type: 'blob',
            mimeType: 'application/epub+zip',
            compression: 'DEFLATE',
        });
        downloadBlob(blob, `${title}.epub`, 'application/epub+zip');
        appendStream(
            `\n📚 已导出 EPUB：${blockCount} 块译文，` +
                (mode === 'regex'
                    ? `按正则划出 ${chapters.length} 章，含目录书签\n`
                    : `正则未匹配到章节，按块导出 ${chapters.length} 节\n`),
        );
    }

    /**
     * 导出 TXT。
     *
     * TXT 格式本身没有目录这个概念，无法内嵌书签。
     * 能做的是把标题写成阅读器容易识别的样子：独占一行、前后空行、格式统一，
     * 这样静读天下之类的阅读器用默认正则就能扫出目录。
     */
    function exportTXT() {
        const { units: chapters, mode, blockCount } = buildExportUnits();
        if (chapters.length === 0) {
            alert('没有已完成的内容可以导出');
            return;
        }
        const title = State.settings.bookTitle || State.file.name.replace(/\.txt$/i, '') || '翻译作品';
        const author = State.settings.bookAuthor || '';

        const parts = [];
        parts.push(title);
        if (author) parts.push(author);
        parts.push('');

        chapters.forEach((ch, i) => {
            parts.push('');
            parts.push(buildDisplayTitle(ch, i));
            parts.push('');
            parts.push(String(ch.text).trim());
            parts.push('');
        });

        const blob = new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' });
        downloadBlob(blob, `${title}.txt`);
        appendStream(
            `\n📄 已导出 TXT：${blockCount} 块译文，` +
                (mode === 'regex' ? `按正则划出 ${chapters.length} 章\n` : `按块导出 ${chapters.length} 节\n`),
        );
    }

    /**
     * @param {Blob} blob
     * @param {string} filename
     * @param {string} [mime] 显式指定 MIME。EPUB 必须传，否则会被当成 zip 存盘。
     */
    function downloadBlob(blob, filename, mime) {
        const out = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
        const url = URL.createObjectURL(out);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // ============================================
    // 任务导入导出
    // ============================================
    function exportTask() {
        if (State.chapters.length === 0) {
            alert('没有可导出的任务');
            return;
        }
        const data = {
            type: 'novelTranslateTask',
            version: VERSION,
            exportedAt: new Date().toISOString(),
            fileName: State.file.name,
            fileHash: State.file.hash,
            bookTitle: State.settings.bookTitle,
            bookAuthor: State.settings.bookAuthor,
            blockAsChapter: State.settings.blockAsChapter,
            chapterRegex: State.settings.chapterRegex,
            // 术语表跟着任务走，再次导入能直接接上
            glossary: State.settings.glossary,
            chapters: State.chapters.map((c) => ({
                index: c.index,
                num: c.num,
                rawTitle: c.rawTitle,
                title: c.title,
                source: c.source,
                translated: c.translated,
                status: c.status === STATUS.RUNNING ? STATUS.PENDING : c.status,
                error: c.error,
            })),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const name = (State.settings.bookTitle || State.file.name || '翻译任务').replace(/\.txt$/i, '');
        downloadBlob(blob, `${name}_翻译任务.json`);
    }

    async function importTask(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.type !== 'novelTranslateTask' || !Array.isArray(data.chapters)) {
                alert('不是有效的翻译任务文件');
                return;
            }
            const doneCount = data.chapters.filter((c) => c.status === STATUS.DONE).length;
            if (
                !confirm(
                    `任务「${data.fileName || '未命名'}」\n` +
                        `共 ${data.chapters.length} 章，已完成 ${doneCount} 章\n` +
                        `术语表 ${Array.isArray(data.glossary) ? data.glossary.length : 0} 条\n\n` +
                        `导入会覆盖当前任务，确定吗？`,
                )
            ) {
                return;
            }

            State.file.name = data.fileName || '';
            State.file.hash = data.fileHash || '';
            State.chapters = data.chapters.map((c, i) => ({
                index: i,
                num: c.num || '',
                rawTitle: c.rawTitle || `第${i + 1}章`,
                title: c.title || c.rawTitle || '',
                source: c.source || '',
                translated: c.translated || '',
                status: c.status || STATUS.PENDING,
                error: c.error || '',
            }));
            if (Array.isArray(data.glossary)) State.settings.glossary = data.glossary;
            if (data.bookTitle) State.settings.bookTitle = data.bookTitle;
            if (data.bookAuthor) State.settings.bookAuthor = data.bookAuthor;
            if (typeof data.blockAsChapter === 'boolean') State.settings.blockAsChapter = data.blockAsChapter;
            else if (typeof data.forceChunkMode === 'boolean') State.settings.blockAsChapter = data.forceChunkMode;
            if (data.chapterRegex) State.settings.chapterRegex = data.chapterRegex;

            saveSettings();
            await saveProgress();
            restoreSettingsToUI();
            renderChapterList();
            updateProgress();
            refreshGlossaryCount();
            showQueueSection(true);
            if (State.chapters.some((c) => c.status === STATUS.DONE)) showExportSection(true);
            appendStream(`\n📥 已导入任务：${State.chapters.length} 章，已完成 ${doneCount} 章\n`);
        } catch (e) {
            alert('导入任务失败: ' + e.message);
        }
    }

    // ============================================
    // 界面
    // ============================================

    function buildModalHtml() {
        const s = State.settings;
        const presets = CHAPTER_REGEX_PRESETS.map(
            (p, i) => `<option value="${i}">${esc(p.label)}</option>`,
        ).join('');

        return `
<div id="ntr-modal" class="ntr-modal-container">
 <div class="ntr-modal-scroll">
  <div class="ntr-modal">
    <div class="ntr-modal-header">
      <span class="ntr-modal-title">📖 小说翻译 v${VERSION}</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="ntr-help" class="ntr-btn-small" title="使用说明">❓</button>
        <button id="ntr-close" class="ntr-modal-close" title="关闭">✕</button>
      </div>
    </div>

    <div class="ntr-modal-body">

      <!-- ===== API 配置 ===== -->
      <div class="ntr-section">
        <div class="ntr-section-header" data-target="ntr-api-content">
          <span>🔧 API 配置<span class="ntr-hint">（独立于世界书模块）</span></span>
          <span class="ntr-collapse-icon">▼</span>
        </div>
        <div id="ntr-api-content" class="ntr-section-content">
          <div class="ntr-row">
            <div class="ntr-field">
              <label>API 提供商</label>
              <select id="ntr-provider" class="ntr-input">
                <option value="openai-compatible">OpenAI兼容</option>
                <option value="gemini">Gemini</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div class="ntr-field">
              <label>模型</label>
              <input type="text" id="ntr-model" class="ntr-input" placeholder="模型名称">
            </div>
          </div>
          <div class="ntr-field" id="ntr-model-select-field" style="display:none;">
            <label>已拉取的模型 <span class="ntr-hint">（选中即填入上面的模型名）</span></label>
            <select id="ntr-model-select" class="ntr-input"></select>
          </div>
          <div class="ntr-field">
            <label>API Key <span class="ntr-hint">(本地模型可留空)</span></label>
            <input type="password" id="ntr-key" class="ntr-input" placeholder="输入 API Key">
          </div>
          <div class="ntr-field">
            <label>API Endpoint <span class="ntr-hint">(留空用默认地址)</span></label>
            <input type="text" id="ntr-endpoint" class="ntr-input" placeholder="可选，自定义API地址">
          </div>
          <div class="ntr-row">
            <div class="ntr-field">
              <label title="指多久没收到新数据算超时，不是总耗时上限">无响应超时(秒)</label>
              <input type="number" id="ntr-timeout" class="ntr-input" min="30" max="3600">
            </div>
            <div class="ntr-field">
              <label title="翻译建议用低温度，保证忠实原文">温度</label>
              <input type="number" id="ntr-temperature" class="ntr-input" min="0" max="2" step="0.05">
            </div>
            <div class="ntr-field">
              <label title="留空用接口默认值。翻译输出长，不建议设太小">最大输出</label>
              <input type="number" id="ntr-maxtokens" class="ntr-input" min="256" step="256" placeholder="默认">
            </div>
          </div>

          <div class="ntr-model-actions">
            <button id="ntr-fetch-models" class="ntr-btn-small">🔄 拉取模型</button>
            <button id="ntr-quick-test" class="ntr-btn-small">⚡ 快速测试</button>
            <div id="ntr-model-status" class="ntr-model-status"></div>
          </div>
          <div class="ntr-hint-block">
            拉取模型会请求接口的模型列表；快速测试会用当前配置发一条最短的请求，验证地址、Key、模型这条链路通不通。
          </div>
        </div>
      </div>

      <!-- ===== 分章与并发 ===== -->
      <div class="ntr-section">
        <div class="ntr-section-header" data-target="ntr-split-content">
          <span>✂️ 分章与并发</span>
          <span class="ntr-collapse-icon">▼</span>
        </div>
        <div id="ntr-split-content" class="ntr-section-content">
          <div class="ntr-hint-block" style="margin-bottom:10px;">
            正文<strong>一律按「每块 token 上限」切分</strong>，不再用正则决定怎么切。
            下面只需要决定 AI 该怎么看待每一块。
          </div>

          <label class="ntr-checkbox">
            <input type="checkbox" id="ntr-block-as-chapter">
            <span>
              <strong>强制记忆块为章节</strong>
              <div class="ntr-hint-block" id="ntr-block-mode-hint"></div>
            </span>
          </label>

          <div class="ntr-row">
            <div class="ntr-field">
              <label title="单次请求的最大输入量，超过会自动拆分">每块 token 上限</label>
              <input type="number" id="ntr-chunk-tokens" class="ntr-input" min="1000" step="1000">
            </div>
            <div class="ntr-field">
              <label title="太高容易触发限流，反而更慢">并发数</label>
              <input type="number" id="ntr-concurrency" class="ntr-input" min="1" max="20">
            </div>
            <div class="ntr-field">
              <label title="前几章串行跑，先把人名地名的译法定下来；填0则不预热">预热章数</label>
              <input type="number" id="ntr-warmup" class="ntr-input" min="0" max="20">
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button id="ntr-rechunk" class="ntr-btn-small" style="background:rgba(52,152,219,0.45);">♻️ 按当前上限重新分块</button>
          </div>
          <div class="ntr-hint-block">
            改了「每块 token 上限」之后<strong>不会自动重切</strong>，点上面的按钮才会按新上限重新分块。
            重新分块会把现有的块拼回整篇再切，<strong>已有译文会作废</strong>，请先导出或备份任务。
          </div>
          <div class="ntr-row">
            <div class="ntr-field">
              <label title="给AI看的上文，不会被翻译进结果">衔接·上文字数</label>
              <input type="number" id="ntr-ctx-prev" class="ntr-input" min="0" max="3000" step="50">
            </div>
            <div class="ntr-field">
              <label title="给AI看的下文，不会被翻译进结果">衔接·下文字数</label>
              <input type="number" id="ntr-ctx-next" class="ntr-input" min="0" max="3000" step="50">
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 章节正则（只用于预览和导出目录） ===== -->
      <div class="ntr-section">
        <div class="ntr-section-header" data-target="ntr-regex-content">
          <span>🔍 章节正则<span class="ntr-hint">（不参与切分，只用于导出目录）</span></span>
          <span class="ntr-collapse-icon">▼</span>
        </div>
        <div id="ntr-regex-content" class="ntr-section-content">
          <div class="ntr-field">
            <label>章节识别正则 <span class="ntr-hint">组1=话数，组2=标题（可为空，会自动兜底）</span></label>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <input type="text" id="ntr-chapter-regex" class="ntr-input" style="flex:1 1 220px;min-width:200px;">
              <select id="ntr-regex-preset" class="ntr-input" style="flex:0 1 160px;">
                <option value="">— 常用预设 —</option>
                ${presets}
              </select>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
              <button id="ntr-test-regex" class="ntr-btn-small">🧪 测原文</button>
              <button id="ntr-test-regex-translated" class="ntr-btn-small" style="background:rgba(46,204,113,0.35);">🧪 测译文（导出预览）</button>
            </div>
            <div id="ntr-regex-result" class="ntr-hint-block"></div>
          </div>
          <div class="ntr-hint-block">
            导出时会把译文拼回整篇，再用这个正则重新划分章节生成目录。
            <strong>导出前点「测译文」看一眼匹配到多少章、标题对不对</strong>，比导完再发现错了省事。
            原文和译文的章节写法可能不同（例如原文 Chapter 12、译文第12话），必要时分别调整。
          </div>
        </div>
      </div>

      <!-- ===== 提示词 ===== -->
      <div class="ntr-section">
        <div class="ntr-section-header" data-target="ntr-prompt-content">
          <span>📝 翻译提示词</span>
          <span class="ntr-collapse-icon">▶</span>
        </div>
        <div id="ntr-prompt-content" class="ntr-section-content" style="display:none;">
          <div class="ntr-field">
            <label>提示词</label>
            <textarea id="ntr-prompt" class="ntr-textarea" rows="10"></textarea>
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
              <button id="ntr-reset-prompt" class="ntr-btn-small">🔄 恢复默认</button>
            </div>
          </div>

          <div class="ntr-field">
            <label>💬 消息链 <span class="ntr-hint">{PROMPT} 代表上面组装好的提示词</span></label>
            <div id="ntr-chain-list"></div>
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
              <button id="ntr-add-chain" class="ntr-btn-small">➕ 添加消息</button>
              <button id="ntr-import-preset" class="ntr-btn-small" style="background:rgba(155,89,182,0.6);">📥 导入酒馆预设</button>
              <button id="ntr-reset-chain" class="ntr-btn-small">🔄 恢复默认</button>
              <input type="file" id="ntr-preset-file" accept=".json,application/json" style="display:none;">
            </div>
            <div id="ntr-preset-name" class="ntr-hint-block" style="color:#9b59b6;"></div>
          </div>
        </div>
      </div>

      <!-- ===== 术语表 ===== -->
      <div class="ntr-section">
        <div class="ntr-section-header" data-target="ntr-glossary-content">
          <span>📖 术语表<span class="ntr-hint" id="ntr-glossary-count"></span></span>
          <span class="ntr-collapse-icon">▶</span>
        </div>
        <div id="ntr-glossary-content" class="ntr-section-content" style="display:none;">
          <label class="ntr-checkbox">
            <input type="checkbox" id="ntr-glossary-enabled">
            <span>
              <strong>启用术语表</strong>
              <div class="ntr-hint-block">
                保证并发翻译时人名地名统一。前几章串行时自动积累，之后每章翻译顺带补充新词。
                术语表只发给 AI 参考，<strong>不会出现在导出的小说里</strong>。
              </div>
            </span>
          </label>
          <div id="ntr-glossary-list" class="ntr-glossary-list"></div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
            <button id="ntr-add-term" class="ntr-btn-small">➕ 添加术语</button>
            <button id="ntr-clear-glossary" class="ntr-btn-small" style="background:rgba(231,76,60,0.4);">🗑️ 清空</button>
          </div>
        </div>
      </div>

      <!-- ===== 文件 ===== -->
      <div class="ntr-section">
        <div class="ntr-section-header-static">
          <span>📄 导入小说</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button id="ntr-update-chapters" class="ntr-btn-small" style="background:rgba(39,174,96,0.4);" title="小说更新后追加新章节，已翻译的块不受影响">📗 导入更新章节</button>
            <button id="ntr-import-task" class="ntr-btn-small">📥 导入任务</button>
            <button id="ntr-export-task" class="ntr-btn-small">📤 导出任务</button>
          </div>
        </div>
        <div class="ntr-section-content">
          <div class="ntr-upload" id="ntr-upload">
            <div style="font-size:40px;margin-bottom:8px;">📁</div>
            <div style="font-size:13px;opacity:0.8;">点击或拖拽 TXT 文件到此处</div>
            <input type="file" id="ntr-file-input" accept=".txt" style="display:none;">
            <input type="file" id="ntr-task-input" accept=".json" style="display:none;">
            <input type="file" id="ntr-update-input" accept=".txt" style="display:none;">
          </div>
          <div id="ntr-file-info" class="ntr-file-info" style="display:none;">
            <span id="ntr-file-name"></span>
            <span id="ntr-file-size"></span>
            <button id="ntr-clear-file" class="ntr-btn-small">清除</button>
          </div>
          <div class="ntr-row" style="margin-top:10px;">
            <div class="ntr-field">
              <label>书名 <span class="ntr-hint">(默认用文件名)</span></label>
              <input type="text" id="ntr-book-title" class="ntr-input" placeholder="导出时使用">
            </div>
            <div class="ntr-field">
              <label>作者 <span class="ntr-hint">(可留空)</span></label>
              <input type="text" id="ntr-book-author" class="ntr-input" placeholder="导出时使用">
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 章节列表 ===== -->
      <div class="ntr-section" id="ntr-queue-section" style="display:none;">
        <div class="ntr-section-header-static">
          <span>📋 分块列表<span class="ntr-hint" id="ntr-queue-count"></span></span>
          <span class="ntr-hint">点任意一块查看内容</span>
        </div>
        <div class="ntr-section-content">
          <div id="ntr-chapter-list" class="ntr-chapter-list"></div>
        </div>
      </div>

      <!-- ===== 进度 ===== -->
      <div class="ntr-section" id="ntr-progress-section" style="display:none;">
        <div class="ntr-section-header-static">
          <span>⏳ 翻译进度</span>
          <button id="ntr-toggle-stream" class="ntr-btn-small">👁️ 实时输出</button>
        </div>
        <div class="ntr-section-content">
          <div class="ntr-progress-bar"><div id="ntr-progress-fill" class="ntr-progress-fill"></div></div>
          <div id="ntr-progress-text" class="ntr-progress-text">准备中...</div>
          <div id="ntr-stream-container" class="ntr-stream-container" style="display:none;">
            <div class="ntr-stream-header">
              <span>📤 实时输出</span>
              <button id="ntr-clear-stream" class="ntr-btn-small">清空</button>
            </div>
            <pre id="ntr-stream-content" class="ntr-stream-content"></pre>
          </div>
        </div>
      </div>

      <!-- ===== 导出 ===== -->
      <div class="ntr-section" id="ntr-export-section" style="display:none;">
        <div class="ntr-section-header-static"><span>📦 导出成品</span></div>
        <div class="ntr-section-content">
          <div class="ntr-row">
            <div class="ntr-field">
              <label title="影响导出时章节标题的编号写法">章节编号格式</label>
              <select id="ntr-title-format" class="ntr-input">
                <option value="original">沿用原文（第12话）</option>
                <option value="arabic">阿拉伯数字（第12话）</option>
                <option value="chinese">中文数字（第十二话）</option>
              </select>
            </div>
          </div>
          <label class="ntr-checkbox">
            <input type="checkbox" id="ntr-export-split-regex">
            <span>
              <strong>导出时用正则重新划分章节</strong>
              <div class="ntr-hint-block">
                正文是按长度切的，块边界不等于章节边界。勾选后会把译文拼回整篇，
                用「章节正则」重新划出真正的章节来做目录。匹配不到时自动退回「一块一节」。
              </div>
            </span>
          </label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <button id="ntr-preview-export" class="ntr-btn-small">🔎 预览导出目录</button>
          </div>
          <div id="ntr-export-preview" class="ntr-hint-block"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <button id="ntr-export-epub" class="ntr-btn ntr-btn-primary">📚 导出 EPUB（带目录）</button>
            <button id="ntr-export-txt" class="ntr-btn">📄 导出 TXT</button>
          </div>
          <div class="ntr-hint-block" style="margin-top:8px;">
            EPUB 的目录是写死在文件里的，一定能跳转。
            TXT 格式本身不支持目录，只能把标题排成阅读器容易识别的样子，能不能生成目录取决于阅读器。
          </div>
        </div>
      </div>

    </div>

    <div class="ntr-modal-footer">
      <div id="ntr-footer-info" class="ntr-hint" style="margin-right:auto;"></div>
      <button id="ntr-repair" class="ntr-btn" style="display:none;background:rgba(230,126,34,0.5);">🔧 修复失败</button>
      <button id="ntr-stop" class="ntr-btn" style="display:none;background:rgba(231,76,60,0.5);">⏹️ 停止</button>
      <button id="ntr-start" class="ntr-btn ntr-btn-primary">🚀 开始翻译</button>
    </div>
  </div>
 </div>
</div>`;
    }

    function buildStyles() {
        return `
<style id="ntr-styles">
.ntr-modal-container{position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:99999;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;box-sizing:border-box;}
.ntr-modal-scroll{display:flex;justify-content:center;align-items:flex-start;min-height:100%;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom));box-sizing:border-box;}
.ntr-modal{background:var(--SmartThemeBlurTintColor,#1e1e1e);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:10px;width:100%;max-width:820px;display:flex;flex-direction:column;color:var(--SmartThemeBodyColor,#eee);}
.ntr-modal-header{position:sticky;top:0;z-index:3;display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);background:#1c1c1c;background:linear-gradient(rgba(0,0,0,0.35),rgba(0,0,0,0.35)),var(--SmartThemeBlurTintColor,#1e1e1e);border-radius:10px 10px 0 0;}
.ntr-modal-title{font-weight:bold;font-size:15px;}
.ntr-modal-close{background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:0 6px;line-height:1;}
.ntr-modal-close:hover{color:#fff;}
.ntr-modal-body{padding:14px;overflow:visible;}
.ntr-modal-footer{position:sticky;bottom:0;z-index:3;display:flex;gap:8px;align-items:center;padding:12px 16px;padding-bottom:max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--SmartThemeBorderColor,#444);background:#1c1c1c;background:linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.55)),var(--SmartThemeBlurTintColor,#1e1e1e);border-radius:0 0 10px 10px;flex-wrap:wrap;}
.ntr-section{background:rgba(0,0,0,0.2);border-radius:8px;margin-bottom:12px;overflow:hidden;}
.ntr-section-header,.ntr-section-header-static{display:flex;justify-content:space-between;align-items:center;padding:11px 14px;background:rgba(0,0,0,0.3);font-weight:500;font-size:13px;gap:8px;flex-wrap:wrap;}
.ntr-section-header{cursor:pointer;}
.ntr-section-content{padding:14px;}
.ntr-collapse-icon{font-size:10px;}
.ntr-row{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;}
.ntr-field{flex:1 1 130px;min-width:120px;margin-bottom:10px;}
.ntr-field>label{display:block;font-size:12px;opacity:0.85;margin-bottom:4px;}
.ntr-input,.ntr-textarea{width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;color:#fff;font-size:13px;padding:9px 11px;}
.ntr-textarea{font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;}
.ntr-hint{font-size:11px;opacity:0.55;font-weight:normal;}
.ntr-hint-block{font-size:11px;opacity:0.6;line-height:1.6;margin-top:4px;}
.ntr-btn{padding:9px 15px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;background:rgba(255,255,255,0.08);color:#fff;cursor:pointer;font-size:13px;}
.ntr-btn:hover{background:rgba(255,255,255,0.15);}
.ntr-btn-primary{background:linear-gradient(135deg,#3498db,#2980b9);border-color:transparent;}
.ntr-btn:disabled{opacity:0.5;cursor:not-allowed;}
.ntr-btn-small{padding:5px 10px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:5px;background:rgba(255,255,255,0.08);color:#fff;cursor:pointer;font-size:11px;}
.ntr-btn-small:hover{background:rgba(255,255,255,0.16);}
.ntr-checkbox{display:flex;gap:9px;align-items:flex-start;padding:9px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:10px;cursor:pointer;}
.ntr-checkbox input{margin-top:3px;flex-shrink:0;}
.ntr-upload{border:2px dashed #555;border-radius:8px;padding:26px 14px;text-align:center;cursor:pointer;transition:all 0.2s;}
.ntr-upload:hover{border-color:#3498db;background:rgba(52,152,219,0.06);}
.ntr-file-info{display:flex;gap:10px;align-items:center;padding:9px 12px;background:rgba(52,152,219,0.12);border-radius:6px;margin-top:10px;font-size:12px;flex-wrap:wrap;}
.ntr-chapter-list{max-height:300px;overflow-y:auto;-webkit-overflow-scrolling:touch;}
.ntr-chapter-item{display:flex;gap:9px;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;cursor:pointer;}
.ntr-chapter-item:hover{background:rgba(255,255,255,0.07);}
.ntr-chapter-arrow{flex:0 0 auto;opacity:0.35;font-size:11px;}
.ntr-model-actions{display:flex;gap:8px;align-items:center;margin-top:12px;padding:10px;background:rgba(52,152,219,0.1);border:1px solid rgba(52,152,219,0.3);border-radius:6px;flex-wrap:wrap;}
.ntr-model-actions>button{flex:0 0 auto;white-space:nowrap;}
.ntr-model-status{font-size:12px;flex:1 1 100%;min-width:0;white-space:pre-wrap;word-break:break-word;line-height:1.5;opacity:0.85;}
.ntr-model-status.success{color:#2ecc71;opacity:1;}
.ntr-model-status.error{color:#e74c3c;opacity:1;}
.ntr-model-status.loading{color:#f39c12;opacity:1;}
.ntr-chapter-item:last-child{border-bottom:none;}
.ntr-chapter-status{flex:0 0 auto;font-size:14px;width:20px;text-align:center;}
.ntr-chapter-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ntr-chapter-meta{flex:0 0 auto;font-size:11px;opacity:0.55;}
.ntr-chapter-item.failed{background:rgba(231,76,60,0.12);}
.ntr-chapter-item.done{background:rgba(46,204,113,0.07);}
.ntr-chapter-item.running{background:rgba(52,152,219,0.14);}
.ntr-progress-bar{height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;}
.ntr-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#3498db,#2ecc71);transition:width 0.3s;}
.ntr-progress-text{font-size:12px;margin-top:8px;opacity:0.85;}
.ntr-stream-container{margin-top:12px;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:6px;overflow:hidden;position:relative;}
.ntr-stream-header{display:flex;justify-content:space-between;align-items:center;padding:7px 11px;background:rgba(0,0,0,0.35);font-size:12px;}
.ntr-stream-content{margin:0;padding:11px;max-height:280px;overflow-y:auto;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,0.25);-webkit-overflow-scrolling:touch;}
.ntr-glossary-list{max-height:260px;overflow-y:auto;-webkit-overflow-scrolling:touch;}
.ntr-glossary-item{display:flex;gap:6px;align-items:center;padding:5px 0;flex-wrap:wrap;}
.ntr-glossary-item input{flex:1 1 100px;min-width:90px;padding:6px 8px;font-size:12px;background:rgba(0,0,0,0.3);border:1px solid #555;border-radius:5px;color:#fff;box-sizing:border-box;}
@media (max-width:600px){
  .ntr-modal-scroll{padding:8px;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom));}
  .ntr-modal{max-width:100%;}
  .ntr-modal-header{padding:10px 12px;}
  .ntr-modal-body{padding:10px;}
  .ntr-modal-footer{padding:10px 12px;padding-bottom:max(10px,env(safe-area-inset-bottom));}
  .ntr-field{flex:1 1 100%;}
  .ntr-modal-footer .ntr-btn{flex:1 1 auto;}
  .ntr-chapter-list{max-height:240px;}
  .ntr-stream-content{max-height:200px;}
  .ntr-glossary-list{max-height:200px;}
}
</style>`;
    }

    // ============================================
    // 界面渲染与状态同步
    // ============================================

    function $(id) {
        return document.getElementById(id);
    }

    function appendStream(text) {
        State.streamContent += text;
        const el = $('ntr-stream-content');
        if (!el) return;

        // 只有本来就贴着底部时才自动跟随，否则用户往上翻会被一直拽回去
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
        el.textContent = State.streamContent;
        if (atBottom && State.streamAutoScroll !== false) {
            el.scrollTop = el.scrollHeight;
        }
    }

    function updateProgress(etaText) {
        const done = State.chapters.filter((c) => c.status === STATUS.DONE).length;
        const failed = State.chapters.filter((c) => c.status === STATUS.FAILED).length;
        const total = State.chapters.length;
        const pct = total ? Math.round((done / total) * 100) : 0;

        const fill = $('ntr-progress-fill');
        if (fill) fill.style.width = `${pct}%`;

        const eta = etaText !== undefined ? etaText : getETA(total - done);
        const text = $('ntr-progress-text');
        if (text) {
            const parts = [`${done}/${total} 章 (${pct}%)`];
            if (failed > 0) parts.push(`失败 ${failed}`);
            if (eta) parts.push(`预计剩余 ${eta}`);
            text.textContent = State.status === 'running' ? `🚀 翻译中 · ${parts.join(' · ')}` : parts.join(' · ');
        }

        const repairBtn = $('ntr-repair');
        if (repairBtn) repairBtn.style.display = failed > 0 ? 'inline-block' : 'none';

        const info = $('ntr-footer-info');
        if (info && total) info.textContent = `共 ${total} 章`;
    }

    function renderChapterList() {
        const container = $('ntr-chapter-list');
        if (!container) return;

        const icons = {
            [STATUS.PENDING]: '⚪',
            [STATUS.RUNNING]: '🔄',
            [STATUS.DONE]: '✅',
            [STATUS.FAILED]: '❌',
        };

        const html = State.chapters
            .map((c) => {
                const cls = c.status === STATUS.DONE ? 'done' : c.status === STATUS.FAILED ? 'failed' : c.status === STATUS.RUNNING ? 'running' : '';
                const meta = c.status === STATUS.FAILED
                    ? esc(c.error || '失败').slice(0, 40)
                    : c.translated
                      ? `${c.translated.length}字`
                      : `${estimateTokens(c.source)}tk`;
                return `<div class="ntr-chapter-item ${cls}" data-index="${c.index}">
                    <span class="ntr-chapter-status">${icons[c.status] || '⚪'}</span>
                    <span class="ntr-chapter-title" title="${esc(c.rawTitle)}">${esc(c.rawTitle)}</span>
                    <span class="ntr-chapter-meta">${meta}</span>
                    <span class="ntr-chapter-arrow">▶</span>
                </div>`;
            })
            .join('');
        container.innerHTML = html || '<div class="ntr-hint-block">暂无章节</div>';

        container.querySelectorAll('.ntr-chapter-item[data-index]').forEach((el) => {
            el.addEventListener('click', () => showBlockModal(parseInt(el.dataset.index, 10)));
        });

        const count = $('ntr-queue-count');
        if (count) count.textContent = `（${State.chapters.length} 块）`;
    }

    // ============================================
    // 分块详情：查看 / 复制 / 编辑 / 合并 / 删除
    // ============================================

    /** 合并、删除之后重排序号与标题，保证界面和导出编号连续 */
    function renumberChapters() {
        State.chapters.forEach((c, i) => {
            c.index = i;
            if (/^第\d+部分$/.test(c.rawTitle || '')) {
                c.rawTitle = `第${i + 1}部分`;
                c.title = c.rawTitle;
            }
            c.num = String(i + 1);
        });
    }

    /** 内容被改动过的块要退回未翻译状态，否则译文和原文对不上 */
    function invalidateChapter(ch) {
        ch.translated = '';
        ch.status = STATUS.PENDING;
        ch.error = '';
    }

    function closeBlockModal() {
        const el = $('ntr-block-modal');
        if (el) el.remove();
    }

    function showBlockModal(index) {
        const ch = State.chapters[index];
        if (!ch) return;
        closeBlockModal();

        const statusText = {
            [STATUS.PENDING]: '⚪ 等待翻译',
            [STATUS.RUNNING]: '🔄 翻译中',
            [STATUS.DONE]: '✅ 已完成',
            [STATUS.FAILED]: '❌ 失败',
        }[ch.status] || '⚪ 等待翻译';
        const statusColor = {
            [STATUS.DONE]: '#2ecc71',
            [STATUS.FAILED]: '#e74c3c',
            [STATUS.RUNNING]: '#3498db',
        }[ch.status] || '#f39c12';

        const running = State.status === 'running';
        const dis = running ? 'disabled' : '';

        const html = `
<div id="ntr-block-modal" class="ntr-modal-container" style="z-index:100000;">
 <div class="ntr-modal-scroll">
  <div class="ntr-modal" style="max-width:900px;">
    <div class="ntr-modal-header">
      <span class="ntr-modal-title">📄 第 ${index + 1} 块 / 共 ${State.chapters.length} 块</span>
      <button class="ntr-modal-close" id="ntr-block-close">✕</button>
    </div>
    <div class="ntr-modal-body">
      <div class="ntr-file-info" style="margin-top:0;justify-content:space-between;">
        <span style="color:${statusColor};font-weight:bold;">${statusText}</span>
        <span>原文 <span id="ntr-block-srclen">${ch.source.length.toLocaleString()}</span> 字 · 约 ${estimateTokens(ch.source)} tk</span>
        <span>译文 ${ch.translated ? ch.translated.length.toLocaleString() + ' 字' : '—'}</span>
      </div>
      ${ch.error ? `<div class="ntr-hint-block" style="color:#e74c3c;">❌ ${esc(ch.error)}</div>` : ''}

      <div class="ntr-field" style="margin-top:10px;">
        <label style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <span>📝 原文 <span class="ntr-hint">(可直接编辑)</span></span>
          <span style="display:flex;gap:6px;flex-wrap:wrap;">
            <button id="ntr-block-copy-src" class="ntr-btn-small">📋 复制原文</button>
            <button id="ntr-block-merge-prev" class="ntr-btn-small" ${index === 0 ? 'disabled' : dis}>⬆️ 并入上一块</button>
            <button id="ntr-block-merge-next" class="ntr-btn-small" ${index === State.chapters.length - 1 ? 'disabled' : dis}>⬇️ 并入下一块</button>
            <button id="ntr-block-split" class="ntr-btn-small" ${dis}>✂️ 按上限重切本块</button>
          </span>
        </label>
        <textarea id="ntr-block-src" class="ntr-textarea" rows="14">${esc(ch.source)}</textarea>
      </div>

      <div class="ntr-field">
        <label style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <span>📗 译文 <span class="ntr-hint">(可直接编辑，改完保存即生效)</span></span>
          <span style="display:flex;gap:6px;flex-wrap:wrap;">
            <button id="ntr-block-copy-dst" class="ntr-btn-small" ${ch.translated ? '' : 'disabled'}>📋 复制译文</button>
            <button id="ntr-block-retranslate" class="ntr-btn-small" ${dis} style="background:rgba(52,152,219,0.45);">🔁 重翻本块</button>
          </span>
        </label>
        <textarea id="ntr-block-dst" class="ntr-textarea" rows="14" placeholder="${ch.translated ? '' : '尚未翻译'}">${esc(ch.translated)}</textarea>
      </div>
    </div>
    <div class="ntr-modal-footer">
      <button id="ntr-block-delete" class="ntr-btn" style="margin-right:auto;background:rgba(231,76,60,0.5);" ${dis}>🗑️ 删除本块</button>
      <button id="ntr-block-cancel" class="ntr-btn">取消</button>
      <button id="ntr-block-save" class="ntr-btn ntr-btn-primary">💾 保存修改</button>
    </div>
  </div>
 </div>
</div>`;

        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        document.body.appendChild(wrap.firstElementChild);

        const srcEl = $('ntr-block-src');
        const dstEl = $('ntr-block-dst');
        const lenEl = $('ntr-block-srclen');
        srcEl.addEventListener('input', () => {
            if (lenEl) lenEl.textContent = srcEl.value.length.toLocaleString();
        });

        const copyTo = async (btn, text) => {
            try {
                await navigator.clipboard.writeText(text);
            } catch (e) {
                // 非 https 或浏览器不给权限时退回选中复制
                srcEl.focus();
                alert('浏览器不允许直接写剪贴板，请手动选中复制');
                return;
            }
            const old = btn.textContent;
            btn.textContent = '✅ 已复制';
            setTimeout(() => (btn.textContent = old), 1500);
        };

        $('ntr-block-copy-src').addEventListener('click', (e) => copyTo(e.target, srcEl.value));
        const copyDst = $('ntr-block-copy-dst');
        if (copyDst && !copyDst.disabled) copyDst.addEventListener('click', (e) => copyTo(e.target, dstEl.value));

        $('ntr-block-close').addEventListener('click', closeBlockModal);
        $('ntr-block-cancel').addEventListener('click', closeBlockModal);

        $('ntr-block-save').addEventListener('click', async () => {
            const newSrc = srcEl.value;
            const newDst = dstEl.value;
            if (newSrc !== ch.source) {
                ch.source = newSrc;
                // 原文改了，旧译文已经对不上；但用户手改的译文要留住
                if (newDst === ch.translated) invalidateChapter(ch);
            }
            if (newDst !== ch.translated) {
                ch.translated = newDst;
                ch.status = newDst.trim() ? STATUS.DONE : STATUS.PENDING;
                ch.error = '';
            }
            await saveProgress();
            renderChapterList();
            updateProgress();
            if (State.chapters.some((c) => c.status === STATUS.DONE)) showExportSection(true);
            closeBlockModal();
        });

        const mergeInto = async (dir) => {
            const target = State.chapters[index + dir];
            if (!target) return;
            const label = dir < 0 ? '上一块' : '下一块';
            if (!confirm(`把第 ${index + 1} 块并入${label}（第 ${index + 1 + dir} 块）？\n\n合并后本块会被删除，两块的译文都会作废需要重翻。`)) return;
            target.source = dir < 0 ? target.source + '\n\n' + srcEl.value : srcEl.value + '\n\n' + target.source;
            invalidateChapter(target);
            State.chapters.splice(index, 1);
            renumberChapters();
            await saveProgress();
            renderChapterList();
            updateProgress();
            closeBlockModal();
            appendStream(`\n🔗 已合并为第 ${target.index + 1} 块（${target.source.length} 字），需重新翻译\n`);
        };
        const mp = $('ntr-block-merge-prev');
        if (mp && !mp.disabled) mp.addEventListener('click', () => mergeInto(-1));
        const mn = $('ntr-block-merge-next');
        if (mn && !mn.disabled) mn.addEventListener('click', () => mergeInto(1));

        const splitBtn = $('ntr-block-split');
        if (splitBtn && !splitBtn.disabled) {
            splitBtn.addEventListener('click', async () => {
                const pieces = splitBySize(srcEl.value, State.settings.chunkTokens);
                if (pieces.length <= 1) {
                    alert('这一块没有超过当前的 token 上限，不需要再切。');
                    return;
                }
                if (!confirm(`本块会被切成 ${pieces.length} 块，切开后都需要重新翻译。继续吗？`)) return;
                const newOnes = pieces.map((p) => ({
                    index: 0,
                    num: '',
                    rawTitle: '第0部分',
                    title: '第0部分',
                    source: p.source,
                    translated: '',
                    status: STATUS.PENDING,
                    error: '',
                }));
                State.chapters.splice(index, 1, ...newOnes);
                renumberChapters();
                await saveProgress();
                renderChapterList();
                updateProgress();
                closeBlockModal();
                appendStream(`\n✂️ 已把第 ${index + 1} 块切成 ${pieces.length} 块\n`);
            });
        }

        const retryBtn = $('ntr-block-retranslate');
        if (retryBtn && !retryBtn.disabled) {
            retryBtn.addEventListener('click', async () => {
                ch.source = srcEl.value;
                invalidateChapter(ch);
                await saveProgress();
                renderChapterList();
                closeBlockModal();
                collectSettingsFromUI();
                setRunningUI(true);
                State.status = 'running';
                State.isStopped = false;
                try {
                    await runOne(ch, 1, true);
                } finally {
                    State.status = 'idle';
                    setRunningUI(false);
                    await saveProgress();
                    renderChapterList();
                    updateProgress();
                    if (State.chapters.some((c) => c.status === STATUS.DONE)) showExportSection(true);
                }
            });
        }

        const delBtn = $('ntr-block-delete');
        if (delBtn && !delBtn.disabled) {
            delBtn.addEventListener('click', async () => {
                if (!confirm(`确定删除第 ${index + 1} 块？原文和译文都会丢失。`)) return;
                State.chapters.splice(index, 1);
                renumberChapters();
                await saveProgress();
                renderChapterList();
                updateProgress();
                closeBlockModal();
            });
        }
    }

    function renderChain() {
        const container = $('ntr-chain-list');
        if (!container) return;
        const chain = State.settings.promptMessageChain || [];
        const labels = { system: '🔷 系统', user: '🟢 用户', assistant: '🟡 AI助手' };

        container.innerHTML = chain
            .map(
                (m, i) => `
        <div style="background:rgba(0,0,0,0.2);border-radius:6px;padding:8px;margin-bottom:6px;">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:5px;flex-wrap:wrap;">
                <select class="ntr-chain-role ntr-input" data-i="${i}" style="width:auto;flex:0 0 auto;padding:4px 8px;font-size:12px;">
                    ${['system', 'user', 'assistant']
                        .map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${labels[r]}</option>`)
                        .join('')}
                </select>
                <label style="font-size:11px;display:flex;gap:4px;align-items:center;">
                    <input type="checkbox" class="ntr-chain-on" data-i="${i}" ${m.enabled !== false ? 'checked' : ''}> 启用
                </label>
                <div style="margin-left:auto;display:flex;gap:4px;">
                    <button class="ntr-btn-small ntr-chain-up" data-i="${i}">↑</button>
                    <button class="ntr-btn-small ntr-chain-down" data-i="${i}">↓</button>
                    <button class="ntr-btn-small ntr-chain-del" data-i="${i}">🗑️</button>
                </div>
            </div>
            <textarea class="ntr-textarea ntr-chain-text" data-i="${i}" rows="2">${esc(m.content || '')}</textarea>
        </div>`,
            )
            .join('');

        container.querySelectorAll('.ntr-chain-role').forEach((el) =>
            el.addEventListener('change', (e) => {
                State.settings.promptMessageChain[+e.target.dataset.i].role = e.target.value;
                saveSettings();
            }),
        );
        container.querySelectorAll('.ntr-chain-on').forEach((el) =>
            el.addEventListener('change', (e) => {
                State.settings.promptMessageChain[+e.target.dataset.i].enabled = e.target.checked;
                saveSettings();
            }),
        );
        container.querySelectorAll('.ntr-chain-text').forEach((el) =>
            el.addEventListener('input', (e) => {
                State.settings.promptMessageChain[+e.target.dataset.i].content = e.target.value;
                saveSettings();
            }),
        );
        container.querySelectorAll('.ntr-chain-up').forEach((el) =>
            el.addEventListener('click', (e) => {
                const i = +e.target.dataset.i;
                const chain = State.settings.promptMessageChain;
                if (i > 0) {
                    [chain[i], chain[i - 1]] = [chain[i - 1], chain[i]];
                    renderChain();
                    saveSettings();
                }
            }),
        );
        container.querySelectorAll('.ntr-chain-down').forEach((el) =>
            el.addEventListener('click', (e) => {
                const i = +e.target.dataset.i;
                const chain = State.settings.promptMessageChain;
                if (i < chain.length - 1) {
                    [chain[i], chain[i + 1]] = [chain[i + 1], chain[i]];
                    renderChain();
                    saveSettings();
                }
            }),
        );
        container.querySelectorAll('.ntr-chain-del').forEach((el) =>
            el.addEventListener('click', (e) => {
                State.settings.promptMessageChain.splice(+e.target.dataset.i, 1);
                renderChain();
                saveSettings();
            }),
        );
    }

    function renderGlossary() {
        const container = $('ntr-glossary-list');
        if (!container) return;
        const g = State.settings.glossary || [];
        if (g.length === 0) {
            container.innerHTML = '<div class="ntr-hint-block">暂无术语。翻译过程中会自动积累，也可以手动添加。</div>';
            refreshGlossaryCount();
            return;
        }
        container.innerHTML = g
            .map(
                (it, i) => `<div class="ntr-glossary-item">
            <input type="text" class="ntr-g-src" data-i="${i}" value="${esc(it.source)}" placeholder="原文">
            <span style="opacity:0.5;">→</span>
            <input type="text" class="ntr-g-tgt" data-i="${i}" value="${esc(it.target)}" placeholder="中文">
            <input type="text" class="ntr-g-note" data-i="${i}" value="${esc(it.note || '')}" placeholder="说明(可选)">
            <button class="ntr-btn-small ntr-g-del" data-i="${i}">🗑️</button>
        </div>`,
            )
            .join('');

        const bind = (cls, field) =>
            container.querySelectorAll(cls).forEach((el) =>
                el.addEventListener('change', (e) => {
                    State.settings.glossary[+e.target.dataset.i][field] = e.target.value;
                    saveSettings();
                }),
            );
        bind('.ntr-g-src', 'source');
        bind('.ntr-g-tgt', 'target');
        bind('.ntr-g-note', 'note');
        container.querySelectorAll('.ntr-g-del').forEach((el) =>
            el.addEventListener('click', (e) => {
                State.settings.glossary.splice(+e.target.dataset.i, 1);
                renderGlossary();
                saveSettings();
            }),
        );
        refreshGlossaryCount();
    }

    function refreshGlossaryCount() {
        const el = $('ntr-glossary-count');
        if (el) el.textContent = `（${(State.settings.glossary || []).length} 条）`;
    }

    function updateBlockModeHint() {
        const hint = $('ntr-block-mode-hint');
        if (!hint) return;
        if (State.settings.blockAsChapter) {
            hint.innerHTML =
                '已开启：提示词里会要求 AI 把<strong>每一块整个当成一章</strong>，块内不再分章，' +
                '也不会自行加编号。适合原文没有规范章节标记、你就想按固定长度分章的情况。';
        } else {
            hint.innerHTML =
                '未开启：提示词里会说明这一块只是按长度切出来的，' +
                '要求 AI <strong>沿用原文自身的话数/章数</strong>，不得合并或拆分，也不要把一块当成一章。' +
                '原文章节标题会照常翻译并单独成行，导出时再靠正则划分。';
        }
    }

    function showQueueSection(show) {
        const el = $('ntr-queue-section');
        if (el) el.style.display = show ? 'block' : 'none';
    }
    function showProgressSection(show) {
        const el = $('ntr-progress-section');
        if (el) el.style.display = show ? 'block' : 'none';
    }
    function showExportSection(show) {
        const el = $('ntr-export-section');
        if (el) el.style.display = show ? 'block' : 'none';
    }

    function setRunningUI(running) {
        const start = $('ntr-start');
        const stop = $('ntr-stop');
        if (start) {
            start.disabled = running;
            start.textContent = running ? '⏳ 翻译中...' : '🚀 开始翻译';
        }
        if (stop) stop.style.display = running ? 'inline-block' : 'none';
        if (running) showProgressSection(true);
    }

    function restoreSettingsToUI() {
        const s = State.settings;
        const set = (id, val) => {
            const el = $(id);
            if (el) el.value = val === null || val === undefined ? '' : val;
        };
        const check = (id, val) => {
            const el = $(id);
            if (el) el.checked = !!val;
        };

        set('ntr-provider', s.apiProvider);
        set('ntr-model', s.apiModel);
        set('ntr-key', s.apiKey);
        set('ntr-endpoint', s.apiEndpoint);
        set('ntr-timeout', Math.round((s.apiTimeout || 300000) / 1000));
        set('ntr-temperature', s.temperature);
        set('ntr-maxtokens', s.maxTokens);
        check('ntr-block-as-chapter', s.blockAsChapter);
        check('ntr-export-split-regex', s.exportSplitByRegex);
        set('ntr-chapter-regex', s.chapterRegex);
        set('ntr-chunk-tokens', s.chunkTokens);
        set('ntr-concurrency', s.concurrency);
        set('ntr-warmup', s.warmupChapters);
        set('ntr-ctx-prev', s.contextPrevChars);
        set('ntr-ctx-next', s.contextNextChars);
        set('ntr-prompt', s.customPrompt);
        check('ntr-glossary-enabled', s.glossaryEnabled);
        set('ntr-book-title', s.bookTitle);
        set('ntr-book-author', s.bookAuthor);
        set('ntr-title-format', s.txtTitleFormat);

        const presetName = $('ntr-preset-name');
        if (presetName) presetName.textContent = s.importedPresetName ? `📥 已导入预设：${s.importedPresetName}` : '';

        updateBlockModeHint();
        renderChain();
        renderGlossary();
    }

    function collectSettingsFromUI() {
        const s = State.settings;
        const num = (id, fallback) => {
            const el = $(id);
            if (!el) return fallback;
            const v = String(el.value).trim();
            if (v === '') return null;
            const n = parseFloat(v);
            return isNaN(n) ? fallback : n;
        };

        const provider = $('ntr-provider');
        if (provider) s.apiProvider = provider.value;
        const model = $('ntr-model');
        if (model) s.apiModel = model.value.trim();
        const key = $('ntr-key');
        if (key) s.apiKey = key.value;
        const endpoint = $('ntr-endpoint');
        if (endpoint) s.apiEndpoint = endpoint.value.trim();

        const timeout = num('ntr-timeout', 300);
        if (timeout !== null) s.apiTimeout = Math.max(30, timeout) * 1000;
        const temp = num('ntr-temperature', 0.3);
        if (temp !== null) s.temperature = Math.min(2, Math.max(0, temp));
        s.maxTokens = num('ntr-maxtokens', null);

        const blockMode = $('ntr-block-as-chapter');
        if (blockMode) s.blockAsChapter = blockMode.checked;
        const expRegex = $('ntr-export-split-regex');
        if (expRegex) s.exportSplitByRegex = expRegex.checked;
        const regex = $('ntr-chapter-regex');
        if (regex && regex.value.trim()) s.chapterRegex = regex.value.trim();

        const ct = num('ntr-chunk-tokens', 30000);
        if (ct !== null) s.chunkTokens = Math.max(1000, ct);
        const cc = num('ntr-concurrency', 3);
        if (cc !== null) s.concurrency = Math.min(20, Math.max(1, Math.round(cc)));
        const wu = num('ntr-warmup', 3);
        if (wu !== null) s.warmupChapters = Math.min(20, Math.max(0, Math.round(wu)));
        const cp = num('ntr-ctx-prev', 300);
        if (cp !== null) s.contextPrevChars = Math.max(0, Math.round(cp));
        const cn = num('ntr-ctx-next', 300);
        if (cn !== null) s.contextNextChars = Math.max(0, Math.round(cn));

        const prompt = $('ntr-prompt');
        if (prompt) s.customPrompt = prompt.value;
        const gEnabled = $('ntr-glossary-enabled');
        if (gEnabled) s.glossaryEnabled = gEnabled.checked;

        const bt = $('ntr-book-title');
        if (bt) s.bookTitle = bt.value.trim();
        const ba = $('ntr-book-author');
        if (ba) s.bookAuthor = ba.value.trim();
        const tf = $('ntr-title-format');
        if (tf) s.txtTitleFormat = tf.value;

        saveSettings();
    }

    // ============================================
    // 文件导入
    // ============================================
    async function handleFileSelect(file) {
        if (!file.name.toLowerCase().endsWith('.txt')) {
            alert('请选择 TXT 文件');
            return;
        }
        if (file.size > 200 * 1024 * 1024) {
            alert(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），最大支持 200 MB`);
            return;
        }

        appendStream(`\n📂 正在读取 ${file.name}...\n`);
        showProgressSection(true);

        try {
            const { encoding, content } = await detectBestEncoding(file);
            State.file.name = file.name;
            State.file.hash = await hashText(content);

            collectSettingsFromUI();
            const chapters = buildChapters(content);
            if (!chapters || chapters.length === 0) {
                alert('没有切分出任何章节，请检查文件内容或章节正则');
                return;
            }
            State.chapters = chapters;

            if (!State.settings.bookTitle) {
                State.settings.bookTitle = file.name.replace(/\.txt$/i, '');
                const bt = $('ntr-book-title');
                if (bt) bt.value = State.settings.bookTitle;
                saveSettings();
            }

            const info = $('ntr-file-info');
            if (info) info.style.display = 'flex';
            const nameEl = $('ntr-file-name');
            if (nameEl) nameEl.textContent = file.name;
            const sizeEl = $('ntr-file-size');
            if (sizeEl) {
                sizeEl.textContent = `(${(content.length / 10000).toFixed(1)}万字, ${chapters.length}块, ${encoding})`;
            }

            showQueueSection(true);
            renderChapterList();
            updateProgress();
            await saveProgress();

            appendStream(
                `✅ 编码 ${encoding}，共 ${content.length} 字，按长度切成 ${chapters.length} 块\n` +
                    (State.settings.blockAsChapter
                        ? '⚙️ 章节纪律：一块 = 一章（强制）\n'
                        : '⚙️ 章节纪律：沿用原文自身的话数/章数\n'),
            );
        } catch (e) {
            appendStream(`❌ 读取失败: ${e.message}\n`);
            alert('读取文件失败: ' + e.message);
        }
    }

    /**
     * 切分正文。
     *
     * 恒按长度切，不再用正则决定边界，也不再弹窗问用户。
     * 正则只在导出时用来重新划分章节做目录。
     */
    function buildChapters(content) {
        return splitBySize(content, State.settings.chunkTokens);
    }

    /**
     * 用当前正则在指定文本里找章节标记，返回全部匹配。
     * @param {'source'|'translated'} which
     */
    function testRegex(which = 'source') {
        const input = $('ntr-chapter-regex');
        const result = $('ntr-regex-result');
        if (!input || !result) return;
        const pattern = input.value.trim();

        if (State.chapters.length === 0) {
            result.innerHTML = '⚠️ 请先导入 TXT 文件再测试';
            return;
        }

        let sample;
        let label;
        if (which === 'translated') {
            const done = State.chapters.filter((c) => c.status === STATUS.DONE && c.translated);
            if (done.length === 0) {
                result.innerHTML = '⚠️ 还没有已翻译的内容，先翻几块再测译文';
                return;
            }
            sample = done.map((c) => String(c.translated).trim()).join('\n\n');
            label = `译文（${done.length}/${State.chapters.length} 块已完成）`;
        } else {
            sample = State.chapters.map((c) => c.source).join('\n\n');
            label = '原文';
        }

        try {
            const re = new RegExp(pattern, 'gm');
            const found = [];
            let total = 0;
            let m;
            let guard = 0;
            while ((m = re.exec(sample)) !== null && guard++ < 100000) {
                if (m.index === re.lastIndex) re.lastIndex++;
                total++;
                if (found.length < 10) {
                    let title = (m[2] || '').trim();
                    const nl = title.indexOf('\n');
                    if (nl !== -1) title = title.slice(0, nl).trim();
                    found.push({ num: m[1] || '?', title: title || '(无标题，导出时用整句兜底)' });
                }
            }
            if (total === 0) {
                result.innerHTML =
                    `❌ 在${label}里<strong>一个章节都没匹配到</strong>。` +
                    (which === 'translated'
                        ? '<br>译文的章节写法可能和原文不同（例如原文 Chapter 12、译文第12话），照译文改正则。' +
                          '<br>导出时会自动退回「一块一节」，目录就是第1部分、第2部分这样。'
                        : '<br>请换个预设或检查正则。');
                return;
            }
            result.innerHTML =
                `✅ 在${label}里匹配到 <strong>${total}</strong> 个章节` +
                (which === 'translated' ? `，导出后目录就是这 ${total} 条` : '') +
                `，前 ${found.length} 条：<br>` +
                found.map((f) => `　${esc(f.num)} · ${esc(f.title)}`).join('<br>') +
                (total > found.length ? '<br>　…' : '');
        } catch (e) {
            result.innerHTML = `❌ 正则语法错误: ${esc(e.message)}`;
        }
    }

    /** 导出前预览目录：直接用导出时那套逻辑算一遍 */
    function previewExport() {
        const el = $('ntr-export-preview');
        if (!el) return;
        collectSettingsFromUI();
        const { units, mode, blockCount } = buildExportUnits();
        if (units.length === 0) {
            el.innerHTML = '⚠️ 还没有已完成的内容';
            return;
        }
        const head = units
            .slice(0, 10)
            .map((u, i) => `　${esc(buildDisplayTitle(u, i))}`)
            .join('<br>');
        el.innerHTML =
            (mode === 'regex'
                ? `✅ ${blockCount} 块译文 → 正则划出 <strong>${units.length}</strong> 章`
                : `⚠️ 正则没匹配到章节，将按块导出 <strong>${units.length}</strong> 节`) +
            `，目录前 ${Math.min(10, units.length)} 条：<br>${head}` +
            (units.length > 10 ? '<br>　…' : '');
    }

    /** 把当前所有块拼回整篇原文。切块本身不丢内容，所以拼回来就是全文。 */
    function joinAllSource() {
        return State.chapters.map((c) => String(c.source).trim()).join('\n\n');
    }

    /**
     * 按当前的「每块 token 上限」重新分块。
     *
     * 改上限不会自动重切——重切必然作废已有译文，不能偷偷做。
     */
    async function rechunk() {
        if (State.status === 'running') {
            alert('翻译进行中，请先停止再重新分块');
            return;
        }
        if (State.chapters.length === 0) {
            alert('还没有导入文件');
            return;
        }
        collectSettingsFromUI();

        const full = joinAllSource();
        const next = splitBySize(full, State.settings.chunkTokens);
        if (next.length === 0) {
            alert('重新分块结果为空，请检查内容');
            return;
        }

        const doneCount = State.chapters.filter((c) => c.status === STATUS.DONE).length;
        const warn =
            doneCount > 0
                ? `\n\n⚠️ 当前有 ${doneCount} 块已翻译，重新分块后这些译文会全部作废。\n建议先「导出任务」备份。`
                : '';
        if (
            !confirm(
                `按 ${State.settings.chunkTokens} token 上限重新分块：\n\n` +
                    `${State.chapters.length} 块 → ${next.length} 块${warn}\n\n确定吗？`,
            )
        ) {
            return;
        }

        State.chapters = next;
        State.timings = [];
        await saveProgress();
        showQueueSection(true);
        showExportSection(false);
        renderChapterList();
        updateProgress();
        appendStream(`\n♻️ 已按 ${State.settings.chunkTokens} tk 上限重新分块：共 ${next.length} 块\n`);
    }

    /** 「导入更新章节」的模式选择弹窗 */
    function pickUpdateMode() {
        return new Promise((resolve) => {
            const id = 'ntr-update-mode-modal';
            const old = $(id);
            if (old) old.remove();
            const html = `
<div id="${id}" class="ntr-modal-container" style="z-index:100000;">
 <div class="ntr-modal-scroll">
  <div class="ntr-modal" style="max-width:520px;">
    <div class="ntr-modal-header">
      <span class="ntr-modal-title">📗 导入更新章节 — 选择模式</span>
      <button class="ntr-modal-close" id="ntr-update-x">✕</button>
    </div>
    <div class="ntr-modal-body">
      <div class="ntr-section"><div class="ntr-section-content">
        <strong>➕ 仅新增模式</strong>
        <div class="ntr-hint-block">
          导入的 TXT <strong>只包含新增的章节</strong>，整个文件直接切块追加到末尾，不做任何比对。
        </div>
        <button id="ntr-update-append" class="ntr-btn ntr-btn-primary" style="margin-top:8px;width:100%;">用这个模式</button>
      </div></div>
      <div class="ntr-section"><div class="ntr-section-content">
        <strong>📘 完整文件模式</strong>
        <div class="ntr-hint-block">
          导入的是<strong>更新后的整本 TXT</strong>。会拿现有内容的末尾一段做锚点定位，
          只把锚点之后的新增部分切块追加。原文若有大段重复文本也不会误判。
        </div>
        <button id="ntr-update-full" class="ntr-btn" style="margin-top:8px;width:100%;">用这个模式</button>
      </div></div>
      <div class="ntr-hint-block">
        两种模式都<strong>只往末尾追加</strong>，已翻译的块不会被动。追加完点「开始翻译」只会跑新增的块。
      </div>
    </div>
    <div class="ntr-modal-footer">
      <button id="ntr-update-cancel" class="ntr-btn" style="margin-left:auto;">取消</button>
    </div>
  </div>
 </div>
</div>`;
            const wrap = document.createElement('div');
            wrap.innerHTML = html;
            document.body.appendChild(wrap.firstElementChild);

            const done = (v) => {
                const el = $(id);
                if (el) el.remove();
                resolve(v);
            };
            $('ntr-update-append').addEventListener('click', () => done('append-only'));
            $('ntr-update-full').addEventListener('click', () => done('full-file'));
            $('ntr-update-cancel').addEventListener('click', () => done(null));
            $('ntr-update-x').addEventListener('click', () => done(null));
        });
    }

    /**
     * 导入更新章节：把新增内容切块追加到末尾。
     *
     * 定位逻辑与世界书模块一致：锚点先看预期位置，再 lastIndexOf，最后才按长度截取。
     * 不能用 indexOf —— 小说里有重复段落（诗词、口号、章节模板）时会命中靠前那次，
     * 导致把已有内容当成新增又导入一遍。
     *
     * @param {'append-only'|'full-file'} mode
     * @param {File} file
     */
    async function importUpdateChapters(mode, file) {
        if (State.chapters.length === 0) {
            alert('请先导入原始 TXT 再用「导入更新章节」');
            return;
        }
        if (State.status === 'running') {
            alert('翻译进行中，请先停止');
            return;
        }

        try {
            collectSettingsFromUI();
            const { content } = await detectBestEncoding(file);
            let newPart = '';

            if (mode === 'append-only') {
                newPart = content.replace(/^\s+/, '');
                if (!newPart.trim()) {
                    alert('导入的文件内容为空');
                    return;
                }
            } else {
                const oldContent = joinAllSource();
                const oldLen = oldContent.length;

                if (content.length <= oldLen) {
                    if (!confirm('导入的文件长度不大于当前内容，可能没有新增章节。仍要继续吗？')) return;
                }

                const anchorLen = Math.min(2000, oldLen);
                if (anchorLen > 0) {
                    const anchor = oldContent.slice(oldLen - anchorLen);
                    const expectedPos = oldLen - anchorLen;
                    let anchorPos = -1;
                    if (content.startsWith(anchor, expectedPos)) anchorPos = expectedPos;
                    else anchorPos = content.lastIndexOf(anchor);
                    newPart = anchorPos !== -1 ? content.slice(anchorPos + anchor.length) : content.slice(oldLen);
                } else {
                    newPart = content.slice(oldLen);
                }
                newPart = newPart.replace(/^\s+/, '');

                if (!newPart.trim()) {
                    alert(
                        '未检测到新增内容。\n\n' +
                            '如果你导入的是「只含新增部分」的文件，请改用「➕ 仅新增模式」。\n' +
                            '注意：如果之前编辑或合并过分块，整篇内容和原始 TXT 会对不上，锚点可能失效。',
                    );
                    return;
                }
            }

            const pieces = splitBySize(newPart, State.settings.chunkTokens);
            if (pieces.length === 0) {
                alert('新增内容切块结果为空');
                return;
            }

            const modeLabel = mode === 'append-only' ? '仅新增模式' : '完整文件模式';
            if (
                !confirm(
                    `[${modeLabel}] 检测到约 ${(newPart.length / 1000).toFixed(1)}k 字新增内容。\n\n` +
                        `将切成 ${pieces.length} 块追加到末尾（第 ${State.chapters.length + 1}~${State.chapters.length + pieces.length} 块）。\n` +
                        `已翻译的块不受影响。\n\n确定导入吗？`,
                )
            ) {
                return;
            }

            const prevLen = State.chapters.length;
            pieces.forEach((p) => {
                State.chapters.push({
                    index: 0,
                    num: '',
                    rawTitle: '第0部分',
                    title: '第0部分',
                    source: p.source,
                    translated: '',
                    status: STATUS.PENDING,
                    error: '',
                });
            });
            renumberChapters();

            await saveProgress();
            showQueueSection(true);
            renderChapterList();
            updateProgress();

            const sizeEl = $('ntr-file-size');
            if (sizeEl) {
                const total = State.chapters.reduce((sum, c) => sum + c.source.length, 0);
                sizeEl.textContent = `(${(total / 10000).toFixed(1)}万字, ${State.chapters.length}块, 含更新)`;
            }

            appendStream(
                `\n📗 已追加 ${pieces.length} 块（第 ${prevLen + 1}~${State.chapters.length} 块）。\n` +
                    `点「开始翻译」只会跑未翻译的块。\n`,
            );
        } catch (e) {
            log(`导入更新章节失败: ${e.message}`, 'err');
            alert('导入更新章节失败: ' + e.message);
        }
    }

    async function clearFile() {
        if (State.status === 'running') {
            alert('翻译进行中，请先停止');
            return;
        }
        if (State.chapters.length > 0 && !confirm('确定清除当前文件和所有翻译进度吗？')) return;
        State.file = { name: '', hash: '' };
        State.chapters = [];
        State.timings = [];
        await dbDelete('current');
        const info = $('ntr-file-info');
        if (info) info.style.display = 'none';
        showQueueSection(false);
        showExportSection(false);
        renderChapterList();
        updateProgress();
    }

    // ============================================
    // 恢复上次进度
    // ============================================
    async function tryRestore() {
        const saved = await dbGet('current');
        if (!saved || !Array.isArray(saved.chapters) || saved.chapters.length === 0) return;
        const done = saved.chapters.filter((c) => c.status === STATUS.DONE).length;
        if (done === 0 && saved.chapters.every((c) => !c.translated)) return;

        const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('zh-CN') : '未知时间';
        if (
            !confirm(
                `发现未完成的翻译任务：\n\n` +
                    `${saved.fileName || '未命名'}\n` +
                    `共 ${saved.chapters.length} 章，已完成 ${done} 章\n` +
                    `保存于 ${when}\n\n` +
                    `是否恢复？`,
            )
        ) {
            return;
        }

        State.file.name = saved.fileName || '';
        State.file.hash = saved.fileHash || '';
        State.chapters = saved.chapters.map((c, i) => ({
            index: i,
            num: c.num || '',
            rawTitle: c.rawTitle || `第${i + 1}章`,
            title: c.title || '',
            source: c.source || '',
            translated: c.translated || '',
            status: c.status || STATUS.PENDING,
            error: c.error || '',
        }));
        if (Array.isArray(saved.glossary) && saved.glossary.length) {
            State.settings.glossary = saved.glossary;
        }

        const info = $('ntr-file-info');
        if (info) info.style.display = 'flex';
        const nameEl = $('ntr-file-name');
        if (nameEl) nameEl.textContent = State.file.name;
        const sizeEl = $('ntr-file-size');
        if (sizeEl) sizeEl.textContent = `(${State.chapters.length}章, 已恢复)`;

        showQueueSection(true);
        showProgressSection(true);
        if (done > 0) showExportSection(true);
        renderChapterList();
        renderGlossary();
        updateProgress();
        appendStream(`\n♻️ 已恢复上次进度：${done}/${State.chapters.length} 章\n`);
    }

    // ============================================
    // 帮助
    // ============================================
    function showHelp() {
        const html = `
<div id="ntr-help-modal" class="ntr-modal-container" style="z-index:100000;">
 <div class="ntr-modal-scroll">
  <div class="ntr-modal" style="max-width:620px;">
    <div class="ntr-modal-header">
      <span class="ntr-modal-title">❓ 小说翻译 使用说明</span>
      <button class="ntr-modal-close" id="ntr-help-close">✕</button>
    </div>
    <div class="ntr-modal-body" style="font-size:13px;line-height:1.75;">
      <div class="ntr-section"><div class="ntr-section-content">
        <strong>📌 基本流程</strong>
        <div>导入 TXT → 按长度切块 → 并发翻译 → 导出 EPUB / TXT。全程可中断，进度自动保存。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>✂️ 分块与「强制记忆块为章节」</strong>
        <div>正文<strong>一律按「每块 token 上限」切分</strong>，不再用正则决定边界，也不会再弹窗问你。
        切出来的每一块是一个请求。</div>
        <div style="margin-top:6px;"><strong>不勾选</strong>（默认）：提示词里会说明这块只是按长度切出来的，
        要求 AI 沿用<strong>原文自身的话数/章数</strong>，不得合并或拆分，也不要把一块当成一章。
        原文的章节标题会照常翻译并单独成行。</div>
        <div style="margin-top:6px;"><strong>勾选</strong>：提示词里会要求 AI 把每一块<strong>整个当成一章</strong>，
        块内不再分章。适合原文压根没有规范章节标记、你就想按固定长度分章的情况。</div>
        <div style="margin-top:6px;">分块列表里<strong>点任意一块</strong>可以查看和编辑原文/译文，
        也能复制、合并到相邻块、按上限重切、单独重翻或删除。</div>
        <div style="margin-top:6px;">改了「每块 token 上限」<strong>不会自动重切</strong>，
        要点「♻️ 按当前上限重新分块」才生效——重切会作废已有译文，所以不能偷偷做。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>📖 术语表</strong>
        <div>并发翻译最大的问题是人名不统一——同一个名字在不同章被译成两种写法。</div>
        <div style="margin-top:6px;">解决办法：<strong>前几章串行跑</strong>（默认3章，可改0~20），把主要人名地名定下来；
        之后每章翻译时顺带回报新出现的专有名词，滚动补充。每次请求都会带上术语表让 AI 照着译。</div>
        <div style="margin-top:6px;">术语表可以手动编辑，改完之后的章节全部照新的来。
        <strong>术语表只发给 AI 参考，不会出现在导出的小说里。</strong></div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>🔗 章节衔接</strong>
        <div>每章会带上一章结尾和下一章开头各若干字给 AI 看，避免代词指代和语气断裂。
        这两段<strong>只是参考，不会被翻译进结果</strong>，提示词里已写明。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>✅ 怎么判断翻译失败</strong>
        <div>译文用 <code>&lt;译文&gt;&lt;/译文&gt;</code> 标签包裹。输出被 max_tokens 截断时闭合标签一定不在，
        据此判定截断并自动重试。另外还会检查译文长度，明显过短也判为异常。</div>
        <div style="margin-top:6px;">导出时标签会被剥掉，你拿到的是纯正文。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>🔍 章节正则（导出目录用）</strong>
        <div>因为切块和章节边界无关，目录不能按块来做。导出时会把译文<strong>拼回整篇</strong>，
        再用这个正则重新划分章节，划出来的才是目录。匹配不到时退回「一块一节」。</div>
        <div style="margin-top:6px;">正则区有两个测试按钮：<strong>测原文</strong>看原文能匹配多少章，
        <strong>测译文</strong>看译文能匹配多少章。<strong>导出前点一下「测译文」或「预览导出目录」</strong>，
        就能提前看到目录会长什么样，不用导完再发现错了。</div>
        <div style="margin-top:6px;">注意原文和译文的章节写法可能不一样（原文 Chapter 12、译文第12话），
        必要时分别调整正则。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>🔧 拉取模型与快速测试</strong>
        <div><strong>拉取模型</strong>会向接口要一份可用模型列表，拉到后从下拉里选即可，省得手打模型名。
        三家接口各走各的地址（OpenAI 兼容 /models、Gemini /models、Anthropic /v1/models）。</div>
        <div style="margin-top:6px;"><strong>快速测试</strong>用当前配置发一条最短的非流式请求，
        验证「地址 + Key + 模型」这条链路通不通。开跑前先测一下，比翻到一半才报错省时间。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>📦 EPUB 和 TXT 的区别</strong>
        <div><strong>EPUB</strong>：目录写在文件内部（toc.ncx），每章一个书签，阅读器里一定能跳转。</div>
        <div style="margin-top:6px;"><strong>TXT</strong>：格式本身<strong>不支持目录</strong>，无法内嵌书签。
        导出时只能把标题排成独占一行、前后空行的规范样子，让阅读器用正则自己扫。能不能扫出来取决于阅读器。
        <strong>要目录就用 EPUB。</strong></div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>📗 导入更新章节</strong>
        <div>小说更新后追加新章节用这个，<strong>已翻译的块完全不受影响</strong>，追加完点开始只跑新块。</div>
        <div style="margin-top:6px;"><strong>仅新增模式</strong>：导入的 TXT 只含新章节，整个文件切块追加。</div>
        <div style="margin-top:6px;"><strong>完整文件模式</strong>：导入更新后的整本 TXT，
        用现有内容末尾一段做锚点定位，只追加锚点之后的部分。原文有重复段落也不会误判成新增。</div>
        <div style="margin-top:6px;">注意：如果你手动编辑或合并过分块，整篇内容和原始 TXT 就对不上了，
        锚点可能失效，这时改用「仅新增模式」。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>💾 断点续传与任务</strong>
        <div>翻译时每 60 秒自动存盘，关页面前也会存。下次打开会问你是否恢复。</div>
        <div style="margin-top:6px;"><strong>导出任务</strong>会把原文、译文、术语表一起打包成 json。
        再次导入就能接着翻，也可以只重译其中几章。</div>
      </div></div>

      <div class="ntr-section"><div class="ntr-section-content">
        <strong>⚠️ 关于并发数</strong>
        <div>并发上限取决于你的 API 提供商的速率限制，没有统一答案。
        429 报错变多就调小——插件会自动退避重试，但并发太高反而更慢。默认 3 是保守起点。</div>
      </div></div>
    </div>
    <div class="ntr-modal-footer">
      <button class="ntr-btn ntr-btn-primary" id="ntr-help-ok" style="margin-left:auto;">我知道了</button>
    </div>
  </div>
 </div>
</div>`;
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        document.body.appendChild(wrap.firstElementChild);
        const close = () => {
            const el = $('ntr-help-modal');
            if (el) el.remove();
        };
        $('ntr-help-close').addEventListener('click', close);
        $('ntr-help-ok').addEventListener('click', close);
    }

    // ============================================
    // 模型拉取 / 快速测试
    // ============================================
    function setModelStatus(text, type) {
        const el = $('ntr-model-status');
        if (!el) return;
        el.textContent = text;
        el.className = 'ntr-model-status' + (type ? ' ' + type : '');
    }

    async function handleFetchModels() {
        const btn = $('ntr-fetch-models');
        const field = $('ntr-model-select-field');
        const select = $('ntr-model-select');
        collectSettingsFromUI();

        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 拉取中...';
        }
        setModelStatus('正在拉取模型列表...', 'loading');

        try {
            const models = await fetchModelList();
            if (!models.length) {
                setModelStatus('❌ 接口没返回任何模型，手动填模型名即可', 'error');
                if (field) field.style.display = 'none';
                return;
            }
            if (select) {
                select.innerHTML =
                    '<option value="">-- 共 ' + models.length + ' 个，选一个 --</option>' +
                    models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
                if (models.includes(State.settings.apiModel)) select.value = State.settings.apiModel;
            }
            if (field) field.style.display = 'block';
            setModelStatus(`✅ 拉取到 ${models.length} 个模型`, 'success');
        } catch (e) {
            log(`拉取模型失败: ${e.message}`, 'err');
            setModelStatus(`❌ ${e.message}`, 'error');
            if (field) field.style.display = 'none';
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔄 拉取模型';
            }
        }
    }

    async function handleQuickTest() {
        const btn = $('ntr-quick-test');
        collectSettingsFromUI();

        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 测试中...';
        }
        setModelStatus('正在测试连接...', 'loading');

        try {
            const { elapsed, reply } = await quickTestModel();
            setModelStatus(`✅ 连接正常 (${elapsed}ms)${reply ? ' · 回复: ' + reply.slice(0, 40) : ''}`, 'success');
        } catch (e) {
            log(`快速测试失败: ${e.message}`, 'err');
            setModelStatus(`❌ ${e.message}`, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '⚡ 快速测试';
            }
        }
    }

    // ============================================
    // 事件绑定
    // ============================================
    function bindEvents() {
        // --- 折叠面板 ---
        document.querySelectorAll('#ntr-modal .ntr-section-header[data-target]').forEach((header) => {
            header.addEventListener('click', () => {
                const content = $(header.dataset.target);
                const icon = header.querySelector('.ntr-collapse-icon');
                if (!content) return;
                const hidden = content.style.display === 'none';
                content.style.display = hidden ? 'block' : 'none';
                if (icon) icon.textContent = hidden ? '▼' : '▶';
            });
        });

        // --- 关闭 ---
        $('ntr-close').addEventListener('click', closeModal);
        $('ntr-help').addEventListener('click', showHelp);

        // --- 设置变更自动保存 ---
        [
            'ntr-provider', 'ntr-model', 'ntr-key', 'ntr-endpoint', 'ntr-timeout',
            'ntr-temperature', 'ntr-maxtokens', 'ntr-chunk-tokens', 'ntr-concurrency',
            'ntr-warmup', 'ntr-ctx-prev', 'ntr-ctx-next', 'ntr-chapter-regex',
            'ntr-book-title', 'ntr-book-author', 'ntr-title-format',
        ].forEach((id) => {
            const el = $(id);
            if (el) el.addEventListener('change', collectSettingsFromUI);
        });

        const promptEl = $('ntr-prompt');
        if (promptEl) promptEl.addEventListener('input', collectSettingsFromUI);

        $('ntr-glossary-enabled').addEventListener('change', collectSettingsFromUI);
        $('ntr-export-split-regex').addEventListener('change', () => {
            collectSettingsFromUI();
            previewExport();
        });

        // --- 模型拉取 / 快速测试 ---
        $('ntr-fetch-models').addEventListener('click', handleFetchModels);
        $('ntr-quick-test').addEventListener('click', handleQuickTest);
        $('ntr-model-select').addEventListener('change', (e) => {
            if (!e.target.value) return;
            $('ntr-model').value = e.target.value;
            collectSettingsFromUI();
            setModelStatus(`已选择模型：${e.target.value}`, 'success');
        });

        // --- 块即章节开关 ---
        $('ntr-block-as-chapter').addEventListener('change', () => {
            collectSettingsFromUI();
            updateBlockModeHint();
            if (State.chapters.some((c) => c.status === STATUS.DONE)) {
                appendStream('\n⚠️ 章节纪律已改变，只影响之后翻译的块，已完成的块不受影响。\n');
            }
        });

        // --- 正则预设与测试 ---
        $('ntr-regex-preset').addEventListener('change', (e) => {
            const idx = e.target.value;
            if (idx === '') return;
            const preset = CHAPTER_REGEX_PRESETS[+idx];
            if (preset) {
                $('ntr-chapter-regex').value = preset.value;
                collectSettingsFromUI();
                testRegex('source');
            }
            e.target.value = '';
        });
        $('ntr-test-regex').addEventListener('click', () => testRegex('source'));
        $('ntr-test-regex-translated').addEventListener('click', () => testRegex('translated'));
        $('ntr-preview-export').addEventListener('click', previewExport);

        // --- 提示词 ---
        $('ntr-reset-prompt').addEventListener('click', () => {
            if (!confirm('恢复默认翻译提示词？')) return;
            State.settings.customPrompt = DEFAULT_PROMPT;
            $('ntr-prompt').value = DEFAULT_PROMPT;
            saveSettings();
        });

        // --- 消息链 ---
        $('ntr-add-chain').addEventListener('click', () => {
            State.settings.promptMessageChain.push({ role: 'user', content: '', enabled: true });
            renderChain();
            saveSettings();
        });
        $('ntr-reset-chain').addEventListener('click', () => {
            if (!confirm('恢复默认消息链？')) return;
            State.settings.promptMessageChain = [{ role: 'user', content: '{PROMPT}', enabled: true }];
            State.settings.importedPresetName = '';
            renderChain();
            const el = $('ntr-preset-name');
            if (el) el.textContent = '';
            saveSettings();
        });

        // --- 导入酒馆预设 ---
        $('ntr-import-preset').addEventListener('click', () => $('ntr-preset-file').click());
        $('ntr-preset-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            e.target.value = '';
            try {
                const parsed = parseTavernPreset(JSON.parse(await file.text()));
                const name = file.name.replace(/\.json$/i, '');
                const st = parsed.stats;
                const msg =
                    `预设「${name}」解析结果：\n\n` +
                    `· 条目 ${st.used} 条\n` +
                    `· 丢弃占位符 ${st.dropped} 个（角色卡/世界书等，本模块无对应物）\n` +
                    `· 跳过空内容 ${st.skippedEmpty} 条\n` +
                    `· 正文槽位：${st.hasSlot ? '来自「聊天记录」占位符' : '已自动追加到末尾'}\n` +
                    (parsed.params.temperature !== null ? `· temperature = ${parsed.params.temperature}\n` : '') +
                    `\n导入会覆盖当前消息链，确认？`;
                if (!confirm(msg)) return;

                State.settings.promptMessageChain = parsed.chain;
                if (parsed.params.temperature !== null) State.settings.temperature = parsed.params.temperature;
                if (parsed.params.maxTokens !== null) State.settings.maxTokens = parsed.params.maxTokens;
                State.settings.importedPresetName = name;
                saveSettings();
                restoreSettingsToUI();
                alert(`✅ 预设「${name}」已导入`);
            } catch (err) {
                alert('预设导入失败: ' + err.message);
            }
        });

        // --- 术语表 ---
        $('ntr-add-term').addEventListener('click', () => {
            State.settings.glossary.push({ source: '', target: '', note: '' });
            renderGlossary();
            saveSettings();
        });
        $('ntr-clear-glossary').addEventListener('click', () => {
            if (!confirm(`确定清空术语表（${State.settings.glossary.length} 条）？`)) return;
            State.settings.glossary = [];
            renderGlossary();
            saveSettings();
        });

        // --- 文件 ---
        const upload = $('ntr-upload');
        const fileInput = $('ntr-file-input');
        upload.addEventListener('click', () => fileInput.click());
        upload.addEventListener('dragover', (e) => {
            e.preventDefault();
            upload.style.borderColor = '#3498db';
        });
        upload.addEventListener('dragleave', () => {
            upload.style.borderColor = '#555';
        });
        upload.addEventListener('drop', (e) => {
            e.preventDefault();
            upload.style.borderColor = '#555';
            if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) handleFileSelect(e.target.files[0]);
            e.target.value = '';
        });
        $('ntr-clear-file').addEventListener('click', clearFile);

        // --- 任务导入导出 ---
        $('ntr-export-task').addEventListener('click', exportTask);
        $('ntr-import-task').addEventListener('click', () => $('ntr-task-input').click());
        $('ntr-task-input').addEventListener('change', (e) => {
            if (e.target.files.length) importTask(e.target.files[0]);
            e.target.value = '';
        });

        // --- 重新分块 ---
        $('ntr-rechunk').addEventListener('click', rechunk);

        // --- 导入更新章节 ---
        $('ntr-update-chapters').addEventListener('click', async () => {
            if (State.chapters.length === 0) {
                alert('请先导入原始 TXT 再用「导入更新章节」');
                return;
            }
            const mode = await pickUpdateMode();
            if (!mode) return;
            State.__updateMode = mode;
            $('ntr-update-input').click();
        });
        $('ntr-update-input').addEventListener('change', (e) => {
            const f = e.target.files[0];
            e.target.value = '';
            if (f && State.__updateMode) importUpdateChapters(State.__updateMode, f);
            State.__updateMode = null;
        });

        // --- 实时输出 ---
        $('ntr-toggle-stream').addEventListener('click', () => {
            const c = $('ntr-stream-container');
            c.style.display = c.style.display === 'none' ? 'block' : 'none';
        });
        $('ntr-clear-stream').addEventListener('click', () => {
            State.streamContent = '';
            $('ntr-stream-content').textContent = '';
        });
        const streamEl = $('ntr-stream-content');
        if (streamEl) {
            streamEl.addEventListener('scroll', () => {
                State.streamAutoScroll =
                    streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight <= 40;
            });
        }

        // --- 主操作 ---
        $('ntr-start').addEventListener('click', () => {
            collectSettingsFromUI();
            startTranslation(0);
        });
        $('ntr-stop').addEventListener('click', () => {
            State.isStopped = true;
            appendStream('\n⏹️ 正在停止，等待进行中的请求结束...\n');
        });
        $('ntr-repair').addEventListener('click', () => {
            collectSettingsFromUI();
            repairFailed();
        });

        // --- 导出 ---
        $('ntr-export-epub').addEventListener('click', () => {
            collectSettingsFromUI();
            exportEPUB().catch((e) => alert('导出失败: ' + e.message));
        });
        $('ntr-export-txt').addEventListener('click', () => {
            collectSettingsFromUI();
            try {
                exportTXT();
            } catch (e) {
                alert('导出失败: ' + e.message);
            }
        });
    }

    // ============================================
    // 打开 / 关闭
    // ============================================
    let opened = false;

    async function openModal() {
        if ($('ntr-modal')) {
            $('ntr-modal').style.display = 'block';
            $('ntr-modal').scrollTop = 0;
            document.body.style.overflow = 'hidden';
            return;
        }

        loadSettings();

        if (!$('ntr-styles')) {
            const styleWrap = document.createElement('div');
            styleWrap.innerHTML = buildStyles();
            document.head.appendChild(styleWrap.firstElementChild);
        }

        const wrap = document.createElement('div');
        wrap.innerHTML = buildModalHtml();
        document.body.appendChild(wrap.firstElementChild);
        document.body.style.overflow = 'hidden';

        bindEvents();
        restoreSettingsToUI();
        renderChapterList();
        updateProgress();

        if (!opened) {
            opened = true;
            // 首次打开时问一次是否恢复上次进度
            setTimeout(() => tryRestore().catch(() => {}), 300);
        }
    }

    function closeModal() {
        if (State.status === 'running') {
            if (!confirm('翻译还在进行中，关闭界面不会停止翻译。确定关闭吗？')) return;
        }
        const el = $('ntr-modal');
        if (el) el.style.display = 'none';
        document.body.style.overflow = '';
    }

    // ============================================
    // 对外接口
    // ============================================
    window.NovelTranslate = {
        open: openModal,
        close: closeModal,
        version: VERSION,
        // 供调试
        _state: State,
        _splitByChapterRegex: splitByChapterRegex,
        _splitBySize: splitBySize,
        _extractTranslation: extractTranslation,
        _estimateTokens: estimateTokens,
        _parseTavernPreset: parseTavernPreset,
        _extractReportedTerms: extractReportedTerms,
        _cnNumToInt: cnNumToInt,
        _buildChapters: buildChapters,
        _buildPrompt: buildPrompt,
        _buildExportUnits: buildExportUnits,
        _buildDisplayTitle: buildDisplayTitle,
        _buildRequest: buildRequest,
        _buildModelsUrl: buildModelsUrl,
        _renumberChapters: renumberChapters,
        _importUpdateChapters: importUpdateChapters,
        _joinAllSource: joinAllSource,
        _downloadBlob: downloadBlob,
    };

    console.log(`[NovelTranslate] 📖 小说翻译模块已加载 v${VERSION}`);
})();
