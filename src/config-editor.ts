import * as p from "@clack/prompts";
import {
  CREATE_PR_ENVS,
  type CreatePrEnv,
  ENV_NAMES,
  type EnvName,
  type RepoType,
  type XEployConfig,
  applyMissingDefaults,
  buildSubprojectsConfig,
  configExists,
  createDefaultConfig,
  formatConfigValue,
  validateConfig,
  writeConfig,
} from "./config.js";
import { listBranches } from "./git.js";
import { BACK, cancelAsBack, isBack } from "./prompts-util.js";
import { isValidBranchName } from "./validate.js";

async function editBoolean(message: string, current: boolean): Promise<boolean | typeof BACK> {
  const choice = cancelAsBack(await p.confirm({ message, initialValue: current }));
  if (isBack(choice)) {
    return BACK;
  }
  return choice;
}

async function pickBranch(cwd: string, message: string): Promise<string | typeof BACK> {
  const branches = listBranches(cwd);
  if (branches.length === 0) {
    p.log.warn("No branches found.");
    const manual = cancelAsBack(
      await p.text({
        message: "Enter branch name:",
        validate: (v) => {
          if (!v) {
            return "Branch name is required";
          }
          if (!isValidBranchName(v)) {
            return "Invalid branch name";
          }
        },
      }),
    );
    if (isBack(manual) || !manual) {
      return BACK;
    }
    return manual;
  }

  const choice = cancelAsBack(
    await p.select({
      message,
      options: [
        ...branches.map((b) => ({ label: b, value: b })),
        { label: "Clear (set to null)", value: "__null__" },
      ],
    }),
  );
  if (isBack(choice)) {
    return BACK;
  }
  return choice === "__null__" ? "" : (choice as string);
}

async function editType(config: XEployConfig, cwd: string): Promise<void> {
  while (true) {
    const choice = cancelAsBack(
      await p.select<RepoType>({
        message: "Repository type",
        options: [
          { label: "default", value: "default" },
          { label: "mono", value: "mono" },
          { label: "meta", value: "meta" },
        ],
        initialValue: config.type,
      }),
    );
    if (isBack(choice)) {
      return;
    }
    config.type = choice;

    if (choice === "mono" || choice === "meta") {
      const detected = createDefaultConfig(cwd).subprojectsDir ?? "apps";
      const dir = cancelAsBack(
        await p.text({
          message: "Sub-projects directory (parent folder):",
          initialValue: config.subprojectsDir ?? detected,
        }),
      );
      if (isBack(dir)) {
        continue;
      }
      config.subprojectsDir = (dir as string) || null;
      config.subprojects = buildSubprojectsConfig(
        cwd,
        choice,
        config.subprojectsDir,
        listBranches(cwd),
      );
    } else {
      config.subprojectsDir = null;
      config.subprojects = undefined;
    }
    return;
  }
}

async function editCreatePr(createPr: Record<CreatePrEnv, boolean>, cwd: string): Promise<void> {
  void cwd;
  while (true) {
    const env = cancelAsBack(
      await p.select<CreatePrEnv>({
        message: "Select environment for create_pr",
        options: CREATE_PR_ENVS.map((e) => ({
          label: `${e}: ${createPr[e]}`,
          value: e,
        })),
      }),
    );
    if (isBack(env)) {
      return;
    }

    const value = await editBoolean(`Create PR for ${env}?`, createPr[env]);
    if (isBack(value)) {
      continue;
    }
    createPr[env] = value;
    return;
  }
}

async function editEnvironments(
  environments: Record<EnvName, string | null>,
  cwd: string,
): Promise<void> {
  while (true) {
    const env = cancelAsBack(
      await p.select<EnvName>({
        message: "Select environment to map",
        options: ENV_NAMES.map((e) => ({
          label: `${e}: ${formatConfigValue(environments[e])}`,
          value: e,
        })),
      }),
    );
    if (isBack(env)) {
      return;
    }

    const branch = await pickBranch(cwd, `Branch for "${env}" (type to filter in list):`);
    if (isBack(branch)) {
      continue;
    }
    environments[env] = branch || null;
    return;
  }
}

async function editSubprojectsConfig(config: XEployConfig, cwd: string): Promise<void> {
  if (!config.subprojects || config.subprojects.length === 0) {
    p.log.warn('No subprojects configured. Set type to "mono" or "meta" first.');
    return;
  }

  const isMeta = config.type === "meta";

  while (true) {
    const repo = cancelAsBack(
      await p.select<string>({
        message: "Select subproject",
        options: config.subprojects.map((s) => ({
          label: `${s.repo}${s.enabled ? "" : "  (disabled)"}`,
          value: s.repo,
        })),
      }),
    );
    if (isBack(repo)) {
      return;
    }

    const entry = config.subprojects.find((s) => s.repo === repo);
    if (!entry) {
      return;
    }

    while (true) {
      const fieldOptions: {
        label: string;
        value: "enabled" | "create_pr" | "create_tag" | "environments";
      }[] = [{ label: `enabled: ${entry.enabled}`, value: "enabled" }];
      if (isMeta) {
        fieldOptions.push(
          { label: `create_tag: ${entry.create_tag ?? true}`, value: "create_tag" },
          { label: "create_pr", value: "create_pr" },
          { label: "environments", value: "environments" },
        );
      }

      const field = cancelAsBack(
        await p.select({
          message: `Edit config for "${repo}"`,
          options: fieldOptions,
        }),
      );
      if (isBack(field)) {
        break;
      }

      if (field === "enabled") {
        const value = await editBoolean(`Enable "${repo}" for release/bump?`, entry.enabled);
        if (!isBack(value)) {
          entry.enabled = value;
        }
      } else if (field === "create_tag") {
        const value = await editBoolean(
          `Create git tag and GitHub release for "${repo}"?`,
          entry.create_tag ?? true,
        );
        if (!isBack(value)) {
          entry.create_tag = value;
        }
      } else if (field === "create_pr") {
        entry.create_pr ??= {
          staging: false,
          uat: false,
          sandbox: false,
          production: false,
        };
        await editCreatePr(entry.create_pr, cwd);
      } else {
        entry.environments ??= {
          develop: null,
          staging: null,
          uat: null,
          sandbox: null,
          production: null,
        };
        await editEnvironments(entry.environments, cwd);
      }
      return;
    }
  }
}

async function editSubprojectsDir(config: XEployConfig): Promise<void> {
  while (true) {
    const input = cancelAsBack(
      await p.text({
        message: "Sub-projects directory:",
        initialValue: config.subprojectsDir ?? "",
      }),
    );
    if (isBack(input)) {
      return;
    }
    config.subprojectsDir = (input as string) || null;
    return;
  }
}

type ConfigKey =
  | "type"
  | "subprojectsDir"
  | "tag_prefix"
  | "generate_release_notes"
  | "create_production_release_branch"
  | "create_tag"
  | "create_pr"
  | "environments"
  | "subprojects";

function configMenuOptions(config: XEployConfig): { label: string; value: ConfigKey }[] {
  const options: { label: string; value: ConfigKey }[] = [
    { label: `type: ${config.type}`, value: "type" },
    {
      label: `generate_release_notes: ${config.generate_release_notes}`,
      value: "generate_release_notes",
    },
    {
      label: `tag_prefix: ${formatConfigValue(config.tag_prefix) || '""'}`,
      value: "tag_prefix",
    },
    {
      label: `create_production_release_branch: ${config.create_production_release_branch}`,
      value: "create_production_release_branch",
    },
    {
      label: `create_tag: ${config.create_tag}`,
      value: "create_tag",
    },
    {
      label: `create_pr: ${formatConfigValue(config.create_pr)}`,
      value: "create_pr",
    },
    {
      label: `environments: ${formatConfigValue(config.environments)}`,
      value: "environments",
    },
  ];

  if (config.type === "mono" || config.type === "meta") {
    options.splice(1, 0, {
      label: `subprojectsDir: ${formatConfigValue(config.subprojectsDir)}`,
      value: "subprojectsDir",
    });

    const enabledCount = (config.subprojects ?? []).filter((s) => s.enabled).length;
    options.push({
      label: `subprojects: ${config.subprojects?.length ?? 0} (${enabledCount} enabled)`,
      value: "subprojects",
    });
  }

  return options;
}

export async function runConfigEditor(
  config: XEployConfig,
  cwd: string,
): Promise<typeof BACK | undefined> {
  let editing = true;

  while (editing) {
    const key = cancelAsBack(
      await p.select<ConfigKey | "done">({
        message: "Select config to edit",
        options: [...configMenuOptions(config), { label: "Done", value: "done" }],
      }),
    );
    if (isBack(key)) {
      return BACK;
    }
    if (key === "done") {
      editing = false;
      break;
    }

    switch (key) {
      case "type":
        await editType(config, cwd);
        break;
      case "subprojectsDir":
        await editSubprojectsDir(config);
        break;
      case "tag_prefix": {
        const input = cancelAsBack(
          await p.text({
            message: 'Git tag prefix (e.g. "v" for v1.0.0, leave empty for none):',
            initialValue: config.tag_prefix,
            validate: (v) => {
              if (v && !/^[\w.-]*$/.test(v)) {
                return "Prefix may only contain letters, numbers, dots, dashes, and underscores";
              }
            },
          }),
        );
        if (!isBack(input)) {
          config.tag_prefix = (input as string) ?? "";
        }
        break;
      }
      case "generate_release_notes": {
        const value = await editBoolean("Generate release notes?", config.generate_release_notes);
        if (!isBack(value)) {
          config.generate_release_notes = value;
        }
        break;
      }
      case "create_production_release_branch": {
        const value = await editBoolean(
          "Create production release branch (release/{tag_prefix}X.Y.Z)?",
          config.create_production_release_branch,
        );
        if (!isBack(value)) {
          config.create_production_release_branch = value;
        }
        break;
      }
      case "create_tag": {
        const value = await editBoolean(
          "Create git tag and GitHub release (false = bump version file only)?",
          config.create_tag,
        );
        if (!isBack(value)) {
          config.create_tag = value;
        }
        break;
      }
      case "create_pr":
        await editCreatePr(config.create_pr, cwd);
        break;
      case "environments":
        await editEnvironments(config.environments, cwd);
        break;
      case "subprojects":
        await editSubprojectsConfig(config, cwd);
        break;
    }

    validateConfig(config, cwd);
    writeConfig(cwd, config);
    p.log.success("Config saved.");
  }
}

export async function ensureConfig(cwd: string): Promise<XEployConfig> {
  if (!configExists(cwd)) {
    const create = await p.confirm({
      message: "No .xeploy.json found. Create one?",
      initialValue: true,
    });
    if (p.isCancel(create)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    if (create) {
      const config = createDefaultConfig(cwd);
      writeConfig(cwd, config);
      p.log.success("Created .xeploy.json");
      return config;
    }
    return createDefaultConfig(cwd);
  }

  const { config, updated } = applyMissingDefaults(cwd);
  if (updated) {
    p.log.success("Added missing defaults to .xeploy.json");
  }
  return config;
}
