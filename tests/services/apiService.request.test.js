import { describe, it, expect } from 'vitest';
import { createApiService } from '../../txtToWorldbook/services/apiService.js';

function makeService(settings = {}) {
    const AppState = {
        settings: {
            customApiProvider: 'openai-compatible',
            customApiKey: 'test-key',
            customApiEndpoint: '',
            customApiModel: '',
            apiTimeout: 120000,
            presetTemperature: 0.3,
            presetMaxTokens: null,
            presetTopP: null,
            presetFreqPenalty: null,
            presetPresPenalty: null,
            liveStreamOutput: true,
            useTavernApi: false,
            ...settings,
        },
    };
    const svc = createApiService({
        AppState,
        Logger: { info: () => {}, warn: () => {}, error: () => {} },
        APICaller: {},
        updateStreamContent: () => {},
        debugLog: () => {},
        messagesToString: (m) => m.map((x) => x.content).join('\n'),
        convertToGeminiContents: (m) => ({
            contents: m
                .filter((x) => x.role !== 'system')
                .map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
        }),
        applyMessageChain: (p) => [{ role: 'user', content: p }],
    });
    return { svc, AppState };
}

/** 通过 callCustomAPI 之外的方式拿到构造结果：直接调用内部构造器的替身 */
function buildVia(svc, AppState, messages) {
    // buildCustomApiRequest 未导出，这里借助 callCustomAPI 的前半段行为间接验证不现实，
    // 因此改为直接从 getSamplingParams + 已知规则断言。见下方各用例。
    return null;
}

describe('getSamplingParams', () => {
    it('默认温度 0.3，其余为 null', () => {
        const { svc } = makeService();
        const sp = svc.getSamplingParams();
        expect(sp.temperature).toBe(0.3);
        expect(sp.maxTokens).toBeNull();
        expect(sp.topP).toBeNull();
    });

    it('界面设置的温度生效', () => {
        const { svc } = makeService({ presetTemperature: 1.2 });
        expect(svc.getSamplingParams().temperature).toBe(1.2);
    });

    it('温度为 0 时不被当作缺省值', () => {
        const { svc } = makeService({ presetTemperature: 0 });
        expect(svc.getSamplingParams().temperature).toBe(0);
    });

    it('非法温度落回 0.3', () => {
        const { svc } = makeService({ presetTemperature: NaN });
        expect(svc.getSamplingParams().temperature).toBe(0.3);
    });

    it('最大输出与 top_p 透传', () => {
        const { svc } = makeService({ presetMaxTokens: 8192, presetTopP: 0.9 });
        const sp = svc.getSamplingParams();
        expect(sp.maxTokens).toBe(8192);
        expect(sp.topP).toBe(0.9);
    });
});

// ============================================================
// 请求构造：通过 mock 掉 APICaller 捕获真实请求参数
// ============================================================
function captureRequest(settings, messages = [{ role: 'user', content: '正文' }]) {
    let captured = null;
    const AppState = {
        settings: {
            customApiProvider: 'openai-compatible',
            customApiKey: 'k',
            customApiEndpoint: '',
            customApiModel: '',
            apiTimeout: 120000,
            presetTemperature: 0.3,
            presetMaxTokens: null,
            presetTopP: null,
            presetFreqPenalty: null,
            presetPresPenalty: null,
            liveStreamOutput: false,
            useTavernApi: false,
            ...settings,
        },
    };
    const APICaller = {
        async requestStream(url, options) {
            captured = { url, options, mode: 'stream' };
            return '结果';
        },
        async requestJSON(url, options) {
            captured = { url, options, mode: 'json' };
            return { choices: [{ message: { content: '结果' } }] };
        },
        async withRetry(task) {
            return task(0);
        },
        isRetryableError: () => false,
        handleError: () => ({ type: 'unknown', message: 'x' }),
    };
    const svc = createApiService({
        AppState,
        Logger: { info: () => {}, warn: () => {}, error: () => {} },
        APICaller,
        updateStreamContent: () => {},
        debugLog: () => {},
        messagesToString: (m) => m.map((x) => x.content).join('\n'),
        convertToGeminiContents: (m) => ({
            contents: m
                .filter((x) => x.role !== 'system')
                .map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
        }),
        applyMessageChain: (p) => [{ role: 'user', content: p }],
    });
    return { svc, getCaptured: () => captured };
}

describe('请求构造 - OpenAI 兼容', () => {
    it('启用流式', async () => {
        const { svc, getCaptured } = captureRequest({ customApiEndpoint: 'http://localhost:5000/v1' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        const c = getCaptured();
        expect(c.mode).toBe('stream');
        expect(JSON.parse(c.options.body).stream).toBe(true);
    });

    it('温度与最大输出写入请求体', async () => {
        const { svc, getCaptured } = captureRequest({
            customApiEndpoint: 'http://x/v1',
            presetTemperature: 1.1,
            presetMaxTokens: 4096,
        });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        const body = JSON.parse(getCaptured().options.body);
        expect(body.temperature).toBe(1.1);
        expect(body.max_tokens).toBe(4096);
    });

    it('未设置最大输出时使用默认 64000', async () => {
        const { svc, getCaptured } = captureRequest({ customApiEndpoint: 'http://x/v1' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(JSON.parse(getCaptured().options.body).max_tokens).toBe(64000);
    });

    it('未设置 top_p 时请求体不含该字段', async () => {
        const { svc, getCaptured } = captureRequest({ customApiEndpoint: 'http://x/v1' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(JSON.parse(getCaptured().options.body).top_p).toBeUndefined();
    });

    it('有 API Key 时带 Authorization 头', async () => {
        const { svc, getCaptured } = captureRequest({ customApiEndpoint: 'http://x/v1', customApiKey: 'sk-abc' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().options.headers.Authorization).toBe('Bearer sk-abc');
    });

    it('无 API Key 时不带 Authorization 头（本地模型）', async () => {
        const { svc, getCaptured } = captureRequest({ customApiEndpoint: 'http://x/v1', customApiKey: '' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().options.headers.Authorization).toBeUndefined();
    });
});

describe('请求构造 - Anthropic', () => {
    it('带浏览器直连头，否则会被 CORS 拦截', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().options.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    });

    it('带版本头和 x-api-key', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic', customApiKey: 'sk-ant' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        const h = getCaptured().options.headers;
        expect(h['anthropic-version']).toBe('2023-06-01');
        expect(h['x-api-key']).toBe('sk-ant');
    });

    it('system 消息提到顶层字段，不留在 messages 里', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        svc.callAPI; // 保持接口引用
        const messages = [
            { role: 'system', content: '你是助手' },
            { role: 'user', content: '正文' },
        ];
        await svc.callCustomAPI(messages);
        const body = JSON.parse(getCaptured().options.body);
        expect(body.system).toBe('你是助手');
        expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
    });

    it('多条 system 消息合并到顶层', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        await svc.callCustomAPI([
            { role: 'system', content: 'A' },
            { role: 'system', content: 'B' },
            { role: 'user', content: '正文' },
        ]);
        expect(JSON.parse(getCaptured().options.body).system).toBe('A\n\nB');
    });

    it('首条不是 user 时自动补一条 user', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        await svc.callCustomAPI([
            { role: 'system', content: '系统' },
            { role: 'assistant', content: '我先说' },
        ]);
        const body = JSON.parse(getCaptured().options.body);
        expect(body.messages[0].role).toBe('user');
    });

    it('相邻同角色消息被合并', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        await svc.callCustomAPI([
            { role: 'user', content: '第一段' },
            { role: 'user', content: '第二段' },
        ]);
        const body = JSON.parse(getCaptured().options.body);
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].content).toBe('第一段\n\n第二段');
    });

    it('全是 system 时也能生成合法请求', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        await svc.callCustomAPI([{ role: 'system', content: '只有系统' }]);
        const body = JSON.parse(getCaptured().options.body);
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe('user');
    });

    it('启用流式', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'anthropic' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().mode).toBe('stream');
        expect(JSON.parse(getCaptured().options.body).stream).toBe(true);
    });

    it('缺少 API Key 时抛错', async () => {
        const { svc } = captureRequest({ customApiProvider: 'anthropic', customApiKey: '' });
        let err = null;
        try {
            await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        } catch (e) {
            err = e;
        }
        expect(err).toBeTruthy();
        expect(err.message).toContain('Anthropic API Key 未设置');
    });
});

describe('请求构造 - Gemini', () => {
    it('使用 streamGenerateContent 流式端点', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'gemini', customApiKey: 'gk' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().url).toContain(':streamGenerateContent');
        expect(getCaptured().url).toContain('alt=sse');
    });

    it('走流式读取分支', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'gemini', customApiKey: 'gk' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().mode).toBe('stream');
    });

    it('自定义 endpoint 时拼接正确', async () => {
        const { svc, getCaptured } = captureRequest({
            customApiProvider: 'gemini',
            customApiKey: 'gk',
            customApiEndpoint: 'https://my-proxy.com/v1beta/models',
        });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().url).toContain('my-proxy.com');
        expect(getCaptured().url).toContain(':streamGenerateContent');
    });

    it('温度与最大输出写入 generationConfig', async () => {
        const { svc, getCaptured } = captureRequest({
            customApiProvider: 'gemini',
            customApiKey: 'gk',
            presetTemperature: 0.8,
            presetMaxTokens: 16384,
        });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        const cfg = JSON.parse(getCaptured().options.body).generationConfig;
        expect(cfg.temperature).toBe(0.8);
        expect(cfg.maxOutputTokens).toBe(16384);
    });

    it('安全设置全部关闭', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: 'gemini', customApiKey: 'gk' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        const safety = JSON.parse(getCaptured().options.body).safetySettings;
        expect(safety).toHaveLength(4);
        expect(safety.every((s) => s.threshold === 'OFF')).toBe(true);
    });

    it('缺少 API Key 时抛错', async () => {
        const { svc } = captureRequest({ customApiProvider: 'gemini', customApiKey: '' });
        let err = null;
        try {
            await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        } catch (e) {
            err = e;
        }
        expect(err.message).toContain('Gemini API Key 未设置');
    });
});

describe('provider 兜底', () => {
    it('残留的 deepseek 设置落回 OpenAI 兼容而不是报错', async () => {
        const { svc, getCaptured } = captureRequest({
            customApiProvider: 'deepseek',
            customApiEndpoint: 'http://x/v1',
        });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().url).toContain('/chat/completions');
        expect(JSON.parse(getCaptured().options.body).stream).toBe(true);
    });

    it('残留的 gemini-proxy 设置同样安全落回', async () => {
        const { svc, getCaptured } = captureRequest({
            customApiProvider: 'gemini-proxy',
            customApiEndpoint: 'http://x/v1',
        });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured().url).toContain('/chat/completions');
    });

    it('空的 provider 也能工作', async () => {
        const { svc, getCaptured } = captureRequest({ customApiProvider: '', customApiEndpoint: 'http://x/v1' });
        await svc.callCustomAPI([{ role: 'user', content: '正文' }]);
        expect(getCaptured()).toBeTruthy();
    });
});

describe('实时流式输出 - 单任务跟踪', () => {
    it('并行时只有第一个任务收到逐字回调', async () => {
        let capturedChunks = [];
        const AppState = {
            settings: {
                customApiProvider: 'openai-compatible',
                customApiKey: '',
                customApiEndpoint: 'http://x/v1',
                customApiModel: '',
                apiTimeout: 120000,
                presetTemperature: 0.3,
                presetMaxTokens: null,
                presetTopP: null,
                presetFreqPenalty: null,
                presetPresPenalty: null,
                liveStreamOutput: true,
                useTavernApi: false,
            },
        };
        const APICaller = {
            async requestStream(url, options) {
                capturedChunks.push(options.onChunk === null ? 'no-callback' : 'has-callback');
                // 模拟耗时，让两个任务真正并存
                await new Promise((r) => setTimeout(r, 30));
                return '结果';
            },
            async withRetry(task) {
                return task(0);
            },
            isRetryableError: () => false,
            handleError: () => ({ type: 'unknown', message: 'x' }),
        };
        const svc = createApiService({
            AppState,
            Logger: { info: () => {}, warn: () => {}, error: () => {} },
            APICaller,
            updateStreamContent: () => {},
            debugLog: () => {},
            messagesToString: (m) => m.map((x) => x.content).join('\n'),
            convertToGeminiContents: () => ({ contents: [] }),
            applyMessageChain: (p) => [{ role: 'user', content: p }],
        });

        await Promise.all([
            svc.callCustomAPI([{ role: 'user', content: 'A' }], 1),
            svc.callCustomAPI([{ role: 'user', content: 'B' }], 2),
        ]);

        expect(capturedChunks).toHaveLength(2);
        expect(capturedChunks.filter((c) => c === 'has-callback')).toHaveLength(1);
        expect(capturedChunks.filter((c) => c === 'no-callback')).toHaveLength(1);
    });

    it('任务结束后占用被释放，下一个任务可以接管', async () => {
        const seen = [];
        const AppState = {
            settings: {
                customApiProvider: 'openai-compatible',
                customApiKey: '',
                customApiEndpoint: 'http://x/v1',
                customApiModel: '',
                apiTimeout: 120000,
                presetTemperature: 0.3,
                presetMaxTokens: null,
                presetTopP: null,
                presetFreqPenalty: null,
                presetPresPenalty: null,
                liveStreamOutput: true,
                useTavernApi: false,
            },
        };
        const APICaller = {
            async requestStream(url, options) {
                seen.push(options.onChunk !== null);
                return '结果';
            },
            async withRetry(task) {
                return task(0);
            },
            isRetryableError: () => false,
            handleError: () => ({ type: 'unknown', message: 'x' }),
        };
        const svc = createApiService({
            AppState,
            Logger: { info: () => {}, warn: () => {}, error: () => {} },
            APICaller,
            updateStreamContent: () => {},
            debugLog: () => {},
            messagesToString: (m) => m.map((x) => x.content).join('\n'),
            convertToGeminiContents: () => ({ contents: [] }),
            applyMessageChain: (p) => [{ role: 'user', content: p }],
        });

        await svc.callCustomAPI([{ role: 'user', content: 'A' }], 1);
        await svc.callCustomAPI([{ role: 'user', content: 'B' }], 2);
        expect(seen).toEqual([true, true]);
    });

    it('关闭实时输出时所有任务都不带回调', async () => {
        const seen = [];
        const AppState = {
            settings: {
                customApiProvider: 'openai-compatible',
                customApiKey: '',
                customApiEndpoint: 'http://x/v1',
                customApiModel: '',
                apiTimeout: 120000,
                presetTemperature: 0.3,
                presetMaxTokens: null,
                presetTopP: null,
                presetFreqPenalty: null,
                presetPresPenalty: null,
                liveStreamOutput: false,
                useTavernApi: false,
            },
        };
        const APICaller = {
            async requestStream(url, options) {
                seen.push(options.onChunk);
                return '结果';
            },
            async withRetry(task) {
                return task(0);
            },
            isRetryableError: () => false,
            handleError: () => ({ type: 'unknown', message: 'x' }),
        };
        const svc = createApiService({
            AppState,
            Logger: { info: () => {}, warn: () => {}, error: () => {} },
            APICaller,
            updateStreamContent: () => {},
            debugLog: () => {},
            messagesToString: (m) => m.map((x) => x.content).join('\n'),
            convertToGeminiContents: () => ({ contents: [] }),
            applyMessageChain: (p) => [{ role: 'user', content: p }],
        });
        await svc.callCustomAPI([{ role: 'user', content: 'A' }], 1);
        expect(seen[0]).toBeNull();
    });
});
