// @ts-check
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

// GitHub Pages project sites live under /<repo>/; a custom domain serves from /.
const base = process.env.SITE_BASE ?? '/pocketledger-web';
const site = process.env.SITE_URL ?? 'https://jackhale98.github.io';

// ---- engine: pinned by engine/wasm.lock, served under a content-addressed name
const lock = readFileSync(new URL('./engine/wasm.lock', import.meta.url), 'utf8');
const lockValue = (/** @type {string} */ k) => new RegExp(`^${k} *= *"(.*)"$`, 'm').exec(lock)?.[1] ?? '';
const engineSha = lockValue('sha256');
const engineFile = `hledger-${engineSha.slice(0, 16)}.wasm`;
const wasmSrc = fileURLToPath(new URL('./public/wasm/hledger.wasm', import.meta.url));
const wasmVersioned = fileURLToPath(new URL(`./public/wasm/${engineFile}`, import.meta.url));
if (existsSync(wasmSrc) && !existsSync(wasmVersioned)) copyFileSync(wasmSrc, wasmVersioned);
// Option B reactor, if a copy matching wasm.lock is present (engine/scripts/fetch.sh).
const reactorSha = lockValue('reactor_sha256');
const reactorSrc = fileURLToPath(new URL('./public/wasm/hledger-reactor.wasm', import.meta.url));
const jsffiSrc = fileURLToPath(new URL('./public/wasm/hledger-reactor.jsffi.mjs', import.meta.url));
const sha256 = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const reactorOk =
  process.env.ENGINE_MODE !== 'cli' && existsSync(reactorSrc) && existsSync(jsffiSrc) && sha256(reactorSrc) === reactorSha && sha256(jsffiSrc) === lockValue('reactor_jsffi_sha256');
const reactorFile = `hledger-reactor-${reactorSha.slice(0, 16)}.wasm`;
const jsffiFile = `hledger-reactor-${reactorSha.slice(0, 16)}.jsffi.mjs`;
if (reactorOk) {
  for (const [src, name] of /** @type {[string, string][]} */ ([[reactorSrc, reactorFile], [jsffiSrc, jsffiFile]])) {
    const dest = fileURLToPath(new URL(`./public/wasm/${name}`, import.meta.url));
    if (!existsSync(dest)) copyFileSync(src, dest);
  }
}
if (!existsSync(wasmSrc))
  console.warn('[pocketledger] public/wasm/hledger.wasm is missing: run `npm run fetch:engine`.');

// Must match DEFAULT_GIT_PROXY in src/lib/config.ts (a placeholder until a worker is deployed).
const gitProxy = process.env.PUBLIC_GIT_PROXY || 'https://pocketledger-proxy.example.workers.dev';
const extraConnect = (process.env.PUBLIC_CSP_CONNECT_EXTRA ?? '').split(/\s+/).filter(Boolean);
const origin = (/** @type {string} */ u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

/** Service worker: precache the shell; the engine is cached at runtime under its versioned name. */
const offlineApp = {
  name: 'offline-app',
  hooks: {
    'astro:build:done': async (/** @type {{ dir: URL }} */ { dir }) => {
      const root = fileURLToPath(dir);
      // Only the versioned engine ships.
      const keep = new Set([engineFile, ...(reactorOk ? [reactorFile, jsffiFile] : [])]);
      for (const f of await readdir(new URL('wasm/', dir))) if (!keep.has(f)) rmSync(new URL(`wasm/${f}`, dir), { force: true });
      const all = /** @type {string[]} */ (await readdir(root, { recursive: true }));
      const files = all
        .map((f) => f.split('\\').join('/'))
        .filter(
          (f) =>
            /^_astro\/.*\.(js|css|woff2|svg)$/.test(f) ||
            /^icons\/.*\.(png|svg)$/.test(f) ||
            ['index.html', 'app/index.html', 'manifest.webmanifest', 'favicon.svg'].includes(f),
        )
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(await readFile(new URL(f, dir)));
      hash.update(engineSha);
      const paths = files.map((f) => f.replace(/(^|\/)index\.html$/, '$1') || './');
      const template = await readFile(new URL('./scripts/sw.js', import.meta.url), 'utf8');
      await writeFile(
        new URL('sw.js', dir),
        template
          .replace("'__VERSION__'", `'${hash.digest('hex').slice(0, 16)}'`)
          .replace('__FILES__', JSON.stringify(paths))
          .replace("'__ENGINE__'", JSON.stringify(reactorOk ? [`wasm/${reactorFile}`, `wasm/${jsffiFile}`] : [`wasm/${engineFile}`])),
      );
    },
  },
};

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'always' },
  integrations: [svelte(), offlineApp],
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "worker-src 'self'",
        /** @type {`connect-src${string}`} */ ([
          'connect-src',
          "'self'",
          'https://api.dropboxapi.com',
          'https://content.dropboxapi.com',
          'https://api.github.com',
          origin(gitProxy),
          ...extraConnect,
        ]
          .filter(Boolean)
          .join(' ')),
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "manifest-src 'self'",
      ],
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
      styleDirective: { resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }] },
    },
  },
  vite: {
    worker: { format: 'es' },
    build: { assetsInlineLimit: 0, target: 'es2022' },
    define: {
      __ENGINE__: JSON.stringify({
        file: `wasm/${engineFile}`,
        sha256: engineSha,
        hledger: lockValue('hledger_version'),
        flavor: reactorOk ? 'hledger-reactor' : lockValue('flavor'),
        reactor: reactorOk ? { file: `wasm/${reactorFile}`, jsffi: `wasm/${jsffiFile}`, sha256: reactorSha } : null,
      }),
      __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version),
    },
  },
});
