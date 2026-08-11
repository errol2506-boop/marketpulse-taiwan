#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { captureTodayEvidence } from "./captureToday.js";
import { runEvidenceDecisionPipeline, formatPipelineReport } from "./pipeline.js";

function parseArgs(argv) {
  const args = {
    date: new Date().toISOString().slice(0, 10),
    cutoff: "",
    outputDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") {
      args.date = argv[++index];
    } else if (arg === "--cutoff") {
      args.cutoff = argv[++index];
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function defaultCutoff(date) {
  return `${date}T06:30:00+08:00`;
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function buildAdviceMarkdown(result) {
  const lines = [
    `# 台股市場脈衝投資建議 - ${result.snapshot.snapshotId}`,
    "",
    "## 狀態",
    "",
    `- Pipeline: ${result.status}`,
    `- Evidence rows: ${result.validation.selectedCount}`,
    `- CB1.0: ${result.modelInputs.cb10.status} / ${result.modelInputs.cb10.decision}`,
    `- Policy/geopolitical risk: ${result.marketAnalysis.interpretation.geopoliticalRisk}`,
    "",
    "## 下週情境",
    "",
    "| 情境 | 機率 |",
    "|---|---:|",
    `| 續漲突破 | ${percent(result.marketAnalysis.scenarioProbabilities.continuationBreakout)} |`,
    `| 震盪整理 | ${percent(result.marketAnalysis.scenarioProbabilities.consolidation)} |`,
    `| 再次拉回 | ${percent(result.marketAnalysis.scenarioProbabilities.pullback)} |`,
    "",
    "## 四週期投資建議",
    "",
    "| 股票 | 1周內 | 2周內 | 1個月內 | 6個月內 |",
    "|---|---|---|---|---|",
  ];

  for (const row of result.dashboard.rows) {
    lines.push(
      `| ${row.displayName} | ${row.recommendation1w} | ${row.recommendation2w} | ${row.recommendation1m} | ${row.recommendation6m} |`,
    );
  }

  lines.push("", "## 半導體子產業排序", "", "| 族群 | 評分 | 偏向 | 平均變動 |", "|---|---:|---|---:|");
  for (const item of result.marketAnalysis.industryRanking) {
    lines.push(`| ${item.segment} | ${item.rating}/5 | ${item.bias} | ${percent(item.averageMove || 0)} |`);
  }

  lines.push(
    "",
    "## 備註",
    "",
    "本報告為程式產生的非個人化投資訊號，不是針對個人資產配置的財務建議。",
    "",
  );

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = args.outputDir || `runs/${args.date}`;
  const cutoff = args.cutoff || defaultCutoff(args.date);
  const snapshotId = `DAILY-ADVICE-${args.date}`;

  const evidencePath = `${outputDir}/evidence-daily-advice.json`;
  const resultPath = `${outputDir}/pipeline-daily-advice-result.json`;
  const reportPath = `${outputDir}/pipeline-daily-advice-report.txt`;
  const advicePath = `${outputDir}/daily-investment-advice.md`;

  const rows = await captureTodayEvidence({ date: args.date });
  const result = runEvidenceDecisionPipeline(rows, {
    cutoff,
    timePolicy: "LATEST",
    snapshotId,
  });

  await mkdir(dirname(advicePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(reportPath, formatPipelineReport(result), "utf8");
  await writeFile(advicePath, buildAdviceMarkdown(result), "utf8");

  process.stdout.write(`wrote ${advicePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 2;
});
