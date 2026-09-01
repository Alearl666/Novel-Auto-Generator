import { describe, it, expect, vi } from 'vitest';
import { APICaller } from '../../txtToWorldbook/infra/apiCaller.js';
import { RetryableError, FatalError } from '../../txtToWorldbook/core/errors.js';

/**
 * 构造一个假的 fetch Response，body 按给定分片依次吐出。
 * @param {string[]} chunks
 * @param {{delay?:number, stall?:boolean}} opts
 */
function makeStreamResponse(chunks, opts = {}) {
    const encoder = new TextEncoder();
    let i = 0;
    let cancelled = false;
    let pendingResolve = null;

    return {
        ok: true,
        status: 200,
        body: {
            getReader() {
                return {
                    async read() {
                        if (cancelled) return { done: true, value: undefined };
                        if (opts.stall && i >= chunks.length) {
                            // 模拟服务端挂死：读取一直挂起，直到调用方 cancel。
                            // 真实 ReadableStream 在 cancel 后会让挂起的 read() 以 done 结束，
                            // 这里必须照做，否则测不出无数据超时的真实行为。
                            return new Promise((resolve) => {
                                pendingResolve = resolve;
                            });
                        }
                        if (i >= chunks.length) return { done: true, value: undefined };
                        const value = encoder.encode(chunks[i++]);
                        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
                        return { done: false, value };
                    },
                    cancel() {
                        cancelled = true;
                        i = chunks.length;
                        if (pendingResolve) {
                            pendingResolve({ done: true, value: undefined });
                            pendingResolve = null;
                        }
                    },
                };
            },
        },
    };
}

describe('extractStreamDelta - OpenAI 兼容格式', () => {
    it('读取 choices[0].delta.content', () => {
        const d = APICaller.extractStreamDelta({ choices: [{ delta: { content: '你好' } }] });
        expect(d).toBe('你好');
    });

    it('delta 为空时返回空串', () => {
        expect(APICaller.extractStreamDelta({ choices: [{ delta: {} }] })).toBe('');
    });

    it('兼容非增量的 message.content', () => {
        const d = APICaller.extractStreamDelta({ choices: [{ message: { content: '整段' } }] });
        expect(d).toBe('整段');
    });
});

describe('extractStreamDelta - Anthropic 格式', () => {
    it('读取 content_block_delta 的 delta.text', () => {
        const d = APICaller.extractStreamDelta({ type: 'content_block_delta', delta: { text: '克劳德' } });
        expect(d).toBe('克劳德');
    });

    it('读取 content_block_start 的初始文本', () => {
        const d = APICaller.extractStreamDelta({ type: 'content_block_start', content_block: { text: '开头' } });
        expect(d).toBe('开头');
    });

    it('message_start 等控制事件不产生文本', () => {
        expect(APICaller.extractStreamDelta({ type: 'message_start', message: {} })).toBe('');
        expect(APICaller.extractStreamDelta({ type: 'message_stop' })).toBe('');
        expect(APICaller.extractStreamDelta({ type: 'ping' })).toBe('');
    });
});

describe('extractStreamDelta - Gemini 格式', () => {
    it('读取 candidates[0].content.parts 的文本', () => {
        const d = APICaller.extractStreamDelta({
            candidates: [{ content: { parts: [{ text: '双子' }] } }],
        });
        expect(d).toBe('双子');
    });

    it('多个 part 拼接', () => {
        const d = APICaller.extractStreamDelta({
            candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }],
        });
        expect(d).toBe('AB');
    });

    it('parts 里混有非文本项时安全跳过', () => {
        const d = APICaller.extractStreamDelta({
            candidates: [{ content: { parts: [{ inlineData: {} }, { text: 'C' }] } }],
        });
        expect(d).toBe('C');
    });
});

describe('extractStreamDelta - 异常输入', () => {
    it('null / undefined / 非对象返回空串', () => {
        expect(APICaller.extractStreamDelta(null)).toBe('');
        expect(APICaller.extractStreamDelta(undefined)).toBe('');
        expect(APICaller.extractStreamDelta('字符串')).toBe('');
    });

    it('空对象返回空串', () => {
        expect(APICaller.extractStreamDelta({})).toBe('');
    });
});

describe('extractStreamError', () => {
    it('识别 Anthropic 的 error 事件', () => {
        const e = APICaller.extractStreamError({ type: 'error', error: { message: '额度不足' } });
        expect(e).toBe('额度不足');
    });

    it('识别通用 error 字段', () => {
        expect(APICaller.extractStreamError({ error: { message: '密钥无效' } })).toBe('密钥无效');
    });

    it('识别 Gemini 的安全拦截', () => {
        const e = APICaller.extractStreamError({ promptFeedback: { blockReason: 'SAFETY' } });
        expect(e).toContain('SAFETY');
    });

    it('正常负载返回 null', () => {
        expect(APICaller.extractStreamError({ choices: [{ delta: { content: 'ok' } }] })).toBeNull();
    });
});

describe('parseSSEStream - 拼接与回调', () => {
    it('拼接 OpenAI 流式分片', async () => {
        const res = makeStreamResponse([
            'data: {"choices":[{"delta":{"content":"第一"}}]}\n',
            'data: {"choices":[{"delta":{"content":"第二"}}]}\n',
            'data: [DONE]\n',
        ]);
        const out = await APICaller.parseSSEStream(res, {});
        expect(out).toBe('第一第二');
    });

    it('跨分片截断的 JSON 能正确重组', async () => {
        const res = makeStreamResponse([
            'data: {"choices":[{"delta":{"con',
            'tent":"跨片"}}]}\n',
            'data: [DONE]\n',
        ]);
        const out = await APICaller.parseSSEStream(res, {});
        expect(out).toBe('跨片');
    });

    it('onChunk 按到达顺序收到增量', async () => {
        const res = makeStreamResponse([
            'data: {"choices":[{"delta":{"content":"甲"}}]}\n',
            'data: {"choices":[{"delta":{"content":"乙"}}]}\n',
        ]);
        const seen = [];
        const out = await APICaller.parseSSEStream(res, { onChunk: (d) => seen.push(d) });
        expect(seen).toEqual(['甲', '乙']);
        expect(out).toBe('甲乙');
    });

    it('onChunk 抛异常不中断读流', async () => {
        const res = makeStreamResponse([
            'data: {"choices":[{"delta":{"content":"A"}}]}\n',
            'data: {"choices":[{"delta":{"content":"B"}}]}\n',
        ]);
        const out = await APICaller.parseSSEStream(res, {
            onChunk: () => {
                throw new Error('界面炸了');
            },
        });
        expect(out).toBe('AB');
    });

    it('忽略 SSE 注释行和 event: 行', async () => {
        const res = makeStreamResponse([
            ': ping\n',
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","delta":{"text":"有效"}}\n',
        ]);
        const out = await APICaller.parseSSEStream(res, {});
        expect(out).toBe('有效');
    });

    it('非 JSON 的 data 行被跳过而不是抛错', async () => {
        const res = makeStreamResponse([
            'data: 这不是JSON\n',
            'data: {"choices":[{"delta":{"content":"正常"}}]}\n',
        ]);
        const out = await APICaller.parseSSEStream(res, {});
        expect(out).toBe('正常');
    });

    it('缓冲区末尾残留的一行也会被处理', async () => {
        const res = makeStreamResponse(['data: {"choices":[{"delta":{"content":"末尾"}}]}']);
        const out = await APICaller.parseSSEStream(res, {});
        expect(out).toBe('末尾');
    });
});

describe('parseSSEStream - 三家真实报文', () => {
    it('Anthropic 完整事件序列', async () => {
        const res = makeStreamResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"x"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"书"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
        expect(await APICaller.parseSSEStream(res, {})).toBe('世界书');
    });

    it('Gemini streamGenerateContent SSE', async () => {
        const res = makeStreamResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"角色"}],"role":"model"}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"设定"}],"role":"model"}}]}\n\n',
        ]);
        expect(await APICaller.parseSSEStream(res, {})).toBe('角色设定');
    });
});

describe('parseSSEStream - 超时与错误', () => {
    it('长时间无数据抛出可重试的超时错误', async () => {
        const res = makeStreamResponse(['data: {"choices":[{"delta":{"content":"开头"}}]}\n'], { stall: true });
        let err = null;
        try {
            await APICaller.parseSSEStream(res, { inactivityTimeout: 120 });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(RetryableError);
        expect(err.message).toContain('没有收到新数据');
    });

    it('持续有数据时不会因为总耗时长而超时', async () => {
        // 6 个分片 × 60ms = 360ms 总时长，远超 150ms 的无数据超时阈值，
        // 但因为一直在传数据，不应该被中断。
        const chunks = [];
        for (let i = 0; i < 6; i++) {
            chunks.push(`data: {"choices":[{"delta":{"content":"${i}"}}]}\n`);
        }
        const res = makeStreamResponse(chunks, { delay: 60 });
        const out = await APICaller.parseSSEStream(res, { inactivityTimeout: 150 });
        expect(out).toBe('012345');
    });

    it('服务端错误且没有任何内容时抛出可重试错误', async () => {
        const res = makeStreamResponse(['data: {"type":"error","error":{"message":"过载"}}\n']);
        let err = null;
        try {
            await APICaller.parseSSEStream(res, {});
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(RetryableError);
        expect(err.message).toContain('过载');
    });

    it('已经收到内容后出现错误事件时保留内容不抛错', async () => {
        const res = makeStreamResponse([
            'data: {"choices":[{"delta":{"content":"已生成"}}]}\n',
            'data: {"error":{"message":"中途断了"}}\n',
        ]);
        expect(await APICaller.parseSSEStream(res, {})).toBe('已生成');
    });

    it('没有 body 时抛错', async () => {
        let err = null;
        try {
            await APICaller.parseSSEStream({ ok: true }, {});
        } catch (e) {
            err = e;
        }
        expect(err).toBeTruthy();
        expect(err.message).toContain('流式响应不可用');
    });
});

describe('错误分类', () => {
    it('429 / 503 判定为可重试', () => {
        expect(APICaller.isRetryableError({ status: 429 })).toBe(true);
        expect(APICaller.isRetryableError({ status: 503 })).toBe(true);
    });

    it('关键词匹配可重试错误', () => {
        expect(APICaller.isRetryableError(new Error('server overloaded'))).toBe(true);
        expect(APICaller.isRetryableError(new Error('ECONNRESET'))).toBe(true);
    });

    it('普通业务错误不可重试', () => {
        expect(APICaller.isRetryableError(new Error('模型名称不存在'))).toBe(false);
    });

    it('RetryableError 与 FatalError 可正确区分', () => {
        expect(new RetryableError('x') instanceof RetryableError).toBe(true);
        expect(new FatalError('y') instanceof FatalError).toBe(true);
    });
});

describe('withRetry', () => {
    it('可重试错误会按次数重试后成功', async () => {
        let n = 0;
        const task = vi.fn(async () => {
            n++;
            if (n < 3) throw new RetryableError('overloaded');
            return 'ok';
        });
        const out = await APICaller.withRetry(task, {
            retries: 3,
            shouldRetry: () => true,
            onRetry: async () => {},
        });
        expect(out).toBe('ok');
        expect(n).toBe(3);
    });

    it('超过重试次数后抛出最后一个错误', async () => {
        const task = vi.fn(async () => {
            throw new Error('一直失败');
        });
        let err = null;
        try {
            await APICaller.withRetry(task, { retries: 1, shouldRetry: () => true, onRetry: async () => {} });
        } catch (e) {
            err = e;
        }
        expect(err.message).toBe('一直失败');
        expect(task).toHaveBeenCalledTimes(2);
    });

    it('不可重试的错误立即抛出', async () => {
        const task = vi.fn(async () => {
            throw new Error('致命');
        });
        try {
            await APICaller.withRetry(task, { retries: 3, shouldRetry: () => false });
        } catch (e) {
            /* 预期抛错 */
        }
        expect(task).toHaveBeenCalledTimes(1);
    });
});
