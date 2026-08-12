import test from "node:test";
import assert from "node:assert/strict";
import { formatPipelineReport, runEvidenceDecisionPipeline } from "../src/pipeline.js";
import { baseEvidenceRow, completeFixture } from "./fixtures.js";

const allowedRecommendations = new Set(["買進", "持有", "賣出", "強烈買進", "強烈賣出"]);

test("pipeline builds snapshot, model input status, dashboard rows, and market analysis", () => {
  const result = runEvidenceDecisionPipeline(completeFixture(), {
    cutoff: "2026-08-11T06:30:00+08:00",
    snapshotId: "TEST-SNAPSHOT",
  });

  assert.equal(result.status, "READY");
  assert.equal(result.completed, true);
  assert.equal(result.completionMode, "FULL");
  assert.equal(result.snapshot.snapshotId, "TEST-SNAPSHOT");
  assert.equal(result.snapshot.selectedCount, 16);
  assert.equal(result.modelInputs.cb10.status, "READY");
  assert.equal(result.modelInputs.cb10.decision, "BUY_HOLD_REDUCE_AVAILABLE");
  assert.equal(result.modelInputs.cb10.actionSource, "CB1.0_EXECUTABLE_V1");
  assert.equal(result.modelInputs.cb10.runtimeDecisions.length, 4);
  assert.equal(result.dashboard.rows.length, 4);
  assert.equal(result.dashboard.rows[0].code, "3711");
  assert.ok(result.dashboard.rows[0].companyName);
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation1w));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation2w));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation1m));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation6m));
  assert.ok(["BUY", "HOLD", "REDUCE"].includes(result.dashboard.rows[0].officialAction));
  assert.equal(result.marketAnalysis.model, "MARKET_ANALYST_LAYER_V1");
  assert.ok(Number.isFinite(result.marketAnalysis.scenarioProbabilities.consolidation));
});

test("pipeline degrades dashboard production when evidence is partial", () => {
  const rows = completeFixture().filter((row) => row.EvidenceID !== "TX-1");
  const result = runEvidenceDecisionPipeline(rows, {
    cutoff: "2026-08-11T06:30:00+08:00",
  });

  assert.equal(result.status, "DEGRADED_COMPLETE");
  assert.equal(result.completed, true);
  assert.equal(result.completionMode, "DEGRADED_COMPLETE");
  assert.equal(result.validation.cb10, "NO_PRODUCTION");
  assert.equal(result.modelInputs.cb10.status, "DEGRADED_READY");
  assert.equal(result.modelInputs.cb10.actionSource, "CB1.0_DEGRADED_FALLBACK");
  assert.equal(result.modelInputs.cb10.decision, "BUY_HOLD_REDUCE_AVAILABLE");
  assert.ok(["BUY", "HOLD", "REDUCE"].includes(result.dashboard.rows[0].officialAction));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation1w));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation2w));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation1m));
  assert.ok(allowedRecommendations.has(result.dashboard.rows[0].recommendation6m));
  assert.equal(result.dashboard.rows[0].runState, "DEGRADED_READY");
  assert.match(result.dashboard.rows[0].why, /TX_OVERNIGHT/);
});

test("degraded fallback does not use industry rows as tracked stock OHLCV", () => {
  const rows = completeFixture().filter((row) => row.EvidenceID !== "TW-3711");
  rows.push(
    baseEvidenceRow({
      EvidenceID: "SEMI-COWOS-3711",
      Domain: "SEMICONDUCTOR_INDUSTRY",
      FeatureGroup: "RELATIVE_STRENGTH",
      Symbol: "3711",
      Open: 100,
      High: 150,
      Low: 99,
      CloseLast: 150,
      Volume: 1000,
      TextValue: JSON.stringify({ segmentId: "COWOS_ADVANCED_PACKAGING", segmentName: "CoWoS" }),
      QualityTier: "PUBLIC_CONTEXT",
      SourceTier: "PUBLIC_FALLBACK",
      SourceID: "YAHOO_CHART_FALLBACK",
      SourceIdentifier: "https://query1.finance.yahoo.com/v8/finance/chart/3711.TW",
      ChampionEligible: false,
      ResearchEligible: true,
    }),
  );

  const result = runEvidenceDecisionPipeline(rows, {
    cutoff: "2026-08-11T06:30:00+08:00",
  });
  const row3711 = result.dashboard.rows.find((row) => row.symbol === "3711");

  assert.equal(result.status, "DEGRADED_COMPLETE");
  assert.equal(row3711.officialAction, "HOLD");
  assert.equal(row3711.recommendation1w, "持有");
  assert.match(row3711.why, /No TW_STOCK_OHLCV price evidence/);
});

test("pipeline report is human-readable", () => {
  const result = runEvidenceDecisionPipeline(completeFixture(), {
    cutoff: "2026-08-11T06:30:00+08:00",
  });
  const report = formatPipelineReport(result);

  assert.match(report, /Evidence Decision Pipeline/);
  assert.match(report, /Snapshot:/);
  assert.match(report, /Dashboard:/);
  assert.match(report, /Market Analyst Layer/);
  assert.match(report, /Next-Week Scenario Probabilities/);
});

test("relaxed policy emits BUY/HOLD/REDUCE when strict CB1.0 is missing inputs", () => {
  const rows = completeFixture().filter(
    (row) => row.Domain !== "TX_OVERNIGHT" && row.Domain !== "BROKER_FLOW",
  );
  const result = runEvidenceDecisionPipeline(rows, {
    cutoff: "2026-08-11T06:30:00+08:00",
    decisionPolicy: "RELAXED",
  });

  assert.equal(result.status, "RELAXED_DECISION");
  assert.equal(result.completionMode, "RELAXED_FALLBACK");
  assert.equal(result.modelInputs.cb10.status, "RELAXED_READY");
  assert.equal(result.modelInputs.cb10.actionSource, "CB1.0_RELAXED_FALLBACK");
  assert.ok(["BUY", "HOLD", "REDUCE"].includes(result.dashboard.rows[0].officialAction));
});

test("relaxed policy emits BUY/HOLD/REDUCE even when evidence contract is complete", () => {
  const result = runEvidenceDecisionPipeline(completeFixture(), {
    cutoff: "2026-08-11T06:30:00+08:00",
    decisionPolicy: "RELAXED",
  });

  assert.equal(result.status, "RELAXED_DECISION");
  assert.equal(result.completionMode, "RELAXED_FALLBACK");
  assert.equal(result.modelInputs.cb10.status, "RELAXED_READY");
  assert.equal(result.modelInputs.cb10.decision, "BUY_HOLD_REDUCE_AVAILABLE");
  assert.ok(result.dashboard.rows.every((row) => ["BUY", "HOLD", "REDUCE"].includes(row.officialAction)));
});

test("strict CB1.0 executable runtime produces one action for each dashboard symbol", () => {
  const result = runEvidenceDecisionPipeline(completeFixture(), {
    cutoff: "2026-08-11T06:30:00+08:00",
  });

  assert.equal(result.modelInputs.cb10.status, "READY");
  assert.equal(result.modelInputs.cb10.actionSource, "CB1.0_EXECUTABLE_V1");
  assert.equal(result.modelInputs.cb10.runtimeDecisions.length, 4);
  assert.ok(result.modelInputs.cb10.weights.industryMomentum > 0);
  assert.ok(result.modelInputs.cb10.weights.policyRiskPenalty > 0);
  assert.deepEqual(
    result.modelInputs.cb10.runtimeDecisions.map((decision) => decision.symbol),
    ["3711", "2408", "1303", "6538"],
  );
  assert.ok(result.dashboard.rows.every((row) => ["BUY", "HOLD", "REDUCE"].includes(row.officialAction)));
  assert.ok(result.dashboard.rows.every((row) => row.why.includes("CB1.0 score=")));
  assert.ok(
    result.dashboard.rows.every((row) =>
      [row.recommendation1w, row.recommendation2w, row.recommendation1m, row.recommendation6m].every((value) =>
        allowedRecommendations.has(value),
      ),
    ),
  );
});

test("market analyst layer emits scenario probabilities and industry ranking", () => {
  const result = runEvidenceDecisionPipeline(completeFixture(), {
    cutoff: "2026-08-11T06:30:00+08:00",
  });

  const probabilities = result.marketAnalysis.scenarioProbabilities;
  const probabilitySum = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  assert.equal(result.marketAnalysis.status, "READY");
  assert.ok(Math.abs(probabilitySum - 1) < 0.001);
  assert.ok(result.marketAnalysis.industryRanking.length >= 4);
  assert.ok(result.marketAnalysis.industryRanking[0].rating >= result.marketAnalysis.industryRanking.at(-1).rating);
});

test("market analyst layer consumes policy news risk context", () => {
  const rows = completeFixture();
  rows.push(
    baseEvidenceRow({
      EvidenceID: "POLICY-RISK-1",
      Domain: "POLICY_NEWS",
      FeatureGroup: "GEOPOLITICAL_POLICY",
      ValueType: "NEWS_EVENT",
      Open: "",
      High: "",
      Low: "",
      CloseLast: "",
      Volume: "",
      TextValue: JSON.stringify({
        title: "New export controls target AI semiconductor chips",
        source: "Public RSS",
        riskScore: 9,
        riskLevel: "HIGH",
      }),
      QualityTier: "PUBLIC_CONTEXT",
      SourceTier: "PUBLIC_RSS",
      SourceID: "GOOGLE_NEWS_RSS_PUBLIC",
      SourceIdentifier: "https://news.google.com/rss/search?q=semiconductor",
      ChampionEligible: false,
      ResearchEligible: true,
    }),
  );

  const result = runEvidenceDecisionPipeline(rows, {
    cutoff: "2026-08-11T06:30:00+08:00",
  });

  assert.equal(result.modelInputs.cb10.status, "READY");
  assert.equal(result.marketAnalysis.interpretation.geopoliticalRisk, "ELEVATED");
  assert.equal(result.marketAnalysis.policyNews.topEvents[0].riskLevel, "HIGH");
  assert.equal(result.modelInputs.cb10.runtimeDecisions[0].components.policyMaxRiskScore, 9);
  assert.ok(result.modelInputs.cb10.runtimeDecisions[0].components.policyRiskPenalty < 0);
});

test("market analyst layer ranks semiconductor segments from industry constituents", () => {
  const rows = completeFixture();
  rows.push(
    baseEvidenceRow({
      EvidenceID: "SEMI-AI-2330",
      Domain: "SEMICONDUCTOR_INDUSTRY",
      FeatureGroup: "RELATIVE_STRENGTH",
      Symbol: "2330",
      Open: 100,
      High: 108,
      Low: 99,
      CloseLast: 108,
      Volume: 1000,
      TextValue: JSON.stringify({ segmentId: "AI_SERVER", segmentName: "AI Server" }),
      QualityTier: "PUBLIC_CONTEXT",
      SourceTier: "PUBLIC_FALLBACK",
      SourceID: "YAHOO_CHART_FALLBACK",
      SourceIdentifier: "https://query1.finance.yahoo.com/v8/finance/chart/2330.TW",
      ChampionEligible: false,
      ResearchEligible: true,
    }),
  );

  const result = runEvidenceDecisionPipeline(rows, {
    cutoff: "2026-08-11T06:30:00+08:00",
  });

  const aiServer = result.marketAnalysis.industryRanking.find((item) => item.segment === "AI Server");
  assert.ok(aiServer);
  assert.equal(aiServer.constituentCount, 1);
  assert.ok(aiServer.averageMove > 0);
});

test("CB1.0 scoring integrates semiconductor industry momentum", () => {
  const rows = completeFixture();
  rows.push(
    baseEvidenceRow({
      EvidenceID: "SEMI-COWOS-3711",
      Domain: "SEMICONDUCTOR_INDUSTRY",
      FeatureGroup: "RELATIVE_STRENGTH",
      Symbol: "3711",
      Open: 100,
      High: 110,
      Low: 99,
      CloseLast: 110,
      Volume: 1000,
      TextValue: JSON.stringify({ segmentId: "COWOS_ADVANCED_PACKAGING", segmentName: "CoWoS" }),
      QualityTier: "PUBLIC_CONTEXT",
      SourceTier: "PUBLIC_FALLBACK",
      SourceID: "YAHOO_CHART_FALLBACK",
      SourceIdentifier: "https://query1.finance.yahoo.com/v8/finance/chart/3711.TW",
      ChampionEligible: false,
      ResearchEligible: true,
    }),
  );

  const result = runEvidenceDecisionPipeline(rows, {
    cutoff: "2026-08-11T06:30:00+08:00",
  });
  const decision3711 = result.modelInputs.cb10.runtimeDecisions.find((decision) => decision.symbol === "3711");
  assert.ok(decision3711.components.industryMomentum > 0);
  assert.equal(decision3711.components.industrySegment, "COWOS_ADVANCED_PACKAGING");
  assert.ok(allowedRecommendations.has(decision3711.horizonRecommendations.oneMonth.recommendation));
});
