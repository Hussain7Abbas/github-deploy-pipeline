import * as fs from "node:fs";
import * as path from "node:path";
import { resolveVersionFileName } from "./app-type.js";
import { CONFIG_FILE } from "./config.js";
import {
  currentBranch,
  getDirtyPaths,
  gitAdd,
  gitCommit,
  hasChangesToCommit,
  pushBranch,
} from "./git.js";
import { parseSemVer } from "./semver.js";
import type { SemVer } from "./semver.js";
import { assertRepoRelativePath, assertSemverTag } from "./validate.js";

function versionFileKind(filePath: string): "json" | "pubspec" {
  return path.basename(filePath) === "pubspec.yaml" ? "pubspec" : "json";
}

function stripPubspecBuild(version: string): { semver: string; build: string | null } {
  const plus = version.indexOf("+");
  if (plus === -1) {
    return { semver: version.trim(), build: null };
  }
  return {
    semver: version.slice(0, plus).trim(),
    build: version.slice(plus + 1).trim() || null,
  };
}

function readPubspecVersion(filePath: string): SemVer | null {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^version\s*:\s*(.+)$/m);
  if (!match?.[1]) {
    return null;
  }
  const { semver } = stripPubspecBuild(match[1].trim());
  return parseSemVer(semver);
}

function setPubspecVersion(filePath: string, version: string): boolean {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^version\s*:\s*(.+)$/m);
  if (!match?.[0]) {
    return false;
  }

  const existing = match[1]?.trim() ?? "";
  const { build } = stripPubspecBuild(existing);
  const nextValue = build ? `${version}+${build}` : version;
  if (existing === nextValue) {
    return false;
  }

  const updated = raw.replace(/^version\s*:\s*.+$/m, `version: ${nextValue}`);
  fs.writeFileSync(filePath, updated);
  return true;
}

export function readPackageVersion(filePath: string): SemVer | null {
  return readVersionFromFile(filePath);
}

export function readVersionFromFile(filePath: string): SemVer | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    if (versionFileKind(filePath) === "pubspec") {
      return readPubspecVersion(filePath);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version !== "string") {
      return null;
    }
    return parseSemVer(parsed.version);
  } catch {
    return null;
  }
}

export function readProjectVersion(dir: string, overrideVersionFile?: string): SemVer | null {
  const fileName = overrideVersionFile ?? resolveVersionFileName(dir);
  if (!fileName) {
    return null;
  }
  return readVersionFromFile(path.join(dir, fileName));
}

export function setVersionInFile(filePath: string, version: string): boolean {
  if (versionFileKind(filePath) === "pubspec") {
    return setPubspecVersion(filePath, version);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.version === version) {
    return false;
  }
  parsed.version = version;
  const indent = raw.match(/^{\n(\s+)/)?.[1]?.length ?? 2;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, indent)}\n`);
  return true;
}

export function bumpVersionFiles(
  version: string,
  filePaths: string[],
  cwd: string,
  opts?: {
    includeConfigIfDirty?: boolean;
    /** Per-file version overrides keyed by repo-relative path. */
    fileVersions?: Record<string, string>;
  },
): void {
  const safeVersion = assertSemverTag(version);
  const changedPaths: string[] = [];

  for (const f of filePaths) {
    const rel = path.isAbsolute(f) ? path.relative(cwd, f) : f;
    assertRepoRelativePath(cwd, rel);
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`[xeploy] Version file not found, skipping: ${abs}`);
      continue;
    }
    const override = opts?.fileVersions?.[rel];
    const targetVersion = override ? assertSemverTag(override) : safeVersion;
    if (setVersionInFile(abs, targetVersion)) {
      changedPaths.push(rel);
    }
  }

  const pathsToStage = [...changedPaths];
  if (opts?.includeConfigIfDirty) {
    const dirty = getDirtyPaths(cwd);
    if (dirty.includes(CONFIG_FILE) && !pathsToStage.includes(CONFIG_FILE)) {
      pathsToStage.push(CONFIG_FILE);
    }
  }

  if (pathsToStage.length === 0) {
    return;
  }

  gitAdd(pathsToStage, cwd);
  if (hasChangesToCommit(cwd)) {
    gitCommit(`chore(release): bump to ${safeVersion}`, cwd);
    pushBranch(currentBranch(cwd), cwd);
  }
}
