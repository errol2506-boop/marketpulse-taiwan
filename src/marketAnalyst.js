import { parsePolicyNewsPayload } from "./policyNews.js";
import { SEMICONDUCTOR_SEGMENTS, parseIndustryPayload } from "./semiconductorUniverse.js";

const TARGET_SYMBOLS = ["3711", "2408", "1303", "6538"];
const US4_SYMBOLS = ["TSM", "NVDA", "AMD", "AVGO"];

function pctChange(row) {
  const open = Number(row?.Open);
  const close = Number(row?.CloseLast);
  if (!Number.isFinite(open) || open === 0 || !Number.isFinite(close)) {
    return 0;
  }
  return (close - open) / open;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeProbabilities(probabilities) {
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    Object.entries(probabilities).map(([key, value]) => [key, Number((value / total).toFixed(4))]),
  );
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function brokerBalance(rows, symbol) {
  const brokerRows = rows.filter((row) => row.Domain === "BROKER_FLOW" && row.Symbol === symbol);
  const buyLots = brokerRows
    .filter((row) => String(row.Side || "").toUpperCase() === "BUY")
    .reduce((sum, row) => sum + Number(row.Lots || 0), 0);
  const sellLots = brokerRows
    .filter((row) => String(row.Side || "").toUpperCase() === "SELL")
    .reduce((sum, row) => sum + Number(row.Lots || 0), 0);
  return buyLots - sellLots;
}

function starRating(score) {
  if (score >= 0.7) return 5;
  if (score >= 0.45) return 4;
  if (score >= 0.15) return 3;
  if (score >= -0.15) return 2;
  return 1;
}

function classifyMarketRegime(metrics) {
  if (metrics.targetAverageMove >= 0.04 || metrics.strongAdvanceCount >= 3) {
    return "STRONG_REBOUND";
  }
  if (metrics.targetAverageMove <= -0.03 || metrics.us4AverageMove <= -0.025) {
    return "RISK_OFF_PULLBACK";
  }
  if (Math.abs(metrics.targetAverageMove) <= 0.012) {
    return "CONSOLIDATION";
  }
  return "MIXED_REBOUND";
}

function buildScenarioProbabilities(metrics) {
  let continuation = 0.35;
  let consolidation = 0.45;
  let pullback = 0.2;

  if (metrics.txMove > 0.01) {
    continuation += 0.07;
    pullback -= 0.03;
  }
  if (metrics.us4AverageMove < -0.01) {
    continuation -= 0.08;
    consolidation += 0.04;
    pullback += 0.04;
  }
  if (metrics.targetAverageMove > 0.025) {
    continuation -= 0.03;
    consolidation += 0.05;
    pullback += 0.03;
  }
  if (metrics.positiveBrokerBalanceCount >= 2) {
    continuation += 0.04;
    pullback -= 0.02;
  }
  if (metrics.policyRiskScore >= 8) {
    continuation -= 0.08;
    consolidation += 0.03;
    pullback += 0.05;
  } else if (metrics.policyRiskScore >= 5) {
    continuation -= 0.04;
    consolidation += 0.02;
    pullback += 0.02;
  }

  if (metrics.vixClose > 22) {
    continuation -= 0.06;
    consolidation += 0.02;
    pullback += 0.04;
  } else if (metrics.vixClose > 0 && metrics.vixClose < 18) {
    continuation += 0.03;
    pullback -= 0.02;
  }

  continuation = clamp(continuation, 0.05, 0.75);
  consolidation = clamp(consolidation, 0.1, 0.8);
  pullback = clamp(pullback, 0.05, 0.65);

  return normalizeProbabilities({
    continuationBreakout: continuation,
    consolidation: consolidation,
    pullback: pullback,
  });
}

function summarizePolicyNews(rows) {
  const policyRows = rows.filter((row) => row.Domain === "POLICY_NEWS" && row.CaptureStatus === "OK");
  const events = policyRows
    .map((row) => parsePolicyNewsPayload(row))
    .filter((payload) => payload.title)
    .sort((a, b) => Number(b.riskScore || 0) - Number(a.riskScore || 0));
  const maxRiskScore = events.reduce((max, event) => Math.max(max, Number(event.riskScore || 0)), 0);
  const highRiskCount = events.filter((event) => event.riskLevel === "HIGH").length;
  const mediumRiskCount = events.filter((event) => event.riskLevel === "MEDIUM").length;

  return {
    eventCount: events.length,
    maxRiskScore,
    highRiskCount,
    mediumRiskCount,
    topEvents: events.slice(0, 5),
  };
}

function buildIndustryRanking(metrics, rows) {
  const industryRows = rows.filter((row) => row.Domain === "SEMICONDUCTOR_INDUSTRY");
  if (industryRows.length > 0) {
    const bySegment = new Map();
    for (const row of industryRows) {
      const payload = parseIndustryPayload(row);
      const segmentId = payload.segmentId || "UNKNOWN";
      if (!bySegment.has(segmentId)) {
        bySegment.set(segmentId, {
          segment: payload.segmentName || segmentId,
          moves: [],
          freshCount: 0,
          staleCount: 0,
          constituentCount: 0,
        });
      }
      const bucket = bySegment.get(segmentId);
      bucket.moves.push(pctChange(row));
      bucket.constituentCount += 1;
      if (row.FreshnessStatus === "FRESH") {
        bucket.freshCount += 1;
      } else {
        bucket.staleCount += 1;
      }
    }

    for (const segment of SEMICONDUCTOR_SEGMENTS) {
      if (!bySegment.has(segment.id)) {
        bySegment.set(segment.id, {
          segment: segment.name,
          moves: [],
          freshCount: 0,
          staleCount: 0,
          constituentCount: 0,
        });
      }
    }

    return [...bySegment.values()]
      .map((bucket) => {
        const segmentMove = average(bucket.moves);
        const score = segmentMove * 12 + metrics.txMove * 3 + metrics.us4AverageMove * 2 + metrics.vixRisk * 2;
        return {
          segment: bucket.segment,
          rating: starRating(score),
          bias: score >= 0.25 ? "BULLISH" : score >= 0.05 ? "NEUTRAL_TO_BULLISH" : score >= -0.15 ? "CONSOLIDATION" : "WEAK",
          evidence:
            bucket.constituentCount > 0
              ? `Uses ${bucket.constituentCount} captured constituents; average move ${(segmentMove * 100).toFixed(2)}%.`
              : "No live constituents captured; retained in universe for coverage tracking.",
          constituentCount: bucket.constituentCount,
          averageMove: segmentMove,
          freshCount: bucket.freshCount,
          staleCount: bucket.staleCount,
        };
      })
      .sort((a, b) => b.rating - a.rating || b.averageMove - a.averageMove);
  }

  const aiScore = metrics.txMove * 8 + metrics.us4AverageMove * 5 + metrics.vixRisk * 4;
  const memoryScore = metrics.bySymbol["2408"]?.priceMove * 4 + metrics.us4AverageMove * 2;
  const materialsScore = metrics.bySymbol["1303"]?.priceMove * 4 + metrics.txMove * 2;
  const pcbScore = metrics.bySymbol["6538"]?.priceMove * 4 + metrics.txMove * 2;

  return [
    {
      segment: "AI chip / AI server / CoWoS / HBM",
      rating: starRating(aiScore),
      bias: aiScore >= 0.15 ? "BULLISH" : aiScore >= -0.1 ? "NEUTRAL_TO_BULLISH" : "NEUTRAL",
      evidence: "Uses TX overnight, US4 semiconductor proxies, and VIX risk.",
    },
    {
      segment: "Memory / DRAM",
      rating: starRating(memoryScore),
      bias: memoryScore >= 0.15 ? "BULLISH" : memoryScore >= -0.1 ? "CONSOLIDATION" : "WEAK",
      evidence: "Uses 2408 price behavior and US4 proxy pressure.",
    },
    {
      segment: "PCB / CCL / high-speed materials",
      rating: starRating(pcbScore),
      bias: pcbScore >= 0.15 ? "BULLISH" : pcbScore >= -0.1 ? "NEUTRAL_TO_BULLISH" : "WEAK",
      evidence: "Uses 6538 as current tracked proxy plus TX overnight.",
    },
    {
      segment: "Non-semiconductor tracked proxy: 1303",
      rating: starRating(materialsScore),
      bias: materialsScore >= 0.15 ? "BULLISH" : materialsScore >= -0.1 ? "CONSOLIDATION" : "WEAK",
      evidence: "Uses 1303 as a tracked market proxy; not classified as a semiconductor subgroup.",
    },
  ].sort((a, b) => b.rating - a.rating);
}

export function buildMarketAnalysis(result) {
  const rows = result.validation.selectedEvidence;
  const targetRows = TARGET_SYMBOLS.map((symbol) =>
    rows.find((row) => row.Domain === "TW_STOCK_OHLCV" && row.Symbol === symbol),
  ).filter(Boolean);
  const usRows = US4_SYMBOLS.map((symbol) =>
    rows.find((row) => row.Domain === "US_EQUITY" && row.Symbol === symbol),
  ).filter(Boolean);
  const txRow = rows.find((row) => row.Domain === "TX_OVERNIGHT");
  const vixRow = rows.find((row) => row.Domain === "VIX_RISK");
  const policyNews = summarizePolicyNews(rows);

  const bySymbol = Object.fromEntries(
    TARGET_SYMBOLS.map((symbol) => {
      const stockRow = rows.find((row) => row.Domain === "TW_STOCK_OHLCV" && row.Symbol === symbol);
      const priceMove = pctChange(stockRow);
      return [
        symbol,
        {
          priceMove,
          brokerBalanceLots: brokerBalance(rows, symbol),
        },
      ];
    }),
  );

  const vixClose = Number(vixRow?.CloseLast);
  const metrics = {
    targetAverageMove: average(targetRows.map(pctChange)),
    us4AverageMove: average(usRows.map(pctChange)),
    txMove: pctChange(txRow),
    vixClose: Number.isFinite(vixClose) ? vixClose : 0,
    vixRisk: Number.isFinite(vixClose) ? clamp((18 - vixClose) / 1000, -0.02, 0.02) : 0,
    policyRiskScore: policyNews.maxRiskScore,
    strongAdvanceCount: targetRows.filter((row) => pctChange(row) >= 0.03).length,
    positiveBrokerBalanceCount: Object.values(bySymbol).filter((item) => item.brokerBalanceLots > 0).length,
    bySymbol,
  };

  const marketRegime = classifyMarketRegime(metrics);
  const scenarioProbabilities = buildScenarioProbabilities(metrics);
  const industryRanking = buildIndustryRanking(metrics, rows);

  return {
    status: result.validation.coverageLevel === "FULL" ? "READY" : "PARTIAL",
    model: "MARKET_ANALYST_LAYER_V1",
    marketRegime,
    metrics,
    scenarioProbabilities,
    industryRanking,
    interpretation: {
      shortCoveringLikelihood:
        metrics.targetAverageMove >= 0.03 && metrics.us4AverageMove < 0 ? "MEDIUM_HIGH" : "MEDIUM",
      meanReversionRisk: metrics.targetAverageMove >= 0.025 ? "ELEVATED" : "NORMAL",
      macroRisk: metrics.vixClose >= 22 ? "ELEVATED" : metrics.us4AverageMove < -0.015 ? "WATCH" : "NORMAL",
      geopoliticalRisk:
        policyNews.highRiskCount > 0
          ? "ELEVATED"
          : policyNews.mediumRiskCount > 0
            ? "WATCH"
            : policyNews.eventCount > 0
              ? "NORMAL"
              : "NOT_CAPTURED_BY_CURRENT_DATA",
    },
    policyNews,
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function stars(value) {
  return `${value}/5`;
}

export function formatMarketAnalysisReport(analysis) {
  const scenarios = analysis.scenarioProbabilities;
  const lines = [
    "Market Analyst Layer",
    `status: ${analysis.status}`,
    `model: ${analysis.model}`,
    `marketRegime: ${analysis.marketRegime}`,
    "",
    "Macro / Cross-Market:",
    `- TX overnight move: ${percent(analysis.metrics.txMove)}`,
    `- US4 average move: ${percent(analysis.metrics.us4AverageMove)}`,
    `- VIX close: ${analysis.metrics.vixClose.toFixed(2)}`,
    `- Policy/news events captured: ${analysis.policyNews.eventCount}`,
    `- Policy/news max risk score: ${analysis.policyNews.maxRiskScore}`,
    `- Short-covering likelihood: ${analysis.interpretation.shortCoveringLikelihood}`,
    `- Mean-reversion risk: ${analysis.interpretation.meanReversionRisk}`,
    `- Geopolitical risk: ${analysis.interpretation.geopoliticalRisk}`,
    "",
    "Next-Week Scenario Probabilities:",
    `- Continuation breakout: ${percent(scenarios.continuationBreakout)}`,
    `- Range consolidation: ${percent(scenarios.consolidation)}`,
    `- Pullback: ${percent(scenarios.pullback)}`,
    "",
    "Semiconductor / Industry Ranking:",
  ];

  for (const item of analysis.industryRanking) {
    lines.push(`- ${item.segment}: ${stars(item.rating)} ${item.bias}; ${item.evidence}`);
  }

  if (analysis.policyNews.topEvents.length > 0) {
    lines.push("", "Policy / Geopolitical News Signals:");
    for (const event of analysis.policyNews.topEvents) {
      lines.push(`- [${event.riskLevel}] ${event.title} (${event.source || "unknown source"})`);
    }
  }

  return `${lines.join("\n")}\n`;
}
