import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, errorInfo, errorText } from '../src/api.ts';

test('network failures get a readable summary while keeping the browser message', () => {
  // Regression: the Chinese interface showed only the raw "Failed to fetch".
  assert.deepEqual(errorInfo(new TypeError('Failed to fetch')), { summary: '网络连接中断，暂时无法连接本地服务', detail: 'Failed to fetch' });
  assert.equal(errorText(new TypeError('Failed to fetch')), '网络连接中断，暂时无法连接本地服务（Failed to fetch）');
});

test('HTTP errors keep the status and server text as technical detail', () => {
  assert.deepEqual(errorInfo(new ApiError('Internal Server Error', 500)), { summary: '本地服务出错了，请稍后重试', detail: 'HTTP 500 · Internal Server Error' });
  assert.deepEqual(errorInfo(new ApiError('Request body is too large', 413)), { summary: '内容超过大小上限', detail: 'HTTP 413 · Request body is too large' });
  assert.deepEqual(errorInfo(new ApiError('', 502)), { summary: '本地服务出错了，请稍后重试', detail: 'HTTP 502' });
  assert.deepEqual(errorInfo(new ApiError('teapot', 418)), { summary: '请求未完成', detail: 'HTTP 418 · teapot' });
});

test('messages already written for readers are shown as they are', () => {
  assert.deepEqual(errorInfo(new ApiError('设置已被其他窗口修改', 409)), { summary: '设置已被其他窗口修改', detail: 'HTTP 409' });
  assert.deepEqual(errorInfo(new Error('请先填写此连接的 API Key')), { summary: '请先填写此连接的 API Key', detail: null });
  assert.deepEqual(errorInfo(new Error('unexpected token')), { summary: '操作未完成', detail: 'unexpected token' });
  assert.deepEqual(errorInfo('weird'), { summary: '暂时无法连接本地服务', detail: null });
});
