import { defineExtension, type Json } from '@mira/extension-sdk';
import { FeishuChannel } from './channel.ts';
import { createFeishuSdk, type FeishuSdk } from './sdk.ts';

/** Ordinary trusted Cordis extension. No server imports, vendor routes or global singleton. */
export function createFeishuExtension(sdk: FeishuSdk = createFeishuSdk()) {
  return defineExtension({ name: 'mira-feishu-channel', async apply(context, config: Json) {
    const channel = new FeishuChannel(context, config, sdk);
    context.onCleanup(() => channel.close());
    channel.register();
    await channel.initialize();
  } });
}
export default createFeishuExtension();
