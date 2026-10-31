import { defineExtension, type Json } from '@mira/extension-sdk';

function valuesFrom(arguments_: Json): number[] {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    throw new TypeError('Expected an object');
  }
  const values = arguments_['values'];
  if (!Array.isArray(values) || !values.every(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )) throw new TypeError('values must be an array of finite numbers');
  return values;
}

/** Pure local arithmetic. No service, account, filesystem effect, event or Wake. */
export default defineExtension<null>({
  name: 'finite-sum',
  apply(api, config) {
    if (config !== null) throw new TypeError('finite-sum takes no configuration');
    api.registerTool({
      name: 'sum_finite',
      description: 'Sum finite numbers locally. A finite total returns details.ok true. Overflow is a known failure: isError true, details.ok false, and reason numeric-overflow.',
      parameters: {
        type: 'object', properties: { values: { type: 'array', items: { type: 'number' } } },
        required: ['values'], additionalProperties: false,
      },
      async execute(arguments_, { signal }) {
        signal.throwIfAborted();
        const total = valuesFrom(arguments_).reduce((sum, value) => sum + value, 0);
        // Finite inputs do not imply finite arithmetic output. JSON.stringify
        // would silently turn Infinity/NaN into null; check before serialization.
        if (!Number.isFinite(total)) {
          const details = { ok: false, reason: 'numeric-overflow' };
          return { text: JSON.stringify(details), details, isError: true };
        }
        const details = { ok: true, total };
        return { text: JSON.stringify(details), details };
      },
    });
  },
});
