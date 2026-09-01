import { describe, it, expect } from 'vitest';
import {
    UserError,
    RetryableError,
    FatalError,
    AbortedError,
    TokenLimitError,
    isRetryable,
    isUserFacing,
} from '../../txtToWorldbook/core/errors.js';

// ============================================================
// 错误类型构造
// ============================================================
describe('错误类型构造', () => {
    it('UserError 默认属性', () => {
        const err = new UserError('配置错误');
        expect(err.name).toBe('UserError');
        expect(err.message).toBe('配置错误');
        expect(err.userFacing).toBe(true);
        expect(err.retryable).toBe(false);
        expect(err.code).toBe('USER_ERROR');
        expect(err).toBeInstanceOf(Error);
    });

    it('UserError 自定义 code', () => {
        const err = new UserError('缺少 API Key', { code: 'MISSING_API_KEY' });
        expect(err.code).toBe('MISSING_API_KEY');
    });

    it('RetryableError 默认属性', () => {
        const err = new RetryableError('网络错误');
        expect(err.name).toBe('RetryableError');
        expect(err.retryable).toBe(true);
        expect(err.userFacing).toBe(false);
        expect(err.httpStatus).toBeUndefined();
    });

    it('RetryableError 携带 HTTP 状态码', () => {
        const err = new RetryableError('限流', { httpStatus: 429, retryCount: 2 });
        expect(err.httpStatus).toBe(429);
        expect(err.retryCount).toBe(2);
    });

    it('FatalError 默认属性', () => {
        const err = new FatalError('数据库损坏');
        expect(err.name).toBe('FatalError');
        expect(err.userFacing).toBe(true);
        expect(err.retryable).toBe(false);
    });

    it('FatalError 携带 cause', () => {
        const cause = new Error('IO Failure');
        const err = new FatalError('数据库损坏', { cause });
        expect(err.cause).toBe(cause);
    });

    it('AbortedError 默认消息', () => {
        const err = new AbortedError();
        expect(err.message).toBe('用户中止操作');
        expect(err.code).toBe('ABORTED');
        expect(err.userFacing).toBe(false);
    });

    it('TokenLimitError 继承 RetryableError', () => {
        const err = new TokenLimitError('超过限制');
        expect(err).toBeInstanceOf(RetryableError);
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('TokenLimitError');
        expect(err.retryable).toBe(true);
    });

    it('TokenLimitError 携带 memoryIndex', () => {
        const err = new TokenLimitError('Token 超限', { memoryIndex: 5 });
        expect(err.memoryIndex).toBe(5);
        expect(err.code).toBe('TOKEN_LIMIT');
    });
});

// ============================================================
// 错误分类工具
// ============================================================
describe('isRetryable', () => {
    it('RetryableError 返回 true', () => {
        expect(isRetryable(new RetryableError('test'))).toBe(true);
    });

    it('UserError 返回 false', () => {
        expect(isRetryable(new UserError('test'))).toBe(false);
    });

    it('FatalError 返回 false', () => {
        expect(isRetryable(new FatalError('test'))).toBe(false);
    });

    it('AbortedError 返回 false', () => {
        expect(isRetryable(new AbortedError())).toBe(false);
    });

    it('TokenLimitError 返回 true (继承 RetryableError)', () => {
        expect(isRetryable(new TokenLimitError())).toBe(true);
    });

    it('普通 Error 默认返回 false', () => {
        expect(isRetryable(new Error('generic'))).toBe(false);
    });

    it('兼容旧式 TOKEN_LIMIT: 字符串约定', () => {
        expect(isRetryable(new Error('TOKEN_LIMIT:0'))).toBe(true);
    });

    it('兼容旧式 ABORTED 字符串约定', () => {
        expect(isRetryable(new Error('ABORTED'))).toBe(false);
    });

    it('HTTP 状态码匹配', () => {
        const err = new Error('rate limit');
        err.httpStatus = 429;
        expect(isRetryable(err)).toBe(true);
    });

    it('null/undefined 返回 false', () => {
        expect(isRetryable(null)).toBe(false);
        expect(isRetryable(undefined)).toBe(false);
    });
});

describe('isUserFacing', () => {
    it('UserError 返回 true', () => {
        expect(isUserFacing(new UserError('配置问题'))).toBe(true);
    });

    it('FatalError 返回 true', () => {
        expect(isUserFacing(new FatalError('严重问题'))).toBe(true);
    });

    it('RetryableError 返回 false', () => {
        expect(isUserFacing(new RetryableError('网络问题'))).toBe(false);
    });

    it('AbortedError 返回 false', () => {
        expect(isUserFacing(new AbortedError())).toBe(false);
    });

    it('普通错误默认返回 false', () => {
        expect(isUserFacing(new Error('generic'))).toBe(false);
    });

    it('null/undefined 返回 false', () => {
        expect(isUserFacing(null)).toBe(false);
        expect(isUserFacing(undefined)).toBe(false);
    });
});
