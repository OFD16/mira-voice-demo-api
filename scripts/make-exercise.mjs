// Turns the solution into the exercise: every block between `@sol-start <ID>` and `@sol-end`
// is removed. In TS/JS a `throw new Error('TODO(<ID>)')` is left so the project still typechecks.
// Usage: node scripts/make-exercise.mjs [rootDir]
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', '.git', 'android/build', 'ios/Pods', 'build', '.gradle']);
const EXT = /\.(ts|tsx|js|mjs|kt|java|xml|gradle|json|plist|m|mm|swift)$/;
let files = 0, blocks = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(root, p).replaceAll('\\', '/');
    if ([...SKIP].some((s) => rel === s || rel.startsWith(s + '/') || e.name === s)) continue;
    if (e.isDirectory()) walk(p);
    else if (EXT.test(e.name) && !rel.startsWith('scripts/make-exercise')) strip(p);
  }
}

function strip(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('@sol-start')) return;
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:\/\/|<!--|\{\/\*)\s*@sol-start\s+(\S+)(?:\s+(blank))?/);
    if (!m) { out.push(lines[i]); continue; }
    const [, indent, id, blank] = m;
    while (i < lines.length && !/@sol-end/.test(lines[i])) i++;
    const ts = /\.(ts|tsx|js|mjs)$/.test(file);
    if (ts && !blank) out.push(`${indent}throw new Error('TODO(${id}) — see docs/LESSONS.md');`);
    else out.push(`${indent}${file.endsWith('.xml') ? `<!-- TODO(${id}) -->` : `// TODO(${id})`}`);
    blocks++;
  }
  fs.writeFileSync(file, out.join('\n'));
  files++;
}

walk(root);
console.log(`exercise: ${blocks} blocks stripped in ${files} files`);
