/**
 * 关键词精简服务
 *
 * 独立于别名合并。把世界书条目的关键词交给 AI 去芜存菁，
 * 只保留能直接指代该对象的称呼（名字、简称、外号等），
 * 删掉外貌、身份、性格、关系这类不能当名字用的描述性词。
 *
 * 设计要点：
 * - 分批发送，避免一次塞太多条目导致 AI 输出被截断
 * - 多层兜底：AI 不配合时保持原关键词不变，宁可不精简也不能把关键词搞丢
 * - 精简前自动存快照，可从历史记录回退
 */

/** 每批发送给 AI 的条目数上限 */
const BATCH_SIZE = 25;

/** 单个条目内容摘要截断长度，够 AI 判断即可，不必发全文 */
const CONTENT_PREVIEW = 150;

export function createKeywordSimplifyService(deps = {}) {
    const {
        AppState,
        Logger,
        callAPI,
        parseAIResponse,
        updateStreamContent,
        debugLog,
        MemoryHistoryDB,
        getLanguagePrefix = () => '',
    } = deps;

    /**
     * 统计哪些分类有可精简的条目
     *
     * @param {object} [worldbook] 默认用当前生成的世界书
     * @returns {Array<{name:string, entryCount:number, keywordCount:number}>}
     */
    function scanCategories(worldbook) {
        const target = worldbook || AppState.worldbook.generated || {};
        const out = [];
        for (const category of Object.keys(target)) {
            const entries = target[category];
            if (!entries || typeof entries !== 'object') continue;
            let entryCount = 0;
            let keywordCount = 0;
            for (const name of Object.keys(entries)) {
                const kw = entries[name]?.['关键词'];
                if (!Array.isArray(kw) || kw.length === 0) continue;
                entryCount++;
                keywordCount += kw.length;
            }
            if (entryCount > 0) {
                out.push({ name: category, entryCount, keywordCount });
            }
        }
        return out;
    }

    /**
     * 构造发给 AI 的提示词
     *
     * @param {string} categoryName
     * @param {Array<{name:string, keywords:string[], content:string}>} batch
     * @returns {string}
     */
    function buildPrompt(categoryName, batch) {
        const isCharacter = categoryName === '角色';
        const subject = isCharacter ? '这个人物' : '这个事物';

        const rules = isCharacter
            ? `- **保留**：本名、姓、名、全名、简称、小名、乳名、外号、绰号、代号、称号、别名、尊称
- **删除**：
  - 外貌描写：银发、红瞳、高个子
  - 身份职业：学生、队长、魔法师、皇帝
  - 性格特征：冷酷、温柔、腹黑
  - 关系描述：主角的妹妹、李明的师父
  - 所属组织：青云宗弟子
  - 能力技能：火系魔法、剑术
  - 任何不能直接当作称呼喊出来的词`
            : `- **保留**：正式名称、简称、别称、俗称、旧称、代号
- **删除**：
  - 属性与状态描写：繁华的、废弃的、巨大的
  - 功能用途：交易场所、防御工事
  - 所属关系：北方的、皇室的
  - 任何不能直接指代该${categoryName}的描述性词`;

        const items = batch
            .map((item, i) => {
                const content = (item.content || '').substring(0, CONTENT_PREVIEW);
                return `${i + 1}. 【${item.name}】
   现有关键词: ${item.keywords.join(', ')}
   内容摘要: ${content}${(item.content || '').length > CONTENT_PREVIEW ? '...' : ''}`;
            })
            .join('\n\n');

        return (
            getLanguagePrefix() +
            `你是世界书关键词整理专家。下面是「${categoryName}」分类下的若干条目，请精简每个条目的关键词。

## 目标
关键词用于在正文中触发这个条目，所以**只应保留能直接指代${subject}的称呼**。
描述性的词不但触发不准，还会造成误触发。

## 精简规则
${rules}
- 数量控制在 2~6 个，宁缺毋滥
- **不要新造**原有关键词里没有出现过的词
- 条目名本身必须保留在关键词里
- 如果某个条目的关键词已经很干净，原样返回即可

## 待精简的条目
${items}

## 输出格式
只输出 JSON，不要任何解释文字：
{
    "results": [
        {"name": "条目名", "keywords": ["精简后的关键词1", "精简后的关键词2"]},
        {"name": "条目名2", "keywords": ["..."]}
    ]
}`
        );
    }

    /**
     * 校验并采纳 AI 给出的精简关键词。
     *
     * 多层保护，宁可不精简也不能把关键词搞丢：
     *   1. AI 没返回这个条目 -> 保持原样
     *   2. AI 捏造了原本不存在的词 -> 剔除
     *   3. 条目名必须保留 -> 强制补回
     *   4. 精简后没变少，或少到不足 1 个 -> 判定 AI 没照做，保持原样
     *
     * @param {string[]} original 原关键词
     * @param {string[]|undefined} proposed AI 给的精简结果
     * @param {string} entryName 条目名
     * @returns {{keywords:string[], changed:boolean}}
     */
    function applyProposal(original, proposed, entryName) {
        const originalSet = [...new Set(original.map((k) => String(k).trim()).filter(Boolean))];
        if (!Array.isArray(proposed) || proposed.length === 0) {
            return { keywords: originalSet, changed: false };
        }

        const known = new Set(originalSet);
        const filtered = proposed
            .map((k) => String(k).trim())
            .filter((k) => k && known.has(k));

        const name = String(entryName).trim();
        const result = [...new Set([name, ...filtered].filter(Boolean))];

        if (result.length >= originalSet.length || result.length < 1) {
            return { keywords: originalSet, changed: false };
        }
        return { keywords: result, changed: true };
    }

    /**
     * 对指定分类执行关键词精简
     *
     * @param {string[]} categoryNames 要处理的分类名
     * @param {Function} [onProgress] 进度回调 (done, total, categoryName)
     * @returns {Promise<{simplified:number, unchanged:number, failed:number, removedKeywords:number, details:Array}>}
     */
    async function simplifyCategories(categoryNames, onProgress) {
        const worldbook = AppState.worldbook.generated || {};
        const stats = { simplified: 0, unchanged: 0, failed: 0, removedKeywords: 0, details: [] };

        // 精简前存快照，出问题可从历史记录回退
        if (MemoryHistoryDB && typeof MemoryHistoryDB.saveWorldbookSnapshot === 'function') {
            try {
                await MemoryHistoryDB.saveWorldbookSnapshot('关键词精简前');
            } catch (e) {
                Logger.warn('关键词精简', `保存快照失败: ${e.message}`);
            }
        }

        // 汇总所有待处理条目
        const allItems = [];
        for (const category of categoryNames) {
            const entries = worldbook[category];
            if (!entries || typeof entries !== 'object') continue;
            for (const name of Object.keys(entries)) {
                const kw = entries[name]?.['关键词'];
                if (!Array.isArray(kw) || kw.length === 0) continue;
                allItems.push({
                    category,
                    name,
                    keywords: kw.map((k) => String(k)),
                    content: entries[name]?.['内容'] || '',
                });
            }
        }

        if (allItems.length === 0) {
            return stats;
        }

        // 按分类分批，避免把不同分类的规则混在一次请求里
        const byCategory = {};
        for (const item of allItems) {
            (byCategory[item.category] = byCategory[item.category] || []).push(item);
        }

        let done = 0;
        for (const category of Object.keys(byCategory)) {
            const items = byCategory[category];
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                if (AppState.processing.isStopped) {
                    Logger.info('关键词精简', '用户中断');
                    return stats;
                }

                const batch = items.slice(i, i + BATCH_SIZE);
                const batchNo = Math.floor(i / BATCH_SIZE) + 1;
                const batchTotal = Math.ceil(items.length / BATCH_SIZE);
                updateStreamContent(
                    `\n🔤 精简「${category}」关键词 (第${batchNo}/${batchTotal}批, ${batch.length}个条目)...\n`,
                );

                let proposals = {};
                try {
                    const prompt = buildPrompt(category, batch);
                    const response = await callAPI(prompt);
                    const parsed = parseAIResponse(response);
                    const results = parsed?.results || parsed?.Results || [];
                    if (!Array.isArray(results)) throw new Error('返回格式不是数组');
                    for (const r of results) {
                        if (r && r.name) proposals[String(r.name).trim()] = r.keywords;
                    }
                } catch (error) {
                    debugLog(`关键词精简批次失败: ${error.message}`);
                    updateStreamContent(`⚠️ 该批次失败，保持原关键词: ${error.message}\n`);
                    stats.failed += batch.length;
                    done += batch.length;
                    if (typeof onProgress === 'function') onProgress(done, allItems.length, category);
                    continue;
                }

                for (const item of batch) {
                    const entry = worldbook[item.category]?.[item.name];
                    if (!entry) continue;
                    const { keywords, changed } = applyProposal(
                        item.keywords,
                        proposals[item.name],
                        item.name,
                    );
                    if (changed) {
                        const before = item.keywords.length;
                        entry['关键词'] = keywords;
                        stats.simplified++;
                        stats.removedKeywords += before - keywords.length;
                        stats.details.push({
                            category: item.category,
                            name: item.name,
                            before: item.keywords,
                            after: keywords,
                        });
                    } else {
                        stats.unchanged++;
                    }
                }

                done += batch.length;
                if (typeof onProgress === 'function') onProgress(done, allItems.length, category);
            }
        }

        Logger.info(
            '关键词精简',
            `完成: 精简${stats.simplified}个，未变${stats.unchanged}个，失败${stats.failed}个，共删除${stats.removedKeywords}个关键词`,
        );
        return stats;
    }

    return {
        scanCategories,
        simplifyCategories,
        applyProposal,
        buildPrompt,
    };
}
