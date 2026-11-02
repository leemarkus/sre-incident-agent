#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Check every relative Markdown link (and #anchor) under the given roots.
// Usage: node scripts/check-links.mjs [path ...]   (default: README.md docs scenarios)
const SKIP = new Set(['node_modules', 'dist', '.git']);
function walk(target) {
  if (!fs.existsSync(target)) return [];
  if (fs.statSync(target).isFile()) return [target];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
const safePath = (file) => path.resolve(file);
const roots = process.argv.length > 2 ? process.argv.slice(2) : ['README.md', 'docs', 'scenarios'];
let checked = 0; let failures = 0;
for (const file of roots.flatMap(walk).filter(f => f.endsWith('.md'))) {
  const source = fs.readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  const targets = [
    ...[...source.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)/g)].map(m => m[1]),
    ...[...source.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map(m => m[1]),
    ...[...source.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(m => m[1]),
  ];
  for (let target of targets) {
    target = target.replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) continue; // No network checks.
    const [rawPath, fragment] = target.split('#');
    let dest;
    try { dest = safePath(path.resolve(path.dirname(file), decodeURIComponent(rawPath.split('?')[0] || path.basename(file)))); }
    catch (error) { console.error(`FAIL ${file}: ${target}: ${error.message}`); failures++; continue; }
    checked++;
    if (!fs.existsSync(dest)) { console.error(`FAIL ${file}: missing ${target}`); failures++; continue; }
    if (fragment && dest.endsWith('.md')) {
      const text = fs.readFileSync(dest, 'utf8'); const ids = new Set(); const seen = new Map();
      for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
        const base = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
        const count = seen.get(base) ?? 0; seen.set(base, count + 1); ids.add(count ? `${base}-${count}` : base);
      }
      for (const match of text.matchAll(/(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
      if (!ids.has(decodeURIComponent(fragment))) { console.error(`FAIL ${file}: missing anchor ${target}`); failures++; }
    }
  }
}
console.log(`Markdown links: ${checked} local targets checked, ${failures} failures (external URLs not fetched)`);
process.exitCode = failures ? 1 : 0;
