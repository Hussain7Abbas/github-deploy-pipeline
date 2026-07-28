export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  rc: number | null; // null = final release
}

export type BumpType = "rc" | "bugfix" | "minor" | "major";

export function parseSemVer(tag: string): SemVer | null {
  const clean = tag.replace(/^v/, "");
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
  if (!m) {
    return null;
  }
  return {
    major: Number.parseInt(m[1] ?? "0"),
    minor: Number.parseInt(m[2] ?? "0"),
    patch: Number.parseInt(m[3] ?? "0"),
    rc: m[4] !== undefined ? Number.parseInt(m[4]) : null,
  };
}

export function formatSemVer(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.rc !== null ? `${base}-rc.${v.rc}` : base;
}

export function formatGitTag(v: SemVer, tagPrefix = ""): string {
  return `${tagPrefix}${formatSemVer(v)}`;
}

export function formatReleaseBranch(version: string, tagPrefix = ""): string {
  return `release/${toGitTag(version, tagPrefix)}`;
}

export function toGitTag(version: string, tagPrefix = ""): string {
  let stripped = version;
  if (tagPrefix && stripped.startsWith(tagPrefix)) {
    stripped = stripped.slice(tagPrefix.length);
  }
  const semverRe = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
  if (!semverRe.test(stripped)) {
    throw new Error(`Invalid semver tag: ${version}`);
  }
  return `${tagPrefix}${stripped}`;
}

/** rc < final for the same X.Y.Z */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  if (a.rc === null && b.rc === null) {
    return 0;
  }
  if (a.rc === null) {
    return 1;
  }
  if (b.rc === null) {
    return -1;
  }
  return a.rc - b.rc;
}

export function detectTagPrefix(rawTags: string[]): string {
  const parsed = rawTags
    .map((t) => t.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, semver: parseSemVer(raw) }))
    .filter((entry): entry is { raw: string; semver: SemVer } => entry.semver !== null);

  if (parsed.length === 0) {
    return "";
  }

  const latest = parsed.reduce((best, entry) =>
    compareSemVer(entry.semver, best.semver) > 0 ? entry : best,
  );
  const semverStr = formatSemVer(latest.semver);

  if (latest.raw === `v${semverStr}`) {
    return "v";
  }
  if (latest.raw === semverStr) {
    return "";
  }

  return latest.raw.slice(0, latest.raw.length - semverStr.length);
}

export function bumpVersion(type: BumpType, latest: SemVer | null): SemVer {
  if (!latest) {
    // Empty-repo fallback
    return type === "major"
      ? { major: 1, minor: 0, patch: 0, rc: 1 }
      : { major: 0, minor: 1, patch: 0, rc: 1 };
  }
  switch (type) {
    case "rc":
      return latest.rc !== null
        ? { ...latest, rc: latest.rc + 1 }
        : { ...latest, patch: latest.patch + 1, rc: 1 };
    case "bugfix":
      return { ...latest, patch: latest.patch + 1, rc: 1 };
    case "minor":
      return { major: latest.major, minor: latest.minor + 1, patch: 0, rc: 1 };
    case "major":
      return { major: latest.major + 1, minor: 0, patch: 0, rc: 1 };
  }
}
