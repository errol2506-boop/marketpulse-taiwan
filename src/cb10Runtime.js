import { parsePolicyNewsPayload } from "./policyNews.js";
import { parseIndustryPayload } from "./semiconductorUniverse.js";

const TARGET_SYMBOLS = ["3711", "2408", "1303", "6538"];
const US4_SYMBOLS = ["TSM", "NVDA", "AMD", "AVGO"];
const SYMBOL_SEGMENT_MAP = {
  3711: "COWOS_ADVANCED_PACKAGING",
  2408: "MEMORY_DRAM_HBM",
  6538: "PCB_CCL_HIGH_SPEED",
};
const CB10_WEIGHTS = {
  ownMomentum: 0.25,
  brokerPressure: 0.2,
  txMomentum: 0.12,
  us4Momentum: 0.12,
  vixRisk: 0.08,
  industryMomentum: 0.15,
  policyRiskPenalty: 0.08,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctChange(row) {
  const open = Number(row?.Open);
  const close = Number(row?.CloseLast);
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

function recommendationFromScore(score) {
  if (score >= 0.025) {
    return "強烈買進";
  }
  if (score >= 0.012) {
    return "買進";
  }
  if (score <= -0.025) {
    return "強烈賣出";
  }
  if (score <= -0.012) {
    return "賣出";
  }
  return "持有";
}

function buildHorizonRecommendations({
  score,
  ownMomentum,
  brokerPressure,
  txMomentum,
  usMomentum,
  vixRisk,
  industryMomentum,
  policyRiskPenalty,
}) {
  const scores = {
    oneWeek: score,
    twoWeeks:
      ownMomentum * 0.2 +
      brokerPressure * 0.18 +
      txMomentum * 0.12 +
      usMomentum * 0.12 +
      vixRisk * 0.08 +
      industryMomentum * 0.22 +
      policyRiskPenalty * 0.08,
    oneMonth:
      ownMomentum * 0.12 +
      brokerPressure * 0.1 +
      txMomentum * 0.1 +
      usMomentum * 0.12 +
      vixRisk * 0.08 +
      industryMomentum * 0.38 +
      policyRiskPenalty * 0.1,
    sixMonths:
      ownMomentum * 0.05 +
      brokerPressure * 0.05 +
      txMomentum * 0.08 +
      usMomentum * 0.15 +
      vixRisk * 0.08 +
      industryMomentum * 0.44 +
      policyRiskPenalty * 0.15,
  };

  return {
    oneWeek: { label: "1周內", score: scores.oneWeek, recommendation: recommendationFromScore(scores.oneWeek) },
    twoWeeks: { label: "2周內", score: scores.twoWeeks, recommendation: recommendationFromScore(scores.twoWeeks) },
    oneMonth: { label: "1個月內", score: scores.oneMonth, recommendation: recommendationFromScore(scores.oneMonth) },
    sixMonths: { label: "6個月內", score: scores.sixMonths, recommendation: recommendationFromScore(scores.sixMonths) },
  };
}

function confidenceFromScore(score, validation) {
  if (validation.coverageLevel !== "FULL") {
    return "LOW_CONFIDENCE";
  }
  if (Math.abs(score) >= 0.018) {
    return "HIGH";
  }
  return "MEDIUM";
}

function rowsBySymbol(rows, domain) {
  return new Map(rows.filter((row) => row.Domain === domain && row.Symbol).map((row) => [row.Symbol, row]));
}

function policyRiskPenalty(rows) {
  const events = rows
    .filter((row) => row.Domain === "POLICY_NEWS" && row.CaptureStatus === "OK")
    .map((row) => parsePolicyNewsPayload(row));
  const maxRiskScore = events.reduce((max, event) => Math.max(max, Number(event.riskScore || 0)), 0);
  return {
    maxRiskScore,
    eventCount: events.filter((event) => event.title).length,
    penalty: -clamp(maxRiskScore / 500, 0, 0.02),
  };
}

function industryMomentumBySegment(rows) {
  const buckets = new Map();
  for (const row of rows.filter((item) => item.Domain === "SEMICONDUCTOR_INDUSTRY")) {
    const payload = parseIndustryPayload(row);
    const segmentId = payload.segmentId;
    if (!segmentId) {
      continue;
    }
    if (!buckets.has(segmentId)) {
      buckets.set(segmentId, []);
    }
    buckets.get(segmentId).push(pctChange(row));
  }

  return new Map(
    [...buckets.entries()].map(([segmentId, moves]) => [
      segmentId,
      moves.length > 0 ? moves.reduce((sum, value) => sum + value, 0) / moves.length : 0,
    ]),
  );
}

function brokerPressure(rows, symbol, stockRow) {
  const symbolRows = rows.filter((row) => row.Domain === "BROKER_FLOW" && row.Symbol === symbol);
  const marketRows = rows.filter((row) => row.Domain === "BROKER_FLOW" && !row.Symbol);
  const brokerRows = symbolRows.length > 0 ? symbolRows : marketRows;
  const buyLots = brokerRows
    .filter((row) => String(row.Side || "").toUpperCase() === "BUY")
    .reduce((sum, row) => sum + Number(row.Lots || 0), 0);
  const sellLots = brokerRows
    .filter((row) => String(row.Side || "").toUpperCase() === "SELL")
    .reduce((sum, row) => sum + Number(row.Lots || 0), 0);
  const volumeLots = Math.max(1, Number(stockRow?.Volume || 0) / 1000);
  const balanceLots = buyLots - sellLots;

  return {
    buyLots,
    sellLots,
    balanceLots,
    pressure: clamp(balanceLots / volumeLots, -0.05, 0.05),
  };
}

export function runCb10Runtime(validation) {
  if (validation.cb10 !== "READY") {
    return {
      status: "NO_PRODUCTION",
      actionSource: "CB1.0_EXECUTABLE_V1",
      decision: "NO_PRODUCTION",
      decisions: [],
    };
  }

  const selected = validation.selectedEvidence;
  const twRows = rowsBySymbol(selected, "TW_STOCK_OHLCV");
  const usRows = rowsBySymbol(selected, "US_EQUITY");
  const txRow = selected.find((row) => row.Domain === "TX_OVERNIGHT");
  const vixRow = selected.find((row) => row.Domain === "VIX_RISK");

  const usMomentum =
    US4_SYMBOLS.map((symbol) => usRows.get(symbol))
      .filter(Boolean)
      .reduce((sum, row, _index, rows) => sum + pctChange(row) / rows.length, 0) || 0;
  const txMomentum = pctChange(txRow);
  const vixClose = Number(vixRow?.CloseLast);
  const vixRisk = Number.isFinite(vixClose) ? clamp((18 - vixClose) / 1000, -0.02, 0.02) : 0;
  const policy = policyRiskPenalty(selected);
  const industryBySegment = industryMomentumBySegment(selected);

  const decisions = TARGET_SYMBOLS.map((symbol) => {
    const stockRow = twRows.get(symbol);
    const ownMomentum = pctChange(stockRow);
    const flow = brokerPressure(selected, symbol, stockRow);
    const segmentId = SYMBOL_SEGMENT_MAP[symbol] || "";
    const industryMomentum = segmentId ? industryBySegment.get(segmentId) || 0 : 0;
    const score =
      ownMomentum * CB10_WEIGHTS.ownMomentum +
      flow.pressure * CB10_WEIGHTS.brokerPressure +
      txMomentum * CB10_WEIGHTS.txMomentum +
      usMomentum * CB10_WEIGHTS.us4Momentum +
      vixRisk * CB10_WEIGHTS.vixRisk +
      industryMomentum * CB10_WEIGHTS.industryMomentum +
      policy.penalty * CB10_WEIGHTS.policyRiskPenalty;
    const action = actionFromScore(score);
    const horizonRecommendations = buildHorizonRecommendations({
      score,
      ownMomentum,
      brokerPressure: flow.pressure,
      txMomentum,
      usMomentum,
      vixRisk,
      industryMomentum,
      policyRiskPenalty: policy.penalty,
    });

    return {
      symbol,
      action,
      recommendation: recommendationFromScore(score),
      horizonRecommendations,
      confidence: confidenceFromScore(score, validation),
      score,
      components: {
        ownMomentum,
        brokerPressure: flow.pressure,
        brokerBuyLots: flow.buyLots,
        brokerSellLots: flow.sellLots,
        brokerBalanceLots: flow.balanceLots,
        txMomentum,
        us4Momentum: usMomentum,
        vixRisk,
        industrySegment: segmentId || "NO_SEMICONDUCTOR_SEGMENT",
        industryMomentum,
        policyRiskPenalty: policy.penalty,
        policyMaxRiskScore: policy.maxRiskScore,
        policyEventCount: policy.eventCount,
        weights: CB10_WEIGHTS,
      },
      why:
        `CB1.0 score=${score.toFixed(4)} ` +
        `(own=${ownMomentum.toFixed(4)}, broker=${flow.pressure.toFixed(4)}, ` +
        `tx=${txMomentum.toFixed(4)}, us4=${usMomentum.toFixed(4)}, vix=${vixRisk.toFixed(4)}, ` +
        `industry=${industryMomentum.toFixed(4)}, policy=${policy.penalty.toFixed(4)}).`,
    };
  });

  return {
    status: "READY",
    actionSource: "CB1.0_EXECUTABLE_V1",
    decision: "BUY_HOLD_REDUCE_AVAILABLE",
    weights: CB10_WEIGHTS,
    decisions,
  };
}
