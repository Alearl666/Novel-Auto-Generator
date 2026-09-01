import { describe, it, expect } from 'vitest';
import { diffLines, diffStats, renderDiffHtml } from '../../txtToWorldbook/core/diff.js';

describe('diffLines', () => {
    it('完全相同文本返回全部 equal', () => {
        const hunks = diffLines('hello\nworld', 'hello\nworld');
        expect(hunks).toHaveLength(2);
        expect(hunks.every((h) => h.type === 'equal')).toBe(true);
    });

    it('检测新增行', () => {
        const hunks = diffLines('a\nb', 'a\nb\nc');
        const types = hunks.map((h) => h.type);
        expect(types).toContain('add');
        const added = hunks.filter((h) => h.type === 'add');
        expect(added).toHaveLength(1);
        expect(added[0].content).toBe('c');
    });

    it('检测删除行', () => {
        const hunks = diffLines('a\nb\nc', 'a\nc');
        const removed = hunks.filter((h) => h.type === 'remove');
        expect(removed).toHaveLength(1);
        expect(removed[0].content).toBe('b');
    });

    it('检测修改行 (删除+新增)', () => {
        const hunks = diffLines('hello world', 'hello earth');
        const removed = hunks.filter((h) => h.type === 'remove');
        const added = hunks.filter((h) => h.type === 'add');
        expect(removed).toHaveLength(1);
        expect(added).toHaveLength(1);
        expect(removed[0].content).toBe('hello world');
        expect(added[0].content).toBe('hello earth');
    });

    it('空文本处理', () => {
        const hunks = diffLines('', 'new line');
        const added = hunks.filter((h) => h.type === 'add');
        expect(added).toHaveLength(1);
    });

    it('保留行号信息', () => {
        const hunks = diffLines('line1\nline2\nline3', 'line1\nmodified\nline3');
        const modAdd = hunks.find((h) => h.type === 'add');
        expect(modAdd.content).toBe('modified');
        expect(modAdd.newLine).toBe(2);
    });

    it('多行变更', () => {
        const oldText = `李四是青云宗弟子
修为：金丹期
性格：冷漠`;
        const newText = `李四是青云宗弟子
修为：元婴期
性格：冷漠
新增：与张三是好友`;
        const stats = diffStats(diffLines(oldText, newText));
        expect(stats.equal).toBe(2); // 第1行和第3行
        expect(stats.added).toBe(2); // 修为行变化（新增）+ 新增"与张三是好友"行
        expect(stats.removed).toBe(1); // 修为行变化（移除）
    });
});

describe('diffStats', () => {
    it('统计正确', () => {
        const hunks = diffLines('a\nb\nc', 'a\nx\nc\nd');
        const stats = diffStats(hunks);
        expect(stats.equal).toBe(2); // a, c
        expect(stats.removed).toBe(1); // b
        expect(stats.added).toBe(2); // x, d
    });
});

describe('renderDiffHtml', () => {
    it('无变更显示占位', () => {
        const html = renderDiffHtml([]);
        expect(html).toContain('无变更');
    });

    it('正确渲染 add/remove/equal', () => {
        const hunks = diffLines('line1\nline2', 'line1\nmodified\ndiff');
        const html = renderDiffHtml(hunks);
        expect(html).toContain('+');
        expect(html).toContain('-');
        expect(html).toContain('line1');
        expect(html).toContain('modified');
    });

    it('长文本带行号显示', () => {
        const oldText = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
        const newText = oldText.replace('line 5', 'CHANGED LINE 5');
        const hunks = diffLines(oldText, newText);
        const html = renderDiffHtml(hunks, { contextLines: 2, showLineNumbers: true });
        expect(html).toContain('CHANGED');
        // 由于 contextLines=2，远离变更的 equal 行应被折叠
        expect(html).toContain('⋯');
    });

    it('上下文内的 equal 行正常显示', () => {
        const oldText = 'line1\nline2\nline3';
        const newText = 'line1\nmodified\nline3';
        const hunks = diffLines(oldText, newText);
        const html = renderDiffHtml(hunks, { contextLines: 5 });
        expect(html).toContain('line1');
        expect(html).toContain('line3');
    });

    it('HTML 特殊字符正确转义', () => {
        const hunks = diffLines('<script>alert(1)</script>', 'safe text');
        const html = renderDiffHtml(hunks);
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
    });
});
