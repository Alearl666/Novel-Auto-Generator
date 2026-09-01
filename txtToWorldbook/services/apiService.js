/**
 * 构造 OpenAI 兼容 API 的 chat/completions 完整 URL
 *
 * 遵循 OpenAI SDK 标准行为：仅追加 /chat/completions 后缀。
 * 版本号路径由用户自行输入，不再做任何智能识别。
 *
 * 规则：
 *   - endpoint 为空时使用默认值 http://127.0.0.1:5000/v1
 *   - 去除末尾斜杠
 *   - 如 URL 已包含 /chat/completions，则不再追加（信任用户输入的完整 URL）
 *   - 否则追加 /chat/completions
 *   - 缺失协议前缀时补 http://
 *
 * @param {string} [endpoint] 用户输入的 endpoint
 * @returns {string}
 */
export function buildChatUrl(endpoint) {
    const suffix = '/chat/completions';
    let url = endpoint || 'http://127.0.0.1:5000/v1';
    url = url.replace(/\/+$/, '');
    if (!url.includes(suffix)) {
        url += suffix;
    }
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
    }
    return url;
}

/**
 * 构造 OpenAI 兼容 API 的 /models 完整 URL
 *
 * 遵循 OpenAI SDK 标准行为：
 *   - 若 URL 以 /chat/completions 结尾，替换为 /models
 *   - 若 URL 已以 /models 结尾，不修改
 *   - 否则追加 /models
 *
 * @param {string} endpoint 用户输入的 endpoint（可能带或不带 /chat/completions）
 * @returns {string}
 */
export function buildModelsUrl(endpoint) {
    const chatSuffix = '/chat/completions';
    const modelsSuffix = '/models';
    let url = endpoint.replace(/\/+$/, '');
    if (url.endsWith(chatSuffix)) {
        url = url.slice(0, -chatSuffix.length) + modelsSuffix;
    } else if (!url.endsWith(modelsSuffix)) {
        url += modelsSuffix;
    }
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
    }
    return url;
}

export function createApiService(deps = {}) {
    const {
        AppState,
        Logger,
        APICaller,
        updateStreamContent,
        debugLog,
        messagesToString,
        convertToGeminiContents,
        applyMessageChain,
    } = deps;

    let tavernGenerateRawMode = null;
    let tavernArrayFallbackNotified = false;

    async function callSillyTavernAPI(messages, taskId = null) {
        const timeout = AppState.settings.apiTimeout || 120000;
        const logPrefix = taskId !== null ? `[任务${taskId}]` : '';
        const combinedPrompt = messagesToString(messages);
        updateStreamContent(`\n📤 ${logPrefix} 发送请求到酒馆API (${messages.length}条消息)...\n`);
        debugLog(
            `${logPrefix} 酒馆API开始调用, 消息数=${messages.length}, 总长度=${combinedPrompt.length}, 超时=${timeout / 1000}秒`,
        );

        return APICaller.withRetry(
            async (attempt) => {
                if (attempt > 0) {
                    updateStreamContent(`🔄 ${logPrefix} 酒馆API 重试 #${attempt}...\n`);
                    debugLog(`${logPrefix} 酒馆API重试 #${attempt}`);
                }
                try {
                    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
                        throw new Error('无法访问SillyTavern上下文');
                    }

                    const context = SillyTavern.getContext();
                    debugLog(`${logPrefix} 获取到SillyTavern上下文`);

                    // 每次调用独立计时，且用完即清。
                    // 旧实现把同一个 timeoutPromise 复用于「数组格式」和「字符串回退」两次调用，
                    // 第一次消耗掉的时间会从第二次的额度里扣，且计时器从不清除，
                    // 成功返回后仍会在到点时抛出一个无人接管的 rejection。
                    const timers = [];
                    const withTimeout = (promise) => {
                        let timer = null;
                        const timeoutPromise = new Promise((_, reject) => {
                            timer = setTimeout(
                                () => reject(new Error(`API请求超时 (${timeout / 1000}秒)`)),
                                timeout,
                            );
                            timers.push(timer);
                        });
                        return Promise.race([promise, timeoutPromise]).finally(() => {
                            if (timer) clearTimeout(timer);
                        });
                    };
                    const clearAllTimers = () => {
                        for (const t of timers) clearTimeout(t);
                        timers.length = 0;
                    };

                    let result;

                    if (typeof context.generateRaw === 'function') {
                        try {
                            if (tavernGenerateRawMode === 'string' || messages.length === 1) {
                                debugLog(`${logPrefix} 使用generateRaw字符串模式`);
                                result = await withTimeout(context.generateRaw(combinedPrompt, '', false));
                            } else {
                                debugLog(`${logPrefix} 尝试generateRaw消息数组格式 (ST 1.13.2+)`);
                                result = await withTimeout(context.generateRaw({ prompt: messages }));
                                tavernGenerateRawMode = 'messages';
                                debugLog(`${logPrefix} generateRaw消息数组格式成功`);
                            }
                        } catch (rawError) {
                            if (
                                rawError.message?.includes('超时') ||
                                rawError.message?.includes('timeout') ||
                                rawError.message?.includes('API') ||
                                rawError.message?.includes('limit')
                            ) {
                                throw rawError;
                            }
                            tavernGenerateRawMode = 'string';
                            debugLog(`${logPrefix} 消息数组格式不支持(${rawError.message})，已缓存字符串模式`);
                            if (!tavernArrayFallbackNotified) {
                                updateStreamContent(
                                    `ℹ️ ${logPrefix} 当前酒馆不支持消息数组格式，已切换为字符串模式（后续不再提示）\n`,
                                );
                                tavernArrayFallbackNotified = true;
                            }
                            result = await withTimeout(context.generateRaw(combinedPrompt, '', false));
                        }
                    } else if (typeof context.generateQuietPrompt === 'function') {
                        debugLog(`${logPrefix} 使用generateQuietPrompt（字符串模式）`);
                        updateStreamContent(
                            `ℹ️ ${logPrefix} 酒馆API: 使用generateQuietPrompt（字符串模式，消息角色不生效）\n`,
                        );
                        result = await withTimeout(context.generateQuietPrompt(combinedPrompt, false, false));
                    } else {
                        throw new Error('无法找到可用的生成函数');
                    }

                    clearAllTimers();
                    debugLog(`${logPrefix} 收到响应, 长度=${result.length}字符`);
                    updateStreamContent(`📥 ${logPrefix} 收到响应 (${result.length}字符)\n`);
                    return result;
                } catch (error) {
                    clearAllTimers();
                    debugLog(`${logPrefix} 酒馆API出错: ${error.message}`);
                    updateStreamContent(`\n❌ ${logPrefix} 错误: ${error.message}\n`);
                    throw error;
                }
            },
            {
                retries: 2,
                shouldRetry: (error) => APICaller.isRetryableError(error),
                onRetry: async (error, nextAttempt, delay) => {
                    Logger.warn('API', `${logPrefix} 酒馆API重试 #${nextAttempt}: ${error.message}`);
                    updateStreamContent(`⏳ ${logPrefix} ${delay / 1000}秒后重试...\n`);
                },
            },
        );
    }

    /**
     * 读取当前采样参数。界面可调，导入酒馆预设时会被预设值覆盖。
     * @returns {{temperature:number, maxTokens:(number|null), topP:(number|null), freqPenalty:(number|null), presPenalty:(number|null)}}
     */
    function getSamplingParams() {
        const st = AppState.settings;
        const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);
        return {
            temperature: num(st.presetTemperature) !== null ? st.presetTemperature : 0.3,
            maxTokens: num(st.presetMaxTokens),
            topP: num(st.presetTopP),
            freqPenalty: num(st.presetFreqPenalty),
            presPenalty: num(st.presetPresPenalty),
        };
    }

    /**
     * 把采样参数塞进 OpenAI 风格的请求体。
     * @param {object} body
     * @param {number} defaultMaxTokens 未设置 max_tokens 时的兜底值
     * @returns {object}
     */
    function applySamplingToOpenAIBody(body, defaultMaxTokens) {
        const sp = getSamplingParams();
        const out = { ...body, temperature: sp.temperature };
        out.max_tokens = sp.maxTokens || defaultMaxTokens;
        if (sp.topP !== null) out.top_p = sp.topP;
        if (sp.freqPenalty !== null) out.frequency_penalty = sp.freqPenalty;
        if (sp.presPenalty !== null) out.presence_penalty = sp.presPenalty;
        return out;
    }

    /**
     * 把消息数组拆成 Anthropic 需要的形式。
     * Anthropic 不接受 messages 里出现 system 角色，必须提到顶层 system 字段，
     * 且 messages 必须以 user 开头、user/assistant 交替。
     *
     * @param {Array<{role:string, content:string}>} messages
     * @returns {{system:string, messages:Array}}
     */
    function convertToAnthropicMessages(messages) {
        const systemParts = [];
        const rest = [];
        for (const m of messages) {
            if (m.role === 'system') {
                if (m.content) systemParts.push(m.content);
            } else {
                rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
            }
        }

        // 合并相邻同角色消息
        const merged = [];
        for (const m of rest) {
            const prev = merged[merged.length - 1];
            if (prev && prev.role === m.role) {
                prev.content += '\n\n' + m.content;
            } else {
                merged.push({ ...m });
            }
        }

        // 首条必须是 user
        if (merged.length === 0) {
            merged.push({ role: 'user', content: '请开始。' });
        } else if (merged[0].role !== 'user') {
            merged.unshift({ role: 'user', content: '请根据以下内容执行任务。' });
        }

        return { system: systemParts.join('\n\n'), messages: merged };
    }

    function buildCustomApiRequest(messages) {
        const rawProvider = AppState.settings.customApiProvider;
        // 兜底：设置里可能残留已移除的 provider（deepseek / gemini-proxy），
        // 直接落回 OpenAI 兼容，避免抛「不支持的API提供商」。
        const provider = ['openai-compatible', 'gemini', 'anthropic'].includes(rawProvider)
            ? rawProvider
            : 'openai-compatible';
        const apiKey = AppState.settings.customApiKey;
        const endpoint = AppState.settings.customApiEndpoint;
        const model = AppState.settings.customApiModel;
        const openaiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
        const sp = getSamplingParams();
        let requestUrl = '';
        let requestOptions = {};
        let isStreamRequest = false;

        switch (provider) {
            case 'anthropic': {
                if (!apiKey) throw new Error('Anthropic API Key 未设置');
                let base = (endpoint || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
                if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
                requestUrl = base.includes('/v1/messages') ? base : base + '/v1/messages';

                const { system, messages: anthropicMessages } = convertToAnthropicMessages(messages);
                const body = {
                    model: model || 'claude-sonnet-4-20250514',
                    messages: anthropicMessages,
                    temperature: sp.temperature,
                    max_tokens: sp.maxTokens || 8192,
                    stream: true,
                };
                if (system) body.system = system;
                if (sp.topP !== null) body.top_p = sp.topP;

                requestOptions = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        // 浏览器直连 Anthropic 必须显式声明，否则被 CORS 拦截
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify(body),
                };
                isStreamRequest = true;
                break;
            }

            case 'gemini': {
                if (!apiKey) throw new Error('Gemini API Key 未设置');
                const geminiModel = model || 'gemini-2.5-flash';
                // 使用流式接口 streamGenerateContent，配合 alt=sse 拿到标准 SSE
                let geminiBaseUrl = endpoint ? endpoint.trim() : '';
                if (geminiBaseUrl) {
                    if (!geminiBaseUrl.startsWith('http')) geminiBaseUrl = 'https://' + geminiBaseUrl;
                    if (geminiBaseUrl.endsWith('/')) geminiBaseUrl = geminiBaseUrl.slice(0, -1);
                    const sep = geminiBaseUrl.includes('?') ? '&' : '?';
                    requestUrl = `${geminiBaseUrl}/${geminiModel}:streamGenerateContent${sep}alt=sse&key=${apiKey}`;
                } else {
                    requestUrl =
                        `https://generativelanguage.googleapis.com/v1beta/models/` +
                        `${geminiModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
                }
                const geminiData = convertToGeminiContents(messages);
                const generationConfig = {
                    maxOutputTokens: sp.maxTokens || 65536,
                    temperature: sp.temperature,
                };
                if (sp.topP !== null) generationConfig.topP = sp.topP;

                requestOptions = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...geminiData,
                        generationConfig,
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                        ],
                    }),
                };
                isStreamRequest = true;
                break;
            }

            case 'openai-compatible':
            default: {
                const openaiEndpoint = buildChatUrl(endpoint);
                const openaiModel = model || 'local-model';

                const headers = { 'Content-Type': 'application/json' };
                if (apiKey) {
                    headers.Authorization = `Bearer ${apiKey}`;
                }

                requestUrl = openaiEndpoint;
                requestOptions = {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(
                        applySamplingToOpenAIBody(
                            {
                                model: openaiModel,
                                messages: openaiMessages,
                                stream: true,
                            },
                            64000,
                        ),
                    ),
                };
                isStreamRequest = true;
                break;
            }
        }

        return { provider, requestUrl, requestOptions, isStreamRequest, model };
    }

    function extractCustomApiText(provider, data) {
        if (provider === 'gemini') {
            return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
        if (provider === 'anthropic') {
            return data.content?.[0]?.text || '';
        }
        return data.choices?.[0]?.message?.content || '';
    }

    // ===== 实时流式输出的任务跟踪 =====
    // 并行处理时多个任务同时吐字，全塞进同一个面板会交错成乱码。
    // 这里只跟踪「第一个开始的任务」，其余任务只报开始/结束，不逐字显示。
    let liveStreamOwner = null;

    function claimLiveStream(taskId) {
        if (!AppState.settings.liveStreamOutput) return false;
        const key = taskId === null || taskId === undefined ? '__single__' : String(taskId);
        if (liveStreamOwner === null) {
            liveStreamOwner = key;
            return true;
        }
        return liveStreamOwner === key;
    }

    function releaseLiveStream(taskId) {
        const key = taskId === null || taskId === undefined ? '__single__' : String(taskId);
        if (liveStreamOwner === key) liveStreamOwner = null;
    }

    /** 处理开始/结束时重置，避免上一轮的占用残留 */
    function resetLiveStream() {
        liveStreamOwner = null;
    }

    async function callCustomAPI(messages, taskId = null) {
        const maxRetries = 3;
        const timeout = AppState.settings.apiTimeout || 120000;
        const requestConfig = buildCustomApiRequest(messages);
        const combinedPrompt = messagesToString(messages);
        const logPrefix = taskId !== null && taskId !== undefined ? `[任务${taskId}]` : '';

        updateStreamContent(
            `\n📤 ${logPrefix} 发送请求到自定义API (${requestConfig.provider}, ${messages.length}条消息)...\n`,
        );
        debugLog(
            `自定义API开始调用, provider=${requestConfig.provider}, model=${requestConfig.model}, 消息数=${messages.length}, 总长度=${combinedPrompt.length}`,
        );

        try {
            return await APICaller.withRetry(
                async () => {
                    debugLog(`自定义API请求目标: ${requestConfig.requestUrl.substring(0, 80)}...`);

                    if (requestConfig.isStreamRequest) {
                        const isLive = claimLiveStream(taskId);
                        let liveHeaderShown = false;
                        const onChunk = isLive
                            ? (delta) => {
                                  if (!liveHeaderShown) {
                                      updateStreamContent(`\n💬 ${logPrefix} AI 正在输出：\n`);
                                      liveHeaderShown = true;
                                  }
                                  updateStreamContent(delta);
                              }
                            : null;

                        try {
                            const result = await APICaller.requestStream(requestConfig.requestUrl, {
                                ...requestConfig.requestOptions,
                                timeout,
                                inactivityTimeout: Math.min(timeout, 120000),
                                onChunk,
                            });
                            debugLog(`自定义API流式读取完成, 结果长度=${result.length}字符`);
                            updateStreamContent(`\n📥 ${logPrefix} 收到流式响应 (${result.length}字符)\n`);
                            return result;
                        } finally {
                            releaseLiveStream(taskId);
                        }
                    }

                    const data = await APICaller.requestJSON(requestConfig.requestUrl, {
                        ...requestConfig.requestOptions,
                        timeout,
                    });
                    debugLog('自定义API JSON解析完成, 开始提取内容');
                    const result = extractCustomApiText(requestConfig.provider, data);
                    debugLog(`自定义API提取完成, 结果长度=${result.length}字符`);
                    updateStreamContent(`📥 ${logPrefix} 收到响应 (${result.length}字符)\n`);
                    return result;
                },
                {
                    retries: maxRetries,
                    shouldRetry: (error) => APICaller.isRetryableError(error),
                    onRetry: async (error, nextAttempt, delay) => {
                        Logger.warn('API', `重试 #${nextAttempt}: ${error.message}`);
                        updateStreamContent(`⏳ ${logPrefix} 遇到瞬态错误，${delay / 1000}秒后重试...\n`);
                    },
                },
            );
        } catch (error) {
            releaseLiveStream(taskId);
            const normalized = APICaller.handleError(error, '自定义API');
            debugLog(`自定义API出错: ${error.name || 'Error'} - ${error.message}`);
            if (normalized.type === 'timeout') {
                throw new Error(`API请求超时 (${timeout / 1000}秒)`);
            }
            throw error;
        }
    }

    async function handleFetchModelList() {
        const endpoint = AppState.settings.customApiEndpoint || '';
        if (!endpoint) {
            throw new Error('请先设置 API Endpoint');
        }

        const modelsUrl = buildModelsUrl(endpoint);

        const headers = { 'Content-Type': 'application/json' };
        if (AppState.settings.customApiKey) {
            headers.Authorization = `Bearer ${AppState.settings.customApiKey}`;
        }

        Logger.info('API', '拉取模型列表: ' + modelsUrl);

        const data = await APICaller.getJSON(modelsUrl, { method: 'GET', headers });
        Logger.info('API', '模型列表响应: ' + JSON.stringify(data).substring(0, 200));

        let models = [];
        if (data.data && Array.isArray(data.data)) {
            models = data.data.map((m) => m.id || m.name || m);
        } else if (Array.isArray(data)) {
            models = data.map((m) => (typeof m === 'string' ? m : m.id || m.name || m));
        } else if (data.models && Array.isArray(data.models)) {
            models = data.models.map((m) => (typeof m === 'string' ? m : m.id || m.name || m));
        }

        return models;
    }

    async function handleQuickTestModel() {
        const endpoint = AppState.settings.customApiEndpoint || '';
        const model = AppState.settings.customApiModel || '';

        if (!endpoint) {
            throw new Error('请先设置 API Endpoint');
        }
        if (!model) {
            throw new Error('请先设置模型名称');
        }

        const requestUrl = buildChatUrl(endpoint);

        const headers = { 'Content-Type': 'application/json' };
        if (AppState.settings.customApiKey) {
            headers.Authorization = `Bearer ${AppState.settings.customApiKey}`;
        }

        Logger.info('API', `快速测试: ${requestUrl} 模型: ${model}`);

        const startTime = Date.now();
        const data = await APICaller.getJSON(requestUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Say "OK" if you can hear me.' }],
                max_tokens: 100,
                temperature: 0.1,
            }),
        });

        const elapsed = Date.now() - startTime;
        Logger.info('API', '测试响应: ' + JSON.stringify(data).substring(0, 200));

        let responseText = '';

        if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
            const choice = data.choices[0];
            if (choice.message && choice.message.content) {
                responseText = choice.message.content;
            } else if (choice.text) {
                responseText = choice.text;
            } else if (typeof choice.content === 'string') {
                responseText = choice.content;
            }
        } else if (data.response) {
            responseText = data.response;
        } else if (data.content) {
            responseText = data.content;
        } else if (data.text) {
            responseText = data.text;
        } else if (data.output) {
            responseText = data.output;
        } else if (data.generated_text) {
            responseText = data.generated_text;
        }

        if (!responseText || responseText.trim() === '') {
            Logger.warn('API', '无法解析响应，完整数据: ' + JSON.stringify(data, null, 2));

            const possibleFields = ['result', 'message', 'data', 'completion'];
            for (const field of possibleFields) {
                if (data[field]) {
                    if (typeof data[field] === 'string') {
                        responseText = data[field];
                        break;
                    } else if (typeof data[field] === 'object' && data[field].content) {
                        responseText = data[field].content;
                        break;
                    }
                }
            }
        }

        if (!responseText || responseText.trim() === '') {
            throw new Error(`API返回了无法解析的响应格式。\n响应数据: ${JSON.stringify(data).substring(0, 200)}`);
        }

        return {
            success: true,
            elapsed,
            response: responseText.substring(0, 100),
        };
    }

    async function callAPI(prompt, taskId = null) {
        const messages = applyMessageChain(prompt);
        debugLog(`callAPI: 消息链转换完成, ${messages.length}条消息, roles=[${messages.map((m) => m.role).join(',')}]`);
        if (AppState.settings.useTavernApi) {
            return callSillyTavernAPI(messages, taskId);
        }
        return callCustomAPI(messages, taskId);
    }

    return {
        callSillyTavernAPI,
        callCustomAPI,
        handleFetchModelList,
        handleQuickTestModel,
        callAPI,
        resetLiveStream,
        getSamplingParams,
    };
}
