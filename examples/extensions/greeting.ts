import { defineExtension } from '@mira/extension-sdk';
export default defineExtension({
  name: 'greeting',
  apply(api) {
    api.registerTool({ name: 'example_greet', description: 'Return a local greeting. No network or external side effects.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      async execute(args) {
        const name = args && typeof args === 'object' && !Array.isArray(args) ? args['name'] : undefined;
        return { text: `Hello, ${String(name)}` };
      },
    });
  },
});
