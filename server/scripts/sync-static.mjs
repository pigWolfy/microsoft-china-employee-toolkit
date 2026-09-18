import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');
const target = path.join(serverRoot, 'public');
mkdirSync(target, { recursive: true });
for (const name of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']) {
  copyFileSync(path.join(repoRoot, name), path.join(target, name));
}