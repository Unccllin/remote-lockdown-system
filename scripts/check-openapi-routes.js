#!/usr/bin/env node
/**
 * check-openapi-routes.js — fail when a registered Express route is undocumented.
 *
 * Why (S141/S142 sweep, finding #3): docs/openapi.yaml documented 42 of 74
 * endpoints. The 28 `/v1/*` PBL routes and 4 `/api` routes were invisible, and
 * nothing noticed because no check compared the two. A spec that drifts silently
 * is worse than no spec: it reads as authoritative.
 *
 * Mount-aware: routes are parsed from server/src/routes/*.js and combined with
 * the `app.use('<prefix>', <var>)` mounts in server/src/index.js, including the
 * `/v1` wrapper that mounts pblRoutes. Express `:param` becomes `{param}`.
 *
 * Usage:
 *   node scripts/check-openapi-routes.js            # exit 1 on any gap
 *   node scripts/check-openapi-routes.js --list     # print both sets
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'server/src/index.js');
const ROUTES_DIR = path.join(ROOT, 'server/src/routes');
const SPEC = path.join(ROOT, 'docs/openapi.yaml');

const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

function readMounts() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const mounts = {};

  // const xRoutes = require('./routes/x')
  const requireRe = /const\s+(\w+)\s*=\s*require\('\.\/routes\/(\w+)'\)/g;
  for (const m of src.matchAll(requireRe)) {
    mounts[m[1]] = null; // known route module, prefix resolved below
    mounts[`__file__${m[1]}`] = m[2];
  }

  // app.use('/api/x', limiter, xRoutes)
  const useRe = /app\.use\('([^']+)'[^)]*?(\w+)\)/g;
  for (const m of src.matchAll(useRe)) {
    const [, prefix, varName] = m;
    if (mounts[varName] !== undefined) mounts[varName] = prefix;
  }

  // The /v1 PBL surface is mounted through a wrapper: app.use('/v1', ... pblRoutes)
  if (/app\.use\('\/v1'/.test(src) && mounts.pblRoutes === null) mounts.pblRoutes = '/v1';
  return mounts;
}

function registeredRoutes() {
  const mounts = readMounts();
  const out = new Set();

  for (const [varName, prefix] of Object.entries(mounts)) {
    if (varName.startsWith('__file__') || prefix === null || !prefix) continue;
    const file = mounts[`__file__${varName}`];
    const filePath = path.join(ROUTES_DIR, `${file}.js`);
    if (!fs.existsSync(filePath)) continue;

    const src = fs.readFileSync(filePath, 'utf8');
    const routeRe = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    for (const m of src.matchAll(routeRe)) {
      const verb = m[1].toLowerCase();
      let routePath = m[2];
      let full = `${prefix.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`;
      full = full.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      full = full.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
      out.add(`${verb.toUpperCase()} ${full}`);
    }
  }
  return out;
}

/** Minimal YAML path reader: top-level `  /path:` lines plus verb children. */
function documentedRoutes() {
  const lines = fs.readFileSync(SPEC, 'utf8').split(/\r?\n/);
  const out = new Set();
  let currentPath = null;
  let inPaths = false;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    // Only a top-level KEY ends the paths map — a column-0 comment (section
    // banner) must not, or every path after the first banner is invisible.
    if (inPaths && /^[A-Za-z_"'][^:]*:\s*$/.test(line)) { inPaths = false; currentPath = null; }
    if (!inPaths) continue;

    const pathMatch = line.match(/^ {2}(\/[^:]*):\s*$/);
    if (pathMatch) { currentPath = pathMatch[1].replace(/\/$/, '') || '/'; continue; }

    const verbMatch = line.match(/^ {4}(get|post|put|patch|delete):\s*$/);
    if (verbMatch && currentPath) out.add(`${verbMatch[1].toUpperCase()} ${currentPath}`);
  }
  return out;
}

function main() {
  const registered = registeredRoutes();
  const documented = documentedRoutes();
  const missing = [...registered].filter((r) => !documented.has(r)).sort();
  const extra = [...documented].filter((d) => !registered.has(d)).sort();

  if (process.argv.includes('--list')) {
    console.log(`registered: ${registered.size}  documented: ${documented.size}`);
    for (const r of [...registered].sort()) console.log(`  ${documented.has(r) ? 'ok  ' : 'MISS'} ${r}`);
    for (const e of extra) console.log(`  EXTRA ${e}`);
    return missing.length === 0 ? 0 : 1;
  }

  console.log(`registered routes: ${registered.size}   documented: ${documented.size}`);
  if (missing.length) {
    console.log(`\n[FAIL] ${missing.length} registered route(s) missing from docs/openapi.yaml:`);
    for (const m of missing) console.log(`  ${m}`);
  }
  if (extra.length) {
    console.log(`\n[WARN] ${extra.length} documented route(s) no longer registered:`);
    for (const e of extra) console.log(`  ${e}`);
  }
  if (!missing.length) console.log('\n[OK] every registered route is documented');
  // Documented-but-unregistered is a warning: the spec may describe a retired
  // endpoint, which is worth fixing but should not block a build.
  return missing.length ? 1 : 0;
}

process.exit(main());
