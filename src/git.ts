import { execSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { compareSemVer, parseSemVer } from './semver.js';
import type { SemVer } from './semver.js';

export function run(cmd: string): string {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim();
}

export function runInherit(cmd: string): void {
  execSync(cmd, { stdio: 'inherit' });
}

export function tryRun(cmd: string): string | null {
  try {
    return run(cmd);
  } catch {
    return null;
  }
}

export function ensurePrereqs(): void {
  const ghAuth = tryRun('gh auth status 2>&1');
  if (!ghAuth || ghAuth.includes('not logged in')) {
    p.cancel('gh CLI is not authenticated. Run: gh auth login');
    process.exit(1);
  }
  if (!tryRun('git rev-parse --git-dir')) {
    p.cancel('Not inside a git repository.');
    process.exit(1);
  }
  if (!tryRun('git remote get-url origin')) {
    p.cancel('No "origin" remote configured.');
    process.exit(1);
  }
  const s = p.spinner();
  s.start('Fetching tags and branches from origin');
  try {
    runInherit('git fetch --tags --prune origin');
    s.stop('Fetched tags and branches');
  } catch {
    s.stop('Fetch failed — continuing with local state');
  }
}

export function requireCleanTree(): void {
  if (run('git status --porcelain')) {
    p.cancel('Working tree has uncommitted changes. Please commit or stash first.');
    process.exit(1);
  }
}

export function currentBranch(): string {
  return run('git rev-parse --abbrev-ref HEAD');
}

export function getTags(): SemVer[] {
  const raw = tryRun('git tag --list');
  if (!raw) {
    return [];
  }
  return raw
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parseSemVer)
    .filter((v): v is SemVer => v !== null);
}

export function getLatestTag(tags: SemVer[]): SemVer | null {
  if (tags.length === 0) {
    return null;
  }
  return tags.reduce((best, v) => (compareSemVer(v, best) > 0 ? v : best));
}

export function getLatestRcTag(tags: SemVer[]): SemVer | null {
  const rcs = tags.filter((v) => v.rc !== null);
  if (rcs.length === 0) {
    return null;
  }
  return rcs.reduce((best, v) => (compareSemVer(v, best) > 0 ? v : best));
}

export function getLatestFinalTag(tags: SemVer[]): SemVer | null {
  const finals = tags.filter((v) => v.rc === null);
  if (finals.length === 0) {
    return null;
  }
  return finals.reduce((best, v) => (compareSemVer(v, best) > 0 ? v : best));
}

export function getRcTags(tags: SemVer[]): SemVer[] {
  return tags.filter((v) => v.rc !== null).sort((a, b) => compareSemVer(b, a));
}

export function tagExists(tag: string): boolean {
  return tryRun(`git rev-parse --verify "refs/tags/${tag}"`) !== null;
}

export function ghReleaseExists(tag: string): boolean {
  const out = tryRun(`gh release view "${tag}" 2>&1`);
  return out !== null && !out.includes('release not found');
}

export function createRelease(opts: {
  tag: string;
  prerelease: boolean;
  notesStartTag: string | null;
  branch: string;
}): void {
  let cmd = `gh release create "${opts.tag}" --title "${opts.tag}" --generate-notes --target "${opts.branch}"`;
  if (opts.prerelease) {
    cmd += ' --prerelease';
  }
  if (opts.notesStartTag) {
    cmd += ` --notes-start-tag "${opts.notesStartTag}"`;
  }
  runInherit(cmd);
}

export function republishRc(tag: string): void {
  if (ghReleaseExists(tag)) {
    runInherit(`gh release delete "${tag}" --yes`);
  }
  tryRun(`git push origin "${tag}"`);
  runInherit(
    `gh release create "${tag}" --title "${tag}" --generate-notes --target "${currentBranch()}" --prerelease`,
  );
}

export async function syncBranch(
  target: string,
  newTag: string,
  originalBranch: string,
): Promise<void> {
  const remote = tryRun(`git ls-remote --heads origin ${target}`);
  if (!remote) {
    p.note(`Branch "${target}" does not exist on origin — skipping sync.`, 'Skipped');
    return;
  }

  const doSync = await p.confirm({
    message: `Merge "${originalBranch}" into "${target}" and push?`,
    initialValue: true,
  });
  if (p.isCancel(doSync) || !doSync) {
    p.log.info('Branch sync skipped.');
    return;
  }

  const s = p.spinner();
  try {
    s.start(`Syncing branch "${target}"`);
    runInherit(`git checkout "${target}"`);
    runInherit('git pull --ff-only');
    runInherit(`git merge "${originalBranch}" --no-edit`);
    runInherit(`git push origin "${target}"`);
    runInherit(`git push origin "${newTag}"`);
    s.stop(`Branch "${target}" synced`);
  } catch {
    s.stop('Sync failed');
    tryRun('git merge --abort');
    p.log.error('Merge conflict or push failure — merge aborted. Please resolve manually.');
  } finally {
    runInherit(`git checkout "${originalBranch}"`);
    runInherit(`git push origin "${originalBranch}"`);
  }
}
