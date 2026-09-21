import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Oracle systemd unit", () => {
  const service = readFileSync(join(root, "deploy/systemd/rent-radar-telegram.service"), "utf8");
  const timer = readFileSync(join(root, "deploy/systemd/rent-radar-telegram.timer"), "utf8");
  const installer = readFileSync(join(root, "scripts/oracle-telegram-test/install-systemd.sh"), "utf8");

  it("uses absolute placeholders, on-failure restart, and a single unit", () => {
    expect(service).toContain("WorkingDirectory=__REPO_DIR__");
    expect(service).toContain("Environment=DATABASE_PATH=__DATABASE_PATH__");
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("TELEGRAM_POLL_CYCLES=0");
    expect(service).toContain("ENABLE_OLX=false");
    expect(service).not.toMatch(/ENABLE_OLX_BROWSER=true/);
    expect(service).toContain("one instance of this unit");
    expect(service).toContain("__NODE_BIN__ --import tsx ./src/scripts/test-telegram-poll.ts");
    expect(service).toContain("KillMode=control-group");
    expect(service).toContain("RestartPreventExitStatus=2 3");
  });

  it("loads secrets only from the protected user env file", () => {
    expect(service).toContain("EnvironmentFile=%h/.config/rent-radar/telegram-test.env");
    expect(service).not.toMatch(/EnvironmentFile=-/);
    expect(installer).toContain('EXPECTED_ENV_FILE="$HOME/.config/rent-radar/telegram-test.env"');
    expect(installer).toContain('Environment file must be $EXPECTED_ENV_FILE');
  });

  it("documents linger for reboot and starts via a boot timer", () => {
    expect(timer).toContain("OnBootSec=1min");
    expect(timer).toContain("Unit=rent-radar-telegram.service");
    expect(installer).toContain("loginctl enable-linger");
  });
});
