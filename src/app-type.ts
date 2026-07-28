import * as fs from "node:fs";
import * as path from "node:path";

export type AppType = "node" | "flutter";

export const VERSION_FILE_BY_APP_TYPE: Record<AppType, string> = {
  node: "package.json",
  flutter: "pubspec.yaml",
};

function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function looksLikeFlutterPubspec(content: string): boolean {
  if (!/^\s*version\s*:/m.test(content)) {
    return false;
  }
  if (/^\s*flutter\s*:/m.test(content)) {
    return true;
  }
  return /^\s*dependencies\s*:[\s\S]*?\n\s*flutter\s*:/m.test(content);
}

/**
 * Detect whether a directory is a Node (`package.json`) or Flutter (`pubspec.yaml`)
 * project. Flutter wins when both files exist and the pubspec looks like a Flutter app.
 */
export function detectAppType(dir: string, override?: AppType): AppType {
  if (override) {
    return override;
  }

  const pubspecPath = path.join(dir, "pubspec.yaml");
  const packagePath = path.join(dir, "package.json");
  const pubspec = readText(pubspecPath);
  const pkg = readText(packagePath);

  if (pubspec && looksLikeFlutterPubspec(pubspec)) {
    return "flutter";
  }
  if (pkg) {
    return "node";
  }
  if (pubspec) {
    return "flutter";
  }
  return "node";
}

export function resolveVersionFileName(dir: string, override?: AppType): string | null {
  const appType = detectAppType(dir, override);
  const fileName = VERSION_FILE_BY_APP_TYPE[appType];
  if (fs.existsSync(path.join(dir, fileName))) {
    return fileName;
  }
  const fallback = appType === "flutter" ? "package.json" : "pubspec.yaml";
  if (fs.existsSync(path.join(dir, fallback))) {
    return fallback;
  }
  return null;
}

export function isProjectRoot(dir: string): boolean {
  return resolveVersionFileName(dir) !== null;
}
