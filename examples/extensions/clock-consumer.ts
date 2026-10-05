import { defineExtension } from '@mira/extension-sdk';
export default defineExtension({
  name: 'clock-consumer', requires: ['example-clock'],
  apply(api) {
    // Capture the injected generation during apply, not a mutable global registry.
    const clock = api.service<{ read(): number }>('example-clock');
    let notifications = 0;
    api.onEvent('example.tick', () => { notifications++; });
    api.registerTool({ name: 'example.clock', description: 'Read the local example clock service and listener counter.', parameters: { type: 'object', additionalProperties: false },
      async execute() { return { text: JSON.stringify({ ticks: clock.read(), notifications }) }; },
    });
  },
});
