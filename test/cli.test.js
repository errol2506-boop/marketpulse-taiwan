import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { completeFixture } from "./fixtures.js";

const cliPath = join(process.cwd(), "src", "cli.js");

test("CLI validates a complete JSON evidence file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-guard-"));
  const input = join(directory, "evidence.json");
  await writeFile(input, JSON.stringify(completeFixture(), null, 2), "utf8");

  const run = spawnSync(process.execPath, [cliPath, "--input", input, "--cutoff", "2026-08-11T06:30:00+08:00"], {
    encoding: "utf8",
  });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Evidence Decision Pipeline/);
  assert.match(run.stdout, /coverage: FULL/);
  assert.match(run.stdout, /CB1.0: READY/);
});

test("CLI returns non-zero when required evidence is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-guard-"));
  const input = join(directory, "evidence.json");
  const rows = completeFixture().filter((row) => row.EvidenceID !== "VIX-1");
  await writeFile(input, JSON.stringify({ rows }, null, 2), "utf8");

  const run = spawnSync(process.execPath, [cliPath, "--input", input, "--json", "--mode", "validate"], {
    encoding: "utf8",
  });

  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.cb10, "NO_PRODUCTION");
  assert.ok(report.missingInputs.includes("VIX_RISK"));
});

test("CLI can continue with exit zero when evidence is blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-guard-"));
  const input = join(directory, "evidence.json");
  const rows = completeFixture().filter((row) => row.EvidenceID !== "VIX-1");
  await writeFile(input, JSON.stringify({ rows }, null, 2), "utf8");

  const run = spawnSync(process.execPath, [cliPath, "--input", input, "--continue-on-blocked"], {
    encoding: "utf8",
  });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /completionMode: DEGRADED_CONTINUED/);
  assert.match(run.stdout, /NO_PRODUCTION/);
});

test("CLI accepts LATEST time policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-guard-"));
  const input = join(directory, "evidence.json");
  const rows = completeFixture().map((row) => ({
    ...row,
    AvailableAsOf: "2026-08-11T14:00:00+08:00",
    RetrievedAt: "2026-08-11T14:00:00+08:00",
  }));
  await writeFile(input, JSON.stringify(rows, null, 2), "utf8");

  const run = spawnSync(process.execPath, [cliPath, "--input", input, "--time-policy", "LATEST"], {
    encoding: "utf8",
  });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /timePolicy: LATEST/);
});

test("CLI relaxed policy produces actions with partial evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-guard-"));
  const input = join(directory, "evidence.json");
  const rows = completeFixture().filter(
    (row) => row.Domain !== "TX_OVERNIGHT" && row.Domain !== "BROKER_FLOW",
  );
  await writeFile(input, JSON.stringify(rows, null, 2), "utf8");

  const run = spawnSync(
    process.execPath,
    [cliPath, "--input", input, "--decision-policy", "RELAXED", "--continue-on-blocked"],
    { encoding: "utf8" },
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /CB1.0 source: CB1.0_RELAXED_FALLBACK/);
  assert.match(run.stdout, /(BUY|HOLD|REDUCE)/);
});
