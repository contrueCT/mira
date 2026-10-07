import { registerHooks } from 'node:module';

// Run the actual CLI argument/env/path/configuration code, replacing only its
// database-backed service and HTTP listener. This is an offline wiring probe,
// not evidence that PostgreSQL or the listener works.
const cli = new URL('../../../apps/server/src/web-cli.mts', import.meta.url).href;
const modules = {
  './web-service.ts': `
    import { writeFile } from 'node:fs/promises';
    export class LocalWebService {
      static async open(options) {
        if (!process.env.MIRA_TEST_CLI_CAPTURE) throw Error('Missing capture file');
        await writeFile(process.env.MIRA_TEST_CLI_CAPTURE, JSON.stringify(options));
        return { close: async () => {} };
      }
    }
  `,
  './http.ts': `
    export function createLocalHttp() {
      return {
        listen: async ({ host, port }) => 'http://' + host + ':' + port,
        close: async () => {},
      };
    }
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === cli && Object.hasOwn(modules, specifier)) {
      return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
