import { formatReport, validateEvidenceDecisionFlow } from "./evidenceValidator.js";
import { runCb10Runtime } from "./cb10Runtime.js";
import { buildMarketAnalysis, formatMarketAnalysisReport } from "./marketAnalyst.js";
import { stockDisplayName, stockMeta } from "./stockMeta.js";

const DASHBOARD_SYMBOLS = ["3711", "2408", "1303", "6538"];

function pctChange(row) {
  const open = Number(row.Open);
  const close = Number(row.CloseLast);
  if (!Number.isFinite(open) || open === 0 || !Number.isFinite(close)) {
    return 0;
  }
  return (close - open) / open;
}

function actionFromScore(score) {
  if (score >= 0.012) {
    return "BUY";
  }
  if (score <= -0.012) {
    return "REDUCE";
  }
  return "HOLD";
}

function buildRelaxedDecisions(validation) {
  const selected = validation.selectedEvidence;
  const bySymbol = new Map(selected.filter((row) => row.Symbol).map((row) => [row.Symbol, row]));
  const usRows = ["TSM", "NVDA", "AMD", "AVGO"].map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  const vix = selected.find((row) => row.Domain === "VIX_RISK");
  const usMomentum = usRows.length > 0 ? usRows.reduce((sum, row) => sum + pctChange(row), 0) / usRows.length : 0;
  const vixClose = Number(vix?.CloseLast);
  const vixRisk = Number.isFinite(vixClose) ? Math.max(-0.02, Math.min(0.02, (18 - vixClose) / 1000)) : 0;

  return DASHBOARD_SYMBOLS.map((symbol) => {
    const row = bySymbol.get(symbol);
    if (!row) {
      return {
        symbol,
        action: "HOLD",
        confidence: "LOW_CONFIDENCE",
        score: 0,
        why: "No symbol price evidence; default relaxed action is HOLD.",
      };
    }

    const ownMomentum = pctChange(row);
    const score = ownMomentum * 0.65 + usMomentum * 0.25 + vixRisk * 0.1;
    const action = actionFromScore(score);
    const confidence = validation.coverageLevel === "FULL" ? "HIGH" : "LOW_CONFIDENCE";

    return {
      symbol,
      action,
      confidence,
      score,
      why: `Relaxed fallback score=${score.toFixed(4)} from own=${ownMomentum.toFixed(4)}, us4=${usMomentum.toFixed(4)}, vixRisk=${vixRisk.toFixed(4)}.`,
    };
  });
}

function compactQuality(rows) {
  const byDomain = new Map();
  for (const row of rows) {
    if (!byDomain.has(row.Domain)) {
      byDomain.set(row.Domain, new Set());
    }
    byDomain.get(row.Domain).add(row.QualityTier);
  }

  return Object.fromEntries(
    [...byDomain.entries()].map(([domain, qualities]) => [domain, [...qualities].sort()]),
  );
}

function buildSnapshot(validation, options) {
  const snapshotId = options.snapshotId || `SNAPSHOT-${validation.cutoff}`;
  return {
    snapshotId,
    cutoff: validation.cutoff,
    environment: validation.environment,
    timePolicy: validation.timePolicy,
    evidenceIds: validation.selectedEvidenceIds,
    lateExcludedEvidenceIds: validation.lateExcludedEvidenceIds,
    selectedCount: validation.selectedCount,
    lateExcludedCount: validation.lateExcludedCount,
    pitViolationCount: validation.pitViolationCount,
    immutable: true,
  };
}

function buildModelInputs(validation, options) {
  const evidenceById = new Map(validation.selectedEvidence.map((row) => [row.EvidenceID, row]));
  const selectedRows = validation.selectedEvidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
  const relaxed = options.decisionPolicy === "RELAXED";
  const cb10Runtime = relaxed ? null : runCb10Runtime(validation);
  const relaxedDecisions = relaxed ? buildRelaxedDecisions(validation) : [];
  const hasRelaxedDecision = relaxedDecisions.length > 0 && validation.selectedCount > 0;
  const hasCb10RuntimeDecision = cb10Runtime?.status === "READY";
  const status =
    hasRelaxedDecision
      ? "RELAXED_DECISION"
      : hasCb10RuntimeDecision && validation.v4r12 === "READY"
        ? "READY"
      : validation.cb10 === "READY" && validation.v4r12 === "READY"
        ? "READY"
        : "BLOCKED";

  return {
    status,
    coverageLevel: validation.coverageLevel,
    cb10: {
      status: hasRelaxedDecision ? "RELAXED_READY" : hasCb10RuntimeDecision ? "READY" : validation.cb10,
      actionSource: hasRelaxedDecision
        ? "CB1.0_RELAXED_FALLBACK"
        : cb10Runtime?.actionSource || "CB1.0_EXECUTABLE_V1",
      decision: hasRelaxedDecision
        ? "BUY_HOLD_REDUCE_AVAILABLE"
        : cb10Runtime?.decision || "NO_PRODUCTION",
      missingInputs: validation.missingInputs,
      weights: cb10Runtime?.weights || {},
      runtimeDecisions: cb10Runtime?.decisions || [],
      relaxedDecisions,
    },
    v4r12: {
      status: validation.v4r12,
      mode: "RESEARCH_SHADOW",
      decision: validation.v4r12 === "READY" ? "PENDING_FROZEN_MODEL_RUNTIME" : "UNASSESSED",
      missingInputs: validation.missingInputs,
    },
    evidenceQualitySummary: compactQuality(selectedRows),
  };
}

function buildDashboard(validation, modelInputs, snapshot) {
  const runtimeBySymbol = new Map(modelInputs.cb10.runtimeDecisions.map((decision) => [decision.symbol, decision]));
  const relaxedBySymbol = new Map(modelInputs.cb10.relaxedDecisions.map((decision) => [decision.symbol, decision]));
  const canProduceOfficial = modelInputs.cb10.status === "READY" || modelInputs.cb10.status === "RELAXED_READY";
  const canProduceResearch = modelInputs.v4r12.status === "READY";
  return {
    snapshotId: snapshot.snapshotId,
    coverageLevel: validation.coverageLevel,
    cb10Status: modelInputs.cb10.status,
    v4r12Status: modelInputs.v4r12.status,
    rows: DASHBOARD_SYMBOLS.map((symbol) => {
      const meta = stockMeta(symbol);
      return {
        symbol,
        code: meta.code,
        companyName: meta.companyName,
        displayName: stockDisplayName(symbol),
        officialAction:
          runtimeBySymbol.get(symbol)?.action ||
          relaxedBySymbol.get(symbol)?.action ||
          "NO_PRODUCTION",
        recommendation1w: runtimeBySymbol.get(symbol)?.horizonRecommendations?.oneWeek?.recommendation || "",
        recommendation2w: runtimeBySymbol.get(symbol)?.horizonRecommendations?.twoWeeks?.recommendation || "",
        recommendation1m: runtimeBySymbol.get(symbol)?.horizonRecommendations?.oneMonth?.recommendation || "",
        recommendation6m: runtimeBySymbol.get(symbol)?.horizonRecommendations?.sixMonths?.recommendation || "",
        horizonRecommendations: runtimeBySymbol.get(symbol)?.horizonRecommendations || {},
        actionSource: modelInputs.cb10.actionSource,
        researchD1: canProduceResearch ? "PENDING_FROZEN_MODEL_RUNTIME" : "UNASSESSED",
        researchD3: canProduceResearch ? "PENDING_FROZEN_MODEL_RUNTIME" : "UNASSESSED",
        researchD5: canProduceResearch ? "PENDING_FROZEN_MODEL_RUNTIME" : "UNASSESSED",
        confidence: runtimeBySymbol.get(symbol)?.confidence || relaxedBySymbol.get(symbol)?.confidence || validation.coverageLevel,
        runState: canProduceOfficial ? modelInputs.cb10.status : "DEGRADED_CONTINUED",
        why:
          runtimeBySymbol.get(symbol)?.why ||
          relaxedBySymbol.get(symbol)?.why ||
          (validation.coverageLevel === "FULL"
            ? "Evidence contract is complete, but CB1.0 runtime did not return an action."
            : `Blocked by missing inputs: ${validation.missingInputs.join(", ")}`),
      };
    }),
    audit: {
      selectedCount: validation.selectedCount,
      lateExcludedCount: validation.lateExcludedCount,
      pitViolationCount: validation.pitViolationCount,
      issueCount: validation.issues.length,
    },
  };
}

export function runEvidenceDecisionPipeline(rows, options = {}) {
  const validation = validateEvidenceDecisionFlow(rows, options);
  const snapshot = buildSnapshot(validation, options);
  const modelInputs = buildModelInputs(validation, options);
  const dashboard = buildDashboard(validation, modelInputs, snapshot);
  const baseResult = {
    status: modelInputs.status,
    completed: true,
    completionMode:
      modelInputs.status === "READY" ? "FULL" : modelInputs.status === "RELAXED_DECISION" ? "RELAXED_FALLBACK" : "DEGRADED_CONTINUED",
    validation,
    snapshot,
    modelInputs,
    dashboard,
  };

  return {
    ...baseResult,
    marketAnalysis: buildMarketAnalysis(baseResult),
  };
}

export function formatPipelineReport(result) {
  const lines = [
    "Evidence Decision Pipeline",
    `status: ${result.status}`,
    `completed: ${result.completed}`,
    `completionMode: ${result.completionMode}`,
    "",
    formatReport(result.validation).trimEnd(),
    "",
    "Snapshot:",
    `- SnapshotID: ${result.snapshot.snapshotId}`,
    `- Evidence rows: ${result.snapshot.selectedCount}`,
    `- Late excluded: ${result.snapshot.lateExcludedCount}`,
    `- PIT violations: ${result.snapshot.pitViolationCount}`,
    "",
    "Model Inputs:",
    `- CB1.0: ${result.modelInputs.cb10.status} / ${result.modelInputs.cb10.decision}`,
    `- CB1.0 source: ${result.modelInputs.cb10.actionSource}`,
    `- V4R1.2: ${result.modelInputs.v4r12.status} / ${result.modelInputs.v4r12.decision}`,
    "",
    "Dashboard:",
  ];

  for (const row of result.dashboard.rows) {
    lines.push(
      `- ${row.displayName || row.symbol}: ${row.officialAction}; ` +
        `1w=${row.recommendation1w || "N/A"}; 2w=${row.recommendation2w || "N/A"}; ` +
        `1m=${row.recommendation1m || "N/A"}; 6m=${row.recommendation6m || "N/A"}; ` +
        `confidence=${row.confidence}; why=${row.why}`,
    );
  }

  if (result.marketAnalysis) {
    lines.push("", formatMarketAnalysisReport(result.marketAnalysis).trimEnd());
  }

  return `${lines.join("\n")}\n`;
}
