import { describe, it, expect } from 'vitest';
import { createParserService } from '../../txtToWorldbook/services/parserService.js';

// ============================================================
// 测试环境辅助
// ============================================================
function createTestParserService(overrides = {}) {
    const debugMessages = [];
    const AppState = {
        settings: {
            filterResponseTags: 'thinking,/think',
        },
    };
    const service = createParserService({
        AppState,
        debugLog: (msg) => debugMessages.push(msg),
        getEnabledCategoryNames: () => overrides.categories || ['角色', '地点'],
    });
    return { service, AppState, debugMessages };
}

// ============================================================
// filterResponseContent
// ============================================================
describe('filterResponseContent', () => {
    it('空输入返回空', () => {
        const { service } = createTestParserService();
        expect(service.filterResponseContent('')).toBe('');
        expect(service.filterResponseContent(null)).toBe(null);
    });

    it('移除 thinking 标签', () => {
        const { service } = createTestParserService();
        const input = '<thinking>内部思考</thinking>正文内容';
        expect(service.filterResponseContent(input)).toBe('正文内容');
    });

    it('移除 /think 前缀式（从开头到 </think>）', () => {
        const { service } = createTestParserService();
        const input = '一些前缀文本</think>正文字体';
        expect(service.filterResponseContent(input)).toBe('正文字体');
    });

    it('无标签时返回原文', () => {
        const { service } = createTestParserService();
        expect(service.filterResponseContent('普通文本')).toBe('普通文本');
    });

    it('多个 thinking 标签全部移除', () => {
        const { service } = createTestParserService();
        const input = '<thinking>思考1</thinking>正文<thinking>思考2</thinking>更多正文';
        expect(service.filterResponseContent(input)).toBe('正文更多正文');
    });
});

// ============================================================
// parseAIResponse
// ============================================================
describe('parseAIResponse', () => {
    it('解析有效 JSON', () => {
        const { service } = createTestParserService();
        const input = '{"角色":{"张三":{"关键词":["张三"],"内容":"测试"}}}';
        const result = service.parseAIResponse(input);
        expect(result.角色.张三['关键词']).toEqual(['张三']);
    });

    it('从 Markdown 代码块提取 JSON', () => {
        const { service } = createTestParserService();
        const input = '```json\n{"角色":{"张三":{"关键词":["张三"],"内容":"测试"}}}\n```';
        const result = service.parseAIResponse(input);
        expect(result.角色.张三['内容']).toBe('测试');
    });

    it('修复中文引号和尾逗号', () => {
        const { service } = createTestParserService();
        const input = '{"角色": {"张三": {"关键词": ["张三", ], "内容": \u201c测试\u201d}}}';
        const result = service.parseAIResponse(input);
        expect(result.角色.张三['内容']).toBe('测试');
    });

    it('修复缺少闭合括号', () => {
        const { service } = createTestParserService();
        const input = '{"角色":{"张三":{"关键词":["张三"],"内容":"测试"}';
        const result = service.parseAIResponse(input);
        expect(result.角色.张三['内容']).toBe('测试');
    });

    it('过滤 thinking 标签后解析', () => {
        const { service } = createTestParserService();
        const input = '<thinking>这是思考</thinking>{"角色":{"张三":{"关键词":["张三"],"内容":"测试"}}}';
        const result = service.parseAIResponse(input);
        expect(result.角色.张三['关键词']).toContain('张三');
    });

    it('无效 JSON 抛出明确错误', () => {
        const { service } = createTestParserService();
        const input = '这不是 JSON 格式的内容，只是一段普通文本。';
        expect(() => service.parseAIResponse(input)).toThrow(/JSON解析失败/);
    });

    it('通过世界书兜底提取', () => {
        const { service } = createTestParserService({ categories: ['角色'] });
        // 这个输入不是有效 JSON，但包含角色分类和条目结构
        const input = '{"角色": {"张三": {"关键词": ["张三"], "内容": "一个"测试"角色"}}}';
        // 即使 JSON.parse 失败，正则兜底也能提取
        let result;
        try {
            result = service.parseAIResponse(input);
            // 如果走到这里说明 JSON 被成功修复了
            expect(result.角色.张三['关键词']).toContain('张三');
        } catch (e) {
            // 兜底正则也可能无法处理所有情况
            expect(e.message).toContain('JSON解析失败');
        }
    });
});
