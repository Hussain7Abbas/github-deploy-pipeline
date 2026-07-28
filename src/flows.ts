import * as path from "node:path";
import * as p from "@clack/prompts";
import type {
  CreatePrEnv,
  ReleaseEnv,
  SubprojectConfig,
  SubprojectSelection,
  XEployConfig,
} from "./config.js";
import {
  CONFIG_FILE,
  FINAL_ENVS,
  RC_ENVS,
  getConfiguredReleaseEnvs,
  getEnabledSubprojects,
  isRcEnv,
  resolveVersionFileForDir,
  resolveVersionFiles,
} from "./config.js";
import {
  checkRepoWriteAccess,
  createRelease,
  createReleaseBranch,
  currentBranch,
  fetchTags,
  getLatestFinalTag,
  getLatestRcTag,
  getLatestTag,
  getRcTags,
  getTags,
  ghReleaseExists,
  initSubmodules,
  listSubmodules,
  mergeOrPr,
  republishRc,
  requireCleanTree,
  resolveTagsWithSpinner,
  syncBranch,
  tagExists,
} from "./git.js";
import type { BackgroundTagFetch } from "./git.js";
import { BACK, abort, cancelAsBack, isBack } from "./prompts-util.js";
import {
  bumpVersion,
  compareSemVer,
  formatGitTag,
  formatReleaseBranch,
  formatSemVer,
  parseSemVer,
  toGitTag,
} from "./semver.js";
import type { BumpType, SemVer } from "./semver.js";
import { resolveSubmodulePath } from "./validate.js";
import { bumpVersionFiles, readProjectVersion } from "./versions.js";

function releaseNote(tag: string, notesStart: string | null, prerelease: boolean): string {
  return [
    `Tag:         ${tag}  (${prerelease ? "pre-release" : "final"})`,
    `Notes since: ${notesStart ?? "beginning of history"}`,
  ].join("\n");
}

function stripRc(version: SemVer): SemVer {
  return { ...version, rc: null };
}

function resolveBumpBase(tags: SemVer[], needsRc: boolean, needsFinal: boolean): SemVer | null {
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const latestRc = getLatestRcTag(tags);

  if (needsFinal && !needsRc) {
    if (latestFinal) {
      return latestFinal;
    }
    if (latestRc) {
      return stripRc(latestRc);
    }
    return null;
  }

  return latest;
}

function formatBumpPreview(bumped: SemVer, needsRc: boolean, needsFinal: boolean): string {
  if (needsFinal && !needsRc) {
    return formatSemVer(stripRc(bumped));
  }
  return formatSemVer(bumped);
}

/**
 * Non-interactive equivalent of `promptBumpType` for a known bump type. Used to
 * recompute per-repo target versions from each repo's own tags/versions.
 */
function computeTierTags(
  tags: SemVer[],
  bumpType: BumpType,
  needsRc: boolean,
  needsFinal: boolean,
): RepoTierTags {
  const baseForBump = resolveBumpBase(tags, needsRc, needsFinal);
  const bumped = bumpVersion(bumpType, baseForBump);
  return {
    rcTag: needsRc ? formatSemVer(bumped) : null,
    finalTag: needsFinal ? formatSemVer(stripRc(bumped)) : null,
  };
}

function displayTierTag(tags: RepoTierTags): string {
  return tags.finalTag ?? tags.rcTag ?? "(none)";
}

function baseVersionString(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function getCreatePr(
  config: XEployConfig,
  env: CreatePrEnv,
  metaOverride?: SubprojectConfig,
): boolean {
  if (metaOverride?.create_pr) {
    return metaOverride.create_pr[env];
  }
  return config.create_pr[env];
}

function getCreateTag(config: XEployConfig, metaOverride?: SubprojectConfig): boolean {
  if (metaOverride?.create_tag !== undefined) {
    return metaOverride.create_tag;
  }
  return config.create_tag;
}

function getMetaEnvBranch(
  config: XEployConfig,
  env: ReleaseEnv,
  metaOverride?: SubprojectConfig,
): string | null {
  if (metaOverride?.environments) {
    return metaOverride.environments[env];
  }
  return config.environments[env];
}

const UMBRELLA_SELECTION = "__umbrella__";

export async function promptSubprojectSelection(
  config: XEployConfig,
): Promise<SubprojectSelection | typeof BACK> {
  if (config.type !== "mono" && config.type !== "meta") {
    return { includeUmbrella: true, repos: [] };
  }

  const enabled = getEnabledSubprojects(config);
  if (enabled.length === 0) {
    return { includeUmbrella: true, repos: [] };
  }

  const options = [
    { label: "Umbrella (this repo)", value: UMBRELLA_SELECTION },
    ...enabled.map((s) => ({ label: s.repo, value: s.repo })),
  ];

  const selected = cancelAsBack(
    await p.multiselect<string>({
      message: "Select repos to bump",
      options,
      initialValues: options.map((o) => o.value),
      required: false,
    }),
  );
  if (isBack(selected)) {
    return BACK;
  }

  return {
    includeUmbrella: selected.includes(UMBRELLA_SELECTION),
    repos: selected.filter((v) => v !== UMBRELLA_SELECTION),
  };
}

export function verifySelectedRepoAccess(
  config: XEployConfig,
  cwd: string,
  selection: SubprojectSelection,
): boolean {
  const s = p.spinner();
  s.start("Checking repository access");

  const checks = [];

  if (config.type === "meta") {
    initSubmodules(cwd);
    const submoduleByName = new Map(listSubmodules(cwd).map((sub) => [sub.name, sub]));

    if (selection.includeUmbrella) {
      checks.push(checkRepoWriteAccess(cwd, "Umbrella (this repo)"));
    }

    for (const repoName of selection.repos) {
      const sub = submoduleByName.get(repoName);
      if (!sub) {
        checks.push({
          label: repoName,
          slug: "(unknown)",
          ok: false,
          error: "Submodule not found in .gitmodules",
        });
        continue;
      }
      checks.push(checkRepoWriteAccess(resolveSubmodulePath(cwd, sub.path), repoName));
    }
  } else if (config.type === "mono") {
    if (selection.includeUmbrella || selection.repos.length > 0) {
      checks.push(checkRepoWriteAccess(cwd, "This repo"));
    }
  } else {
    checks.push(checkRepoWriteAccess(cwd, "This repo"));
  }

  if (checks.length === 0) {
    s.stop("No repositories selected");
    return true;
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    s.stop("Repository access verified");
    return true;
  }

  s.stop("Repository access check failed");
  for (const check of failed) {
    p.log.error(`${check.label} (${check.slug}): ${check.error ?? "No write access"}`);
  }
  if (config.type === "meta" || config.type === "mono") {
    p.log.error("Deselect inaccessible repos or request access before deploying.");
  } else {
    p.log.error("Request write access before deploying.");
  }
  return false;
}

async function promptBumpType(
  tags: SemVer[],
  needsRc: boolean,
  needsFinal: boolean,
  cwd: string,
  tagPrefix: string,
): Promise<
  { rcTag: string | null; finalTag: string | null; bumpType: BumpType | "custom" } | typeof BACK
> {
  const latest = getLatestTag(tags);
  const baseForBump = resolveBumpBase(tags, needsRc, needsFinal);
  const latestStr = latest ? formatSemVer(latest) : "(none)";
  const baseStr = baseForBump ? formatSemVer(baseForBump) : "(none)";

  while (true) {
    const rcOptions = needsRc
      ? [
          {
            label: `Release Candidate  →  ${formatSemVer(bumpVersion("rc", latest))}`,
            value: "rc" as BumpType,
          },
        ]
      : [];

    const bumpOptions = [
      ...rcOptions,
      {
        label: `Bug Fix            →  ${formatBumpPreview(bumpVersion("bugfix", baseForBump), needsRc, needsFinal)}`,
        value: "bugfix" as BumpType,
      },
      {
        label: `Minor              →  ${formatBumpPreview(bumpVersion("minor", baseForBump), needsRc, needsFinal)}`,
        value: "minor" as BumpType,
      },
      {
        label: `Major              →  ${formatBumpPreview(bumpVersion("major", baseForBump), needsRc, needsFinal)}`,
        value: "major" as BumpType,
      },
      { label: "Custom", value: "custom" as const },
    ];

    const bumpChoice = cancelAsBack(
      await p.select<BumpType | "custom">({
        message: `Select bump type  (current latest: ${needsFinal && !needsRc ? baseStr : latestStr})`,
        options: bumpOptions,
      }),
    );
    if (isBack(bumpChoice)) {
      return BACK;
    }

    if (bumpChoice === "custom") {
      const compareBase = baseForBump ?? latest;
      const compareStr = compareBase ? formatSemVer(compareBase) : "(none)";

      while (true) {
        const customTag = cancelAsBack(
          await p.text({
            message:
              needsRc && !needsFinal
                ? "Enter custom version (e.g. 1.2.3-rc.1):"
                : "Enter custom version (e.g. 1.2.3 or 1.2.3-rc.1):",
            validate: (v) => {
              if (!v) {
                return "Version is required";
              }
              if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(v)) {
                return "Format must be X.Y.Z or X.Y.Z-rc.N";
              }
              if (tagExists(v, cwd, tagPrefix)) {
                return `Tag "${toGitTag(v, tagPrefix)}" already exists`;
              }
              const parsed = parseSemVer(v);
              if (parsed && compareBase && compareSemVer(parsed, compareBase) <= 0) {
                return `Version must be greater than current latest "${compareStr}"`;
              }
            },
          }),
        );
        if (isBack(customTag)) {
          break;
        }
        const parsed = parseSemVer(customTag as string);
        if (!parsed) {
          abort();
        }
        const rcTag = parsed.rc !== null ? (customTag as string) : null;
        const finalTag = parsed.rc === null ? (customTag as string) : formatSemVer(stripRc(parsed));
        return {
          rcTag: needsRc ? (rcTag ?? formatSemVer({ ...parsed, rc: parsed.rc ?? 1 })) : null,
          finalTag: needsFinal ? finalTag : null,
          bumpType: "custom",
        };
      }
      continue;
    }

    const tierTags = computeTierTags(tags, bumpChoice as BumpType, needsRc, needsFinal);
    return { ...tierTags, bumpType: bumpChoice as BumpType };
  }
}

export interface RepoTierTags {
  rcTag: string | null;
  finalTag: string | null;
}

export interface ReleasePlan {
  selectedEnvs: ReleaseEnv[];
  rcTag: string | null;
  finalTag: string | null;
  /** Bump type chosen for this release (used to recompute per-repo targets). */
  bumpType?: BumpType | "custom";
  /**
   * Per-repo target versions keyed by repo/subproject name, used when the
   * user opts to bump inconsistent repos separately. The umbrella keeps the
   * top-level `rcTag`/`finalTag`.
   */
  perRepoTags?: Record<string, RepoTierTags>;
  /** Merge into paired env (decided upfront after version selection). */
  mergePairedEnv?: boolean;
}

const RELEASE_ENV_LABELS: Record<ReleaseEnv, string> = {
  staging: "staging release   (RC)",
  uat: "uat release       (RC)",
  sandbox: "sandbox release   (final)",
  production: "production release (final)",
};

const PAIRED_RELEASE_ENVS: Partial<Record<ReleaseEnv, ReleaseEnv>> = {
  staging: "uat",
  uat: "staging",
  sandbox: "production",
  production: "sandbox",
};

function getPairedReleaseEnv(env: ReleaseEnv): ReleaseEnv | null {
  return PAIRED_RELEASE_ENVS[env] ?? null;
}

async function promptMergePairedEnv(
  pairedEnv: ReleaseEnv,
  config: XEployConfig,
  metaOverride?: SubprojectConfig,
): Promise<boolean> {
  const createPr = getCreatePr(config, pairedEnv, metaOverride);
  const message = createPr ? `Open PR into ${pairedEnv}?` : `Also merge into ${pairedEnv}?`;

  const merge = await p.confirm({
    message,
    initialValue: false,
  });
  if (p.isCancel(merge)) {
    abort();
  }
  return merge;
}

async function promptMergePairedEnvUpfront(
  plan: ReleasePlan,
  config: XEployConfig,
): Promise<ReleasePlan | typeof BACK> {
  const primaryEnv = plan.selectedEnvs[0];
  if (!primaryEnv) {
    return plan;
  }

  const pairedEnv = getPairedReleaseEnv(primaryEnv);
  if (!pairedEnv) {
    return plan;
  }

  const createPr = getCreatePr(config, pairedEnv);
  const repoScope =
    config.type === "meta" || config.type === "mono" ? " for all selected repos" : "";
  const message = createPr
    ? `Open PR into ${pairedEnv}${repoScope}?`
    : `Also merge into ${pairedEnv}${repoScope}?`;

  const merge = cancelAsBack(
    await p.confirm({
      message,
      initialValue: false,
    }),
  );
  if (isBack(merge)) {
    return BACK;
  }

  return { ...plan, mergePairedEnv: merge };
}

export async function planRelease(
  config: XEployConfig,
  tagFetch: BackgroundTagFetch,
  cwd: string,
): Promise<ReleasePlan | typeof BACK> {
  const availableEnvs = getConfiguredReleaseEnvs(config);
  if (availableEnvs.length === 0) {
    p.cancel("No release environments configured in .xeploy.json.");
    process.exit(1);
  }

  while (true) {
    const selected = cancelAsBack(
      await p.select<ReleaseEnv>({
        message: "Select release environment",
        options: availableEnvs.map((env) => ({
          label: RELEASE_ENV_LABELS[env],
          value: env,
        })),
      }),
    );
    if (isBack(selected)) {
      return BACK;
    }

    const needsRc = RC_ENVS.includes(selected);
    const needsFinal = FINAL_ENVS.includes(selected);

    while (true) {
      const tags = await resolveTagsWithSpinner(tagFetch, cwd);
      const bumpResult = await promptBumpType(tags, needsRc, needsFinal, cwd, config.tag_prefix);
      if (isBack(bumpResult)) {
        break;
      }
      return {
        selectedEnvs: [selected],
        rcTag: bumpResult.rcTag,
        finalTag: bumpResult.finalTag,
        bumpType: bumpResult.bumpType,
      };
    }
  }
}

interface RepoVersionInfo {
  key: string;
  label: string;
  isUmbrella: boolean;
  tags: SemVer[];
  latest: SemVer | null;
}

function gatherMetaRepoVersions(cwd: string, selection: SubprojectSelection): RepoVersionInfo[] {
  const infos: RepoVersionInfo[] = [];

  if (selection.includeUmbrella) {
    const tags = getTags(cwd);
    infos.push({
      key: UMBRELLA_SELECTION,
      label: "Umbrella (this repo)",
      isUmbrella: true,
      tags,
      latest: getLatestTag(tags),
    });
  }

  initSubmodules(cwd);
  const byName = new Map(listSubmodules(cwd).map((sub) => [sub.name, sub]));
  for (const repo of selection.repos) {
    const sub = byName.get(repo);
    if (!sub) {
      continue;
    }
    const subPath = resolveSubmodulePath(cwd, sub.path);
    fetchTags(subPath);
    const tags = getTags(subPath);
    infos.push({
      key: repo,
      label: repo,
      isUmbrella: false,
      tags,
      latest: getLatestTag(tags),
    });
  }

  return infos;
}

function gatherMonoRepoVersions(
  config: XEployConfig,
  cwd: string,
  selection: SubprojectSelection,
): RepoVersionInfo[] {
  const infos: RepoVersionInfo[] = [];

  if (selection.includeUmbrella) {
    const latest = readProjectVersion(cwd);
    infos.push({
      key: UMBRELLA_SELECTION,
      label: "Umbrella (this repo)",
      isUmbrella: true,
      tags: latest ? [latest] : [],
      latest,
    });
  }

  if (config.subprojectsDir) {
    const enabled = new Set(getEnabledSubprojects(config).map((s) => s.repo));
    for (const repo of selection.repos) {
      if (!enabled.has(repo)) {
        continue;
      }
      const latest = readProjectVersion(path.join(cwd, config.subprojectsDir, repo), undefined);
      infos.push({
        key: repo,
        label: repo,
        isUmbrella: false,
        tags: latest ? [latest] : [],
        latest,
      });
    }
  }

  return infos;
}

function versionsInconsistent(infos: RepoVersionInfo[]): boolean {
  const bases = infos.map((i) => (i.latest ? baseVersionString(i.latest) : "(none)"));
  return new Set(bases).size > 1;
}

function highestRepoVersion(infos: RepoVersionInfo[]): RepoVersionInfo {
  return infos.reduce((highest, info) => {
    if (!info.latest) {
      return highest;
    }
    if (!highest.latest) {
      return info;
    }
    return compareSemVer(info.latest, highest.latest) > 0 ? info : highest;
  });
}

/**
 * When selected repos have inconsistent latest versions, ask whether to bump
 * each repo from its own version or unify everything to the highest version.
 * Returns the plan possibly augmented with `perRepoTags` (separate) or with the
 * umbrella tags rewritten to the unified (highest-based) target.
 */
async function resolveRepoVersionConsistency(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  selection: SubprojectSelection,
): Promise<ReleasePlan | typeof BACK> {
  if (config.type !== "meta" && config.type !== "mono") {
    return plan;
  }
  if (!plan.bumpType || plan.bumpType === "custom") {
    return plan;
  }
  if (selection.repos.length === 0) {
    return plan;
  }

  const needsRc = plan.selectedEnvs.some((e) => RC_ENVS.includes(e));
  const needsFinal = plan.selectedEnvs.some((e) => FINAL_ENVS.includes(e));

  const s = p.spinner();
  s.start("Checking repo versions");
  const infos =
    config.type === "meta"
      ? gatherMetaRepoVersions(cwd, selection)
      : gatherMonoRepoVersions(config, cwd, selection);
  s.stop("Repo versions checked");

  if (infos.length < 2 || !versionsInconsistent(infos)) {
    return plan;
  }

  const bumpType = plan.bumpType;
  const separate = infos.map((info) => ({
    info,
    tags: computeTierTags(info.tags, bumpType, needsRc, needsFinal),
  }));
  const unifyTags = computeTierTags(highestRepoVersion(infos).tags, bumpType, needsRc, needsFinal);

  const separateLabel = `Bump each version separately (${separate
    .map((e) => `${e.info.label}: ${displayTierTag(e.tags)}`)
    .join(", ")})`;
  const unifyLabel = `Unify them to ${displayTierTag(unifyTags)}`;

  const currentList = infos
    .map((i) => `${i.label}: ${i.latest ? formatSemVer(i.latest) : "(none)"}`)
    .join("\n");

  const choice = cancelAsBack(
    await p.select<"separate" | "unify">({
      message: `The latest versions of selected repos are different:\n${currentList}\n\nHow would you like to bump?`,
      options: [
        { label: separateLabel, value: "separate" },
        { label: unifyLabel, value: "unify" },
      ],
    }),
  );
  if (isBack(choice)) {
    return BACK;
  }

  if (choice === "unify") {
    return {
      ...plan,
      rcTag: unifyTags.rcTag,
      finalTag: unifyTags.finalTag,
      perRepoTags: undefined,
    };
  }

  const perRepoTags: Record<string, RepoTierTags> = {};
  let umbrellaTags: RepoTierTags = { rcTag: plan.rcTag, finalTag: plan.finalTag };
  for (const entry of separate) {
    if (entry.info.isUmbrella) {
      umbrellaTags = entry.tags;
    } else {
      perRepoTags[entry.info.key] = entry.tags;
    }
  }

  return {
    ...plan,
    rcTag: umbrellaTags.rcTag,
    finalTag: umbrellaTags.finalTag,
    perRepoTags,
  };
}

function monoFileVersionsForTier(
  config: XEployConfig,
  plan: ReleasePlan,
  tier: "rc" | "final",
  cwd: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!plan.perRepoTags || !config.subprojectsDir) {
    return map;
  }
  for (const [repo, tierTags] of Object.entries(plan.perRepoTags)) {
    const version = tier === "rc" ? tierTags.rcTag : tierTags.finalTag;
    if (!version) {
      continue;
    }
    const sub = getEnabledSubprojects(config).find((s) => s.repo === repo);
    map[resolveVersionFileForDir(cwd, path.join(cwd, config.subprojectsDir, repo), sub?.appType)] =
      version;
  }
  return map;
}

async function preflightReleasePlan(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  options?: { skipSummary?: boolean },
): Promise<true | typeof BACK> {
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatGitTag(latest, config.tag_prefix) : null;
  const notesStartFinal = latestFinal ? formatGitTag(latestFinal, config.tag_prefix) : null;

  if (!options?.skipSummary) {
    const summaryLines: string[] = [];
    if (plan.rcTag) {
      summaryLines.push(releaseNote(toGitTag(plan.rcTag, config.tag_prefix), notesStartRc, true));
    }
    if (plan.finalTag) {
      summaryLines.push(
        releaseNote(toGitTag(plan.finalTag, config.tag_prefix), notesStartFinal, false),
      );
    }
    summaryLines.push(`Branch: ${branch}`);
    summaryLines.push(`Environments: ${plan.selectedEnvs.join(", ")}`);
    const primaryEnv = plan.selectedEnvs[0];
    if (primaryEnv) {
      const pairedEnv = getPairedReleaseEnv(primaryEnv);
      if (pairedEnv && plan.mergePairedEnv !== undefined) {
        const scope = config.type === "meta" || config.type === "mono" ? " (all repos)" : "";
        summaryLines.push(
          `Also sync to ${pairedEnv}: ${plan.mergePairedEnv ? "yes" : "no"}${scope}`,
        );
      }
    }
    if (config.type === "meta") {
      summaryLines.push("Mode: meta (submodules serial, then umbrella)");
    }

    if (plan.perRepoTags && Object.keys(plan.perRepoTags).length > 0) {
      const perRepoLines = Object.entries(plan.perRepoTags).map(
        ([repo, tierTags]) => `  ${repo}: ${displayTierTag(tierTags)}`,
      );
      summaryLines.push(["Per-repo versions (separate bump):", ...perRepoLines].join("\n"));
    }

    p.note(summaryLines.join("\n\n"), "Release summary");
  }

  const ok = cancelAsBack(await p.confirm({ message: "Proceed?", initialValue: true }));
  if (isBack(ok)) {
    return BACK;
  }
  if (!ok) {
    abort();
  }

  requireCleanTree(cwd, { allowOnly: [CONFIG_FILE] });
  return true;
}

export async function runReleaseTier(opts: {
  tag: string;
  prerelease: boolean;
  envs: ReleaseEnv[];
  versionFiles: string[];
  notesStartTag: string | null;
  branch: string;
  config: XEployConfig;
  cwd: string;
  metaOverride?: SubprojectConfig;
  includeConfigIfDirty?: boolean;
  mergePairedEnv?: boolean;
  skipSyncConfirm?: boolean;
  fileVersions?: Record<string, string>;
}): Promise<void> {
  const tagPrefix = opts.config.tag_prefix;
  const createTag = getCreateTag(opts.config, opts.metaOverride);

  if (opts.envs.length === 0) {
    return;
  }

  const s = p.spinner();
  s.start(`Bumping version to ${opts.tag}`);
  bumpVersionFiles(opts.tag, opts.versionFiles, opts.cwd, {
    includeConfigIfDirty: opts.includeConfigIfDirty,
    fileVersions: opts.fileVersions,
  });
  s.stop("Version bumped, committed, and pushed");

  if (createTag) {
    s.start(`Creating ${opts.prerelease ? "pre-" : ""}release ${toGitTag(opts.tag, tagPrefix)}`);
    createRelease({
      tag: opts.tag,
      prerelease: opts.prerelease,
      notesStartTag: opts.notesStartTag,
      branch: opts.branch,
      generateReleaseNotes: opts.config.generate_release_notes,
      tagPrefix,
      cwd: opts.cwd,
    });
    s.stop(`Release ${toGitTag(opts.tag, tagPrefix)} created`);
  } else {
    p.log.info(`Skipping tag creation for ${toGitTag(opts.tag, tagPrefix)} (create_tag: false)`);
  }

  for (const env of opts.envs) {
    await handleEnvPostRelease({
      env,
      tag: opts.tag,
      config: opts.config,
      branch: opts.branch,
      metaOverride: opts.metaOverride,
      cwd: opts.cwd,
      skipSyncConfirm: opts.skipSyncConfirm,
    });

    const pairedEnv = getPairedReleaseEnv(env);
    if (!pairedEnv) {
      continue;
    }

    const pairedBranch = getMetaEnvBranch(opts.config, pairedEnv, opts.metaOverride);
    if (!pairedBranch) {
      continue;
    }

    const mergePaired =
      opts.mergePairedEnv !== undefined
        ? opts.mergePairedEnv
        : await promptMergePairedEnv(pairedEnv, opts.config, opts.metaOverride);
    if (!mergePaired) {
      continue;
    }

    await handleEnvPostRelease({
      env: pairedEnv,
      tag: opts.tag,
      config: opts.config,
      branch: opts.branch,
      metaOverride: opts.metaOverride,
      cwd: opts.cwd,
      skipSyncConfirm: opts.skipSyncConfirm,
    });
  }
}

export async function executeReleasePlan(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  options?: {
    metaOverride?: SubprojectConfig;
    skipPreflight?: boolean;
    skipSummary?: boolean;
    submoduleRelPath?: string;
    repoRoot?: string;
    selection?: SubprojectSelection;
    skipSyncConfirm?: boolean;
  },
): Promise<void> {
  if (!options?.skipPreflight) {
    await preflightReleasePlan(plan, config, cwd, tags, {
      skipSummary: options?.skipSummary,
    });
  } else {
    const allowOnly = options?.submoduleRelPath ? undefined : [CONFIG_FILE];
    requireCleanTree(cwd, { allowOnly });
  }

  const repoRoot = options?.repoRoot ?? cwd;
  const versionFiles = options?.submoduleRelPath
    ? [resolveVersionFileForDir(cwd, cwd, options.metaOverride?.appType)]
    : resolveVersionFiles(config, repoRoot, options?.selection);
  const metaOverride = options?.metaOverride;
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatGitTag(latest, config.tag_prefix) : null;
  const notesStartFinal = latestFinal ? formatGitTag(latestFinal, config.tag_prefix) : null;

  const includeConfigIfDirty = !options?.submoduleRelPath;
  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));

  // Per-file version overrides only apply to the umbrella version file set of
  // a mono repo. Meta submodules bump their own version file from their own
  // (already per-repo overridden) plan, so they don't use file overrides.
  const isMono = config.type === "mono" && !options?.submoduleRelPath;

  const tierOpts = {
    mergePairedEnv: plan.mergePairedEnv,
    skipSyncConfirm: options?.skipSyncConfirm,
  };

  if (plan.rcTag) {
    await runReleaseTier({
      tag: plan.rcTag,
      prerelease: true,
      envs: rcEnvs,
      versionFiles,
      notesStartTag: notesStartRc,
      branch,
      config,
      cwd,
      metaOverride,
      includeConfigIfDirty,
      fileVersions: isMono ? monoFileVersionsForTier(config, plan, "rc", repoRoot) : undefined,
      ...tierOpts,
    });
  }

  if (plan.finalTag) {
    await runReleaseTier({
      tag: plan.finalTag,
      prerelease: false,
      envs: finalEnvs,
      versionFiles,
      notesStartTag: notesStartFinal,
      branch,
      cwd,
      config,
      metaOverride,
      includeConfigIfDirty,
      fileVersions: isMono ? monoFileVersionsForTier(config, plan, "final", repoRoot) : undefined,
      ...tierOpts,
    });
  }
}

export async function handleEnvPostRelease(opts: {
  env: ReleaseEnv;
  tag: string;
  config: XEployConfig;
  branch: string;
  metaOverride?: SubprojectConfig;
  cwd: string;
  skipSyncConfirm?: boolean;
}): Promise<void> {
  const envBranch = getMetaEnvBranch(opts.config, opts.env, opts.metaOverride);
  if (!envBranch) {
    p.note(`Environment "${opts.env}" has no branch mapped — skipping.`, "Skipped");
    return;
  }

  let sourceBranch = opts.branch;

  if (opts.env === "production" && opts.config.create_production_release_branch) {
    const releaseBranch = formatReleaseBranch(opts.tag, opts.config.tag_prefix);
    const s = p.spinner();
    s.start(`Creating release branch ${releaseBranch}`);
    try {
      createReleaseBranch(releaseBranch, opts.branch, opts.cwd);
      sourceBranch = releaseBranch;
      s.stop(`Release branch ${releaseBranch} created`);
    } catch {
      s.stop("Failed to create release branch");
      p.log.error("Could not create release branch. Continuing with current branch.");
    }
  }

  const createPr = getCreatePr(opts.config, opts.env, opts.metaOverride);
  const createTag = getCreateTag(opts.config, opts.metaOverride);
  const prTitle = `Release ${opts.tag} → ${opts.env}`;

  if (createPr) {
    await mergeOrPr({
      envBranch,
      sourceBranch,
      tag: opts.tag,
      createPr: true,
      prTitle,
      checkoutBranch: opts.branch,
      tagPrefix: opts.config.tag_prefix,
      cwd: opts.cwd,
      skipSyncConfirm: opts.skipSyncConfirm,
      pushTagOnSync: createTag,
    });
  } else {
    await syncBranch(
      envBranch,
      opts.tag,
      sourceBranch,
      opts.cwd,
      opts.branch,
      opts.config.tag_prefix,
      opts.skipSyncConfirm,
      createTag,
    );
  }
}

export async function flowNewRelease(
  tagFetch: BackgroundTagFetch,
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): Promise<typeof BACK | undefined> {
  while (true) {
    let plan = await planRelease(config, tagFetch, cwd);
    if (isBack(plan)) {
      return BACK;
    }

    if (selection) {
      const resolved = await resolveRepoVersionConsistency(plan, config, cwd, selection);
      if (isBack(resolved)) {
        continue;
      }
      plan = resolved;
    }

    const withMerge = await promptMergePairedEnvUpfront(plan, config);
    if (isBack(withMerge)) {
      continue;
    }
    plan = withMerge;

    const tags = await resolveTagsWithSpinner(tagFetch, cwd);
    const preflight = await preflightReleasePlan(plan, config, cwd, tags);
    if (isBack(preflight)) {
      continue;
    }

    if (config.type === "meta") {
      const { runMetaRelease } = await import("./meta.js");
      await runMetaRelease(plan, config, cwd, tags, selection);
      return;
    }

    await executeReleasePlan(plan, config, cwd, tags, {
      skipPreflight: true,
      skipSyncConfirm: true,
      selection,
    });
    return;
  }
}

export async function flowOldRelease(
  tagFetch: BackgroundTagFetch,
  config: XEployConfig,
  cwd: string,
): Promise<typeof BACK | undefined> {
  const tags = await resolveTagsWithSpinner(tagFetch, cwd);
  const rcTags = getRcTags(tags);
  if (rcTags.length === 0) {
    p.cancel("No release candidate tags found.");
    process.exit(1);
  }

  while (true) {
    const chosen = cancelAsBack(
      await p.select<string>({
        message: "Select a previous RC release",
        options: rcTags.map((v) => ({
          label: formatSemVer(v),
          value: formatSemVer(v),
        })),
      }),
    );
    if (isBack(chosen)) {
      return BACK;
    }

    while (true) {
      const action = cancelAsBack(
        await p.select<"promote" | "republish">({
          message: `What to do with ${chosen}?`,
          options: [
            {
              label: `Promote to production  →  ${(chosen as string).replace(/-rc\.\d+$/, "")}  (final)`,
              value: "promote",
            },
            {
              label: `Re-publish as same RC  →  ${chosen}`,
              value: "republish",
            },
          ],
        }),
      );
      if (isBack(action)) {
        break;
      }

      if (action === "republish") {
        if (!config.create_tag) {
          p.log.warn("create_tag is false — re-publish requires tag creation.");
          continue;
        }

        const alreadyExists = ghReleaseExists(chosen as string, cwd, config.tag_prefix);
        p.note(
          [
            `Tag: ${toGitTag(chosen as string, config.tag_prefix)}  (pre-release, unchanged)`,
            alreadyExists ? "Existing GitHub release will be deleted and re-created." : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "Re-publish summary",
        );

        while (true) {
          const ok = cancelAsBack(await p.confirm({ message: "Proceed?", initialValue: true }));
          if (isBack(ok)) {
            break;
          }
          if (!ok) {
            abort();
          }
          const s = p.spinner();
          s.start(`Re-publishing ${toGitTag(chosen as string, config.tag_prefix)}`);
          republishRc(chosen as string, {
            generateReleaseNotes: config.generate_release_notes,
            tagPrefix: config.tag_prefix,
            cwd,
          });
          s.stop(`Re-published ${toGitTag(chosen as string, config.tag_prefix)}`);
          return;
        }
        continue;
      }

      const parsed = parseSemVer(chosen as string);
      if (!parsed) {
        p.cancel("Invalid tag selected.");
        process.exit(1);
      }
      const finalVer: SemVer = { ...parsed, rc: null };
      const finalTag = formatSemVer(finalVer);
      const latestFinal = getLatestFinalTag(tags);
      const notesStartTag = latestFinal ? formatGitTag(latestFinal, config.tag_prefix) : null;
      const branch = currentBranch(cwd);
      const productionBranch = config.environments.production;
      const versionFiles = resolveVersionFiles(config, cwd);

      p.note(
        [
          `Source RC:   ${chosen}`,
          releaseNote(finalTag, notesStartTag, false),
          `Branch:      ${branch}`,
          `Version files: ${versionFiles.join(", ")}`,
        ].join("\n"),
        "Promote summary",
      );

      while (true) {
        const ok = cancelAsBack(await p.confirm({ message: "Proceed?", initialValue: true }));
        if (isBack(ok)) {
          break;
        }
        if (!ok) {
          abort();
        }

        requireCleanTree(cwd);

        const s = p.spinner();
        s.start(`Bumping version to ${finalTag}`);
        bumpVersionFiles(finalTag, versionFiles, cwd);
        s.stop("Version bumped, committed, and pushed");

        if (config.create_tag) {
          s.start(`Creating final release ${toGitTag(finalTag, config.tag_prefix)}`);
          createRelease({
            tag: finalTag,
            prerelease: false,
            notesStartTag,
            branch,
            generateReleaseNotes: config.generate_release_notes,
            tagPrefix: config.tag_prefix,
            cwd,
          });
          s.stop(`Release ${toGitTag(finalTag, config.tag_prefix)} created`);
        } else {
          p.log.info(
            `Skipping tag creation for ${toGitTag(finalTag, config.tag_prefix)} (create_tag: false)`,
          );
        }

        if (productionBranch) {
          let sourceBranch = branch;
          if (config.create_production_release_branch) {
            const releaseBranch = formatReleaseBranch(finalTag, config.tag_prefix);
            const rs = p.spinner();
            rs.start(`Creating release branch ${releaseBranch}`);
            try {
              createReleaseBranch(releaseBranch, branch, cwd);
              sourceBranch = releaseBranch;
              rs.stop(`Release branch ${releaseBranch} created`);
            } catch {
              rs.stop("Failed to create release branch");
            }
          }

          if (config.create_pr.production) {
            await mergeOrPr({
              envBranch: productionBranch,
              sourceBranch,
              tag: finalTag,
              createPr: true,
              prTitle: `Release ${finalTag} → production`,
              checkoutBranch: branch,
              tagPrefix: config.tag_prefix,
              cwd,
              pushTagOnSync: config.create_tag,
            });
          } else {
            await syncBranch(
              productionBranch,
              finalTag,
              sourceBranch,
              cwd,
              branch,
              config.tag_prefix,
              false,
              config.create_tag,
            );
          }
        }
        return;
      }
    }
  }
}
