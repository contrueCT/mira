import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { checkBoundaries, importsFrom } from '../../scripts/check-boundaries.mts';

test('the repository obeys its declared boundaries', async () => {
  assert.deepEqual(await checkBoundaries(process.cwd()), []);
});

test('AST parsing covers imports, reexports, dynamic imports, and import types', () => {
  const result = importsFrom(`import type { A } from '@mira/context'; export { b } from '@mira/life'; const c = import('@mira/cognition'); type D = import('@mira/authorization').D;`, 'example.ts');
  assert.deepEqual(result.imports, ['@mira/context', '@mira/life', '@mira/cognition', '@mira/authorization']);
  assert.deepEqual(result.errors, []);
});

test('computed dynamic imports and require are rejected', () => {
  assert.equal(importsFrom('import(name); require("something")', 'example.ts').errors.length, 2);
});

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-boundaries-'));
  try {
    for (const dir of ['apps', 'packages', 'scripts']) await cp(path.join(process.cwd(), dir), path.join(root, dir), { recursive: true, filter: (source) => !['node_modules', 'dist', '.git'].includes(path.basename(source)) });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('rejects framework, internal subpath, relative escape, and undeclared imports', async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, 'packages/life/src'), { recursive: true });
    await writeFile(path.join(root, 'packages/life/src/bad.ts'), `import 'fastify'; export * from '@mira/context/private'; import '../../runtime-pi/private.js'; import 'node:fs';`);
    const errors = await checkBoundaries(root);
    for (const expected of ['external import not allowed fastify', 'non-public import @mira/context/private', 'cross-package relative import', 'platform-independent package']) assert.ok(errors.some((error) => error.includes(expected)), expected);
  });
});

test('rejects manifest-only dependency violations', async () => {
  await fixture(async (root) => {
    const file = path.join(root, 'packages/context/package.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.dependencies = { '@mira/runtime-pi': 'workspace:*', pg: '1.0.0' };
    await writeFile(file, JSON.stringify(manifest));
    const errors = await checkBoundaries(root);
    assert.ok(errors.some((error) => error.includes('forbidden dependency @mira/runtime-pi')));
    assert.ok(errors.some((error) => error.includes('external dependency not allowed: pg')));
  });
});

test('rejects packages omitted from the policy', async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, 'packages/rogue'));
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('package missing boundary policy')));
  });
});

test('accepts only an explicitly declared public workspace import', async () => {
  await fixture(async (root) => {
    const policyPath = path.join(root, 'scripts/boundaries.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy['@mira/life'].allow = ['@mira/context', '@mira/cognition'];
    await writeFile(policyPath, JSON.stringify(policy));
    const lifePath = path.join(root, 'packages/life/package.json');
    const life = JSON.parse(await readFile(lifePath, 'utf8'));
    life.dependencies = { '@mira/context': 'workspace:*', '@mira/cognition': 'workspace:*' };
    await writeFile(lifePath, JSON.stringify(life));
    const contextPath = path.join(root, 'packages/context/package.json');
    const context = JSON.parse(await readFile(contextPath, 'utf8'));
    context.exports = { '.': './src/index.ts' };
    await writeFile(contextPath, JSON.stringify(context));
    await mkdir(path.join(root, 'packages/context/src'), { recursive: true });
    await writeFile(path.join(root, 'packages/context/src/index.ts'), 'export const example = 1;');
    await writeFile(path.join(root, 'packages/life/example.ts'), "import { example } from '@mira/context';");
    assert.deepEqual(await checkBoundaries(root), []);
    context.exports = { '.': { types: './src/index.ts', import: './src/index.ts' } };
    await writeFile(contextPath, JSON.stringify(context));
    assert.deepEqual(await checkBoundaries(root), []);
    context.exports = { '.': null };
    await writeFile(contextPath, JSON.stringify(context));
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('non-public import @mira/context')));
    context.exports = { '.': { types: './src/index.ts', import: null } };
    await writeFile(contextPath, JSON.stringify(context));
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('non-public import @mira/context')));
    context.exports = { './*': '../life/*' };
    await writeFile(contextPath, JSON.stringify(context));
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('export target escapes')));
  });
});

test('resolves encoded ESM paths before containment and rejects excluded trees', async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, 'packages/life/example.mts'), `import './%2e%2e/context/private.mjs'; import './dist/hidden.mjs'; import './node_modules/hidden/index.js'; import './%2fdist/hidden.mjs';`);
    const errors = await checkBoundaries(root);
    assert.ok(errors.some((error) => error.includes('cross-package relative import ./%2e%2e')));
    assert.equal(errors.filter((error) => error.includes('import enters excluded tree')).length, 2);
    assert.ok(errors.some((error) => error.includes('invalid local module URL')));
  });
});

test('path references resolve locally without a dot prefix', async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, 'packages/life/types.d.ts'), 'interface LocalType { value: string }');
    await writeFile(path.join(root, 'packages/life/example.ts'), '/// <reference path="types.d.ts" />\nconst value: LocalType = { value: "ok" };');
    assert.deepEqual(await checkBoundaries(root), []);
    await writeFile(path.join(root, 'packages/life/example.ts'), '/// <reference path="../context/private.d.ts" />');
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('cross-package relative import')));
  });
});

test('rejects unsupported JavaScript/JSDoc and CommonJS source formats', async () => {
  await fixture(async (root) => {
    for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'cts']) await writeFile(path.join(root, `packages/life/example.${extension}`), '/** @import { Hidden } from "../context/private.js" */');
    assert.equal((await checkBoundaries(root)).filter((error) => error.includes('only TypeScript ESM source')).length, 5);
  });
});

test('strict configuration includes workspace mts and tsx files', async () => {
  await fixture(async (root) => {
    const files = ['packages/life/wrong.mts', 'apps/web/wrong.tsx'];
    for (const file of files) await writeFile(path.join(root, file), 'const definitelyWrong: number = "text";');
    const config = JSON.parse(await readFile(path.join(process.cwd(), 'tsconfig.json'), 'utf8'));
    const web = JSON.parse(await readFile(path.join(process.cwd(), 'tsconfig.web.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    assert.match(manifest.scripts.typecheck, /tsconfig\.web\.json/);
    for (const file of files) {
      const selected = file.startsWith('apps/web/') ? { ...config, ...web, extends: undefined, compilerOptions: { ...config.compilerOptions, ...web.compilerOptions } } : config;
      const parsed = ts.parseJsonConfigFileContent(selected, ts.sys, root);
      const program = ts.createProgram(parsed.fileNames, { ...parsed.options, types: [] });
      const absolute = path.join(root, file);
      assert.ok(parsed.fileNames.includes(absolute), `${file} must enter typecheck`);
      assert.ok(program.getSemanticDiagnostics(program.getSourceFile(absolute)).some((diagnostic) => diagnostic.code === 2322), `${file} must reject type mismatch`);
    }
  });
});

test('external-module augmentations obey dependency and private-path boundaries', async () => {
  await fixture(async (root) => {
    const manifestPath = path.join(root, 'packages/life/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.dependencies['@mira/context'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(path.join(root, 'packages/life/example.ts'), `export {}; declare module '../context/private.js' { interface Target { forbidden: string } } declare module '@mira/context/private' { interface Hidden {} }`);
    const errors = await checkBoundaries(root);
    assert.ok(errors.some((error) => error.includes('cross-package relative import')));
    assert.ok(errors.some((error) => error.includes('undeclared dependency @mira/context')));
    assert.ok(errors.some((error) => error.includes('non-public import @mira/context/private')));
  });
});

test('type-reference directives use declared type packages instead of runtime names', async () => {
  await fixture(async (root) => {
    const manifestPath = path.join(root, 'apps/server/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.devDependencies = { '@types/node': '24.19.1', '@types/example__scoped': '1.0.0', 'bundled-types': '1.0.0' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const policyPath = path.join(root, 'scripts/boundaries.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy['@mira/server'].external.push('@types/node', '@types/example__scoped', 'bundled-types');
    await writeFile(policyPath, JSON.stringify(policy));
    await writeFile(path.join(root, 'apps/server/example.ts'), '/// <reference types="node" />\n/// <reference types="node/child_process" />\n/// <reference types="@example/scoped" />\n/// <reference types="@example/scoped/subpath" />\n/// <reference types="bundled-types/subpath" />');
    assert.deepEqual(await checkBoundaries(root), []);
    await writeFile(path.join(root, 'packages/life/example.ts'), '/// <reference types="node" />');
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('undeclared dependency @types/node')));
  });
});

test('unsupported export grammars fail explicitly instead of partial Node resolution', async () => {
  await fixture(async (root) => {
    const file = path.join(root, 'packages/context/package.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    for (const value of [{ 'module-sync': './public.mts' }, { 'node-addons': './public.mts' }, { node: [{ browser: './browser.mts' }], import: './public.mts' }, ['./public.mts'], { import: { default: './public.mts' } }, { types: './public.d.ts' }]) {
      manifest.exports = { '.': value };
      await writeFile(file, JSON.stringify(manifest));
      assert.ok((await checkBoundaries(root)).some((error) => error.includes('unsupported export form')));
    }
    for (const target of ['./node_modules/hidden/index.mts', './src/node_modules/hidden.mts', './NODE_MODULES/public.mts', './src/Node_Modules/public.mts', './.git/hidden.mts']) {
      manifest.exports = { '.': target };
      await writeFile(file, JSON.stringify(manifest));
      assert.ok((await checkBoundaries(root)).some((error) => error.includes('export target escapes package or uses unsupported path syntax')));
    }
  });
});

test('rejects cycles even when each individual edge is allowed', async () => {
  await fixture(async (root) => {
    const policyPath = path.join(root, 'scripts/boundaries.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    for (const [name, dependency] of [['life', 'context'], ['context', 'life']]) {
      policy[`@mira/${name}`].allow = [`@mira/${dependency}`];
      const manifestPath = path.join(root, `packages/${name}/package.json`);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.dependencies = { [`@mira/${dependency}`]: 'workspace:*' };
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    await writeFile(policyPath, JSON.stringify(policy));
    assert.ok((await checkBoundaries(root)).some((error) => error.includes('dependency cycle')));
  });
});

test('rejects absolute/URL/alias imports and package symlink escapes', async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, 'packages/life/example.ts'), `import '/tmp/a.js'; import 'file:///tmp/b.js'; import '#hidden';`);
    assert.equal((await checkBoundaries(root)).filter((error) => error.includes('aliases, URLs and absolute imports')).length, 3);
    await symlink(path.join(root, 'packages/context'), path.join(root, 'packages/life/link'));
    await assert.rejects(checkBoundaries(root), /symlinks are not allowed/);
  });
});

test('extension SDK stays platform-independent while host and server use only approved public edges', async () => {
  await fixture(async root => {
    await mkdir(path.join(root, 'packages/extension-sdk/src'), { recursive: true });
    await writeFile(path.join(root, 'packages/extension-sdk/src/bad.ts'), `import 'node:fs'; import 'cordis'; import '@earendil-works/pi-agent-core'; import '@mira/persistence';`);
    const errors = await checkBoundaries(root);
    for (const expected of ['platform-independent package', 'external import not allowed cordis', 'external import not allowed @earendil-works/pi-agent-core', 'forbidden import @mira/persistence']) assert.ok(errors.some(error => error.includes(expected)), expected);
  });
});

test('external SDK stays platform independent and server uses only its public contract', async () => {
  await fixture(async root => {
    await writeFile(path.join(root, 'apps/server/sdk-public.ts'), "import type { ExternalEvent } from '@mira/external-sdk'; export type { ExternalEvent };\n");
    assert.deepEqual(await checkBoundaries(root), []);
    await mkdir(path.join(root, 'packages/external-sdk/src'), { recursive: true });
    await writeFile(path.join(root, 'packages/external-sdk/src/invalid.ts'), "import 'node:fs'; import '@mira/life'; import 'fastify';\n");
    await writeFile(path.join(root, 'apps/server/sdk-internal.ts'), "import '@mira/external-sdk/src/protocol.ts';\n");
    const errors = await checkBoundaries(root);
    for (const expected of ['platform-independent package', 'forbidden import @mira/life', 'external import not allowed fastify', 'non-public import @mira/external-sdk/src/protocol.ts']) {
      assert.ok(errors.some(error => error.includes(expected)), expected);
    }
  });
});


test('native PTY dependency is allowed only at server composition', async () => {
  await fixture(async root => {
    await writeFile(path.join(root, 'apps/server/src/pty-allowed.ts'), "import type { IPty } from 'node-pty'; export type NativePty = IPty;\n");
    assert.deepEqual(await checkBoundaries(root), []);
    await writeFile(path.join(root, 'packages/runtime-pi/src/pty-forbidden.ts'), "import 'node-pty';\n");
    assert.ok((await checkBoundaries(root)).some(error => error.includes('external import not allowed node-pty')));
  });
});

test('local QR rendering stays a Web dependency and is not available to core packages', async () => {
  await fixture(async root => {
    await writeFile(path.join(root,'packages/life/qr.ts'),"import qrcode from 'qrcode-generator'; void qrcode;");
    assert.ok((await checkBoundaries(root)).some(error=>error.includes('external import not allowed qrcode-generator')));
    await rm(path.join(root,'packages/life/qr.ts'));
    await writeFile(path.join(root,'apps/web/src/qr-check.ts'),"import qrcode from 'qrcode-generator'; void qrcode;");
    assert.deepEqual(await checkBoundaries(root),[]);
  });
});

test('Feishu is an ordinary SDK consumer; core cannot import its vendor SDK', async () => {
  await fixture(async root => {
    await mkdir(path.join(root, 'packages/feishu-channel/src'), { recursive: true });
    await writeFile(path.join(root, 'packages/feishu-channel/src/check.ts'), "import '@mira/extension-sdk'; import '@larksuite/channel'; import '@larksuiteoapi/node-sdk';\n");
    assert.deepEqual(await checkBoundaries(root), []);
    await writeFile(path.join(root, 'packages/feishu-channel/src/bad.ts'), "import '@mira/life'; import '@mira/server';\n");
    await writeFile(path.join(root, 'packages/life/feishu-bad.ts'), "import '@larksuite/channel';\n");
    const errors = await checkBoundaries(root);
    for (const expected of ['forbidden import @mira/life', 'forbidden import @mira/server', 'external import not allowed @larksuite/channel']) assert.ok(errors.some(error => error.includes(expected)), expected);
  });
});

test('MCP consumer imports only its public SDK while core cannot import the MCP client', async () => {
  await fixture(async root => {
    const policyPath = path.join(root, 'scripts/boundaries.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy['@mira/mcp-plugin'] = { path: 'packages/mcp-plugin', allow: ['@mira/extension-sdk'], external: ['@modelcontextprotocol/client'] };
    await writeFile(policyPath, JSON.stringify(policy));
    await mkdir(path.join(root, 'packages/mcp-plugin'), { recursive: true });

    await writeFile(path.join(root, 'packages/mcp-plugin/client.ts'), "import { Client } from '@modelcontextprotocol/client';");
    assert.deepEqual(await checkBoundaries(root), []);
    await writeFile(path.join(root, 'packages/life/mcp.ts'), "import { Client } from '@modelcontextprotocol/client';");
    assert.ok((await checkBoundaries(root)).some(error => error.includes('@modelcontextprotocol/client')));
    await writeFile(path.join(root, 'packages/mcp-plugin/client.ts'), "import { PiDurableRuntime } from '@mira/runtime-pi';");
    assert.ok((await checkBoundaries(root)).some(error => error.includes('forbidden import @mira/runtime-pi')));
  });
});
