import { describe, it, expect } from 'vitest';
import { createMergeService } from '../../txtToWorldbook/services/mergeService.js';

function makeService(generated = {}) {
    const AppState = {
        worldbook: { generated, volumes: [], currentVolumeIndex: 0 },
        settings: {},
        processing: {},
        config: {},
    };
    const svc = createMergeService({
        AppState,
        Logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        callAPI: async () => '{}',
        parseAIResponse: () => ({}),
        updateStreamContent: () => {},
        debugLog: () => {},
        MemoryHistoryDB: { saveWorldbookSnapshot: async () => {} },
        ErrorHandler: { showUserError: () => {}, showUserSuccess: () => {} },
        getLanguagePrefix: () => '',
    });
    return { svc, AppState };
}

function charEntries() {
    return {
        角色: {
            李明: {
                关键词: ['李明', '小明', '银发', '学生', '主角的同桌'],
                内容: '李明是一名高中生。',
            },
            明哥: {
                关键词: ['明哥', '李明', '冷酷', '篮球队长'],
                内容: '明哥在球场上很有威望。',
            },
        },
    };
}

describe('别名合并 - 关键词精简', () => {
    it('AI 给出精简列表时采用精简结果', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);

        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [
                    {
                        names: ['李明', '明哥'],
                        mainName: '李明',
                        simplifiedKeywords: ['李明', '小明', '明哥'],
                    },
                ],
            },
            '角色',
        );

        const kw = generated['角色']['李明']['关键词'];
        expect(kw).toContain('李明');
        expect(kw).toContain('小明');
        expect(kw).toContain('明哥');
        // 外貌、身份、性格类词应被剔除
        expect(kw).not.toContain('银发');
        expect(kw).not.toContain('篮球队长');
        expect(kw).not.toContain('冷酷');
    });

    it('主名和各原条目名一定保留', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                // AI 漏了「明哥」
                mergedGroups: [{ names: ['李明', '明哥'], mainName: '李明', simplifiedKeywords: ['李明'] }],
            },
            '角色',
        );
        const kw = generated['角色']['李明']['关键词'];
        expect(kw).toContain('李明');
        expect(kw).toContain('明哥');
    });

    it('AI 凭空捏造的关键词会被剔除', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [
                    {
                        names: ['李明', '明哥'],
                        mainName: '李明',
                        simplifiedKeywords: ['李明', '小明', '这个名字原文里没有'],
                    },
                ],
            },
            '角色',
        );
        expect(generated['角色']['李明']['关键词']).not.toContain('这个名字原文里没有');
    });

    it('没有精简列表时退回全量并集（向后兼容）', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            { pairResults: [], mergedGroups: [{ names: ['李明', '明哥'], mainName: '李明' }] },
            '角色',
        );
        const kw = generated['角色']['李明']['关键词'];
        expect(kw).toContain('银发');
        expect(kw).toContain('篮球队长');
    });

    it('精简列表为空数组时退回全量', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [{ names: ['李明', '明哥'], mainName: '李明', simplifiedKeywords: [] }],
            },
            '角色',
        );
        expect(generated['角色']['李明']['关键词']).toContain('银发');
    });

    it('精简后没有真正变少时退回全量（AI 没照做）', async () => {
        const generated = charEntries();
        const all = [...new Set([...generated['角色']['李明']['关键词'], ...generated['角色']['明哥']['关键词']])];
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [{ names: ['李明', '明哥'], mainName: '李明', simplifiedKeywords: all }],
            },
            '角色',
        );
        expect(generated['角色']['李明']['关键词'].length).toBe(all.length);
    });

    it('内容仍然完整拼接，不受关键词精简影响', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [{ names: ['李明', '明哥'], mainName: '李明', simplifiedKeywords: ['李明', '明哥'] }],
            },
            '角色',
        );
        const content = generated['角色']['李明']['内容'];
        expect(content).toContain('高中生');
        expect(content).toContain('球场');
    });

    it('合并后原条目被删除', async () => {
        const generated = charEntries();
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [{ names: ['李明', '明哥'], mainName: '李明', simplifiedKeywords: ['李明', '明哥'] }],
            },
            '角色',
        );
        expect(generated['角色']['明哥']).toBeUndefined();
        expect(generated['角色']['李明']).toBeDefined();
    });

    it('非角色分类同样生效', async () => {
        const generated = {
            地点: {
                青云城: { 关键词: ['青云城', '繁华', '北方重镇'], 内容: 'A' },
                青云: { 关键词: ['青云', '青云城'], 内容: 'B' },
            },
        };
        const { svc } = makeService(generated);
        await svc.mergeConfirmedDuplicates(
            {
                pairResults: [],
                mergedGroups: [
                    { names: ['青云城', '青云'], mainName: '青云城', simplifiedKeywords: ['青云城', '青云'] },
                ],
            },
            '地点',
        );
        const kw = generated['地点']['青云城']['关键词'];
        expect(kw).toContain('青云城');
        expect(kw).not.toContain('繁华');
    });
});
