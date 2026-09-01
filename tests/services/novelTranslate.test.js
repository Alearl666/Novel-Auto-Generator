import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// novelTranslate.js 是浏览器端 IIFE，测试前先搭最小 DOM 再加载它
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

describe('模块加载', () => {
    it('挂载了 window.NovelTranslate', () => {
        expect(NT).toBeTruthy();
        expect(typeof NT.open).toBe('function');
    });
});

describe('estimateTokens', () => {
    it('中日文按字算', () => {
        expect(NT._estimateTokens('你好世界')).toBe(4);
    });
    it('英文按约4字符算', () => {
        expect(NT._estimateTokens('abcdefgh')).toBe(2);
    });
    it('空串为0', () => {
        expect(NT._estimateTokens('')).toBe(0);
    });
});

describe('章节正则切分', () => {
    const REGEX = '第([0-9一二三四五六七八九十百千零\\d]+)话[\\s：:]+(.+)';

    it('切出正确的章节数和标题', () => {
        const text = `第1话：相遇
内容A第一段
内容A第二段

第2话：重逢
内容B`;
        const chapters = NT._splitByChapterRegex(text, REGEX);
        expect(chapters).toHaveLength(2);
        expect(chapters[0].num).toBe('1');
        expect(chapters[0].rawTitle).toBe('相遇');
        expect(chapters[0].source).toContain('内容A第一段');
        expect(chapters[1].rawTitle).toBe('重逢');
    });

    it('正文不包含标题行', () => {
        const chapters = NT._splitByChapterRegex('第1话：相遇\n正文内容', REGEX);
        expect(chapters[0].source).toBe('正文内容');
    });

    it('第一章之前的内容单独成「前言」，不丢失', () => {
        const text = `这是序章内容，不属于任何一话。

第1话：相遇
正文`;
        const chapters = NT._splitByChapterRegex(text, REGEX);
        expect(chapters[0].rawTitle).toBe('前言');
        expect(chapters[0].source).toContain('序章内容');
        expect(chapters[1].rawTitle).toBe('相遇');
    });

    it('中文数字章节号能识别', () => {
        const chapters = NT._splitByChapterRegex('第十二话：测试\n正文', REGEX);
        expect(chapters[0].num).toBe('十二');
    });

    it('匹配不到时返回 null', () => {
        expect(NT._splitByChapterRegex('没有任何章节标记的纯文本', REGEX)).toBeNull();
    });

    it('无标题时用整个匹配串兜底', () => {
        const loose = '第([0-9一二三四五六七八九十百千零\\d]+)话[ \\t：:]*(.*)';
        const chapters = NT._splitByChapterRegex('第12话\n正文内容', loose);
        expect(chapters).toHaveLength(1);
        expect(chapters[0].rawTitle).toBe('第12话');
        expect(chapters[0].source).toBe('正文内容');
    });

    it('用含 \\s 的正则时，换行不会被吞掉导致正文丢失', () => {
        // \s 包含换行，旧实现会把下一行正文当成标题并从正文里吃掉
        const greedy = '第([0-9一二三四五六七八九十百千零\\d]+)话[\\s：:]+(.+)';
        const chapters = NT._splitByChapterRegex('第12话\n正文第一行\n正文第二行', greedy);
        expect(chapters).toHaveLength(1);
        expect(chapters[0].source).toContain('正文第一行');
        expect(chapters[0].source).toContain('正文第二行');
        expect(chapters[0].rawTitle).not.toBe('正文第一行');
    });

    it('有标题时仍正常捕获', () => {
        const greedy = '第([0-9一二三四五六七八九十百千零\\d]+)话[\\s：:]+(.+)';
        const chapters = NT._splitByChapterRegex('第3话：命运\n正文', greedy);
        expect(chapters[0].rawTitle).toBe('命运');
        expect(chapters[0].source).toBe('正文');
    });

    it('非法正则抛出可读错误', () => {
        expect(() => NT._splitByChapterRegex('文本', '第([0-9')).toThrow('章节正则无效');
    });

    it('index 连续递增', () => {
        const text = '第1话：A\n正文\n第2话：B\n正文\n第3话：C\n正文';
        const chapters = NT._splitByChapterRegex(text, REGEX);
        expect(chapters.map((c) => c.index)).toEqual([0, 1, 2]);
    });

    it('章节编号沿用原文，不重排', () => {
        const text = '第100话：A\n正文\n第101话：B\n正文';
        const chapters = NT._splitByChapterRegex(text, REGEX);
        expect(chapters[0].num).toBe('100');
        expect(chapters[1].num).toBe('101');
    });
});

describe('按长度切分', () => {
    it('短文本只切一块', () => {
        expect(NT._splitBySize('很短的内容', 1000)).toHaveLength(1);
    });

    it('长文本切成多块', () => {
        const text = Array.from({ length: 40 }, (_, i) => `第${i}段内容`.repeat(20)).join('\n\n');
        const chunks = NT._splitBySize(text, 200);
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('每块都不超过上限太多', () => {
        const text = Array.from({ length: 30 }, () => '内容'.repeat(60)).join('\n\n');
        const chunks = NT._splitBySize(text, 200);
        for (const c of chunks) {
            expect(NT._estimateTokens(c.source)).toBeLessThan(400);
        }
    });

    it('内容不丢失', () => {
        const text = '第一段内容\n\n第二段内容\n\n第三段内容';
        const chunks = NT._splitBySize(text, 5);
        const joined = chunks.map((c) => c.source).join('');
        expect(joined).toContain('第一段内容');
        expect(joined).toContain('第三段内容');
    });
});

describe('译文提取与截断检测', () => {
    it('正常标签包裹能提取', () => {
        const r = NT._extractTranslation('<译文>\n翻译好的正文\n</译文>');
        expect(r.ok).toBe(true);
        expect(r.text).toBe('翻译好的正文');
    });

    it('缺少闭合标签判定为截断', () => {
        const r = NT._extractTranslation('<译文>\n翻了一半就断了');
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('截断');
    });

    it('标签内为空判定失败', () => {
        expect(NT._extractTranslation('<译文></译文>').ok).toBe(false);
    });

    it('完全没有标签时按纯文本处理', () => {
        const r = NT._extractTranslation('这是没带标签的译文');
        expect(r.ok).toBe(true);
        expect(r.text).toBe('这是没带标签的译文');
    });

    it('剥掉 markdown 代码块', () => {
        const r = NT._extractTranslation('```\n译文内容\n```');
        expect(r.text).not.toContain('```');
    });

    it('新术语块不混进译文', () => {
        const r = NT._extractTranslation('<译文>正文内容</译文>\n<新术语>\nソラ → 空\n</新术语>');
        expect(r.text).toBe('正文内容');
        expect(r.text).not.toContain('新术语');
    });

    it('空回复判定失败', () => {
        expect(NT._extractTranslation('').ok).toBe(false);
        expect(NT._extractTranslation('   ').ok).toBe(false);
    });

    it('标签顺序错乱判定失败', () => {
        expect(NT._extractTranslation('</译文>内容<译文>').ok).toBe(false);
    });

    it('多段译文取最外层', () => {
        const r = NT._extractTranslation('<译文>第一段\n\n第二段\n\n第三段</译文>');
        expect(r.text).toContain('第一段');
        expect(r.text).toContain('第三段');
    });
});

describe('术语回报解析', () => {
    it('解析箭头格式', () => {
        const terms = NT._extractReportedTerms('<新术语>\nソラ → 空\nカイ → 凯\n</新术语>');
        expect(terms).toHaveLength(2);
        expect(terms[0]).toEqual({ source: 'ソラ', target: '空', note: '' });
    });

    it('支持 -> 写法', () => {
        const terms = NT._extractReportedTerms('<新术语>\nAkira -> 明\n</新术语>');
        expect(terms[0].target).toBe('明');
    });

    it('解析带说明的条目', () => {
        const terms = NT._extractReportedTerms('<新术语>\nソラ → 空（主角）\n</新术语>');
        expect(terms[0].note).toBe('主角');
    });

    it('支持列表符号前缀', () => {
        const terms = NT._extractReportedTerms('<新术语>\n- ソラ → 空\n* カイ → 凯\n</新术语>');
        expect(terms).toHaveLength(2);
    });

    it('内容为「无」时返回空', () => {
        expect(NT._extractReportedTerms('<新术语>\n无\n</新术语>')).toHaveLength(0);
    });

    it('没有术语块时返回空', () => {
        expect(NT._extractReportedTerms('<译文>正文</译文>')).toHaveLength(0);
    });
});

describe('中文数字转换', () => {
    it('阿拉伯数字直通', () => {
        expect(NT._cnNumToInt('123')).toBe(123);
    });
    it('个位', () => {
        expect(NT._cnNumToInt('五')).toBe(5);
    });
    it('十几', () => {
        expect(NT._cnNumToInt('十二')).toBe(12);
    });
    it('几十几', () => {
        expect(NT._cnNumToInt('二十三')).toBe(23);
    });
    it('整十', () => {
        expect(NT._cnNumToInt('三十')).toBe(30);
    });
    it('百位', () => {
        expect(NT._cnNumToInt('一百零五')).toBe(105);
    });
});

describe('酒馆预设解析', () => {
    it('按 prompt_order 展开消息链', () => {
        const r = NT._parseTavernPreset({
            temperature: 0.9,
            prompts: [
                { identifier: 'main', role: 'system', content: '你是翻译' },
                { identifier: 'chatHistory', marker: true },
            ],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                    ],
                },
            ],
        });
        expect(r.chain[0].content).toBe('你是翻译');
        expect(r.chain[1].content).toBe('{PROMPT}');
        expect(r.params.temperature).toBe(0.9);
    });

    it('没有聊天记录槽时自动补 {PROMPT}', () => {
        const r = NT._parseTavernPreset({ prompts: [{ identifier: 'a', role: 'system', content: 'A' }] });
        expect(r.chain[r.chain.length - 1].content).toBe('{PROMPT}');
    });

    it('角色卡类占位符被丢弃', () => {
        const r = NT._parseTavernPreset({
            prompts: [
                { identifier: 'charDescription', marker: true },
                { identifier: 'chatHistory', marker: true },
            ],
        });
        expect(r.stats.dropped).toBe(1);
    });

    it('非法输入抛错', () => {
        expect(() => NT._parseTavernPreset({ foo: 1 })).toThrow('不是有效的酒馆对话补全预设');
    });
});
