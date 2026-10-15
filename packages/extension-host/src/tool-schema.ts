import { Ajv, type AnySchemaObject } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Compile } from 'typebox/compile';
import type { TSchema } from 'typebox';
import type { ExtensionTool } from '@mira/extension-sdk';

// Pure synchronous validation: no remote schema loader, logs or argument
// coercion. Unknown formats remain annotations, as in the existing tool engine.
const options = { strict: false, validateFormats: false, logger: false as const, addUsedSchema: false };
const dialects = new Map([
  ['http://json-schema.org/draft-07/schema', new Ajv(options)],
  ['https://json-schema.org/draft/2019-09/schema', new Ajv2019(options)],
  ['https://json-schema.org/draft/2020-12/schema', new Ajv2020(options)],
]);
export function validateToolSchema(schema: ExtensionTool['parameters']): void {
  const dialect = schema['$schema'] ?? 'https://json-schema.org/draft/2020-12/schema';
  const validator = typeof dialect === 'string' ? dialects.get(dialect.replace(/#$/u, '')) : undefined;
  if (!validator) throw new Error('Unsupported extension tool schema dialect');
  try {
    validator.compile(schema as AnySchemaObject);
    // Match the already pinned runtime tool compiler without importing Pi.
    // A valid schema must also be usable by the actual execution engine.
    Compile(schema as TSchema);
  } catch { throw new Error('Invalid or unsupported extension tool schema'); }
  finally { validator.removeSchema(); } // Never retain an unbounded revision cache.
}
