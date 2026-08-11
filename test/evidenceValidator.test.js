import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceDecisionFlow } from "../src/evidenceValidator.js";
import { baseEvidenceRow, completeFixture } from "./fixtures.js";

const cutoff = "2026-08-11T06:30:00+08:00";

test("complete evidence before cutoff is FULL and both frozen models are READY", () => {
  const result = validateEvidenceDecisionFlow(completeFixture(), { cutoff });
  assert.equal(result.selectedCount, 16);
  assert.equal(result.lateExcludedCount, 0);
  assert.equal(result.pitViolationCount, 0);
  assert.equal(result.coverageLevel, "FULL");
  assert.equal(result.cb10, "READY");
  assert.equal(result.v4r12, "READY");
});

test("late evidence is excluded but not counted as PIT violation", () => {
  const rows = completeFixture();
  rows.push(
    baseEvidenceRow({
      EvidenceID: "TX-LATE",
      Domain: "TX_OVERNIGHT",
      FeatureGroup: "OVERNIGHT_ENVIRONMENT",
      AvailableAsOf: "2026-08-11T06:31:00+08:00",
    }),
  );

  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.lateExcludedCount, 1);
  assert.equal(result.pitViolationCount, 0);
  assert.equal(result.cb10, "READY");
});

test("LATEST time policy includes evidence retrieved after cutoff", () => {
  const rows = completeFixture().map((row) => ({
    ...row,
    AvailableAsOf: "2026-08-11T14:00:00+08:00",
    RetrievedAt: "2026-08-11T14:00:00+08:00",
  }));

  const result = validateEvidenceDecisionFlow(rows, { cutoff, timePolicy: "LATEST" });
  assert.equal(result.selectedCount, 16);
  assert.equal(result.lateExcludedCount, 0);
  assert.equal(result.pitViolationCount, 0);
  assert.equal(result.cb10, "READY");
});

test("low quality champion evidence blocks production", () => {
  const rows = completeFixture();
  rows[0] = { ...rows[0], QualityTier: "YAHOO_RESEARCH_ONLY" };

  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.cb10, "NO_PRODUCTION");
  assert.ok(result.issues.some((issue) => issue.code === "CHAMPION_INELIGIBLE_QUALITY"));
});

test("duplicate broker side/rank blocks production", () => {
  const rows = completeFixture();
  rows.push({ ...rows.find((row) => row.EvidenceID === "BROKER-BUY-1"), EvidenceID: "BROKER-BUY-1-DUP" });

  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.cb10, "NO_PRODUCTION");
  assert.ok(result.issues.some((issue) => issue.code === "DUPLICATE_BROKER_RANK"));
});

test("missing broker SELL3 blocks CB1.0 production", () => {
  const rows = completeFixture().filter((row) => row.EvidenceID !== "BROKER-SELL-3");
  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.coverageLevel, "PARTIAL");
  assert.equal(result.cb10, "NO_PRODUCTION");
  assert.equal(result.v4r12, "UNASSESSED");
  assert.ok(result.missingInputs.includes("BROKER_FLOW:SELL3"));
});

test("test fixture data is rejected in production", () => {
  const rows = completeFixture();
  rows[0] = { ...rows[0], EvidenceID: "TEST-TW-3711" };

  const result = validateEvidenceDecisionFlow(rows, { cutoff, environment: "PRODUCTION" });
  assert.equal(result.cb10, "NO_PRODUCTION");
  assert.ok(result.issues.some((issue) => issue.code === "TEST_DATA_IN_PRODUCTION"));
});

test("expected date cannot replace invalid source timestamp", () => {
  const rows = completeFixture();
  rows[3] = { ...rows[3], EvidenceID: "TW-6538-BAD", ObservedAt: "not-from-source" };

  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.cb10, "NO_PRODUCTION");
  assert.ok(result.issues.some((issue) => issue.code === "INVALID_TIMESTAMP"));
});

test("policy news evidence is accepted as research context without becoming a CB1.0 requirement", () => {
  const rows = completeFixture();
  rows.push(
    baseEvidenceRow({
      EvidenceID: "POLICY-1",
      Domain: "POLICY_NEWS",
      FeatureGroup: "GEOPOLITICAL_POLICY",
      ValueType: "NEWS_EVENT",
      Open: "",
      High: "",
      Low: "",
      CloseLast: "",
      Volume: "",
      TextValue: JSON.stringify({ title: "Export controls affect AI chips", riskScore: 8, riskLevel: "HIGH" }),
      QualityTier: "PUBLIC_CONTEXT",
      SourceTier: "PUBLIC_RSS",
      SourceID: "GOOGLE_NEWS_RSS_PUBLIC",
      SourceIdentifier: "https://news.google.com/rss/search?q=semiconductor",
      ChampionEligible: false,
      ResearchEligible: true,
    }),
  );

  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.cb10, "READY");
  assert.equal(result.selectedCount, 17);
  assert.equal(result.missingInputs.length, 0);
});

test("semiconductor industry evidence is accepted as research context without becoming a CB1.0 requirement", () => {
  const rows = completeFixture();
  rows.push(
    baseEvidenceRow({
      EvidenceID: "SEMI-AI-2330",
      Domain: "SEMICONDUCTOR_INDUSTRY",
      FeatureGroup: "RELATIVE_STRENGTH",
      Symbol: "2330",
      TextValue: JSON.stringify({ segmentId: "ADVANCED_FOUNDRY", segmentName: "Advanced Foundry" }),
      QualityTier: "PUBLIC_CONTEXT",
      SourceTier: "PUBLIC_FALLBACK",
      SourceID: "YAHOO_CHART_FALLBACK",
      SourceIdentifier: "https://query1.finance.yahoo.com/v8/finance/chart/2330.TW",
      ChampionEligible: false,
      ResearchEligible: true,
    }),
  );

  const result = validateEvidenceDecisionFlow(rows, { cutoff });
  assert.equal(result.cb10, "READY");
  assert.equal(result.selectedCount, 17);
  assert.equal(result.missingInputs.length, 0);
});
