import assert from 'node:assert/strict';
import test from 'node:test';
import { searchDirectory, type DirectoryRequest } from '../../packages/feishu-channel/src/directory.ts';
const signal = () => new AbortController().signal;
const ok = (data: unknown) => ({ code: 0, data });
test('directory searches app-visible roots, nested departments and pages, deduplicating shared membership', async () => {
  const calls: string[] = [];
  const request: DirectoryRequest = async (url, params) => {
    calls.push(url);
    if (url.endsWith('/scopes')) return ok({ department_ids: ['root'], user_ids: ['direct'] });
    if (url.endsWith('/users/direct')) return ok({ user: { name: '张三', open_id: 'direct' } });
    if (url.endsWith('/root/children')) return ok({ items: [{ open_department_id: 'child' }], has_more: false });
    assert.ok(url.endsWith('/find_by_department'));
    if (params.department_id === 'root' && !params.page_token) return ok({ items: [{ name: '张三', open_id: 'a' }], has_more: true, page_token: 'next' });
    if (params.department_id === 'root') return ok({ items: [{ name: '张三', open_id: 'b' }], has_more: false });
    return ok({ items: [{ name: '张三', open_id: 'a' }], has_more: false });
  };
  const result = await searchDirectory(request, '张三', signal());
  assert.equal(result.complete, true); assert.deepEqual(result.users.map(u => u.openId).sort(), ['a', 'b', 'direct']); assert.equal(calls.length, 6);
});
test('root traversal works when scope introspection is denied; actual root denial remains incomplete', async () => {
  for (const rootAllowed of [true, false]) {
    const result = await searchDirectory(async url => {
      if (url.endsWith('/scopes')) return { code: 99991672 };
      if (!rootAllowed) return { code: 99991672 };
      if (url.endsWith('/children')) return ok({ items: [], has_more: false });
      return ok({ items: [{ name: '张三', open_id: 'a' }], has_more: false });
    }, '张三', signal());
    assert.equal(result.complete, rootAllowed);
    assert.equal(result.users.length, rootAllowed ? 1 : 0);
  }
});
test('unexpanded groups, missing names and repeated pagination tokens never claim unique complete results', async () => {
  for (const defect of ['group', 'missing-name', 'pagination']) {
    const result = await searchDirectory(async url => {
      if (url.endsWith('/scopes')) return ok({ department_ids: ['0'], ...(defect === 'group' ? { group_ids: ['g'] } : {}) });
      if (url.endsWith('/children')) return ok({ items: [], has_more: false });
      return ok({ items: defect === 'missing-name' ? [{ open_id: 'a' }] : [{ name: '张三', open_id: 'a' }], has_more: defect === 'pagination', page_token: 'repeated' });
    }, '张三', signal());
    assert.equal(result.complete, false);
  }
});
test('directory cancellation propagates and its request budget stops huge organizations', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(searchDirectory(async () => assert.fail(), '张三', controller.signal), /abort/i);
  let count = 0;
  const result = await searchDirectory(async url => {
    count++;
    if (url.endsWith('/scopes')) return ok({ department_ids: Array.from({ length: 101 }, (_, i) => String(i)) });
    return ok({ items: [], has_more: false });
  }, '张三', signal());
  assert.equal(result.complete, false); assert.equal(result.reason, 'budget_exceeded'); assert.equal(count, 100);
});
