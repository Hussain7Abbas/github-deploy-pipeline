import * as p from "@clack/prompts";
import type { SubprojectSelection, XEployConfig } from "./config.js";
import { getSubprojectConfig, isRcEnv, resolveVersionFiles } from "./config.js";
import type { ReleasePlan } from "./flows.js";
import { executeReleasePlan, runReleaseTier } from "./flows.js";
import {
  commitSubmodulePointers,
  currentBranch,
  fetchTags,
  getLatestFinalTag,
  getLatestTag,
  getTags,
  initSubmodules,
  listSubmodules,
  pushBranch,
} from "./git.js";
import { formatGitTag } from "./semver.js";
import type { SemVer } from "./semver.js";
import { resolveSubmodulePath } from "./validate.js";

export async function runMetaRelease(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  selection?: SubprojectSelection,
): Promise<void> {
  initSubmodules(cwd);
  const allSubmodules = listSubmodules(cwd);

  if (allSubmodules.length === 0) {
    p.log.warn("No submodules found. Running umbrella release only.");
    await executeReleasePlan(plan, config, cwd, tags, {
      skipPreflight: true,
      skipSyncConfirm: true,
    });
    return;
  }

  const submodules = allSubmodules.filter((sub) => {
    const subConfig = getSubprojectConfig(config, sub.name);
    if (subConfig?.enabled === false) {
      return false;
    }
    if (selection && !selection.repos.includes(sub.name)) {
      return false;
    }
    return true;
  });

  if (submodules.length === 0) {
    p.log.info("No submodules selected. Skipping submodule releases.");
  } else {
    p.log.info(`Running ${submodules.length} submodule releases serially...`);

    for (const sub of submodules) {
      const subPath = resolveSubmodulePath(cwd, sub.path);
      const metaConfig = getSubprojectConfig(config, sub.name);
      const override = plan.perRepoTags?.[sub.name];
      const subPlan = override
        ? { ...plan, rcTag: override.rcTag, finalTag: override.finalTag }
        : plan;

      p.log.step(`[${sub.name}] Starting release`);

      try {
        fetchTags(subPath);
        const subTags = getTags(subPath);

        await executeReleasePlan(subPlan, config, subPath, subTags, {
          metaOverride: metaConfig ?? undefined,
          skipPreflight: true,
          skipSyncConfirm: true,
          submoduleRelPath: sub.path,
          repoRoot: cwd,
        });

        p.log.success(`[${sub.name}] Release complete`);
      } catch (err) {
        p.log.error(`[${sub.name}] Release failed: ${String(err)}`);
        p.cancel("Submodule release failed. Umbrella release aborted.");
        process.exit(1);
      }
    }
  }

  if (selection && !selection.includeUmbrella) {
    p.log.info("Umbrella not selected. Skipping umbrella release.");
    return;
  }

  p.log.info("All submodule releases complete. Running umbrella release...");

  await runUmbrellaRelease(
    plan,
    config,
    cwd,
    tags,
    submodules.map((s) => s.path),
  );
}

async function runUmbrellaRelease(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  submodulePaths: string[],
): Promise<void> {
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatGitTag(latest, config.tag_prefix) : null;
  const notesStartFinal = latestFinal ? formatGitTag(latestFinal, config.tag_prefix) : null;
  const versionFiles = resolveVersionFiles(config, cwd);

  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));

  if (plan.rcTag && rcEnvs.length > 0) {
    const s = p.spinner();
    s.start("Updating umbrella for RC release");
    commitSubmodulePointers(
      submodulePaths,
      `chore(release): bump submodules to ${plan.rcTag}`,
      cwd,
    );
    pushBranch(branch, cwd);
    s.stop("Submodule pointers committed and pushed");

    await runReleaseTier({
      tag: plan.rcTag,
      prerelease: true,
      envs: rcEnvs,
      versionFiles,
      notesStartTag: notesStartRc,
      branch,
      config,
      cwd,
      includeConfigIfDirty: true,
      mergePairedEnv: plan.mergePairedEnv,
      skipSyncConfirm: true,
    });
  }

  if (plan.finalTag && finalEnvs.length > 0) {
    const s = p.spinner();
    s.start("Updating umbrella for final release");
    commitSubmodulePointers(
      submodulePaths,
      `chore(release): bump submodules to ${plan.finalTag}`,
      cwd,
    );
    pushBranch(branch, cwd);
    s.stop("Submodule pointers committed and pushed");

    await runReleaseTier({
      tag: plan.finalTag,
      prerelease: false,
      envs: finalEnvs,
      versionFiles,
      notesStartTag: notesStartFinal,
      branch,
      config,
      cwd,
      includeConfigIfDirty: true,
      mergePairedEnv: plan.mergePairedEnv,
      skipSyncConfirm: true,
    });
  }
}
