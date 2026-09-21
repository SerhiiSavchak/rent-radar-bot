import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeHeartbeat(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
