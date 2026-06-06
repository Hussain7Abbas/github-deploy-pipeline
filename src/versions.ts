import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInherit } from './git.js';

export function setVersionInFile(filePath: string, version: string): void {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed['version'] === version) {
    return;
  }
  parsed['version'] = version;
  const indent = raw.match(/^{\n(\s+)/)?.[1]?.length ?? 2;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, indent)}\n`);
}

export function bumpVersionFiles(version: string, filePaths: string[], cwd: string): void {
  for (const f of filePaths) {
    const abs = path.isAbsolute(f) ? f : path.join(cwd, f);
    if (!fs.existsSync(abs)) {
      console.warn(`[gdeploy] Version file not found, skipping: ${abs}`);
      continue;
    }
    setVersionInFile(abs, version);
  }
  const relPaths = filePaths.map((f) => `"${path.isAbsolute(f) ? path.relative(cwd, f) : f}"`).join(' ');
  runInherit(`git -C "${cwd}" add ${relPaths}`);
  runInherit(`git -C "${cwd}" commit -m "chore(release): bump to ${version}"`);
}
