# A local Mira extension

This is an ordinary TypeScript workspace outside the Mira checkout. Its entry is
`src/index.ts`; it imports only Mira's public `@mira/extension-sdk` contract.
Read and change the files with the existing Pi `read`, `write`, `edit`, and `bash`
tools. No additional code-generation or editing service is involved.

## Create the workspace

Use Node 24.19.x and a Mira checkout whose locked dependencies are already
installed. From the checkout, choose a new absolute directory with an existing
parent, outside the source checkout:

```sh
node scripts/create-extension-workspace.mts /absolute/new/extension-workspace
cd /absolute/new/extension-workspace
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node --test tests/*.test.mts
```

The helper copies this template and links only the private local SDK and the
checkout's existing TypeScript package. It copies the Node type declarations and
links their existing `undici-types` dependency, preserving resolution when the
workspace is snapshotted. It does not invoke a package manager, contact a
registry, or run installation scripts. It refuses to
overwrite an existing workspace. The checked-in manifest names the local SDK
explicitly through `file:./.deps/extension-sdk`; it is not a published package.
Do not run `npm install` or `pnpm install` as a substitute for this setup.

`node_modules/@mira/extension-sdk` links through `.deps/extension-sdk` to the local
checkout. Node follows the symlink to source outside `node_modules`, where its
native TypeScript stripping is supported. Do not copy SDK `.ts` files directly
into `node_modules` or run Node with `--preserve-symlinks`. The workspace depends
on that checkout remaining available. Immutable staged releases use their own
SDK snapshot rather than these development links.

## Write and test

Give the extension and each tool distinct names. Tool names must start with an
ASCII letter or underscore and contain 1–64 ASCII letters, digits, underscores
or hyphens (`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`), for example `hello_world`. Names are passed unchanged to model APIs; dots are not allowed.
Keep relative source imports
explicit (`./helper.ts`). The supplied `tsconfig.json` uses strict NodeNext with
full declaration checking. `tests/index.test.mts` uses Node's test runner, the
public SDK types, and synthetic arguments; no database, credentials, live model,
or external service is needed.

A successful typecheck, test run, or import is evidence about these files, not an
OS sandbox or proof of safety. Tests and extension imports can execute arbitrary
code with the current OS account's permissions. Use the user's natural-language
authorization and actual OS permissions. Inspect, test, and stage reviewed code
before explicitly requesting its activation. The helper neither stages nor
activates the extension and does not change Mira's host configuration.
