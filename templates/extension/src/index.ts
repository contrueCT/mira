import { defineExtension } from '@mira/extension-sdk';

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export default defineExtension({
  name: 'hello-world',
  apply(context) {
    context.registerTool({
      name: 'hello_world',
      description: 'Return a local greeting without external services',
      parameters: {
        type: 'object', properties: { name: { type: 'string' } },
        required: ['name'], additionalProperties: false,
      },
      async execute(arguments_) {
        if (arguments_ === null || Array.isArray(arguments_) || typeof arguments_ !== 'object' || typeof arguments_['name'] !== 'string') {
          throw new TypeError('name must be a string');
        }
        return { text: greet(arguments_['name']) };
      },
    });
  },
});
