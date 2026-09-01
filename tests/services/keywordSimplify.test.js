import { describe, it, expect } from 'vitest';
import { createKeywordSimplifyService } from '../../txtToWorldbook/services/keywordSimplifyService.js';

function makeService({ generated = {}, aiResults = null, aiThrows = false } = {}) {
    const AppState = {
        worldbook: { generated, volumes: [], currentVolumeIndex: 0 },
        processing: { isStopped: false },
        settings: {},
        config: {},
    };
    const calls = [];
    const svc = createKeywordSimplifyService({
        AppState,
        Logger: { info: () => {}, warn: () => {}, error: () => {} },
        callAPI: async (prompt) => {
            calls.push(prompt);
            if (aiThrows) throw new Error('模拟网络错误');
            return JSON.stringify({ results: aiResults || [] });
        },
        parseAIResponse: (r) => JSON.parse(r),
        updateStreamContent: () => {},
        debugLog: () => {},
        MemoryHistoryDB: { saveWorldbookSnapshot: async () => {} },
    });
    return { svc, AppState, generated, calls };
}

function charBook() {
    return {
        角色: {
            李明: { 关键词: ['李明', '小明', '银发', '学生', '主角的同桌'], 内容: '李明是高中生。' },
            王芳: { 关键词: ['王芳', '芳姐', '温柔', '护士'], 内容: '王芳在医院工作。' },
        },
    };
}

describe('scanCategories', () => {
    it('统计各分类的条目数和关键词数', () => {
        const { svc } = makeService({ generated: charBook() });
        const cats = svc.scanCategories();
        expect(cats).toHaveLength(1);
        expect(cats[0].name).toBe('角色');
        expect(cats[0].entryCount).toBe(2);
        expect(cats[0].keywordCount).toBe(9);
    });

    it('跳过没有关键词的条目', () => {
        const { svc } = makeService({
            generated: { 角色: { A: { 关键词: [], 内容: 'x' }, B: { 关键词: ['B'], 内容: 'y' } } },
        });
        expect(svc.scanCategories()[0].entryCount).toBe(1);
    });

    it('空世界书返回空数组', () => {
        const { svc } = makeService({ generated: {} });
        expect(svc.scanCategories()).toHaveLength(0);
    });
});

describe('applyProposal - 兜底保护', () => {
    it('正常精简被采纳', () => {
        const { svc } = makeService();
        const r = svc.applyProposal(['李明', '小明', '银发', '学生'], ['李明', '小明'], '李明');
        expect(r.changed).toBe(true);
        expect(r.keywords).toEqual(['李明', '小明']);
    });

    it('AI 没返回时保持原样', () => {
        const { svc } = makeService();
        const r = svc.applyProposal(['李明', '银发'], undefined, '李明');
        expect(r.changed).toBe(false);
        expect(r.keywords).toEqual(['李明', '银发']);
    });

    it('AI 返回空数组时保持原样', () => {
        const { svc } = makeService();
        const r = svc.applyProposal(['李明', '银发'], [], '李明');
        expect(r.changed).toBe(false);
    });

    it('捏造的关键词被剔除', () => {
        const { svc } = makeService();
        const r = svc.applyProposal(['李明', '小明', '银发'], ['李明', '凭空捏造的外号'], '李明');
        expect(r.keywords).not.toContain('凭空捏造的外号');
    });

    it('条目名被强制保留', () => {
        const { svc } = makeService();
        const r = svc.applyProposal(['李明', '小明', '银发'], ['小明'], '李明');
        expect(r.keywords).toContain('李明');
    });

    it('没有真正变少时判定AI没照做，保持原样', () => {
        const { svc } = makeService();
        const all = ['李明', '小明', '银发'];
        const r = svc.applyProposal(all, all, '李明');
        expect(r.changed).toBe(false);
        expect(r.keywords).toEqual(all);
    });

    it('去重处理', () => {
        const { svc } = makeService();
        const r = svc.applyProposal(['李明', '李明', '小明', '银发', '学生'], ['李明', '李明', '小明'], '李明');
        expect(r.keywords.filter((k) => k === '李明')).toHaveLength(1);
    });
});

describe('simplifyCategories', () => {
    it('按AI结果更新关键词', async () => {
        const { svc, generated } = makeService({
            generated: charBook(),
            aiResults: [
                { name: '李明', keywords: ['李明', '小明'] },
                { name: '王芳', keywords: ['王芳', '芳姐'] },
            ],
        });
        const stats = await svc.simplifyCategories(['角色']);
        expect(stats.simplified).toBe(2);
        expect(generated['角色']['李明']['关键词']).toEqual(['李明', '小明']);
        expect(generated['角色']['王芳']['关键词']).toEqual(['王芳', '芳姐']);
    });

    it('统计删除的关键词数量', async () => {
        const { svc } = makeService({
            generated: charBook(),
            aiResults: [
                { name: '李明', keywords: ['李明', '小明'] },
                { name: '王芳', keywords: ['王芳', '芳姐'] },
            ],
        });
        const stats = await svc.simplifyCategories(['角色']);
        // 李明 5->2 删3, 王芳 4->2 删2
        expect(stats.removedKeywords).toBe(5);
    });

    it('AI请求失败时保持原关键词不丢', async () => {
        const { svc, generated } = makeService({ generated: charBook(), aiThrows: true });
        const stats = await svc.simplifyCategories(['角色']);
        expect(stats.failed).toBe(2);
        expect(stats.simplified).toBe(0);
        expect(generated['角色']['李明']['关键词']).toContain('银发');
    });

    it('内容不受影响', async () => {
        const { svc, generated } = makeService({
            generated: charBook(),
            aiResults: [{ name: '李明', keywords: ['李明', '小明'] }],
        });
        await svc.simplifyCategories(['角色']);
        expect(generated['角色']['李明']['内容']).toBe('李明是高中生。');
    });

    it('用户中断时立即停止', async () => {
        const { svc, AppState } = makeService({ generated: charBook(), aiResults: [] });
        AppState.processing.isStopped = true;
        const stats = await svc.simplifyCategories(['角色']);
        expect(stats.simplified).toBe(0);
    });

    it('未选中的分类不受影响', async () => {
        const generated = {
            角色: { 李明: { 关键词: ['李明', '银发'], 内容: 'a' } },
            地点: { 青云城: { 关键词: ['青云城', '繁华'], 内容: 'b' } },
        };
        const { svc } = makeService({ generated, aiResults: [{ name: '李明', keywords: ['李明'] }] });
        await svc.simplifyCategories(['角色']);
        expect(generated['地点']['青云城']['关键词']).toContain('繁华');
    });

    it('记录详细变更用于回溯', async () => {
        const { svc } = makeService({
            generated: charBook(),
            aiResults: [{ name: '李明', keywords: ['李明', '小明'] }],
        });
        const stats = await svc.simplifyCategories(['角色']);
        expect(stats.details[0].name).toBe('李明');
        expect(stats.details[0].before).toContain('银发');
        expect(stats.details[0].after).not.toContain('银发');
    });
});

describe('buildPrompt', () => {
    it('角色分类使用人物专用规则', () => {
        const { svc } = makeService();
        const p = svc.buildPrompt('角色', [{ name: '李明', keywords: ['李明', '银发'], content: 'x' }]);
        expect(p).toContain('外号');
        expect(p).toContain('身份职业');
    });

    it('非角色分类使用通用规则', () => {
        const { svc } = makeService();
        const p = svc.buildPrompt('地点', [{ name: '青云城', keywords: ['青云城'], content: 'x' }]);
        expect(p).toContain('正式名称');
    });

    it('包含条目的现有关键词供AI参考', () => {
        const { svc } = makeService();
        const p = svc.buildPrompt('角色', [{ name: '李明', keywords: ['李明', '银发'], content: 'x' }]);
        expect(p).toContain('银发');
    });

    it('要求只输出JSON', () => {
        const { svc } = makeService();
        const p = svc.buildPrompt('角色', [{ name: 'A', keywords: ['A'], content: '' }]);
        expect(p).toContain('只输出 JSON');
    });
});
