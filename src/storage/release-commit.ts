import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{7,40}$/i;

export function resolveReleaseCommit(options?: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  readGit?: () => string | undefined;
}): string {
  const env = options?.env ?? process.env;
  for (const key of ["RENT_RADAR_COMMIT", "SOAK_COMMIT"]) {
    const value = env[key]?.trim();
    if (value && value.toLowerCase() !== "unknown" && SHA.test(value)) {
      return value.toLowerCase();
    }
  }
  const fromGit = options?.readGit ? options.readGit() : readGitHead(options?.cwd ?? process.cwd());
  const trimmed = fromGit?.trim().toLowerCase();
  if (trimmed && trimmed !== "unknown" && SHA.test(trimmed)) {
    return trimmed;
  }
  throw new Error("release commit SHA is unavailable; set RENT_RADAR_COMMIT or run from a git checkout");
}

function readGitHead(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
