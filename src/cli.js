#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { readEvidenceRows } from "./io.js";
import { formatReport, validateEvidenceDecisionFlow } from "./evidenceValidator.js";
import { formatPipelineReport, runEvidenceDecisionPipeline } from "./pipeline.js";

function usage() {
  return `Usage:
  node ./src/cli.js --input <file.json|file.csv> [--cutoff <iso>] [--environment PRODUCTION|TEST] [--time-policy PIT|LATEST] [--decision-policy STRICT|RELAXED] [--mode validate|pipeline] [--continue-on-blocked] [--json] [--output <file>]

Examples:
  node ./src/cli.js --input ./fixtures/complete-evidence.json --cutoff 2026-08-11T06:30:00+08:00
  node ./src/cli.js --input evidence.csv --environment PRODUCTION --json --output report.json
`;
}

function parseArgs(argv) {
  const args = {
    environment: "PRODUCTION",
    json: false,
    mode: "pipeline",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--continue-on-blocked") {
      args.continueOnBlocked = true;
    } else if (arg === "--input") {
      args.input = argv[++index];
    } else if (arg === "--cutoff") {
      args.cutoff = argv[++index];
    } else if (arg === "--environment") {
      args.environment = argv[++index];
    } else if (arg === "--time-policy") {
      args.timePolicy = argv[++index];
    } else if (arg === "--decision-policy") {
      args.decisionPolicy = argv[++index];
    } else if (arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--mode") {
      args.mode = argv[++index];
    } else if (arg === "--snapshot-id") {
      args.snapshotId = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.input) {
    process.stderr.write(`${usage()}\nERROR: --input is required\n`);
    return 2;
  }

  const rows = await readEvidenceRows(args.input);
  const options = {
    cutoff: args.cutoff,
    environment: args.environment,
    timePolicy: args.timePolicy,
    decisionPolicy: args.decisionPolicy,
    snapshotId: args.snapshotId,
  };
  const result =
    args.mode === "validate"
      ? validateEvidenceDecisionFlow(rows, options)
      : runEvidenceDecisionPipeline(rows, options);
  const output = args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : args.mode === "validate"
      ? formatReport(result)
      : formatPipelineReport(result);

  if (args.output) {
    await writeFile(args.output, output, "utf8");
  } else {
    process.stdout.write(output);
  }

  const validation = args.mode === "validate" ? result : result.validation;
  if (args.continueOnBlocked) {
    return 0;
  }
  return validation.cb10 === "READY" && validation.v4r12 === "READY" && validation.pitViolationCount === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 2;
  });
