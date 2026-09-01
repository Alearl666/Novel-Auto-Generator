/**
 * 酒馆「对话补全预设」导入服务
 *
 * 把酒馆导出的预设 JSON 解析成本插件的 promptMessageChain，
 * 并同步其中的采样参数（temperature / max_tokens / top_p / 惩罚项）。
 *
 * 说明：
 * - 酒馆预设里的占位符条目（角色卡、世界书、示例对话等）在本插件没有对应物，
 *   只有「聊天记录」会被映射成正文槽位 {PROMPT}，其余直接丢弃。
 * - injection_position === 1 的条目（多数越狱条目属于此类）在酒馆是按深度插进
 *   聊天记录中间的；本插件没有聊天记录，近似处理为放在 {PROMPT} 之后，
 *   depth 大的排在前面，保持相对顺序。
 */

/** 酒馆占位符 -> 本插件对应物。null 表示无对应物、直接丢弃。 */
const ST_MARKER_MAP = {
    chatHistory: '{PROMPT}',
    worldInfoBefore: null,
    worldInfoAfter: null,
    charDescription: null,
    charPersonality: null,
    scenario: null,
    personaDescription: null,
    dialogueExamples: null,
};

const VALID_ROLES = ['system', 'user', 'assistant'];

/**
 * 解析酒馆对话补全预设
 *
 * @param {object} json 预设 JSON
 * @returns {{chain: Array, params: object, stats: object}}
 */
export function parseTavernPreset(json) {
    if (!json || !Array.isArray(json.prompts)) {
        throw new Error('不是有效的酒馆对话补全预设（缺少 prompts 数组）');
    }

    const byId = {};
    for (const p of json.prompts) {
        if (p && p.identifier) byId[p.identifier] = p;
    }

    // 取排布顺序。酒馆用 character_id 100001 作为全局默认档。
    let order = null;
    if (Array.isArray(json.prompt_order) && json.prompt_order.length) {
        const global =
            json.prompt_order.find((o) => o.character_id === 100001) ||
            json.prompt_order[json.prompt_order.length - 1];
        order = Array.isArray(global && global.order) ? global.order : null;
    }
    // 没有 prompt_order 的老预设：按 prompts 原序
    if (!order) {
        order = json.prompts.map((p) => ({ identifier: p.identifier, enabled: p.enabled !== false }));
    }

    const chain = [];
    const depthInjections = [];
    let droppedMarkers = 0;
    let skippedEmpty = 0;
    let hasPromptSlot = false;

    for (const item of order) {
        const p = byId[item.identifier];
        if (!p) continue;

        const enabled = item.enabled !== false;

        // 占位符条目
        if (p.marker === true || Object.prototype.hasOwnProperty.call(ST_MARKER_MAP, p.identifier)) {
            if (ST_MARKER_MAP[p.identifier] === '{PROMPT}') {
                chain.push({ role: 'user', content: '{PROMPT}', enabled });
                hasPromptSlot = true;
            } else {
                droppedMarkers++;
            }
            continue;
        }

        const content = (p.content || '').trim();
        if (!content) {
            skippedEmpty++;
            continue;
        }

        let role = p.role || 'system';
        if (!VALID_ROLES.includes(role)) role = 'system';

        const entry = { role, content, enabled };

        if (p.injection_position === 1) {
            entry.__depth = typeof p.injection_depth === 'number' ? p.injection_depth : 4;
            depthInjections.push(entry);
        } else {
            chain.push(entry);
        }
    }

    // 深度注入条目：放在正文槽之后，depth 大的靠前
    if (depthInjections.length) {
        depthInjections.sort((a, b) => b.__depth - a.__depth);
        const slotIdx = chain.findIndex((m) => m.content === '{PROMPT}');
        const insertAt = slotIdx >= 0 ? slotIdx + 1 : chain.length;
        chain.splice(insertAt, 0, ...depthInjections);
    }

    // 预设里没有聊天记录槽时兜底，否则正文根本发不出去
    if (!hasPromptSlot) {
        chain.push({ role: 'user', content: '{PROMPT}', enabled: true });
    }

    // squash_system_messages：合并相邻的 system 消息
    let finalChain = chain;
    if (json.squash_system_messages === true) {
        finalChain = [];
        for (const m of chain) {
            const prev = finalChain[finalChain.length - 1];
            if (
                prev &&
                prev.role === 'system' &&
                m.role === 'system' &&
                prev.enabled === m.enabled &&
                m.content !== '{PROMPT}'
            ) {
                prev.content += '\n\n' + m.content;
            } else {
                finalChain.push({ role: m.role, content: m.content, enabled: m.enabled });
            }
        }
    } else {
        finalChain = chain.map((m) => ({ role: m.role, content: m.content, enabled: m.enabled }));
    }

    const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);
    const maxTok = num(json.openai_max_tokens);
    const params = {
        temperature: num(json.temperature),
        maxTokens: maxTok !== null ? maxTok : num(json.max_tokens) !== null ? num(json.max_tokens) : num(json.genamt),
        topP: num(json.top_p),
        freqPenalty: num(json.frequency_penalty),
        presPenalty: num(json.presence_penalty),
    };

    return {
        chain: finalChain,
        params,
        stats: {
            used: finalChain.length,
            enabled: finalChain.filter((m) => m.enabled !== false).length,
            droppedMarkers,
            skippedEmpty,
            hadPromptSlot: hasPromptSlot,
        },
    };
}

/**
 * 组装导入结果摘要文本，供确认弹窗展示
 *
 * @param {string} name 预设名
 * @param {{stats:object, params:object}} parsed
 * @returns {string}
 */
export function buildPresetSummary(name, parsed) {
    const s = parsed.stats;
    const lines = [
        `预设「${name}」解析结果：`,
        '',
        `· 条目 ${s.used} 条（启用 ${s.enabled} 条）`,
        `· 丢弃占位符 ${s.droppedMarkers} 个（角色卡/世界书/示例对话，本插件无对应物）`,
        `· 跳过空内容 ${s.skippedEmpty} 条`,
        `· 正文槽位：${s.hadPromptSlot ? '来自「聊天记录」占位符' : '预设中无聊天记录，已自动追加到末尾'}`,
    ];
    if (parsed.params.temperature !== null) lines.push(`· temperature = ${parsed.params.temperature}`);
    if (parsed.params.maxTokens !== null) lines.push(`· max_tokens = ${parsed.params.maxTokens}`);
    if (parsed.params.topP !== null) lines.push(`· top_p = ${parsed.params.topP}`);
    lines.push('', '导入会覆盖当前消息链，确认？');
    return lines.join('\n');
}

export function createPresetImportService(deps = {}) {
    const { AppState, saveCurrentSettings, Logger } = deps;

    /**
     * 把解析结果写入设置
     *
     * @param {{chain:Array, params:object}} parsed
     * @param {string} presetName
     */
    function applyTavernPreset(parsed, presetName) {
        AppState.settings.promptMessageChain = parsed.chain.map((m) => ({
            role: m.role,
            content: m.content,
            enabled: m.enabled !== false,
        }));

        const p = parsed.params;
        if (p.temperature !== null) AppState.settings.presetTemperature = p.temperature;
        if (p.maxTokens !== null) AppState.settings.presetMaxTokens = p.maxTokens;
        if (p.topP !== null) AppState.settings.presetTopP = p.topP;
        if (p.freqPenalty !== null) AppState.settings.presetFreqPenalty = p.freqPenalty;
        if (p.presPenalty !== null) AppState.settings.presetPresPenalty = p.presPenalty;
        AppState.settings.importedPresetName = presetName || '';

        if (typeof saveCurrentSettings === 'function') saveCurrentSettings();
        if (Logger) Logger.info('Preset', `已导入酒馆预设: ${presetName}（${parsed.chain.length} 条消息）`);
    }

    /** 清空预设带来的采样参数，恢复默认 */
    function clearImportedPreset() {
        AppState.settings.presetTemperature = 0.3;
        AppState.settings.presetMaxTokens = null;
        AppState.settings.presetTopP = null;
        AppState.settings.presetFreqPenalty = null;
        AppState.settings.presetPresPenalty = null;
        AppState.settings.importedPresetName = '';
        if (typeof saveCurrentSettings === 'function') saveCurrentSettings();
    }

    return {
        parseTavernPreset,
        buildPresetSummary,
        applyTavernPreset,
        clearImportedPreset,
    };
}
