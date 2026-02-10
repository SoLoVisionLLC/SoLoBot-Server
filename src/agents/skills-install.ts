import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { OpenClawConfig } from "../config/config.js";
import { resolveBrewExecutable } from "../infra/brew.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";
import { CONFIG_DIR, ensureDir, resolveUserPath } from "../utils.js";
import {
  hasBinary,
  loadWorkspaceSkillEntries,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveSkillKey } from "./skills/frontmatter.js";

export type SkillInstallRequest = {
  workspaceDir: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
  config?: OpenClawConfig;
};

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
  warnings?: string[];
};

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function detectPlatformIncompatibilityHint(output: string): string | undefined {
  const hay = output.toLowerCase();

  // brew formula requirement style (common for arch-specific tools).
  if (hay.includes("required: arm64") || hay.includes("arm64 architecture")) {
    if (process.arch !== "arm64") {
      return `Not supported on this machine architecture (requires arm64; current ${process.arch}).`;
    }
  }

  // Generic platform mismatch hints.
  if (hay.includes("requires macos") || hay.includes("macos is required")) {
    if (process.platform !== "darwin") {
      return `Not supported on this OS (requires macOS; current ${process.platform}).`;
    }
  }
  if (hay.includes("requires linux") || hay.includes("linux is required")) {
    if (process.platform !== "linux") {
      return `Not supported on this OS (requires Linux; current ${process.platform}).`;
    }
  }

  return undefined;
}

function summarizeInstallOutput(text: string): string | undefined {
  const raw = text.trim();
  if (!raw) {
    return undefined;
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const preferred =
    lines.find((line) => /^error\b/i.test(line)) ??
    lines.find((line) => /\b(err!|error:|failed)\b/i.test(line)) ??
    lines.at(-1);

  if (!preferred) {
    return undefined;
  }
  const normalized = preferred.replace(/\s+/g, " ").trim();
  const maxLen = 200;
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function formatInstallFailureMessage(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): string {
  const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
  const summary = summarizeInstallOutput(result.stderr) ?? summarizeInstallOutput(result.stdout);
  const hint = detectPlatformIncompatibilityHint(`${result.stderr}
${result.stdout}`);
  if (!summary) {
    return hint ? `Install failed (${code}): ${hint}` : `Install failed (${code})`;
  }
  return hint ? `Install failed (${code}): ${hint} ${summary}` : `Install failed (${code}): ${summary}`;
}

function withWarnings(result: SkillInstallResult, warnings: string[]): SkillInstallResult {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings: warnings.slice(),
  };
}

function formatScanFindingDetail(
  rootDir: string,
  finding: { message: string; file: string; line: number },
): string {
  const relativePath = path.relative(rootDir, finding.file);
  const filePath =
    relativePath && relativePath !== "." && !relativePath.startsWith("..")
      ? relativePath
      : path.basename(finding.file);
  return `${finding.message} (${filePath}:${finding.line})`;
}

async function collectSkillInstallScanWarnings(entry: SkillEntry): Promise<string[]> {
  const warnings: string[] = [];
  const skillName = entry.skill.name;
  const skillDir = path.resolve(entry.skill.baseDir);

  try {
    const summary = await scanDirectoryWithSummary(skillDir);
    if (summary.critical > 0) {
      const criticalDetails = summary.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => formatScanFindingDetail(skillDir, finding))
        .join("; ");
      warnings.push(
        `WARNING: Skill "${skillName}" contains dangerous code patterns: ${criticalDetails}`,
      );
    } else if (summary.warn > 0) {
      warnings.push(
        `Skill "${skillName}" has ${summary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
      );
    }
  } catch (err) {
    warnings.push(
      `Skill "${skillName}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }

  return warnings;
}

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

function findInstallSpec(entry: SkillEntry, installId: string): SkillInstallSpec | undefined {
  const specs = entry.metadata?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) {
      return spec;
    }
  }
  return undefined;
}

function buildNodeInstallCommand(packageName: string, prefs: SkillsInstallPreferences): string[] {
  switch (prefs.nodeManager) {
    case "pnpm":
      return ["pnpm", "add", "-g", packageName];
    case "yarn":
      return ["yarn", "global", "add", packageName];
    case "bun":
      return ["bun", "add", "-g", packageName];
    default:
      return ["npm", "install", "-g", packageName];
  }
}

function buildInstallCommand(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): {
  argv: string[] | null;
  error?: string;
} {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) {
        return { argv: null, error: "missing brew formula" };
      }
      return { argv: ["brew", "install", spec.formula] };
    }
    case "node": {
      if (!spec.package) {
        return { argv: null, error: "missing node package" };
      }
      return {
        argv: buildNodeInstallCommand(spec.package, prefs),
      };
    }
    case "go": {
      if (!spec.module) {
        return { argv: null, error: "missing go module" };
      }
      return { argv: ["go", "install", spec.module] };
    }
    case "uv": {
      if (!spec.package) {
        return { argv: null, error: "missing uv package" };
      }
      return { argv: ["uv", "tool", "install", spec.package] };
    }
    case "download": {
      return { argv: null, error: "download install handled separately" };
    }
    default:
      return { argv: null, error: "unsupported installer" };
  }
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  if (spec.targetDir?.trim()) {
    return resolveUserPath(spec.targetDir);
  }
  const key = resolveSkillKey(entry.skill, entry);
  return path.join(CONFIG_DIR, "tools", key);
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = spec.archive?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

async function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number,
): Promise<{ bytes: number }> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    timeoutMs: Math.max(1_000, timeoutMs),
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    await ensureDir(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    await release();
  }
}

async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  if (archiveType === "zip") {
    if (!hasBinary("unzip")) {
      return { stdout: "", stderr: "unzip not found on PATH", code: null };
    }
    const argv = ["unzip", "-q", archivePath, "-d", targetDir];
    return await runCommandWithTimeout(argv, { timeoutMs });
  }

  if (!hasBinary("tar")) {
    return { stdout: "", stderr: "tar not found on PATH", code: null };
  }
  const argv = ["tar", "xf", archivePath, "-C", targetDir];
  if (typeof stripComponents === "number" && Number.isFinite(stripComponents)) {
    argv.push("--strip-components", String(Math.max(0, Math.floor(stripComponents))));
  }
  return await runCommandWithTimeout(argv, { timeoutMs });
}

async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  const targetDir = resolveDownloadTargetDir(entry, spec);
  await ensureDir(targetDir);

  const archivePath = path.join(targetDir, filename);
  let downloaded = 0;
  try {
    const result = await downloadFile(url, archivePath, timeoutMs);
    downloaded = result.bytes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      ok: true,
      message: `Downloaded to ${archivePath}`,
      stdout: `downloaded=${downloaded}`,
      stderr: "",
      code: 0,
    };
  }

  if (!archiveType) {
    return {
      ok: false,
      message: "extract requested but archive type could not be detected",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    targetDir,
    stripComponents: spec.stripComponents,
    timeoutMs,
  });
  const success = extractResult.code === 0;
  return {
    ok: success,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    stdout: extractResult.stdout.trim(),
    stderr: extractResult.stderr.trim(),
    code: extractResult.code,
  };
}

async function resolveBrewBinDir(timeoutMs: number, brewExe?: string): Promise<string | undefined> {
  const exe = brewExe ?? (hasBinary("brew") ? "brew" : resolveBrewExecutable());
  if (!exe) {
    return undefined;
  }

  const prefixResult = await runCommandWithTimeout([exe, "--prefix"], {
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  if (prefixResult.code === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) {
      return path.join(prefix, "bin");
    }
  }

  const envPrefix = process.env.HOMEBREW_PREFIX?.trim();
  if (envPrefix) {
    return path.join(envPrefix, "bin");
  }

  for (const candidate of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

type PrereqInstallAttempt = {
  bin: string;
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

const BIN_INSTALL_ALLOWLIST: Record<
  string,
  { apt?: string[]; brew?: string[]; node?: string[]; go?: string[] }
> = {
  // common tooling
  git: { apt: ["git"], brew: ["git"] },
  curl: { apt: ["curl"], brew: ["curl"] },
  unzip: { apt: ["unzip"], brew: ["unzip"] },
  tar: { apt: ["tar"], brew: ["gnu-tar"] },

  // media / camera / image tooling
  ffmpeg: { apt: ["ffmpeg"], brew: ["ffmpeg"] },
  convert: { apt: ["imagemagick"], brew: ["imagemagick"] },

  // language runtimes / package managers
  go: { apt: ["golang-go"], brew: ["go"] },
  uv: { apt: [], brew: ["uv"] },
  python3: { apt: ["python3"], brew: ["python"] },
  pip3: { apt: ["python3-pip"], brew: ["python"] },
};

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))];
}

function canRunApt(): boolean {
  if (process.platform !== "linux") return false;
  // apt-get must be present and we must be root (or have sudo, which we don't assume here).
  return hasBinary("apt-get") && typeof process.getuid === "function" && process.getuid() === 0;
}

async function tryInstallPrereqBin(params: {
  bin: string;
  prefs: SkillsInstallPreferences;
  brewExe: string | null;
  timeoutMs: number;
}): Promise<PrereqInstallAttempt> {
  const { bin, prefs, brewExe, timeoutMs } = params;
  const allow = BIN_INSTALL_ALLOWLIST[bin];
  if (!allow) {
    return {
      bin,
      ok: false,
      message: `No auto-installer allowlisted for missing binary: ${bin}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const attempts: Array<{ kind: string; argv: string[] }> = [];

  // Prefer brew when requested and available.
  if (prefs.preferBrew && brewExe && allow.brew && allow.brew.length > 0) {
    for (const formula of allow.brew) attempts.push({ kind: "brew", argv: [brewExe, "install", formula] });
  }

  // apt is linux-only + root-required in our deployment.
  if (canRunApt() && allow.apt && allow.apt.length > 0) {
    // Keep it simple: install packages directly. (We intentionally avoid apt-get update here.)
    attempts.push({ kind: "apt", argv: ["apt-get", "install", "-y", ...allow.apt] });
  }

  // As a last resort, try node global install if mapped.
  if (allow.node && allow.node.length > 0) {
    for (const pkg of allow.node) attempts.push({ kind: "node", argv: buildNodeInstallCommand(pkg, prefs) });
  }

  // As a last resort, try go install if mapped.
  if (allow.go && allow.go.length > 0) {
    for (const mod of allow.go) attempts.push({ kind: "go", argv: ["go", "install", mod] });
  }

  if (attempts.length == 0) {
    const aptNote = hasBinary("apt-get") && process.platform === "linux" ? " (apt-get present but needs root)" : "";
    return {
      bin,
      ok: false,
      message: `No applicable installer for ${bin}${aptNote}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  for (const attempt of attempts) {
    const res = await runCommandWithTimeout(attempt.argv, { timeoutMs });
    if (res.code === 0) {
      return {
        bin,
        ok: true,
        message: `Installed prerequisite (${attempt.kind}): ${bin}`,
        stdout: res.stdout.trim(),
        stderr: res.stderr.trim(),
        code: res.code,
      };
    }
  }

  // Return the last attempt output for debugging.
  const last = attempts.at(-1)!;
  const res = await runCommandWithTimeout(last.argv, { timeoutMs });
  return {
    bin,
    ok: false,
    message: `Failed to auto-install prerequisite (${last.kind}): ${bin}`,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    code: res.code,
  };
}

async function ensurePrerequisiteBins(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  prefs: SkillsInstallPreferences;
  brewExe: string | null;
  timeoutMs: number;
}): Promise<{
  ok: boolean;
  message?: string;
  stdout: string;
  stderr: string;
  warnings: string[];
}> {
  const { entry, spec, prefs, brewExe, timeoutMs } = params;
  const warnings: string[] = [];

  const specBins = (spec.bins ?? []).map((b) => String(b).trim()).filter(Boolean);
  const requiredBins = uniqueNonEmpty([...(entry.metadata?.requires?.bins ?? []), ...specBins]);
  const anyBins = uniqueNonEmpty(entry.metadata?.requires?.anyBins ?? []);

  const missingRequired = requiredBins.filter((bin) => !hasBinary(bin));
  const hasAny = anyBins.length == 0 ? true : anyBins.some((bin) => hasBinary(bin));

  // If anyBins is specified and none are present, we can't safely choose which one to install.
  if (!hasAny && anyBins.length > 0) {
    return {
      ok: false,
      message: `Missing prerequisite: need one of [${anyBins.join(", ")}]`,
      stdout: "",
      stderr: "",
      warnings,
    };
  }

  if (missingRequired.length === 0) {
    return { ok: true, stdout: "", stderr: "", warnings };
  }

  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  for (const bin of missingRequired) {
    const attempt = await tryInstallPrereqBin({ bin, prefs, brewExe, timeoutMs });
    stdoutParts.push(`==> prereq ${bin}: ${attempt.message}`, attempt.stdout);
    if (attempt.stderr) stderrParts.push(`==> prereq ${bin} stderr`, attempt.stderr);
    if (!attempt.ok) {
      return {
        ok: false,
        message: attempt.message,
        stdout: stdoutParts.filter(Boolean).join("
"),
        stderr: stderrParts.filter(Boolean).join("
"),
        warnings,
      };
    }
  }

  // Re-check after installs.
  const stillMissing = missingRequired.filter((bin) => !hasBinary(bin));
  if (stillMissing.length > 0) {
    return {
      ok: false,
      message: `Prerequisites still missing after auto-install: ${stillMissing.join(", ")}`,
      stdout: stdoutParts.filter(Boolean).join("
"),
      stderr: stderrParts.filter(Boolean).join("
"),
      warnings,
    };
  }

  return { ok: true, stdout: stdoutParts.filter(Boolean).join("
"), stderr: stderrParts.filter(Boolean).join("
"), warnings };
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000);
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const entries = loadWorkspaceSkillEntries(workspaceDir);
  const entry = entries.find((item) => item.skill.name === params.skillName);
  if (!entry) {
    return {
      ok: false,
      message: `Skill not found: ${params.skillName}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const spec = findInstallSpec(entry, params.installId);
  const warnings = await collectSkillInstallScanWarnings(entry);
  if (!spec) {
    return withWarnings(
      {
        ok: false,
        message: `Installer not found: ${params.installId}`,
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }
  if (spec.kind === "download") {
    const downloadResult = await installDownloadSpec({ entry, spec, timeoutMs });
    return withWarnings(downloadResult, warnings);
  }

  const prefs = resolveSkillsInstallPreferences(params.config);
  const command = buildInstallCommand(spec, prefs);
  if (command.error) {
    const debug = {
      skill: {
        name: entry.skill.name,
        source: entry.skill.source,
        baseDir: entry.skill.baseDir,
        filePath: entry.skill.filePath,
      },
      installId: params.installId,
      spec,
    };

    return withWarnings(
      {
        ok: false,
        message: command.error,
        stdout: "",
        stderr: `Invalid installer spec (debug follows)\n${JSON.stringify(debug, null, 2)}`,
        code: null,
      },
      warnings,
    );
  }

  const brewExe = hasBinary("brew") ? "brew" : resolveBrewExecutable();
  if (spec.kind === "brew" && !brewExe) {
    return withWarnings(
      {
        ok: false,
        message: "brew not installed",
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }

  // Best-effort auto-install of allowlisted prerequisites (bins) before running the installer.
  const prereq = await ensurePrerequisiteBins({
    entry,
    spec,
    prefs,
    brewExe,
    timeoutMs,
  });
  warnings.push(...prereq.warnings);
  if (!prereq.ok) {
    return withWarnings(
      {
        ok: false,
        message: prereq.message ?? "Missing prerequisites",
        stdout: prereq.stdout.trim(),
        stderr: prereq.stderr.trim(),
        code: null,
      },
      warnings,
    );
  }
  if (spec.kind === "uv" && !hasBinary("uv")) {
    if (brewExe) {
      const brewResult = await runCommandWithTimeout([brewExe, "install", "uv"], {
        timeoutMs,
      });
      if (brewResult.code !== 0) {
        return withWarnings(
          {
            ok: false,
            message: "Failed to install uv (brew)",
            stdout: brewResult.stdout.trim(),
            stderr: brewResult.stderr.trim(),
            code: brewResult.code,
          },
          warnings,
        );
      }
    } else {
      return withWarnings(
        {
          ok: false,
          message: "uv not installed (install via brew)",
          stdout: "",
          stderr: "",
          code: null,
        },
        warnings,
      );
    }
  }
  if (!command.argv || command.argv.length === 0) {
    return withWarnings(
      {
        ok: false,
        message: "invalid install command",
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }

  if (spec.kind === "brew" && brewExe && command.argv[0] === "brew") {
    command.argv[0] = brewExe;
  }

  if (spec.kind === "go" && !hasBinary("go")) {
    if (brewExe) {
      const brewResult = await runCommandWithTimeout([brewExe, "install", "go"], {
        timeoutMs,
      });
      if (brewResult.code !== 0) {
        return withWarnings(
          {
            ok: false,
            message: "Failed to install go (brew)",
            stdout: brewResult.stdout.trim(),
            stderr: brewResult.stderr.trim(),
            code: brewResult.code,
          },
          warnings,
        );
      }
    } else {
      return withWarnings(
        {
          ok: false,
          message: "go not installed (install via brew)",
          stdout: "",
          stderr: "",
          code: null,
        },
        warnings,
      );
    }
  }

  let env: NodeJS.ProcessEnv | undefined;
  if (spec.kind === "go" && brewExe) {
    const brewBin = await resolveBrewBinDir(timeoutMs, brewExe);
    if (brewBin) {
      env = { GOBIN: brewBin };
    }
  }

  const result = await (async () => {
    const argv = command.argv;
    if (!argv || argv.length === 0) {
      return { code: null, stdout: "", stderr: "invalid install command" };
    }
    try {
      return await runCommandWithTimeout(argv, {
        timeoutMs,
        env,
      });
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      return { code: null, stdout: "", stderr };
    }
  })();

  const success = result.code === 0;

  const mergedStdout = [prereq.stdout, result.stdout].map((v) => v.trim()).filter(Boolean).join("\n");
  const mergedStderr = [prereq.stderr, result.stderr].map((v) => v.trim()).filter(Boolean).join("\n");

  return withWarnings(
    {
      ok: success,
      message: success ? "Installed" : formatInstallFailureMessage({ ...result, stdout: mergedStdout, stderr: mergedStderr }),
      stdout: mergedStdout,
      stderr: mergedStderr,
      code: result.code,
    },
    warnings,
  );
}
