import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { parseSubmodules } from "./discover.js";
import { spawnSyncFile, trySpawnSyncFile } from "./exec.js";
import { compareSemVer, parseSemVer, toGitTag } from "./semver.js";
import type { SemVer } from "./semver.js";
import { assertBranchName, assertCommitMessage } from "./validate.js";

export type { SubmoduleInfo } from "./discover.js";

export function run(cmd: string, args: string[], cwd?: string, opts?: { trim?: boolean }): string {
  return spawnSyncFile(cmd, args, { cwd, trim: opts?.trim });
}

export function runInherit(cmd: string, args: string[], cwd?: string): void {
  spawnSyncFile(cmd, args, { cwd, inherit: true });
}

export function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  return trySpawnSyncFile(cmd, args, { cwd });
}

export function parseGitHubRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();

  const https = trimmed.match(
    /^https?:\/\/(?:[^/]*\.)?github\.com\/([^/]+\/[^/.]+?)(?:\.git)?(?:\/.*)?$/i,
  );
  if (https?.[1]) {
    return https[1];
  }

  const scpStyle = trimmed.match(/^git@([^:]+):([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (scpStyle?.[1] && scpStyle[2] && scpStyle[1].toLowerCase().includes("github")) {
    return scpStyle[2];
  }

  const sshUrl = trimmed.match(
    /^ssh:\/\/git@(?:[^/]*\.)?github[^/]*\/([^/]+\/[^/.]+?)(?:\.git)?$/i,
  );
  if (sshUrl?.[1]) {
    return sshUrl[1];
  }

  return null;
}

export interface RepoAccessCheck {
  label: string;
  slug: string;
  ok: boolean;
  error?: string;
}

export function checkRepoWriteAccess(repoCwd: string, label: string): RepoAccessCheck {
  const originUrl = tryRun("git", ["remote", "get-url", "origin"], repoCwd);
  if (!originUrl) {
    return {
      label,
      slug: "(unknown)",
      ok: false,
      error: 'No "origin" remote configured',
    };
  }

  const raw = tryRun("gh", ["repo", "view", "--json", "nameWithOwner,viewerPermission"], repoCwd);
  if (!raw) {
    const slug = parseGitHubRepoSlug(originUrl) ?? originUrl;
    return {
      label,
      slug,
      ok: false,
      error: "Repository not found or no access",
    };
  }

  let nameWithOwner: string | undefined;
  let viewerPermission: string | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      nameWithOwner?: string;
      viewerPermission?: string;
    };
    nameWithOwner = parsed.nameWithOwner;
    viewerPermission = parsed.viewerPermission;
  } catch {
    return {
      label,
      slug: parseGitHubRepoSlug(originUrl) ?? originUrl,
      ok: false,
      error: "Failed to parse repository permissions",
    };
  }

  const slug = nameWithOwner ?? parseGitHubRepoSlug(originUrl) ?? originUrl;

  if (
    viewerPermission !== "ADMIN" &&
    viewerPermission !== "MAINTAIN" &&
    viewerPermission !== "WRITE"
  ) {
    return {
      label,
      slug,
      ok: false,
      error: `Insufficient permission (${viewerPermission ?? "none"}) — write access required`,
    };
  }

  return { label, slug, ok: true };
}

export function ensurePrereqs(cwd: string = process.cwd()): void {
  const ghAuth = tryRun("gh", ["auth", "status"], cwd);
  if (!ghAuth) {
    p.cancel("gh CLI is not authenticated. Run: gh auth login");
    process.exit(1);
  }
  if (!tryRun("git", ["rev-parse", "--git-dir"], cwd)) {
    p.cancel("Not inside a git repository.");
    process.exit(1);
  }
  if (!tryRun("git", ["remote", "get-url", "origin"], cwd)) {
    p.cancel('No "origin" remote configured.');
    process.exit(1);
  }
}

export interface BackgroundTagFetch {
  ready: Promise<void>;
  isSettled: () => boolean;
  getLocalTags: () => SemVer[];
}

export function startBackgroundTagFetch(cwd: string = process.cwd()): BackgroundTagFetch {
  let settled = false;
  const ready = new Promise<void>((resolve) => {
    const child = spawn("git", ["fetch", "--tags", "--prune", "origin"], {
      cwd,
      stdio: "ignore",
    });
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.on("close", finish);
    child.on("error", finish);
  });
  return {
    ready,
    isSettled: () => settled,
    getLocalTags: () => getTags(cwd),
  };
}

export async function resolveTagsWithSpinner(
  tagFetch: BackgroundTagFetch,
  cwd: string = process.cwd(),
): Promise<SemVer[]> {
  if (!tagFetch.isSettled()) {
    const s = p.spinner();
    s.start("Fetching tags from origin");
    await tagFetch.ready;
    s.stop("Tags fetched");
  }
  return getTags(cwd);
}

export function fetchTags(cwd: string = process.cwd()): void {
  runInherit("git", ["fetch", "--tags", "--prune", "origin"], cwd);
}

function parsePorcelainPath(line: string): string {
  if (line.startsWith("?? ")) {
    return line.slice(3).trim();
  }

  let path: string;
  if (line.length >= 4 && line[2] === " ") {
    path = line.slice(3).trim();
  } else if (line.length >= 3) {
    path = line.slice(2).trim();
  } else {
    return line.trim();
  }

  if (path.includes(" -> ")) {
    return path.split(" -> ")[1]?.trim() ?? path;
  }
  return path;
}

export function getDirtyPaths(cwd: string = process.cwd()): string[] {
  const raw = run("git", ["status", "--porcelain"], cwd, { trim: false }).trimEnd();
  if (!raw) {
    return [];
  }
  return raw.split("\n").filter(Boolean).map(parsePorcelainPath);
}

export function requireCleanTree(
  cwd: string = process.cwd(),
  opts?: { allowOnly?: string[] },
): void {
  const dirty = getDirtyPaths(cwd);
  if (dirty.length === 0) {
    return;
  }

  if (opts?.allowOnly) {
    const allowed = new Set(opts.allowOnly);
    const disallowed = dirty.filter((p) => !allowed.has(p));
    if (disallowed.length === 0) {
      return;
    }
  }

  p.cancel("Working tree has uncommitted changes. Please commit or stash first.");
  process.exit(1);
}

export function currentBranch(cwd: string = process.cwd()): string {
  return assertBranchName(run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd));
}

export function listBranches(cwd: string = process.cwd()): string[] {
  const branches = new Set<string>();

  const local = tryRun("git", ["branch", "--format=%(refname:short)"], cwd);
  if (local) {
    for (const b of local.split("\n")) {
      const trimmed = b.trim();
      if (trimmed && isValidBranchOrSkip(trimmed)) {
        branches.add(trimmed);
      }
    }
  }

  const remote = tryRun("git", ["branch", "-r", "--format=%(refname:short)"], cwd);
  if (remote) {
    for (const b of remote.split("\n")) {
      const trimmed = b.trim();
      if (!trimmed || trimmed.includes("HEAD")) {
        continue;
      }
      const name = trimmed.replace(/^origin\//, "");
      if (name && isValidBranchOrSkip(name)) {
        branches.add(name);
      }
    }
  }

  return [...branches].sort((a, b) => a.localeCompare(b));
}

function isValidBranchOrSkip(name: string): boolean {
  try {
    assertBranchName(name);
    return true;
  } catch {
    return false;
  }
}

export function listSubmodules(cwd: string = process.cwd()) {
  return parseSubmodules(cwd);
}

export function getRawTags(cwd: string = process.cwd()): string[] {
  const raw = tryRun("git", ["tag", "--list"], cwd);
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function getTags(cwd: string = process.cwd()): SemVer[] {
  return getRawTags(cwd)
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

export function tagExists(tag: string, cwd: string = process.cwd(), tagPrefix = ""): boolean {
  const gitTag = toGitTag(tag, tagPrefix);
  return tryRun("git", ["rev-parse", "--verify", `refs/tags/${gitTag}`], cwd) !== null;
}

export function ghReleaseExists(tag: string, cwd: string = process.cwd(), tagPrefix = ""): boolean {
  const gitTag = toGitTag(tag, tagPrefix);
  const out = tryRun("gh", ["release", "view", gitTag], cwd);
  return out !== null;
}

export function pushBranch(branch: string, cwd: string = process.cwd()): void {
  const safeBranch = assertBranchName(branch);
  runInherit("git", ["push", "-u", "origin", safeBranch], cwd);
}

export function pushTag(tag: string, cwd: string = process.cwd(), tagPrefix = ""): void {
  const gitTag = toGitTag(tag, tagPrefix);
  runInherit("git", ["push", "origin", gitTag], cwd);
}

export function createRelease(opts: {
  tag: string;
  prerelease: boolean;
  notesStartTag: string | null;
  branch: string;
  generateReleaseNotes: boolean;
  tagPrefix?: string;
  cwd?: string;
}): void {
  const cwd = opts.cwd ?? process.cwd();
  const tagPrefix = opts.tagPrefix ?? "";
  const tag = toGitTag(opts.tag, tagPrefix);
  const branch = assertBranchName(opts.branch);

  const args = ["release", "create", tag, "--title", tag, "--target", branch];
  if (opts.generateReleaseNotes) {
    args.push("--generate-notes");
    if (opts.notesStartTag) {
      args.push("--notes-start-tag", toGitTag(opts.notesStartTag, tagPrefix));
    }
  } else {
    args.push("--notes", "");
  }
  if (opts.prerelease) {
    args.push("--prerelease");
  }
  runInherit("gh", args, cwd);
}

export function republishRc(
  tag: string,
  opts?: { generateReleaseNotes?: boolean; tagPrefix?: string; cwd?: string },
): void {
  const cwd = opts?.cwd ?? process.cwd();
  const tagPrefix = opts?.tagPrefix ?? "";
  const gitTag = toGitTag(tag, tagPrefix);
  const generateReleaseNotes = opts?.generateReleaseNotes ?? true;
  if (ghReleaseExists(tag, cwd, tagPrefix)) {
    runInherit("gh", ["release", "delete", gitTag, "--yes"], cwd);
  }
  pushTag(tag, cwd, tagPrefix);
  createRelease({
    tag,
    prerelease: true,
    notesStartTag: null,
    branch: currentBranch(cwd),
    generateReleaseNotes,
    tagPrefix,
    cwd,
  });
}

export function createReleaseBranch(
  branchName: string,
  fromBranch: string,
  cwd: string = process.cwd(),
): void {
  const safeName = assertBranchName(branchName);
  const safeFrom = assertBranchName(fromBranch);
  runInherit("git", ["branch", safeName, safeFrom], cwd);
  pushBranch(safeName, cwd);
}

export function openPr(opts: {
  head: string;
  base: string;
  title: string;
  body?: string;
  cwd?: string;
}): void {
  const cwd = opts.cwd ?? process.cwd();
  const args = [
    "pr",
    "create",
    "--base",
    assertBranchName(opts.base),
    "--head",
    assertBranchName(opts.head),
    "--title",
    opts.title,
    "--body",
    opts.body ?? "",
  ];
  runInherit("gh", args, cwd);
}

export async function syncBranch(
  target: string,
  newTag: string,
  sourceBranch: string,
  cwd: string = process.cwd(),
  checkoutBranch?: string,
  tagPrefix = "",
  skipConfirm = false,
  pushTagOnSync = true,
): Promise<void> {
  const safeTarget = assertBranchName(target);
  const safeSource = assertBranchName(sourceBranch);
  const safeCheckout = assertBranchName(checkoutBranch ?? sourceBranch);

  const remote = tryRun("git", ["ls-remote", "--heads", "origin", safeTarget], cwd);
  if (!remote) {
    p.note(`Branch "${safeTarget}" does not exist on origin — skipping sync.`, "Skipped");
    return;
  }

  const doSync = skipConfirm
    ? true
    : await p.confirm({
        message: `Merge "${safeSource}" into "${safeTarget}" and push?`,
        initialValue: true,
      });
  if (!skipConfirm && (p.isCancel(doSync) || !doSync)) {
    p.log.info("Branch sync skipped.");
    return;
  }

  const s = p.spinner();
  try {
    s.start(`Syncing branch "${safeTarget}"`);
    runInherit("git", ["checkout", safeTarget], cwd);
    runInherit("git", ["pull", "--ff-only"], cwd);
    runInherit("git", ["merge", safeSource, "--no-edit"], cwd);
    runInherit("git", ["push", "origin", safeTarget], cwd);
    if (pushTagOnSync) {
      pushTag(newTag, cwd, tagPrefix);
    }
    s.stop(`Branch "${safeTarget}" synced`);
  } catch {
    s.stop("Sync failed");
    tryRun("git", ["merge", "--abort"], cwd);
    p.log.error("Merge conflict or push failure — merge aborted. Please resolve manually.");
  } finally {
    runInherit("git", ["checkout", safeCheckout], cwd);
    pushBranch(safeCheckout, cwd);
  }
}

export async function mergeOrPr(opts: {
  envBranch: string;
  sourceBranch: string;
  tag: string;
  createPr: boolean;
  prTitle: string;
  checkoutBranch?: string;
  tagPrefix?: string;
  cwd?: string;
  skipSyncConfirm?: boolean;
  pushTagOnSync?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const tagPrefix = opts.tagPrefix ?? "";
  const safeEnvBranch = assertBranchName(opts.envBranch);
  const safeSource = assertBranchName(opts.sourceBranch);
  const safeCheckout = assertBranchName(opts.checkoutBranch ?? opts.sourceBranch);

  const remote = tryRun("git", ["ls-remote", "--heads", "origin", safeEnvBranch], cwd);
  if (!remote) {
    p.note(`Branch "${safeEnvBranch}" does not exist on origin — skipping.`, "Skipped");
    return;
  }

  if (opts.createPr) {
    const s = p.spinner();
    s.start(`Opening PR: ${safeSource} → ${safeEnvBranch}`);
    try {
      pushBranch(safeSource, cwd);
      openPr({
        head: safeSource,
        base: safeEnvBranch,
        title: opts.prTitle,
        cwd,
      });
      s.stop(`PR opened: ${safeSource} → ${safeEnvBranch}`);
    } catch {
      s.stop("Failed to open PR");
      p.log.error("Could not create pull request. Please open it manually.");
    } finally {
      runInherit("git", ["checkout", safeCheckout], cwd);
    }
    return;
  }

  await syncBranch(
    safeEnvBranch,
    opts.tag,
    safeSource,
    cwd,
    safeCheckout,
    tagPrefix,
    opts.skipSyncConfirm,
    opts.pushTagOnSync ?? true,
  );
}

export function commitSubmodulePointers(
  submodulePaths: string[],
  message: string,
  cwd: string = process.cwd(),
): void {
  const safeMessage = assertCommitMessage(message);
  const args = ["add", ...submodulePaths];
  runInherit("git", args, cwd);
  runInherit("git", ["commit", "-m", safeMessage], cwd);
}

export function initSubmodules(cwd: string = process.cwd()): void {
  tryRun("git", ["submodule", "update", "--init", "--recursive"], cwd);
}

export function gitAdd(files: string[], cwd: string): void {
  if (files.length === 0) {
    return;
  }
  runInherit("git", ["add", ...files], cwd);
}

export function gitCommit(message: string, cwd: string): void {
  runInherit("git", ["commit", "-m", assertCommitMessage(message)], cwd);
}

export function hasChangesToCommit(cwd: string): boolean {
  const staged = tryRun("git", ["diff", "--cached", "--name-only"], cwd);
  return staged !== null && staged.length > 0;
}
