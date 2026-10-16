import type { jsonSchemaValidator } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator, addFormats } from '@modelcontextprotocol/client/validators/ajv';
import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

// Match the pinned SDK's dialect dispatch and validation options, but never
// allow server-controlled schema diagnostics to escape through Ajv's logger.
// Its public customization API accepts structurally compatible Ajv engines.
export function createOutputSchemaValidator(): jsonSchemaValidator {
  const validators = new Map<string, { provider: AjvJsonSchemaValidator; clear(): void }>();
  return {
    getValidator<T>(schema: Parameters<jsonSchemaValidator['getValidator']>[0]) {
      if (schema.$schema !== undefined && typeof schema.$schema !== 'string') throw new Error('Unsupported MCP output schema dialect');
      const declared = schema.$schema?.replace(/#$/, '');
      let dialect: '2020-12' | '2019-09' | 'draft-7';
      if (declared === undefined || /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema$/.test(declared)) dialect = '2020-12';
      else if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema$/.test(declared)) dialect = '2019-09';
      else if (/^https?:\/\/json-schema\.org\/draft-0[67]\/schema$/.test(declared)) dialect = 'draft-7';
      else throw new Error('Unsupported MCP output schema dialect');
      let validator = validators.get(dialect);
      if (!validator) {
        const Engine = dialect === '2020-12' ? Ajv2020 : dialect === '2019-09' ? Ajv2019 : Ajv;
        const engine = new Engine({ strict: false, validateFormats: true, validateSchema: false, allErrors: true, logger: false, addUsedSchema: false });
        addFormats(engine);
        validator = { provider: new AjvJsonSchemaValidator(engine), clear: () => { engine.removeSchema(); } };
        validators.set(dialect, validator);
      }
      try { return validator.provider.getValidator<T>(schema); }
      finally { validator.clear(); } // Old compiled closures remain valid; revisions do not accumulate.
    },
  };
}
