// Lets plain Node load the generated Prisma client (CHE-382).
//
// The client is the workerd build (prisma/schema.prisma `runtime = "workerd"`):
// it imports its query engine as `query_engine_bg.wasm?module`, which workerd
// and the bundler turn into a compiled WebAssembly.Module. Node has no such
// import. This hook answers that one specifier with a module whose default
// export is the compiled WebAssembly.Module — what workerd would hand over —
// so a verify script can run the real client against a real local D1
// (scripts/fixtures/real-d1.ts). Nothing else is touched.
//
// Usage: node --import ./scripts/fixtures/wasm-module-loader.mjs …

import { register } from "node:module";

if (!globalThis.__wasmModuleLoaderRegistered) {
  globalThis.__wasmModuleLoaderRegistered = true;
  register(
    "data:text/javascript," +
      encodeURIComponent(`
        export async function resolve(specifier, context, next) {
          if (specifier.endsWith(".wasm?module")) {
            const url = new URL(specifier.slice(0, -"?module".length), context.parentURL).href;
            return { url: url + "?compiled", shortCircuit: true };
          }
          return next(specifier, context);
        }
        export async function load(url, context, next) {
          if (url.endsWith(".wasm?compiled")) {
            const path = new URL(url.slice(0, -"?compiled".length));
            return {
              format: "module",
              shortCircuit: true,
              source:
                "import { readFileSync } from 'node:fs';" +
                "export default new WebAssembly.Module(readFileSync(new URL(" + JSON.stringify(path.href) + ")));",
            };
          }
          return next(url, context);
        }
      `),
  );
}
