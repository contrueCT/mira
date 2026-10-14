import assert from 'node:assert/strict';
import test from 'node:test';
import { defineExtension, type ExtensionContext, type ExtensionDefinition, type Json } from '@mira/extension-sdk';

const unavailable = (): never => { throw Error('Unexpected resource use'); };
const context: ExtensionContext = {
    schedules: { create: unavailable, get: unavailable, list: unavailable, replace: unavailable, cancel: unavailable },
  id: 'configuration-boundary-test', registerTool: unavailable, registerContextProvider: unavailable, emitEvent: unavailable,
  requestWake: unavailable, provideService: unavailable, service: unavailable,
  onCleanup: unavailable, onEvent: unavailable, publish: unavailable, interval: unavailable,
};
type Config = { prefix: string };

for (const asynchronous of [false, true]) test(`host apply accepts raw Json and preserves ${asynchronous ? 'async' : 'sync'} author config validation`, async () => {
  const seen: Config[] = [];
  const validate = (config: Config): void => {
    if (!config || typeof config.prefix !== 'string') throw TypeError('prefix must be a string');
    seen.push(config);
  };
  const definition: ExtensionDefinition<Config> = {
    name: 'configurable', apply: asynchronous ? async (_context, config) => { await Promise.resolve(); validate(config); }
      : (_context, config) => { validate(config); },
  };
  const extension = defineExtension(definition);
  type HostConfig = Parameters<typeof extension.apply>[1];
  const valid: HostConfig = { prefix: 'Hello' };
  await extension.apply({ mira: context }, valid);
  assert.deepEqual(seen, [{ prefix: 'Hello' }]);
  for (const invalid of [null, { prefix: 42 }, [], 'unexpected'] satisfies Json[]) {
    await assert.rejects(async () => { await extension.apply({ mira: context }, invalid); }, /prefix must be a string/);
  }
  assert.deepEqual(seen, [{ prefix: 'Hello' }], 'invalid input did not pass validation');
  if (false) {
    // @ts-expect-error Author callback remains Config-typed, not widened to Json.
    definition.apply(context, { prefix: 42 });
    // @ts-expect-error Host input is JSON, not arbitrary values or functions.
    extension.apply({ mira: context }, () => 'not JSON');
  }
});
