import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 与 novelTranslate.test.js 相同的最小 DOM 替身
function loadModule() {
    const registry = new Map();
    const makeEl = (tag) => ({
        tagName: String(tag).toUpperCase(),
        style: {},
        dataset: {},
        children: [],
        _listeners: {},
        value: '',
        checked: false,
        textContent: '',
        innerHTML: '',
        appendChild(c) {
            this.children.push(c);
            return c;
        },
        removeChild(c) {
            this.children = this.children.filter((x) => x !== c);
        },
        remove() {},
        addEventListener(t, f) {
            (this._listeners[t] = this._listeners[t] || []).push(f);
        },
        removeEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        click() {},
        get firstElementChild() {
            return this.children[0] || null;
        },
    });

    globalThis.document = {
        head: makeEl('head'),
        body: makeEl('body'),
        createElement: makeEl,
        getElementById: (id) => registry.get(id) || null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: () => {},
    };
    globalThis.window = globalThis.window || {};
    globalThis.localStorage = {
        _d: {},
        getItem(k) {
            return this._d[k] ?? null;
        },
        setItem(k, v) {
            this._d[k] = String(v);
        },
        removeItem(k) {
            delete this._d[k];
        },
    };
    globalThis.indexedDB = {
        open() {
            const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
            setTimeout(() => req.onerror && req.onerror({ target: { error: new Error('no db') } }), 0);
            return req;
        },
    };
    globalThis.alert = () => {};
    globalThis.confirm = () => true;

    const src = readFileSync(new URL('../../novelTranslate.js', import.meta.url), 'utf8');
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    return globalThis.window.NovelTranslate;
}

const NT = loadModule();
const S = NT._state.settings;

function mkChapter(i, source, translated) {
    return {
        index: i,
        num: String(i + 1),
        rawTitle: `第${i + 1}部分`,
        title: `第${i + 1}部分`,
        source,
        translated: translated || '',
        status: translated ? 'done' : 'pending',
        error: '',
    };
}

describe('需求3 · 恒按长度分块', () => {
    it('原文有规范章节标记时也照样按长度切，不按章节切', () => {
        const text = Array.from({ length: 6 }, (_, i) => `第${i + 1}话：标题${i + 1}\n${'正'.repeat(500)}`).join('\n\n');
        // 每话约 508 tk，上限 1200 → 两话装一块，共 3 块（若按章节切会是 6 块）
        S.chunkTokens = 1200;
        const blocks = NT._buildChapters(text);
        expect(blocks).toHaveLength(3);
        expect(blocks[0].rawTitle).toBe('第1部分');
        // 同一块里同时含两个章节标记 —— 证明块边界和章节边界确实无关
        expect(blocks[0].source).toContain('第1话');
        expect(blocks[0].source).toContain('第2话');
    });

    it('不再返回 null，也不依赖 confirm 弹窗', () => {
        S.chunkTokens = 30000;
        const blocks = NT._buildChapters('完全没有任何章节标记的一段文字');
        expect(Array.isArray(blocks)).toBe(true);
        expect(blocks.length).toBe(1);
    });

    it('切块保留原文全部内容，包括章节标题行', () => {
        S.chunkTokens = 100;
        const text = '第1话：相遇\n' + '甲'.repeat(200) + '\n\n第2话：重逢\n' + '乙'.repeat(200);
        const joined = NT._buildChapters(text)
            .map((b) => b.source)
            .join('\n\n');
        expect(joined).toContain('第1话：相遇');
        expect(joined).toContain('第2话：重逢');
        expect((joined.match(/甲/g) || []).length).toBe(200);
        expect((joined.match(/乙/g) || []).length).toBe(200);
    });
});

describe('需求3 · 强制记忆块为章节 开关只改提示词', () => {
    const ch = mkChapter(2, '正文内容');

    it('开启时要求整块当一章', () => {
        S.blockAsChapter = true;
        const p = NT._buildPrompt(ch, '正文内容');
        expect(p).toContain('当作完整的第 3 章');
        expect(p).toContain('不要在块内部再划分章节');
        expect(p).toContain('本块编号：第 3 块');
    });

    it('关闭时要求沿用原文话数，不得当成一章', () => {
        S.blockAsChapter = false;
        const p = NT._buildPrompt(ch, '正文内容');
        expect(p).toContain('沿用原文自身的话数/章数');
        expect(p).toContain('不得合并');
        expect(p).toContain('不要**把这一块当成一章');
        expect(p).not.toContain('本块编号');
    });
});

describe('需求4 · 导出用正则在译文里重新划分章节', () => {
    const REGEX = '第([0-9一二三四五六七八九十百千零\\d]+)话[ \\t：:]*(.*)';

    it('块边界与章节边界无关时，导出仍能划出正确章节', () => {
        S.chapterRegex = REGEX;
        S.exportSplitByRegex = true;
        S.txtTitleFormat = 'original';
        // 一块里含两话，且第3话被劈成两块
        NT._state.chapters = [
            mkChapter(0, 'x', '第1话：相遇\n甲内容\n\n第2话：重逢\n乙内容\n\n第3话：离别\n丙内容前半'),
            mkChapter(1, 'x', '丙内容后半'),
        ];
        const { units, mode, blockCount } = NT._buildExportUnits();
        expect(mode).toBe('regex');
        expect(blockCount).toBe(2);
        expect(units).toHaveLength(3);
        expect(units[0].title).toBe('相遇');
        expect(units[2].title).toBe('离别');
        // 被劈开的第3话应重新拼回完整
        expect(units[2].text).toContain('丙内容前半');
        expect(units[2].text).toContain('丙内容后半');
    });

    it('正则匹配不到时退回一块一节，不报错', () => {
        S.chapterRegex = REGEX;
        S.exportSplitByRegex = true;
        NT._state.chapters = [mkChapter(0, 'x', '没有章节标记的译文'), mkChapter(1, 'x', '也没有')];
        const { units, mode } = NT._buildExportUnits();
        expect(mode).toBe('block');
        expect(units).toHaveLength(2);
        expect(units[0].title).toBe('第1部分');
    });

    it('关掉开关时不走正则，一块一节', () => {
        S.exportSplitByRegex = false;
        NT._state.chapters = [mkChapter(0, 'x', '第1话：相遇\n甲\n\n第2话：重逢\n乙')];
        const { units, mode } = NT._buildExportUnits();
        expect(mode).toBe('block');
        expect(units).toHaveLength(1);
        S.exportSplitByRegex = true;
    });

    it('未完成的块不进入导出', () => {
        S.chapterRegex = REGEX;
        NT._state.chapters = [mkChapter(0, 'x', '第1话：甲\n内容'), mkChapter(1, 'x')];
        const { blockCount } = NT._buildExportUnits();
        expect(blockCount).toBe(1);
    });

    it('正则语法错误时不抛出，退回按块导出', () => {
        S.chapterRegex = '第([0-9]+话';
        NT._state.chapters = [mkChapter(0, 'x', '第1话：甲\n内容')];
        expect(() => NT._buildExportUnits()).not.toThrow();
        expect(NT._buildExportUnits().mode).toBe('block');
        S.chapterRegex = REGEX;
    });

    it('导出标题按编号格式渲染', () => {
        S.txtTitleFormat = 'chinese';
        expect(NT._buildDisplayTitle({ num: '12', title: '离别' }, 0)).toBe('第十二话 离别');
        S.txtTitleFormat = 'arabic';
        expect(NT._buildDisplayTitle({ num: '十二', title: '离别' }, 0)).toBe('第12话 离别');
        S.txtTitleFormat = 'original';
        // 无编号的块用序号兜底
        expect(NT._buildDisplayTitle({ num: '', title: '' }, 4)).toBe('第5章');
    });
});

describe('需求1 · 模型拉取地址与非流式测试请求', () => {
    it('buildModelsUrl 三种写法都归一到 /models', () => {
        expect(NT._buildModelsUrl('https://api.x.com/v1')).toBe('https://api.x.com/v1/models');
        expect(NT._buildModelsUrl('https://api.x.com/v1/chat/completions')).toBe('https://api.x.com/v1/models');
        expect(NT._buildModelsUrl('https://api.x.com/v1/models')).toBe('https://api.x.com/v1/models');
        expect(NT._buildModelsUrl('api.x.com/v1')).toBe('https://api.x.com/v1/models');
    });

    it('OpenAI 兼容：stream:false 时请求体不开流', () => {
        S.apiProvider = 'openai-compatible';
        S.apiEndpoint = 'https://api.x.com/v1';
        S.apiKey = 'k';
        S.apiModel = 'gpt-test';
        const { url, options } = NT._buildRequest([{ role: 'user', content: 'hi' }], { stream: false, maxTokens: 64 });
        const body = JSON.parse(options.body);
        expect(url).toBe('https://api.x.com/v1/chat/completions');
        expect(body.stream).toBe(false);
        expect(body.max_tokens).toBe(64);
    });

    it('默认仍然是流式，翻译主流程不受影响', () => {
        const body = JSON.parse(NT._buildRequest([{ role: 'user', content: 'hi' }]).options.body);
        expect(body.stream).toBe(true);
    });

    it('Gemini 非流式换成 generateContent', () => {
        S.apiProvider = 'gemini';
        S.apiEndpoint = '';
        S.apiKey = 'gk';
        S.apiModel = 'gemini-2.5-flash';
        expect(NT._buildRequest([{ role: 'user', content: 'hi' }], { stream: false }).url).toContain(':generateContent');
        expect(NT._buildRequest([{ role: 'user', content: 'hi' }]).url).toContain(':streamGenerateContent');
    });

    it('Anthropic 非流式且带浏览器直连头', () => {
        S.apiProvider = 'anthropic';
        S.apiEndpoint = '';
        S.apiKey = 'ak';
        S.apiModel = 'claude-x';
        const { options } = NT._buildRequest([{ role: 'user', content: 'hi' }], { stream: false, maxTokens: 64 });
        expect(JSON.parse(options.body).stream).toBe(false);
        expect(options.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
        S.apiProvider = 'openai-compatible';
    });
});

describe('需求2 · 分块合并后的重编号', () => {
    it('删掉中间一块后序号连续', () => {
        NT._state.chapters = [mkChapter(0, 'a'), mkChapter(1, 'b'), mkChapter(2, 'c')];
        NT._state.chapters.splice(1, 1);
        NT._renumberChapters();
        const list = NT._state.chapters;
        expect(list.map((c) => c.index)).toEqual([0, 1]);
        expect(list.map((c) => c.rawTitle)).toEqual(['第1部分', '第2部分']);
        expect(list.map((c) => c.num)).toEqual(['1', '2']);
    });

    it('用户自定义过的标题不会被重编号覆盖', () => {
        NT._state.chapters = [mkChapter(0, 'a'), mkChapter(1, 'b')];
        NT._state.chapters[0].rawTitle = '我改的标题';
        NT._renumberChapters();
        expect(NT._state.chapters[0].rawTitle).toBe('我改的标题');
        expect(NT._state.chapters[1].rawTitle).toBe('第2部分');
    });
});

describe('debug1 · 重新分块', () => {
    it('joinAllSource 能把块拼回完整原文', () => {
        NT._state.chapters = [mkChapter(0, '第一段内容'), mkChapter(1, '第二段内容')];
        expect(NT._joinAllSource()).toBe('第一段内容\n\n第二段内容');
    });

    it('改上限后重切，块数随之改变且内容不丢', () => {
        S.chunkTokens = 100;
        const text = Array.from({ length: 8 }, (_, i) => `段落${i}` + '文'.repeat(60)).join('\n\n');
        const first = NT._buildChapters(text);
        expect(first.length).toBeGreaterThan(1);

        NT._state.chapters = first;
        // 模拟用户把上限调大后重切
        S.chunkTokens = 100000;
        const again = NT._buildChapters(NT._joinAllSource());
        expect(again).toHaveLength(1);
        for (let i = 0; i < 8; i++) expect(again[0].source).toContain(`段落${i}`);
    });
});

describe('debug2 · 导入更新章节', () => {
    const origAlert = globalThis.alert;
    const origConfirm = globalThis.confirm;

    async function runUpdate(mode, newText, existing) {
        NT._state.chapters = existing;
        NT._state.status = 'idle';
        globalThis.alert = () => {};
        globalThis.confirm = () => true;
        S.chunkTokens = 100000;
        await NT._importUpdateChapters(mode, {
            name: 'u.txt',
            arrayBuffer: async () => new TextEncoder().encode(newText).buffer,
        });
        globalThis.alert = origAlert;
        globalThis.confirm = origConfirm;
        return NT._state.chapters;
    }

    it('仅新增模式：整个文件追加到末尾', async () => {
        const after = await runUpdate('append-only', '第9话：新章\n新内容', [mkChapter(0, '老内容', '老译文')]);
        expect(after).toHaveLength(2);
        expect(after[1].source).toContain('新内容');
        // 已翻译的块不受影响
        expect(after[0].translated).toBe('老译文');
        expect(after[0].status).toBe('done');
    });

    it('完整文件模式：只追加锚点之后的新增部分', async () => {
        const old = '第1话：起\n甲内容\n\n第2话：承\n乙内容';
        const after = await runUpdate('full-file', old + '\n\n第3话：转\n丙内容', [mkChapter(0, old, '译文')]);
        expect(after).toHaveLength(2);
        expect(after[1].source).toContain('丙内容');
        // 关键：旧内容不能被重复导入
        expect(after[1].source).not.toContain('甲内容');
        expect(after[0].translated).toBe('译文');
    });

    it('完整文件模式：正文有重复段落时不会误判（用 lastIndexOf 而非 indexOf）', async () => {
        // 「甲内容」在前面出现过一次，若用 indexOf 定位锚点会命中靠前那次
        const old = '开场白\n甲内容\n\n中段\n甲内容';
        const after = await runUpdate('full-file', old + '\n\n新增章节内容', [mkChapter(0, old)]);
        expect(after).toHaveLength(2);
        expect(after[1].source.trim()).toBe('新增章节内容');
    });

    it('追加后序号连续', async () => {
        const after = await runUpdate('append-only', '新内容', [mkChapter(0, 'a'), mkChapter(1, 'b')]);
        expect(after.map((c) => c.index)).toEqual([0, 1, 2]);
        expect(after[2].rawTitle).toBe('第3部分');
    });
});

describe('debug3 · EPUB 不能是 zip', () => {
    it('downloadBlob 会按传入的 MIME 重新包一层', () => {
        const captured = [];
        const origURL = globalThis.URL;
        const origBlob = globalThis.Blob;
        globalThis.Blob = class {
            constructor(parts, opts) {
                this.parts = parts;
                this.type = (opts && opts.type) || '';
                captured.push(this.type);
            }
        };
        globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

        const zipBlob = { type: 'application/zip' };
        NT._downloadBlob(zipBlob, 'book.epub', 'application/epub+zip');
        expect(captured).toContain('application/epub+zip');

        globalThis.Blob = origBlob;
        globalThis.URL = origURL;
    });

    it('源码里 generateAsync 指定了 epub 的 mimeType', () => {
        const src = readFileSync(new URL('../../novelTranslate.js', import.meta.url), 'utf8');
        const call = src.slice(src.indexOf('zip.generateAsync'));
        expect(call.slice(0, 200)).toContain("mimeType: 'application/epub+zip'");
        // mimetype 文件必须不压缩，否则部分阅读器不认
        expect(src).toContain("zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })");
    });
});

describe('debug4 · 任务导入（隐藏 input 冒泡 bug）', () => {
    it('隐藏的 file input 不再是拖拽区的子元素', () => {
        const src = readFileSync(new URL('../../novelTranslate.js', import.meta.url), 'utf8');
        const start = src.indexOf('<div class="ntr-upload" id="ntr-upload">');
        const end = src.indexOf('</div>', start);
        const dropzone = src.slice(start, end);
        // 放在拖拽区里的话，.click() 会冒泡回去又弹一次 TXT 选择器
        expect(dropzone).not.toContain('<input');
    });

    it('拖拽区的 click 处理器会忽略来自 input 的事件', () => {
        const src = readFileSync(new URL('../../novelTranslate.js', import.meta.url), 'utf8');
        const h = src.slice(src.indexOf("upload.addEventListener('click'"), src.indexOf("upload.addEventListener('dragover'"));
        expect(h).toContain("tagName === 'INPUT'");
    });

    it('导出的任务能被 importTask 认出来', async () => {
        const origConfirm = globalThis.confirm;
        const origAlert = globalThis.alert;
        let alerted = '';
        globalThis.confirm = () => true;
        globalThis.alert = (m) => (alerted = m);

        const task = {
            type: 'novelTranslateTask',
            version: '1.0.0',
            fileName: 'a.txt',
            chapters: [
                { index: 0, num: '1', rawTitle: '第1部分', title: '第1部分', source: '原文', translated: '译文', status: 'done', error: '' },
            ],
            glossary: [{ source: 'A', target: '甲' }],
        };
        NT._state.chapters = [];
        await NT._importTask({ text: async () => JSON.stringify(task) });

        globalThis.confirm = origConfirm;
        globalThis.alert = origAlert;
        expect(alerted).toBe('');
        expect(NT._state.chapters).toHaveLength(1);
        expect(NT._state.chapters[0].translated).toBe('译文');
    });

    it('把配置文件误选进「导入任务」时给出明确提示', async () => {
        const origAlert = globalThis.alert;
        let alerted = '';
        globalThis.alert = (m) => (alerted = m);
        await NT._importTask({ text: async () => JSON.stringify({ type: 'novelTranslateConfig', apiModel: 'x' }) });
        globalThis.alert = origAlert;
        expect(alerted).toContain('导入配置');
    });
});

describe('debug5 · 正则要兼容 第X章', () => {
    const RE = NT._DEFAULT_CHAPTER_REGEX;

    it('默认正则同时认 话/章/节/回', () => {
        for (const [unit, text] of [
            ['话', '第1话：起\n甲'],
            ['章', '第1章：起\n甲'],
            ['节', '第1节：起\n甲'],
            ['回', '第1回：起\n甲'],
        ]) {
            const ch = NT._splitByChapterRegex(text, RE);
            expect(ch, unit).toHaveLength(1);
            expect(ch[0].rawTitle).toBe('起');
            expect(ch[0].unit).toBe(unit);
        }
    });

    it('中文数字 + 章 也能识别', () => {
        const ch = NT._splitByChapterRegex('第十二章：测试\n正文', RE);
        expect(ch[0].num).toBe('十二');
        expect(ch[0].unit).toBe('章');
    });

    it('同一本书里混用话和章都能切开', () => {
        const ch = NT._splitByChapterRegex('第1章：起\n甲\n\n第2话：承\n乙', RE);
        expect(ch).toHaveLength(2);
        expect(ch[0].unit).toBe('章');
        expect(ch[1].unit).toBe('话');
    });

    it('导出标题沿用原文单位字，不再一律写成「话」', () => {
        S.txtTitleFormat = 'arabic';
        expect(NT._buildDisplayTitle({ num: '3', unit: '章', title: '离别' }, 0)).toBe('第3章 离别');
        expect(NT._buildDisplayTitle({ num: '3', unit: '回', title: '离别' }, 0)).toBe('第3回 离别');
        // 没记到单位字时退回「话」
        expect(NT._buildDisplayTitle({ num: '3', title: '离别' }, 0)).toBe('第3话 离别');
        S.txtTitleFormat = 'original';
    });

    it('标题本身已含「第X章」时不重复加前缀', () => {
        expect(NT._buildDisplayTitle({ num: '3', unit: '章', title: '第三章 离别' }, 0)).toBe('第三章 离别');
    });

    it('导出单元带上 unit，目录用词正确', () => {
        S.chapterRegex = RE;
        S.exportSplitByRegex = true;
        NT._state.chapters = [mkChapter(0, 'x', '第1章：起\n甲\n\n第2章：承\n乙')];
        const { units } = NT._buildExportUnits();
        expect(units).toHaveLength(2);
        expect(units[0].unit).toBe('章');
        expect(NT._buildDisplayTitle(units[0], 0)).toContain('章');
    });
});

describe('debug6 · 配置导入导出', () => {
    it('配置字段不含章节数据，只带设置', () => {
        expect(NT._CONFIG_KEYS).toContain('customPrompt');
        expect(NT._CONFIG_KEYS).toContain('chapterRegex');
        expect(NT._CONFIG_KEYS).toContain('glossary');
        // 任务数据不能混进配置
        expect(NT._CONFIG_KEYS).not.toContain('chapters');
        expect(NT._CONFIG_KEYS).not.toContain('apiKey');
    });

    it('导入配置会覆盖设置但不动章节', async () => {
        const origConfirm = globalThis.confirm;
        const origAlert = globalThis.alert;
        globalThis.confirm = () => true;
        globalThis.alert = () => {};

        NT._state.chapters = [mkChapter(0, '原文', '译文')];
        S.concurrency = 3;
        await NT._importConfig({
            text: async () =>
                JSON.stringify({ type: 'novelTranslateConfig', concurrency: 9, customPrompt: '新提示词', apiKey: 'kk' }),
        });

        globalThis.confirm = origConfirm;
        globalThis.alert = origAlert;
        expect(S.concurrency).toBe(9);
        expect(S.customPrompt).toBe('新提示词');
        expect(S.apiKey).toBe('kk');
        // 章节不受影响
        expect(NT._state.chapters).toHaveLength(1);
        expect(NT._state.chapters[0].translated).toBe('译文');
    });

    it('把任务文件误选进「导入配置」时给出明确提示', async () => {
        const origAlert = globalThis.alert;
        let alerted = '';
        globalThis.alert = (m) => (alerted = m);
        await NT._importConfig({ text: async () => JSON.stringify({ type: 'novelTranslateTask', chapters: [] }) });
        globalThis.alert = origAlert;
        expect(alerted).toContain('导入任务');
    });

    it('数组字段被写坏时自动修回，不会渲染时崩掉', async () => {
        const origConfirm = globalThis.confirm;
        const origAlert = globalThis.alert;
        globalThis.confirm = () => true;
        globalThis.alert = () => {};
        await NT._importConfig({
            text: async () =>
                JSON.stringify({ type: 'novelTranslateConfig', glossary: 'not-an-array', promptMessageChain: [] }),
        });
        globalThis.confirm = origConfirm;
        globalThis.alert = origAlert;
        expect(Array.isArray(S.glossary)).toBe(true);
        expect(S.promptMessageChain.length).toBeGreaterThan(0);
    });
});

describe('debug7 · token 显示与缓存', () => {
    it('chapterTokens 与 estimateTokens 口径一致', () => {
        const c = mkChapter(0, '你好世界');
        expect(NT._chapterTokens(c)).toBe(NT._estimateTokens('你好世界'));
    });

    it('原文没变时走缓存，变了会重算', () => {
        const c = mkChapter(0, '你好世界');
        expect(NT._chapterTokens(c)).toBe(4);
        // 篡改缓存值：长度没变就该直接返回缓存，证明确实缓存了
        c._tk = 999;
        expect(NT._chapterTokens(c)).toBe(999);
        // 长度变了必须重算，不能返回过期的 999
        c.source = '你好世界你好世界';
        expect(NT._chapterTokens(c)).toBe(8);
    });
});

describe('debug8 · 多选与批量操作', () => {
    const origConfirm = globalThis.confirm;
    const origAlert = globalThis.alert;

    function setup(n) {
        NT._state.chapters = Array.from({ length: n }, (_, i) => mkChapter(i, `内容${i}`));
        NT._state.status = 'idle';
        NT._state.ui.selected.clear();
        NT._state.startIndex = 0;
    }

    it('getSelectedChapters 按块序返回，不受勾选顺序影响', () => {
        setup(5);
        [3, 0, 2].forEach((i) => NT._state.ui.selected.add(i));
        expect(NT._getSelectedChapters().map((c) => c.index)).toEqual([0, 2, 3]);
    });

    it('批量删除后序号连续，未选中的块保留', async () => {
        setup(5);
        [1, 3].forEach((i) => NT._state.ui.selected.add(i));
        globalThis.confirm = () => true;
        globalThis.alert = () => {};
        await NT._batchDelete();
        globalThis.confirm = origConfirm;
        globalThis.alert = origAlert;

        const list = NT._state.chapters;
        expect(list).toHaveLength(3);
        expect(list.map((c) => c.source)).toEqual(['内容0', '内容2', '内容4']);
        expect(list.map((c) => c.index)).toEqual([0, 1, 2]);
        expect(list.map((c) => c.rawTitle)).toEqual(['第1部分', '第2部分', '第3部分']);
    });

    it('删除后选中集清空，起始块不会指向不存在的块', async () => {
        setup(3);
        NT._state.startIndex = 2;
        [0, 1, 2].forEach((i) => NT._state.ui.selected.add(i));
        globalThis.confirm = () => true;
        globalThis.alert = () => {};
        await NT._batchDelete();
        globalThis.confirm = origConfirm;
        globalThis.alert = origAlert;

        expect(NT._state.chapters).toHaveLength(0);
        expect(NT._state.ui.selected.size).toBe(0);
        expect(NT._state.startIndex).toBe(0);
    });

    it('没勾选任何块时批量删除会提示而不是误删', async () => {
        setup(3);
        let alerted = '';
        globalThis.alert = (m) => (alerted = m);
        await NT._batchDelete();
        globalThis.alert = origAlert;
        expect(alerted).toContain('勾选');
        expect(NT._state.chapters).toHaveLength(3);
    });

    it('翻译进行中不允许批量删除', async () => {
        setup(3);
        NT._state.ui.selected.add(0);
        NT._state.status = 'running';
        let alerted = '';
        globalThis.alert = (m) => (alerted = m);
        await NT._batchDelete();
        globalThis.alert = origAlert;
        NT._state.status = 'idle';
        expect(alerted).toContain('先停止');
        expect(NT._state.chapters).toHaveLength(3);
    });

    it('退出多选会清空已勾选项', () => {
        setup(4);
        [0, 2].forEach((i) => NT._state.ui.selected.add(i));
        NT._setMultiSelect(false);
        expect(NT._state.ui.multiSelect).toBe(false);
        expect(NT._state.ui.selected.size).toBe(0);
    });
});
