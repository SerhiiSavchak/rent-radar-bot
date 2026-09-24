import { describe, expect, it } from "vitest";
import { resolvePollProcessExitCode } from "../src/delivery/poll-process-exit.ts";

describe("poll process exit code", () => {
  it("returns 0 for a clean unbounded graceful stop", () => {
    expect(
      resolvePollProcessExitCode({
        unbounded: true,
        gracefulStopRequested: true,
        operationalFailureObserved: false,
      }),
    ).toBe(0);
  });

  it("graceful unbounded shutdown exits zero after an earlier source failure", () => {
    expect(
      resolvePollProcessExitCode({
        unbounded: true,
        gracefulStopRequested: true,
        operationalFailureObserved: true,
      }),
    ).toBe(0);
  });

  it("returns 1 when an unbounded run observed a failure without a graceful stop", () => {
    expect(
      resolvePollProcessExitCode({
        unbounded: true,
        gracefulStopRequested: false,
        operationalFailureObserved: true,
      }),
    ).toBe(1);
  });

  it("returns 1 when a finite run observed a failure", () => {
    expect(
      resolvePollProcessExitCode({
        unbounded: false,
        gracefulStopRequested: false,
        operationalFailureObserved: true,
      }),
    ).toBe(1);
  });

  it("returns 1 when a finite run is interrupted after an earlier failure", () => {
    expect(
      resolvePollProcessExitCode({
        unbounded: false,
        gracefulStopRequested: true,
        operationalFailureObserved: true,
      }),
    ).toBe(1);
  });

  it("returns 0 when a finite run observed no operational failure", () => {
    expect(
      resolvePollProcessExitCode({
        unbounded: false,
        gracefulStopRequested: false,
        operationalFailureObserved: false,
      }),
    ).toBe(0);
  });
});
