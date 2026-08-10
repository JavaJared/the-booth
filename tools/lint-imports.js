// Catches identifiers a file uses but never imports or declares.
// `node --check` only parses syntax, so a missing import sails through and
// fails at runtime — which is exactly how "TEAM_BY_ID is not defined" shipped.
// Run: node tools/lint-imports.js
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

const FILES = [
  'public/app.js',
  'netlify/functions/api.js',
  ...readdirSync(join(ROOT, 'public/shared')).map((f) => `public/shared/${f}`),
  'tools/balance.js',
];

/** Every name a module exports. */
function exportsOf(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

/** Names a module imports, and from where. */
function importsOf(src) {
  const local = new Set();
  const specs = [];
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    specs.push(m[2]);
    const clause = m[1].trim();
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) local.add(n);
      }
    }
    const bare = clause.replace(/\{[\s\S]*?\}/, '').replace(/^,|,$/g, '').trim();
    if (bare && /^[\w$]+$/.test(bare)) local.add(bare);
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) local.add(ns[1]);
  }
  return { local, specs };
}

/** Anything declared in the file itself. */
function declaredIn(src) {
  const names = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([\w$]+)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/g,
    /(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
    /(?:const|let|var)\s*\[([^\]]*)\]\s*=/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(':').pop().split('=')[0].trim();
        if (/^[\w$]+$/.test(n)) names.add(n);
      }
    }
  }
  return names;
}

// Build the map of what every shared module offers.
const provided = new Map();
for (const f of FILES) provided.set(f, exportsOf(f));
const allShared = new Set();
for (const names of provided.values()) for (const n of names) allShared.add(n);

let problems = 0;
for (const file of FILES) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const { local, specs } = importsOf(src);
  const declared = declaredIn(src);

  // Only flag names some module here exports — those are the ones a missing
  // import silently breaks. Skip property accesses (link.advance) and object
  // keys (record: x), which are not references to a binding at all.
  const stripped = src
    // Import statements name the source binding ("record as seasonRecord");
    // only the local alias is a reference, and importsOf already has it.
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  const used = new Set();
  for (const m of stripped.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*(:?)/gm)) {
    const n = m[2];
    if (m[3] === ':') continue;          // an object key, not a reference
    if (allShared.has(n)) used.add(n);
  }

  const missing = [...used].filter((n) => !local.has(n) && !declared.has(n));
  if (missing.length) {
    problems += missing.length;
    console.log(`\n${file}`);
    for (const n of missing) {
      const from = FILES.find((f) => provided.get(f).has(n));
      console.log(`  ${n.padEnd(22)} used but not imported  (exported by ${from})`);
    }
  }

  // Also verify every import target actually exports what is asked for.
  for (const m of src.matchAll(/import\s+\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!m[2].startsWith('.')) continue;
    const target = resolve(dirname(join(ROOT, file)), m[2]).replace(ROOT + '/', '');
    const offers = provided.get(target);
    if (!offers) continue;
    for (const part of m[1].split(',')) {
      const want = part.trim().split(/\s+as\s+/)[0].trim();
      if (want && !offers.has(want)) {
        problems++;
        console.log(`\n${file}\n  ${want.padEnd(22)} imported from ${m[2]}, which does not export it`);
      }
    }
  }
}

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll imports resolve.');
process.exit(problems ? 1 : 0);
