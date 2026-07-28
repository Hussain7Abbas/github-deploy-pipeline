import * as fs from "node:fs";
import * as path from "node:path";
import { type AppType, detectAppType, isProjectRoot, resolveVersionFileName } from "./app-type.js";
import { parseSubmodules } from "./discover.js";
import { getRawTags, listBranches } from "./git.js";
import { detectTagPrefix } from "./semver.js";
import { assertBranchName, assertRepoRelativePath, isValidBranchName } from "./validate.js";

export type RepoType = "default" | "mono" | "meta";
export type { AppType } from "./app-type.js";
export type EnvName = "develop" | "staging" | "uat" | "sandbox" | "production";
export type CreatePrEnv = "staging" | "uat" | "sandbox" | "production";
export type ReleaseEnv = "staging" | "uat" | "sandbox" | "production";

export const CONFIG_FILE = ".xeploy.json";

export const ENV_NAMES: EnvName[] = ["develop", "staging", "uat", "sandbox", "production"];
export const CREATE_PR_ENVS: CreatePrEnv[] = ["staging", "uat", "sandbox", "production"];
export const RELEASE_ENVS: ReleaseEnv[] = ["staging", "uat", "sandbox", "production"];

export const RC_ENVS: ReleaseEnv[] = ["staging", "uat"];
export const FINAL_ENVS: ReleaseEnv[] = ["sandbox", "production"];

const DEFAULT_ENV_BRANCH_NAMES: Record<EnvName, string> = {
  develop: "develop",
  staging: "staging",
  uat: "uat",
  sandbox: "sandbox",
  production: "main",
};

export interface SubprojectConfig {
  repo: string;
  enabled: boolean;
  /** Auto-detected from `package.json` vs `pubspec.yaml` when omitted. */
  appType?: AppType;
  // meta-only overrides (submodules are separate repos with their own PR/branch mapping)
  create_pr?: Record<CreatePrEnv, boolean>;
  create_tag?: boolean;
  environments?: Record<EnvName, string | null>;
}

export interface SubprojectSelection {
  includeUmbrella: boolean;
  repos: string[];
}

export interface XEployConfig {
  type: RepoType;
  /** Auto-detected from `package.json` vs `pubspec.yaml` when omitted. */
  appType?: AppType;
  subprojectsDir: string | null;
  tag_prefix: string;
  generate_release_notes: boolean;
  create_production_release_branch: boolean;
  create_tag: boolean;
  create_pr: Record<CreatePrEnv, boolean>;
  environments: Record<EnvName, string | null>;
  subprojects?: SubprojectConfig[];
}

function defaultCreatePr(): Record<CreatePrEnv, boolean> {
  return {
    staging: false,
    uat: false,
    sandbox: false,
    production: false,
  };
}

export function mapEnvironmentsToBranches(branches: string[]): Record<EnvName, string | null> {
  const mapped = {} as Record<EnvName, string | null>;
  for (const env of ENV_NAMES) {
    const expected = DEFAULT_ENV_BRANCH_NAMES[env];
    mapped[env] = branches.includes(expected) ? expected : null;
  }
  return mapped;
}

export function detectRepoType(cwd: string): RepoType {
  if (fs.existsSync(path.join(cwd, ".gitmodules"))) {
    return "meta";
  }
  const projectCount = countProjectRoots(cwd);
  if (projectCount > 1) {
    return "mono";
  }
  return "default";
}

function countProjectRoots(cwd: string): number {
  const roots = new Set<string>();
  walkDir(cwd, (file) => {
    if (file.includes("node_modules")) {
      return;
    }
    const base = path.basename(file);
    if (base !== "package.json" && base !== "pubspec.yaml") {
      return;
    }
    const dir = path.dirname(file);
    if (isProjectRoot(dir)) {
      roots.add(dir);
    }
  });
  return roots.size;
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === "dist" || name.startsWith(".");
}

function walkDir(dir: string, onFile: (file: string) => void): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && shouldSkipDir(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

export function detectSubprojectsDir(cwd: string): string | null {
  const appsDir = path.join(cwd, "apps");
  if (fs.existsSync(appsDir) && fs.statSync(appsDir).isDirectory()) {
    return "apps";
  }

  const dirCounts = new Map<string, number>();
  walkDir(cwd, (file) => {
    const base = path.basename(file);
    if (base !== "package.json" && base !== "pubspec.yaml") {
      return;
    }
    const rel = path.relative(cwd, path.dirname(file));
    if (!rel || rel.startsWith("..")) {
      return;
    }
    const top = rel.split(path.sep)[0] ?? ".";
    if (top === ".") {
      return;
    }
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  });

  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

function discoverMonoSubprojectNames(cwd: string, subprojectsDir: string | null): string[] {
  if (!subprojectsDir) {
    return [];
  }

  const parent = path.join(cwd, subprojectsDir);
  if (!fs.existsSync(parent)) {
    return [];
  }

  const names: string[] = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) {
      continue;
    }
    if (isProjectRoot(path.join(parent, entry.name))) {
      names.push(entry.name);
    }
  }
  return names;
}

function defaultSubprojectEntry(
  repo: string,
  type: RepoType,
  branches: string[],
): SubprojectConfig {
  if (type === "meta") {
    return {
      repo,
      enabled: true,
      create_pr: defaultCreatePr(),
      create_tag: true,
      environments: mapEnvironmentsToBranches(branches),
    };
  }
  return { repo, enabled: true };
}

export function buildSubprojectsConfig(
  cwd: string,
  type: RepoType,
  subprojectsDir: string | null,
  branches: string[],
): SubprojectConfig[] {
  if (type === "meta") {
    return parseSubmodules(cwd).map((sub) => defaultSubprojectEntry(sub.name, type, branches));
  }
  if (type === "mono") {
    return discoverMonoSubprojectNames(cwd, subprojectsDir).map((name) =>
      defaultSubprojectEntry(name, type, branches),
    );
  }
  return [];
}

export function getEnabledSubprojects(config: XEployConfig): SubprojectConfig[] {
  return (config.subprojects ?? []).filter((s) => s.enabled);
}

function resolveVersionFileRel(cwd: string, dir: string, appTypeOverride?: AppType): string {
  const fileName =
    resolveVersionFileName(dir, appTypeOverride) ??
    (detectAppType(dir, appTypeOverride) === "flutter" ? "pubspec.yaml" : "package.json");
  const rel = path.relative(cwd, path.join(dir, fileName));
  assertRepoRelativePath(cwd, rel);
  return rel;
}

/**
 * Version files (`package.json` or `pubspec.yaml`, auto-detected) for the
 * umbrella/root repo plus any enabled, selected mono subprojects. Meta
 * submodules bump their own version file from within their working directory
 * instead (see meta.ts).
 */
export function resolveVersionFiles(
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): string[] {
  if (config.type !== "mono" || !config.subprojectsDir) {
    return [resolveVersionFileRel(cwd, cwd, config.appType)];
  }

  const files: string[] = [];
  if (!selection || selection.includeUmbrella) {
    files.push(resolveVersionFileRel(cwd, cwd, config.appType));
  }

  for (const sub of getEnabledSubprojects(config)) {
    if (selection && !selection.repos.includes(sub.repo)) {
      continue;
    }
    files.push(
      resolveVersionFileRel(cwd, path.join(cwd, config.subprojectsDir, sub.repo), sub.appType),
    );
  }

  return files;
}

/** Resolve the version file for a single project directory (e.g. a meta submodule). */
export function resolveVersionFileForDir(
  cwd: string,
  dir: string,
  appTypeOverride?: AppType,
): string {
  return resolveVersionFileRel(cwd, dir, appTypeOverride);
}

function sanitizeEnvironments(
  environments: Record<EnvName, string | null>,
): Record<EnvName, string | null> {
  const sanitized = { ...environments };
  for (const env of ENV_NAMES) {
    const branch = sanitized[env];
    if (branch !== null && !isValidBranchName(branch)) {
      sanitized[env] = null;
    }
  }
  return sanitized;
}

function normalizeSubprojectEntry(
  entry: Partial<SubprojectConfig>,
  defaults: SubprojectConfig,
): SubprojectConfig {
  const normalized: SubprojectConfig = {
    repo: entry.repo ?? defaults.repo,
    enabled: entry.enabled ?? defaults.enabled,
    appType: entry.appType ?? defaults.appType,
  };
  if (defaults.create_pr) {
    normalized.create_pr = { ...defaults.create_pr, ...entry.create_pr };
  }
  if (defaults.create_tag !== undefined || entry.create_tag !== undefined) {
    normalized.create_tag = entry.create_tag ?? defaults.create_tag ?? true;
  }
  if (defaults.environments) {
    normalized.environments = sanitizeEnvironments({
      ...defaults.environments,
      ...entry.environments,
    });
  }
  return normalized;
}

export function createDefaultConfig(cwd: string): XEployConfig {
  const type = detectRepoType(cwd);
  const subprojectsDir = type === "default" ? null : detectSubprojectsDir(cwd);
  const branches = listBranches(cwd);

  const config: XEployConfig = {
    type,
    appType: detectAppType(cwd),
    subprojectsDir,
    tag_prefix: detectTagPrefix(getRawTags(cwd)),
    generate_release_notes: true,
    create_production_release_branch: true,
    create_tag: true,
    create_pr: defaultCreatePr(),
    environments: mapEnvironmentsToBranches(branches),
  };

  if (type === "meta" || type === "mono") {
    config.subprojects = buildSubprojectsConfig(cwd, type, subprojectsDir, branches);
  }

  return config;
}

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILE);
}

export function configExists(cwd: string): boolean {
  return fs.existsSync(configPath(cwd));
}

export function loadConfig(cwd: string = process.cwd()): XEployConfig | null {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<XEployConfig>;
    return normalizeConfig(raw, cwd);
  } catch {
    console.warn(`[xeploy] Failed to parse ${CONFIG_FILE} — using detected defaults.`);
    return createDefaultConfig(cwd);
  }
}

function normalizeSubprojectsConfig(
  rawSubprojects: Partial<SubprojectConfig>[] | undefined,
  subprojectDefaults: SubprojectConfig[],
): SubprojectConfig[] | undefined {
  if (subprojectDefaults.length === 0) {
    if (!rawSubprojects || rawSubprojects.length === 0) {
      return undefined;
    }
    return rawSubprojects.map((entry) =>
      normalizeSubprojectEntry(entry, {
        repo: entry.repo ?? "unknown",
        enabled: true,
      }),
    );
  }

  const normalized = (rawSubprojects ?? []).map((entry) => {
    const match = subprojectDefaults.find((s) => s.repo === entry.repo);
    const base = match ?? { repo: entry.repo ?? "unknown", enabled: true };
    return normalizeSubprojectEntry(entry, base);
  });

  const repos = new Set(normalized.map((s) => s.repo));
  for (const entry of subprojectDefaults) {
    if (!repos.has(entry.repo)) {
      normalized.push(entry);
    }
  }

  return normalized;
}

function configHasMissingDefaults(raw: Partial<XEployConfig>, defaults: XEployConfig): boolean {
  if (raw.type === undefined) {
    return true;
  }
  if (raw.subprojectsDir === undefined) {
    return true;
  }
  if (raw.tag_prefix === undefined) {
    return true;
  }
  if (raw.generate_release_notes === undefined) {
    return true;
  }
  if (raw.create_production_release_branch === undefined) {
    return true;
  }
  if (raw.create_tag === undefined) {
    return true;
  }
  if (raw.create_pr === undefined) {
    return true;
  }
  if (raw.environments === undefined) {
    return true;
  }

  for (const env of CREATE_PR_ENVS) {
    if (raw.create_pr?.[env] === undefined) {
      return true;
    }
  }
  for (const env of ENV_NAMES) {
    if (raw.environments?.[env] === undefined) {
      return true;
    }
  }

  if (defaults.subprojects && defaults.subprojects.length > 0) {
    if (raw.subprojects === undefined) {
      return true;
    }
    const rawRepos = new Set(raw.subprojects.map((s) => s.repo));
    for (const entry of defaults.subprojects) {
      if (!rawRepos.has(entry.repo)) {
        return true;
      }
    }
    for (const entry of raw.subprojects) {
      if (entry.enabled === undefined) {
        return true;
      }
      const defaultEntry = defaults.subprojects.find((s) => s.repo === entry.repo);
      if (defaultEntry?.create_pr) {
        for (const env of CREATE_PR_ENVS) {
          if (entry.create_pr?.[env] === undefined) {
            return true;
          }
        }
      }
      if (defaultEntry?.create_tag !== undefined && entry.create_tag === undefined) {
        return true;
      }
      if (defaultEntry?.environments) {
        for (const env of ENV_NAMES) {
          if (entry.environments?.[env] === undefined) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function normalizeConfig(raw: Partial<XEployConfig>, cwd: string): XEployConfig {
  const defaults = createDefaultConfig(cwd);
  const subprojectDefaults = defaults.subprojects ?? [];
  const subprojects = normalizeSubprojectsConfig(raw.subprojects, subprojectDefaults);

  return {
    ...defaults,
    ...raw,
    create_pr: { ...defaults.create_pr, ...raw.create_pr },
    environments: sanitizeEnvironments({
      ...defaults.environments,
      ...raw.environments,
    }),
    subprojects,
  };
}

export function applyMissingDefaults(cwd: string = process.cwd()): {
  config: XEployConfig;
  updated: boolean;
} {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    return { config: createDefaultConfig(cwd), updated: false };
  }

  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<XEployConfig>;
  const defaults = createDefaultConfig(cwd);
  const config = normalizeConfig(raw, cwd);
  const updated = configHasMissingDefaults(raw, defaults);
  if (updated) {
    writeConfig(cwd, config);
  }
  return { config, updated };
}

export function validateConfig(config: XEployConfig, cwd: string): void {
  if (!/^[\w.-]*$/.test(config.tag_prefix)) {
    throw new Error(`Invalid tag_prefix: ${config.tag_prefix}`);
  }
  if (config.subprojectsDir) {
    assertRepoRelativePath(cwd, config.subprojectsDir);
  }
  for (const env of ENV_NAMES) {
    const branch = config.environments[env];
    if (branch !== null) {
      assertBranchName(branch);
    }
  }
  if (config.subprojects) {
    for (const entry of config.subprojects) {
      if (!entry.environments) {
        continue;
      }
      for (const env of ENV_NAMES) {
        const branch = entry.environments[env];
        if (branch !== null && branch !== undefined) {
          assertBranchName(branch);
        }
      }
    }
  }
}

export function writeConfig(cwd: string, config: XEployConfig): void {
  validateConfig(config, cwd);
  fs.writeFileSync(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`);
}

export function getSubprojectConfig(
  config: XEployConfig,
  repoName: string,
): SubprojectConfig | null {
  return config.subprojects?.find((s) => s.repo === repoName) ?? null;
}

export function isRcEnv(env: ReleaseEnv): boolean {
  return RC_ENVS.includes(env);
}

export function getConfiguredReleaseEnvs(config: XEployConfig): ReleaseEnv[] {
  return RELEASE_ENVS.filter((env) => config.environments[env] !== null);
}

export function formatConfigValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
