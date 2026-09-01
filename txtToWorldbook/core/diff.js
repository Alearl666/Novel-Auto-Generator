/**
 * 简易行级 Diff 实现
 *
 * 基于最长公共子序列 (LCS) 的动态规划算法。
 * 用于比较两个字符串（按行拆分）并生成差异块列表。
 *
 * 复杂度: O(N*M) 时间空间，N/M 为行数
 * 对于世界书条目（通常 <100 行）非常快
 */

/**
 * @typedef {Object} DiffHunk
 * @property {'equal'|'add'|'remove'} type - 变更类型
 * @property {string} content - 行内容
 * @property {number} [oldLine] - 旧文件行号
 * @property {number} [newLine] - 新文件行号
 */

/**
 * 计算两个数组的最长公共子序列回溯矩阵
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]}
 */
function buildLCSMatrix(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    return dp;
}

/**
 * 从 LCS 矩阵回溯生成 diff hunks
 * @param {string[]} a
 * @param {string[]} b
 * @param {number[][]} dp
 * @returns {DiffHunk[]}
 */
function backtrackDiff(a, b, dp) {
    const hunks = [];
    let i = a.length;
    let j = b.length;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            hunks.unshift({ type: 'equal', content: a[i - 1], oldLine: i, newLine: j });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            hunks.unshift({ type: 'add', content: b[j - 1], newLine: j });
            j--;
        } else {
            hunks.unshift({ type: 'remove', content: a[i - 1], oldLine: i });
            i--;
        }
    }
    return hunks;
}

/**
 * 对两行文本进行行级 diff
 * @param {string} oldText
 * @param {string} newText
 * @returns {DiffHunk[]}
 */
export function diffLines(oldText, newText) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    const dp = buildLCSMatrix(oldLines, newLines);
    return backtrackDiff(oldLines, newLines, dp);
}

/**
 * 统计 diff 中新增/移除/不变行数
 * @param {DiffHunk[]} hunks
 * @returns {{added: number, removed: number, equal: number}}
 */
export function diffStats(hunks) {
    return hunks.reduce(
        (acc, h) => {
            if (h.type === 'add') acc.added++;
            else if (h.type === 'remove') acc.removed++;
            else acc.equal++;
            return acc;
        },
        { added: 0, removed: 0, equal: 0 },
    );
}

/**
 * 将 diff hunks 渲染为 HTML
 * @param {DiffHunk[]} hunks
 * @param {Object} [options]
 * @param {number} [options.contextLines=2] - 显示未变更行作为上下文数量
 * @param {boolean} [options.showLineNumbers=true] - 是否显示行号
 * @returns {string} HTML 字符串
 */
export function renderDiffHtml(hunks, options = {}) {
    const { contextLines = 2, showLineNumbers = true } = options;
    if (!hunks || hunks.length === 0) return '<div style="color:#888;padding:8px;">(无变更)</div>';

    // 找到每个 hunk 周围最近的变更距离
    const changeNearest = new Array(hunks.length).fill(Infinity);
    for (let i = 0; i < hunks.length; i++) {
        if (hunks[i].type !== 'equal') {
            changeNearest[i] = 0;
        }
    }
    // 向左传播
    let lastChange = Infinity;
    for (let i = 0; i < hunks.length; i++) {
        if (changeNearest[i] === 0) lastChange = 0;
        else lastChange++;
        changeNearest[i] = Math.min(changeNearest[i], lastChange);
    }
    // 向右传播
    lastChange = Infinity;
    for (let i = hunks.length - 1; i >= 0; i--) {
        if (changeNearest[i] === 0) lastChange = 0;
        else lastChange++;
        changeNearest[i] = Math.min(changeNearest[i], lastChange);
    }

    const rows = [];
    for (let i = 0; i < hunks.length; i++) {
        const h = hunks[i];
        // 折叠不在上下文范围内的 equal 行
        if (h.type === 'equal' && changeNearest[i] > contextLines) {
            // 如果前一个是折叠点，跳过
            if (i > 0 && hunks[i - 1].type === 'equal' && changeNearest[i - 1] > contextLines) {
                continue;
            }
            rows.push(
                `<div style="color:#888;font-size:10px;padding:4px 8px;background:rgba(255,255,255,0.02);text-align:center;">⋯</div>`,
            );
            continue;
        }

        const bgColor =
            h.type === 'add'
                ? 'background:rgba(39,174,96,0.15);'
                : h.type === 'remove'
                  ? 'background:rgba(231,76,60,0.15);'
                  : '';
        const color = h.type === 'add' ? 'color:#27ae60;' : h.type === 'remove' ? 'color:#e74c3c;' : 'color:#ccc;';
        const prefix = h.type === 'add' ? '+' : h.type === 'remove' ? '-' : ' ';

        const lineNums = showLineNumbers
            ? `<span style="color:#666;font-size:10px;min-width:32px;display:inline-block;text-align:right;padding-right:8px;user-select:none;">${h.oldLine || ''}</span>` +
              `<span style="color:#666;font-size:10px;min-width:32px;display:inline-block;text-align:right;padding-right:8px;user-select:none;">${h.newLine || ''}</span>`
            : '';

        rows.push(
            `<div style="${bgColor}display:flex;font-family:monospace;font-size:11px;line-height:1.5;"><span style="color:#666;min-width:16px;padding-right:8px;user-select:none;">${prefix}</span>${lineNums}<span style="${color}flex:1;white-space:pre-wrap;word-break:break-word;">${escapeHtmlForDiff(h.content)}</span></div>`,
        );
    }

    return `<div style="border:1px solid #444;border-radius:4px;overflow:auto;max-height:400px;background:#1a1a1a;padding:6px;">${rows.join('')}</div>`;
}

function escapeHtmlForDiff(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
