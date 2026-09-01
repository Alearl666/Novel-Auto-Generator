import { describe, it, expect } from 'vitest';
import {
    estimateTokenCount,
    chineseNumToInt,
    buildWorldbookSummary,
    naturalSortEntryNames,
} from '../../txtToWorldbook/core/utils.js';

// ============================================================
// estimateTokenCount
// ============================================================
describe('estimateTokenCount', () => {
    it('空字符串返回 0', () => {
        expect(estimateTokenCount('')).toBe(0);
        expect(estimateTokenCount(null)).toBe(0);
        expect(estimateTokenCount(undefined)).toBe(0);
    });

    it('纯英文单词计数', () => {
        expect(estimateTokenCount('hello world')).toBe(2);
        expect(estimateTokenCount('one two three four')).toBe(4);
    });

    it('纯中文按 1.5 倍比例估算', () => {
        // 4 个中文字符，4 * 1.5 = 6
        expect(estimateTokenCount('你好世界')).toBe(6);
    });

    it('纯数字按个数计数', () => {
        // 两组数字 "123" 和 "456"
        expect(estimateTokenCount('123 456')).toBe(2);
    });

    it('混合文本正确估算', () => {
        const text = 'Hello世界 123!';
        // 1 英文单词 + 2 中文字*1.5 + 1 数字 + 1 标点*0.5
        // = 1 + 3 + 1 + 0.5 = 5.5 → ceil = 6
        const result = estimateTokenCount(text);
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(20);
    });

    it('向上取整', () => {
        // 3 个中文字 * 1.5 = 4.5 → ceil = 5
        expect(estimateTokenCount('你好吗')).toBe(5);
    });
});

// ============================================================
// chineseNumToInt
// ============================================================
describe('chineseNumToInt', () => {
    it('阿拉伯数字返回原值', () => {
        expect(chineseNumToInt('123')).toBe(123);
        expect(chineseNumToInt('1')).toBe(1);
        expect(chineseNumToInt('0')).toBe(0);
    });

    it('基础中文数字转换', () => {
        expect(chineseNumToInt('一')).toBe(1);
        expect(chineseNumToInt('零')).toBe(0);
        expect(chineseNumToInt('九')).toBe(9);
    });

    it('十位转换', () => {
        expect(chineseNumToInt('十')).toBe(10);
        expect(chineseNumToInt('十一')).toBe(11);
        expect(chineseNumToInt('二十')).toBe(20);
        expect(chineseNumToInt('二十三')).toBe(23);
    });

    it('百位转换', () => {
        expect(chineseNumToInt('一百')).toBe(100);
        expect(chineseNumToInt('一百二十三')).toBe(123);
        expect(chineseNumToInt('三百零五')).toBe(305);
    });

    it('千位转换', () => {
        expect(chineseNumToInt('一千')).toBe(1000);
        expect(chineseNumToInt('一千零一')).toBe(1001);
        expect(chineseNumToInt('三千六百五十')).toBe(3650);
    });

    it('万位转换', () => {
        expect(chineseNumToInt('一万')).toBe(10000);
        expect(chineseNumToInt('一万零一')).toBe(10001);
        expect(chineseNumToInt('三万五千')).toBe(35000);
    });
});

// ============================================================
// naturalSortEntryNames
// ============================================================
describe('naturalSortEntryNames', () => {
    it('中文数字章节排序', () => {
        const names = ['第三章', '第一章', '第二章', '第十章'];
        expect(naturalSortEntryNames(names)).toEqual(['第一章', '第二章', '第三章', '第十章']);
    });

    it('阿拉伯数字章节排序', () => {
        const names = ['第10章', '第1章', '第2章'];
        expect(naturalSortEntryNames(names)).toEqual(['第1章', '第2章', '第10章']);
    });

    it('混合中英文排序', () => {
        const names = ['第100章', '第十章', '第一章'];
        // 第一章 = 1, 第十章 = 10, 第100章 = 100
        expect(naturalSortEntryNames(names)).toEqual(['第一章', '第十章', '第100章']);
    });

    it('无章节标记的字符串按 locale 排序', () => {
        const names = ['张三', '李四', '王五'];
        const result = naturalSortEntryNames(names);
        expect(result).toHaveLength(3);
        expect(result).toContain('张三');
        expect(result).toContain('李四');
        expect(result).toContain('王五');
    });

    it('不修改原数组', () => {
        const names = ['第三章', '第一章'];
        const result = naturalSortEntryNames(names);
        expect(names[0]).toBe('第三章');
        expect(result[0]).toBe('第一章');
    });
});

// ============================================================
// buildWorldbookSummary
// ============================================================
describe('buildWorldbookSummary', () => {
    it('空输入返回空字符串', () => {
        expect(buildWorldbookSummary(null)).toBe('');
        expect(buildWorldbookSummary({})).toBe('');
    });

    it('正常生成摘要', () => {
        const worldbook = {
            角色: {
                张三: { 关键词: ['张三', '老张'], 内容: '一个普通人' },
                李四: { 关键词: ['李四'], 内容: '另一个普通人' },
            },
        };
        const summary = buildWorldbookSummary(worldbook);
        expect(summary).toContain('张三');
        expect(summary).toContain('李四');
        expect(summary).toContain('角色');
        expect(summary).toContain('【已提取的世界书条目概览】');
    });

    it('条目过多时切换为紧凑格式', () => {
        // 创建大量条目使 token 超过 maxTokens
        const worldbook = { 角色: {} };
        for (let i = 0; i < 500; i++) {
            worldbook['角色'][`角色${i}`] = { 关键词: [`关键字${i}`], 内容: 'x'.repeat(200) };
        }
        const summary = buildWorldbookSummary(worldbook, 100); // 低 limit
        expect(summary).toBeTruthy();
        expect(summary.length).toBeLessThan(JSON.stringify(worldbook).length);
    });

    it('超长时截断', () => {
        const worldbook = { 角色: {} };
        for (let i = 0; i < 50; i++) {
            worldbook['角色'][`角色${i}号`] = { 关键词: [`关${i}`], 内容: 'y'.repeat(100) };
        }
        const summary = buildWorldbookSummary(worldbook, 50);
        expect(summary).toBeTruthy();
    });
});
