import { Logger } from '../core/logger.js';
import { RetryableError, FatalError } from '../core/errors.js';

const HTTP_RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

const APICaller = {
    /**
     * fetchWithTimeout
     *
     * @param {*} url
     * @param {*} options
     * @param {*} timeout
     * @returns {Promise<any>}
     */
    async fetchWithTimeout(url, options = {}, timeout = 120000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new RetryableError('请求超时', { httpStatus: 408, code: 'TIMEOUT' });
            }
            throw new RetryableError(`网络错误: ${error.message}`, { code: 'NETWORK_ERROR' });
        }
    },

    async request(url, options = {}) {
        const { timeout, onChunk: _onChunk, inactivityTimeout: _it, ...fetchOptions } = options;
        const response = await this.fetchWithTimeout(url, fetchOptions, timeout || 120000);
        if (!response.ok) {
            let text = '';
            try {
                text = await response.text();
            } catch (_e) {}
            const message = `API请求失败: ${response.status} ${response.statusText}${text ? ` - ${text.substring(0, 200)}` : ''}`;
            const ErrorClass = HTTP_RETRYABLE.has(response.status) ? RetryableError : FatalError;
            throw new ErrorClass(message, {
                httpStatus: response.status,
                code: `HTTP_${response.status}`,
            });
        }
        return response;
    },

    /**
     * parseResponse
     *
     * @param {*} response
     * @returns {Promise<any>}
     */
    async parseResponse(response, readTimeout = 0) {
        if (!readTimeout || readTimeout <= 0) return response.text();
        // 响应头已到达但 body 迟迟不来时，fetch 的 AbortController 已被清除，
        // 这里补一道读取超时，防止非流式请求永久挂起。
        let timer = null;
        try {
            return await Promise.race([
                response.text(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        reject(
                            new RetryableError(`读取响应超时 (${Math.round(readTimeout / 1000)}秒)`, {
                                httpStatus: 408,
                                code: 'BODY_READ_TIMEOUT',
                            }),
                        );
                    }, readTimeout);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    },

    /**
     * extractJSON
     *
     * @param {*} text
     * @returns {*}
     */
    extractJSON(text) {
        try {
            return JSON.parse(text);
        } catch (e) {}

        const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            try {
                return JSON.parse(jsonBlockMatch[1].trim());
            } catch (e) {}
        }

        const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
            try {
                return JSON.parse(jsonObjectMatch[0]);
            } catch (e) {}
        }

        throw new Error('无法从响应中提取有效的JSON');
    },

    async requestJSON(url, options = {}) {
        const response = await this.request(url, options);
        const text = await this.parseResponse(response, options.timeout || 120000);
        return this.extractJSON(text);
    },

    async requestText(url, options = {}) {
        const response = await this.request(url, options);
        return this.parseResponse(response, options.timeout || 120000);
    },

    /**
     * 从一个 SSE data 负载中抽取增量文本。
     * 兼容三种格式：
     *   - OpenAI 兼容: choices[0].delta.content
     *   - Anthropic  : content_block_delta -> delta.text
     *   - Gemini     : candidates[0].content.parts[*].text
     *
     * @param {*} parsed 已解析的 JSON 对象
     * @returns {string} 增量文本，无内容时返回空串
     */
    extractStreamDelta(parsed) {
        if (!parsed || typeof parsed !== 'object') return '';

        // --- OpenAI 兼容 ---
        const openaiDelta = parsed.choices?.[0]?.delta?.content;
        if (typeof openaiDelta === 'string' && openaiDelta) return openaiDelta;
        // 少数实现把内容放在 message.content（非增量）
        const openaiMsg = parsed.choices?.[0]?.message?.content;
        if (typeof openaiMsg === 'string' && openaiMsg) return openaiMsg;

        // --- Anthropic ---
        if (parsed.type === 'content_block_delta') {
            const t = parsed.delta?.text;
            if (typeof t === 'string' && t) return t;
        }
        if (parsed.type === 'content_block_start') {
            const t = parsed.content_block?.text;
            if (typeof t === 'string' && t) return t;
        }

        // --- Gemini ---
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
            if (text) return text;
        }

        return '';
    },

    /**
     * 从流式响应负载中检测服务端返回的错误。
     * Anthropic 的 error 事件和 Gemini 的 promptFeedback 拦截都走这里。
     *
     * @param {*} parsed
     * @returns {string|null} 错误信息，无错误返回 null
     */
    extractStreamError(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.type === 'error' && parsed.error) {
            return parsed.error.message || JSON.stringify(parsed.error);
        }
        if (parsed.error) {
            return parsed.error.message || JSON.stringify(parsed.error);
        }
        const blockReason = parsed.promptFeedback?.blockReason;
        if (blockReason) {
            return `内容被安全策略拦截 (${blockReason})`;
        }
        return null;
    },

    async parseSSEStream(response, config = {}) {
        const { onChunk = null, inactivityTimeout = 120000 } = config;
        if (!response.body) {
            throw new Error('流式响应不可用');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';
        let inactivityTimer = null;
        let timedOut = false;
        let streamError = null;

        const resetInactivityTimer = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => {
                timedOut = true;
                try {
                    reader.cancel();
                } catch (e) {}
            }, inactivityTimeout);
        };

        const consumeLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) return;
            // 只关心 data: 行，event:/id:/retry: 等字段忽略
            if (!trimmed.startsWith('data:')) return;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') return;
            let parsed;
            try {
                parsed = JSON.parse(dataStr);
            } catch (e) {
                return;
            }
            const err = this.extractStreamError(parsed);
            if (err && !streamError) streamError = err;
            const delta = this.extractStreamDelta(parsed);
            if (delta) {
                fullContent += delta;
                if (typeof onChunk === 'function') {
                    try {
                        onChunk(delta, fullContent, parsed);
                    } catch (e) {
                        // 界面回调失败不应中断读流
                    }
                }
            }
        };

        resetInactivityTimer();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                resetInactivityTimer();
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    consumeLine(line);
                }
            }
        } finally {
            if (inactivityTimer) clearTimeout(inactivityTimer);
        }

        if (buffer.trim()) {
            consumeLine(buffer);
        }

        // 超过 inactivityTimeout 没有收到任何新数据 -> 视为超时，可重试
        if (timedOut) {
            throw new RetryableError(
                `流式响应中断：${Math.round(inactivityTimeout / 1000)}秒内没有收到新数据`,
                { httpStatus: 408, code: 'STREAM_INACTIVITY_TIMEOUT' },
            );
        }
        if (streamError && !fullContent) {
            throw new RetryableError(`流式响应错误: ${streamError}`, { code: 'STREAM_ERROR' });
        }

        return fullContent;
    },

    async requestStream(url, options = {}) {
        const { onChunk = null, inactivityTimeout = 120000, ...requestOptions } = options;
        const response = await this.request(url, requestOptions);
        return this.parseSSEStream(response, { onChunk, inactivityTimeout });
    },

    isRateLimitError(error) {
        const message = String(error?.responseText || error?.message || '').toLowerCase();
        return error?.status === 429 || message.includes('resource_exhausted') || message.includes('rate limit');
    },

    isRetryableError(error) {
        const status = error?.status;
        if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) return true;
        const message = String(error?.responseText || error?.message || '').toLowerCase();
        const patterns = [
            'rate limit',
            'resource_exhausted',
            'overloaded',
            'server error',
            'temporarily unavailable',
            'econnreset',
            'network error',
            'fetch failed',
            'internal server error',
            'bad gateway',
            'service unavailable',
        ];
        return patterns.some((p) => message.includes(p));
    },

    async withRetry(task, config = {}) {
        const { retries = 0, onRetry = null, shouldRetry = null } = config;
        let attempt = 0;
        while (true) {
            try {
                return await task(attempt);
            } catch (error) {
                const canRetry =
                    attempt < retries &&
                    (typeof shouldRetry === 'function' ? shouldRetry(error, attempt) : this.isRateLimitError(error));
                if (!canRetry) throw error;
                const delay = Math.pow(2, attempt) * 1000;
                if (typeof onRetry === 'function') {
                    await onRetry(error, attempt + 1, delay);
                }
                await new Promise((resolve) => setTimeout(resolve, delay));
                attempt += 1;
            }
        }
    },

    /**
     * handleError
     *
     * @param {*} error
     * @param {*} context
     * @returns {*}
     */
    handleError(error, context = '') {
        const prefix = context ? `[${context}] ` : '';
        Logger.error('APICaller', prefix + error.message);

        if (error.message.includes('超时')) {
            return { type: 'timeout', message: '请求超时，请稍后重试' };
        }
        if (error.message.includes('网络') || error.message.includes('fetch')) {
            return { type: 'network', message: '网络错误，请检查连接' };
        }
        if (error.message.includes('API Key')) {
            return { type: 'auth', message: 'API Key 无效或已过期' };
        }

        return { type: 'unknown', message: error.message };
    },

    /**
     * getJSON
     *
     * @param {*} url
     * @param {*} options
     * @returns {Promise<any>}
     */
    async getJSON(url, options = {}) {
        return this.requestJSON(url, options);
    },

    /**
     * getText
     *
     * @param {*} url
     * @param {*} options
     * @returns {Promise<any>}
     */
    async getText(url, options = {}) {
        return this.requestText(url, options);
    },
};

export { APICaller };
