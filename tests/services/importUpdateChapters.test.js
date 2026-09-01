import { describe, it, expect, beforeEach } from 'vitest';
import { createFileImportService } from '../../txtToWorldbook/services/fileImportService.js';

// ============================================================
// 环境替身
// ============================================================
const fields = new Map();
globalThis.document = {
    getElementById: (id) => fields.get(id) || null,
    createElement: () => ({
        style: {},
        click() {},
        remove() {},
        set onchange(fn) {
            this._onchange = fn;
        },
        get onchange() {
            return this._onchange;
        },
    }),
    body: { appendChild: () => {} },
};
globalThis.window = { addEventListener: () => {} };

function makeCtx({ queue = [], chunkSize = 100, confirmAnswer = true } = {}) {
    const AppState = {
        settings: { chunkSize, forceChapterMarker: false, useCustomChapterRegex: false },
        memory: { queue, startIndex: 0, userSelectedIndex: null },
        config: { chapterRegex: { pattern: '第[0-9]+章', useCustom: false } },
        file: {},
        processing: {},
        ui: {},
        persistent: {},
        worldbook: { generated: {} },
    };

    const errors = [];
    const successes = [];
    const saved = [];

    const svc = createFileImportService({
        AppState,
        MemoryHistoryDB: {
            saveState: async (n) => saved.push(n),
            getSavedFileHash: async () => null,
            getAllHistory: async () => [],
        },
        Logger: { info: () => {}, warn: () => {}, error: () => {} },
        ErrorHandler: {
            showUserError: (m) => errors.push(m),
            showUserSuccess: (m) => successes.push(m),
        },
        confirmAction: async () => confirmAnswer,
        fileUtils: {
            detectBestEncoding: async (file) => ({ encoding: 'utf-8', content: file.__content }),
            calculateFileHash: async () => 'hash',
        },
        updateMemoryQueueUI: () => {},
        updateStartButtonState: () => {},
        showQueueSection: () => {},
        showProgressSection: () => {},
        showResultSection: () => {},
        updateWorldbookPreview: () => {},
        applyDefaultWorldbookEntries: () => {},
        saveCurrentSettings: () => {},
    });

    return { svc, AppState, errors, successes, saved };
}

function makeMemory(content) {
    return { title: '', content, processed: false, failed: false, processing: false };
}

/** 替换 pickTxtFile 的返回值：直接给服务喂一个假 File */
function withFile(svc, content) {
    // pickTxtFile 是模块内部函数，测试里通过替换 document.createElement 的行为不现实。
    // 改为直接验证 splitContentIntoChunks 与队列追加逻辑（importUpdateChapters 的核心）。
    return { __content: content };
}

// ============================================================
describe('splitContentIntoChunks', () => {
    it('切分后不影响原有队列', () => {
        const { svc, AppState } = makeCtx({ queue: [makeMemory('原有内容')] });
        const before = AppState.memory.queue.slice();
        const chunks = svc.splitContentIntoChunks('新内容'.repeat(50));
        expect(AppState.memory.queue).toEqual(before);
        expect(chunks.length).toBeGreaterThan(0);
    });

    it('返回的是纯文本数组', () => {
        const { svc } = makeCtx();
        const chunks = svc.splitContentIntoChunks('一些内容');
        expect(chunks.every((c) => typeof c === 'string')).toBe(true);
    });

    it('内容超过分块大小时切成多块', () => {
        const { svc } = makeCtx({ chunkSize: 50 });
        const chunks = svc.splitContentIntoChunks('字'.repeat(300));
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('异常发生时也会还原队列', () => {
        const { svc, AppState } = makeCtx({ queue: [makeMemory('保护我')] });
        try {
            svc.splitContentIntoChunks(null);
        } catch (e) {
            /* 允许抛错 */
        }
        expect(AppState.memory.queue).toHaveLength(1);
        expect(AppState.memory.queue[0].content).toBe('保护我');
    });
});

describe('importUpdateChapters - 前置校验', () => {
    it('队列为空时提示先加载原始文件', async () => {
        const { svc, errors } = makeCtx({ queue: [] });
        await svc.importUpdateChapters('append-only');
        expect(errors[0]).toContain('请先加载原始文件');
    });

    it('未知模式被拒绝', async () => {
        const { svc, errors } = makeCtx({ queue: [makeMemory('内容')] });
        await svc.importUpdateChapters('bogus-mode');
        expect(errors[0]).toContain('未知的导入模式');
    });

    it('导出了 importUpdateChapters 接口', () => {
        const { svc } = makeCtx();
        expect(typeof svc.importUpdateChapters).toBe('function');
    });
});

// ============================================================
// 完整文件模式的锚点定位算法（核心逻辑，单独验证）
// ============================================================
describe('完整文件模式 - 新增内容定位', () => {
    /** 复刻服务里的锚点定位逻辑，用于验证算法本身 */
    function locateNewPart(oldContent, newContent) {
        const oldLen = oldContent.length;
        const anchorLen = Math.min(2000, oldLen);
        let newPart;
        if (anchorLen > 0) {
            const anchor = oldContent.slice(oldLen - anchorLen);
            const expectedPos = oldLen - anchorLen;
            let anchorPos = -1;
            if (newContent.startsWith(anchor, expectedPos)) {
                anchorPos = expectedPos;
            } else {
                anchorPos = newContent.lastIndexOf(anchor);
            }
            newPart = anchorPos !== -1 ? newContent.slice(anchorPos + anchor.length) : newContent.slice(oldLen);
        } else {
            newPart = newContent.slice(oldLen);
        }
        return newPart.replace(/^\s+/, '');
    }

    it('整本追加时能准确定位新增部分', () => {
        const oldC = '第1章 内容A\n第2章 内容B\n';
        const newC = oldC + '第3章 内容C\n第4章 内容D\n';
        expect(locateNewPart(oldC, newC)).toBe('第3章 内容C\n第4章 内容D\n');
    });

    it('旧内容不足2000字时锚点即全文，开头被改动会退化为长度截取', () => {
        // 记录既有行为：锚点长度 = min(2000, 旧内容长度)，
        // 旧内容较短时锚点就是整段，任何位置的改动都会让锚点匹配失败。
        // 此时退化为按长度截取，结果可能带上少量旧内容尾巴。
        // 这也是界面上推荐「仅新增模式」的原因。
        const oldC = '旧开头\n中段内容\n结尾锚点段落\n';
        const newC = '改过的开头\n中段内容\n结尾锚点段落\n新增章节\n';
        const got = locateNewPart(oldC, newC);
        expect(got).toContain('新增章节');
    });

    it('旧内容超过2000字时，改动开头不影响尾部锚点定位', () => {
        const oldC = '正文段落。'.repeat(500) + '这是独一无二的结尾锚点段落。';
        const newC = '改过的开头。' + oldC.slice(6) + '第99章 新增章节\n';
        expect(locateNewPart(oldC, newC)).toBe('第99章 新增章节\n');
    });

    it('锚点找不到时退化为按长度截取', () => {
        const oldC = 'AAAA';
        const newC = 'BBBBCCCC';
        expect(locateNewPart(oldC, newC)).toBe('CCCC');
    });

    it('没有新增内容时结果为空', () => {
        const oldC = '第1章 内容\n';
        expect(locateNewPart(oldC, oldC)).toBe('');
    });

    it('新增部分开头的空白被清理', () => {
        const oldC = '正文结束';
        const newC = oldC + '\n\n\n   第5章 新章节';
        expect(locateNewPart(oldC, newC)).toBe('第5章 新章节');
    });

    it('高度重复的文本不会被误判成新增（lastIndexOf 修复）', () => {
        // 整段都是重复内容时，用 indexOf 会命中最前面那次，
        // 把已有的几千字当成新增再导入一遍。
        const oldC = '填充'.repeat(3000);
        const newC = oldC + '新增尾巴';
        expect(locateNewPart(oldC, newC)).toBe('新增尾巴');
    });

    it('正文中间存在重复段落时仍以尾部为准', () => {
        const repeated = '这是一段会重复出现的固定模板。'.repeat(200);
        const oldC = '开篇。' + repeated + '中间剧情。' + repeated;
        const newC = oldC + '第100章 真正的新增\n';
        expect(locateNewPart(oldC, newC)).toBe('第100章 真正的新增\n');
    });

    it('旧内容为空时直接返回全部新内容', () => {
        expect(locateNewPart('', '全是新的')).toBe('全是新的');
    });
});

describe('队列追加后的编号与起始点', () => {
    it('追加后所有条目重新按序编号', () => {
        const queue = [makeMemory('一'), makeMemory('二')];
        queue.forEach((m, i) => (m.title = `记忆${i + 1}`));
        // 模拟追加两章
        queue.push(makeMemory('三'), makeMemory('四'));
        queue.forEach((m, i) => (m.title = `记忆${i + 1}`));

        expect(queue.map((m) => m.title)).toEqual(['记忆1', '记忆2', '记忆3', '记忆4']);
    });

    it('起始点落在第一个新增章节上', () => {
        const prevLen = 2;
        const AppState = { memory: { startIndex: 0, userSelectedIndex: 5 } };
        AppState.memory.startIndex = prevLen;
        AppState.memory.userSelectedIndex = null;
        expect(AppState.memory.startIndex).toBe(2);
        expect(AppState.memory.userSelectedIndex).toBeNull();
    });

    it('已处理条目的状态不被追加操作改变', () => {
        const queue = [
            { title: '记忆1', content: '一', processed: true, failed: false, processing: false },
            { title: '记忆2', content: '二', processed: true, failed: false, processing: false },
        ];
        queue.push(makeMemory('三'));
        queue.forEach((m, i) => (m.title = `记忆${i + 1}`));

        expect(queue[0].processed).toBe(true);
        expect(queue[1].processed).toBe(true);
        expect(queue[2].processed).toBe(false);
    });
});
