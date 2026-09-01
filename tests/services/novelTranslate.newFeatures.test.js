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
