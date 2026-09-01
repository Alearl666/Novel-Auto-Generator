import { describe, it, expect } from 'vitest';
import {
    parseTavernPreset,
    buildPresetSummary,
    createPresetImportService,
} from '../../txtToWorldbook/services/presetImportService.js';

function makePreset(overrides = {}) {
    return {
        temperature: 1.05,
        openai_max_tokens: 4096,
        top_p: 0.92,
        prompts: [
            { identifier: 'main', name: '主提示词', role: 'system', content: '你是一个专业助手', system_prompt: true },
            { identifier: 'worldInfoBefore', name: '世界书(前)', marker: true },
            { identifier: 'charDescription', name: '角色描述', marker: true },
            { identifier: 'chatHistory', name: '聊天记录', marker: true },
            {
                identifier: 'jailbreak',
                name: '越狱',
                role: 'system',
                content: 'JB内容',
                injection_position: 1,
                injection_depth: 0,
            },
            {
                identifier: 'deep4',
                name: '深度4',
                role: 'user',
                content: '深度4的内容',
                injection_position: 1,
                injection_depth: 4,
            },
            { identifier: 'blank', name: '空条目', role: 'system', content: '   ' },
            { identifier: 'prefill', name: '预填充', role: 'assistant', content: '好的' },
        ],
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'worldInfoBefore', enabled: true },
                    { identifier: 'charDescription', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                    { identifier: 'jailbreak', enabled: true },
                    { identifier: 'deep4', enabled: true },
                    { identifier: 'blank', enabled: true },
                    { identifier: 'prefill', enabled: false },
                ],
            },
        ],
        ...overrides,
    };
}

describe('parseTavernPreset - 基础解析', () => {
    it('按 character_id 100001 的全局排布顺序展开', () => {
        const r = parseTavernPreset(makePreset());
        expect(r.chain[0].role).toBe('system');
        expect(r.chain[0].content).toBe('你是一个专业助手');
    });

    it('聊天记录占位符映射为 {PROMPT} 正文槽', () => {
        const r = parseTavernPreset(makePreset());
        const slots = r.chain.filter((m) => m.content === '{PROMPT}');
        expect(slots).toHaveLength(1);
        expect(r.stats.hadPromptSlot).toBe(true);
    });

    it('无对应物的占位符被丢弃并计数', () => {
        const r = parseTavernPreset(makePreset());
        expect(r.stats.droppedMarkers).toBe(2);
        expect(r.chain.some((m) => m.content.includes('角色描述'))).toBe(false);
    });

    it('空内容条目被跳过并计数', () => {
        const r = parseTavernPreset(makePreset());
        expect(r.stats.skippedEmpty).toBe(1);
    });

    it('禁用条目保留在链里但 enabled 为 false', () => {
        const r = parseTavernPreset(makePreset());
        const prefill = r.chain.find((m) => m.content === '好的');
        expect(prefill).toBeDefined();
        expect(prefill.enabled).toBe(false);
        expect(r.stats.enabled).toBe(r.chain.length - 1);
    });
});

describe('parseTavernPreset - 深度注入', () => {
    it('深度注入条目排在正文槽之后', () => {
        const r = parseTavernPreset(makePreset());
        const slotIdx = r.chain.findIndex((m) => m.content === '{PROMPT}');
        const jbIdx = r.chain.findIndex((m) => m.content === 'JB内容');
        expect(jbIdx).toBeGreaterThan(slotIdx);
    });

    it('depth 大的排在 depth 小的前面', () => {
        const r = parseTavernPreset(makePreset());
        const deep4Idx = r.chain.findIndex((m) => m.content === '深度4的内容');
        const jbIdx = r.chain.findIndex((m) => m.content === 'JB内容');
        expect(deep4Idx).toBeLessThan(jbIdx);
    });

    it('没有 injection_depth 时默认按 4 处理', () => {
        const preset = makePreset({
            prompts: [
                { identifier: 'chatHistory', marker: true },
                { identifier: 'a', role: 'system', content: 'A', injection_position: 1 },
                { identifier: 'b', role: 'system', content: 'B', injection_position: 1, injection_depth: 0 },
            ],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'chatHistory', enabled: true },
                        { identifier: 'a', enabled: true },
                        { identifier: 'b', enabled: true },
                    ],
                },
            ],
        });
        const r = parseTavernPreset(preset);
        expect(r.chain.findIndex((m) => m.content === 'A')).toBeLessThan(
            r.chain.findIndex((m) => m.content === 'B'),
        );
    });
});

describe('parseTavernPreset - 兜底与容错', () => {
    it('预设中没有聊天记录时自动追加正文槽到末尾', () => {
        const preset = makePreset({
            prompts: [{ identifier: 'only', role: 'system', content: '仅系统' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'only', enabled: true }] }],
        });
        const r = parseTavernPreset(preset);
        expect(r.stats.hadPromptSlot).toBe(false);
        expect(r.chain[r.chain.length - 1].content).toBe('{PROMPT}');
    });

    it('没有 prompt_order 的老预设按 prompts 原序展开', () => {
        const r = parseTavernPreset({
            prompts: [
                { identifier: 'x', role: 'system', content: '老格式' },
                { identifier: 'chatHistory', marker: true },
            ],
        });
        expect(r.chain[0].content).toBe('老格式');
        expect(r.chain[1].content).toBe('{PROMPT}');
    });

    it('未知 role 落回 system', () => {
        const r = parseTavernPreset({
            prompts: [{ identifier: 'weird', role: 'moderator', content: '内容' }],
        });
        expect(r.chain[0].role).toBe('system');
    });

    it('缺少 prompts 数组时抛错', () => {
        expect(() => parseTavernPreset({ foo: 1 })).toThrow('不是有效的酒馆对话补全预设');
    });

    it('传入 null 时抛错', () => {
        expect(() => parseTavernPreset(null)).toThrow('不是有效的酒馆对话补全预设');
    });

    it('order 里引用了不存在的 identifier 时安全跳过', () => {
        const r = parseTavernPreset({
            prompts: [{ identifier: 'real', role: 'system', content: '真实条目' }],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'ghost', enabled: true },
                        { identifier: 'real', enabled: true },
                    ],
                },
            ],
        });
        expect(r.chain.filter((m) => m.content === '真实条目')).toHaveLength(1);
    });
});

describe('parseTavernPreset - squash_system_messages', () => {
    it('开启时合并相邻 system 消息', () => {
        const r = parseTavernPreset({
            squash_system_messages: true,
            prompts: [
                { identifier: 'a', role: 'system', content: '系统A' },
                { identifier: 'b', role: 'system', content: '系统B' },
                { identifier: 'c', role: 'user', content: '用户C' },
            ],
        });
        expect(r.chain[0].content).toBe('系统A\n\n系统B');
        expect(r.chain[1].content).toBe('用户C');
    });

    it('关闭时不合并', () => {
        const r = parseTavernPreset({
            prompts: [
                { identifier: 'a', role: 'system', content: '系统A' },
                { identifier: 'b', role: 'system', content: '系统B' },
            ],
        });
        expect(r.chain[0].content).toBe('系统A');
        expect(r.chain[1].content).toBe('系统B');
    });

    it('合并时不会吞掉正文槽', () => {
        const r = parseTavernPreset({
            squash_system_messages: true,
            prompts: [
                { identifier: 'a', role: 'system', content: '系统A' },
                { identifier: 'chatHistory', marker: true },
            ],
        });
        expect(r.chain.filter((m) => m.content === '{PROMPT}')).toHaveLength(1);
    });
});

describe('parseTavernPreset - 采样参数', () => {
    it('读取 temperature / openai_max_tokens / top_p', () => {
        const r = parseTavernPreset(makePreset());
        expect(r.params.temperature).toBe(1.05);
        expect(r.params.maxTokens).toBe(4096);
        expect(r.params.topP).toBe(0.92);
    });

    it('openai_max_tokens 缺失时回退 max_tokens', () => {
        const r = parseTavernPreset({ prompts: [], max_tokens: 2048 });
        expect(r.params.maxTokens).toBe(2048);
    });

    it('都没有时为 null', () => {
        const r = parseTavernPreset({ prompts: [] });
        expect(r.params.maxTokens).toBeNull();
        expect(r.params.temperature).toBeNull();
    });
});

describe('applyTavernPreset', () => {
    function makeState() {
        return {
            settings: {
                promptMessageChain: [{ role: 'user', content: '{PROMPT}', enabled: true }],
                presetTemperature: 0.3,
                presetMaxTokens: null,
                presetTopP: null,
                importedPresetName: '',
            },
        };
    }

    it('写入消息链并去掉内部字段', () => {
        const AppState = makeState();
        let saved = 0;
        const svc = createPresetImportService({ AppState, saveCurrentSettings: () => saved++ });
        svc.applyTavernPreset(parseTavernPreset(makePreset()), '测试预设');

        expect(AppState.settings.importedPresetName).toBe('测试预设');
        expect(saved).toBe(1);
        for (const m of AppState.settings.promptMessageChain) {
            expect(Object.keys(m).sort()).toEqual(['content', 'enabled', 'role']);
        }
    });

    it('同步采样参数', () => {
        const AppState = makeState();
        const svc = createPresetImportService({ AppState, saveCurrentSettings: () => {} });
        svc.applyTavernPreset(parseTavernPreset(makePreset()), 'p');
        expect(AppState.settings.presetTemperature).toBe(1.05);
        expect(AppState.settings.presetMaxTokens).toBe(4096);
        expect(AppState.settings.presetTopP).toBe(0.92);
    });

    it('预设未提供的参数保持原值', () => {
        const AppState = makeState();
        AppState.settings.presetTemperature = 0.7;
        const svc = createPresetImportService({ AppState, saveCurrentSettings: () => {} });
        svc.applyTavernPreset(parseTavernPreset({ prompts: [] }), 'p');
        expect(AppState.settings.presetTemperature).toBe(0.7);
    });

    it('clearImportedPreset 恢复默认', () => {
        const AppState = makeState();
        const svc = createPresetImportService({ AppState, saveCurrentSettings: () => {} });
        svc.applyTavernPreset(parseTavernPreset(makePreset()), 'p');
        svc.clearImportedPreset();
        expect(AppState.settings.presetTemperature).toBe(0.3);
        expect(AppState.settings.presetMaxTokens).toBeNull();
        expect(AppState.settings.importedPresetName).toBe('');
    });
});

describe('buildPresetSummary', () => {
    it('包含条目数、丢弃数和采样参数', () => {
        const parsed = parseTavernPreset(makePreset());
        const text = buildPresetSummary('我的预设', parsed);
        expect(text).toContain('我的预设');
        expect(text).toContain('丢弃占位符 2 个');
        expect(text).toContain('temperature = 1.05');
    });

    it('没有正文槽时提示已自动追加', () => {
        const parsed = parseTavernPreset({ prompts: [{ identifier: 'a', role: 'system', content: 'A' }] });
        expect(buildPresetSummary('x', parsed)).toContain('已自动追加到末尾');
    });
});
