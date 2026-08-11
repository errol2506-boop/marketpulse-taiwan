#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { capturePolicyNews } from "./policyNews.js";
import { captureSemiconductorUniverse } from "./semiconductorUniverse.js";

const TWSE_SYMBOLS = ["3711", "2408", "1303"];
const TPEX_SYMBOLS = ["6538"];
const BROKER_SYMBOLS = ["3711", "2408", "1303", "6538"];
const US_SYMBOLS = ["TSM", "NVDA", "AMD", "AVGO"];
const YAHOO_SYMBOLS = {
  "6538": "6538.TWO",
  TSM: "TSM",
  NVDA: "NVDA",
  AMD: "AMD",
  AVGO: "AVGO",
  VIX_RISK: "%5EVIX",
};
const FALLBACK_NOT_AVAILABLE = "Fallback source is not configured in this workspace.";

function parseArgs(argv) {
  const args = {
    date: "2026-08-11",
    output: "runs/2026-08-11/evidence-live.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") {
      args.date = argv[++index];
    } else if (arg === "--output") {
      args.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function yyyymmdd(date) {
  return date.replaceAll("-", "");
}

function rocDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year - 1911}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function numeric(value) {
  return Number(String(value || "").replaceAll(",", ""));
}

function isNumericValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function parseNumber(value) {
  return Number(String(value || "").replace(/,/g, "").trim());
}

function unixSeconds(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

function evidenceBase({ evidenceId, domain, featureGroup, symbol, now, sourceId, sourceIdentifier }) {
  return {
    EvidenceID: evidenceId,
    Domain: domain,
    FeatureGroup: featureGroup,
    Symbol: symbol,
    DataDate: "",
    ObservedAt: now,
    RetrievedAt: now,
    AvailableAsOf: now,
    SourceID: sourceId,
    SourceIdentifier: sourceIdentifier,
    SourceTier: "OFFICIAL",
    ValueType: "OHLCV",
    Open: "",
    High: "",
    Low: "",
    CloseLast: "",
    Volume: "",
    TextValue: "",
    QualityTier: "OFFICIAL_EXACT",
    FreshnessStatus: "UNKNOWN",
    ChampionEligible: true,
    ResearchEligible: true,
    CaptureStatus: "OK",
    ErrorCode: "",
    Side: "",
    Rank: "",
    BrokerKey: "",
    Lots: "",
    Shares: "",
  };
}

function failedEvidence({ evidenceId, domain, featureGroup, symbol = "", now, sourceId, sourceIdentifier, errorCode, message }) {
  return {
    ...evidenceBase({ evidenceId, domain, featureGroup, symbol, now, sourceId, sourceIdentifier }),
    DataDate: "2026-08-11",
    CaptureStatus: "FAIL",
    ErrorCode: errorCode,
    TextValue: message,
    ChampionEligible: false,
    ResearchEligible: false,
  };
}

function ignoredEvidence({ evidenceId, domain, featureGroup, symbol = "", now, sourceId, message }) {
  return failedEvidence({
    evidenceId,
    domain,
    featureGroup,
    symbol,
    now,
    sourceId,
    sourceIdentifier: message,
    errorCode: "IGNORED_AFTER_FALLBACKS_EXHAUSTED",
    message,
  });
}

async function captureTwseSymbol(symbol, date, now) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${yyyymmdd(date)}&stockNo=${symbol}&response=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TWSE HTTP ${response.status}`);
  }

  const payload = await response.json();
  const row = payload.data?.find((item) => item[0] === rocDate(date));
  if (!row) {
    throw new Error(`TWSE row not found for ${date}`);
  }

  return {
    ...evidenceBase({
      evidenceId: `LIVE-${date}-TWSE-${symbol}`,
      domain: "TW_STOCK_OHLCV",
      featureGroup: "PRICE_STRUCTURE",
      symbol,
      now,
      sourceId: "TWSE_STOCK_DAY",
      sourceIdentifier: url,
    }),
    DataDate: date,
    Open: numeric(row[3]),
    High: numeric(row[4]),
    Low: numeric(row[5]),
    CloseLast: numeric(row[6]),
    Volume: numeric(row[1]),
    TextValue: payload.title || "",
    FreshnessStatus: "FRESH",
  };
}

async function captureYahooOhlcv({ evidenceId, yahooSymbol, domain, featureGroup, symbol, date, now }) {
  const period1 = unixSeconds(date) - 86400 * 5;
  const period2 = unixSeconds(date) + 86400 * 2;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 EvidenceDecisionPipeline/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Yahoo HTTP ${response.status}`);
  }

  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) {
    throw new Error("Yahoo chart returned no OHLCV");
  }

  const targetDay = date;
  const isValidOhlcvAt = (index) =>
    [quote.open, quote.high, quote.low, quote.close].every((series) => isNumericValue(series?.[index])) &&
    isNumericValue(quote.volume?.[index] ?? 0);
  let targetIndex = -1;
  for (let index = 0; index < timestamps.length; index += 1) {
    const day = new Date(timestamps[index] * 1000).toISOString().slice(0, 10);
    if (day === targetDay && isValidOhlcvAt(index)) {
      targetIndex = index;
    }
  }
  if (targetIndex < 0) {
    for (let index = timestamps.length - 1; index >= 0; index -= 1) {
      if (isValidOhlcvAt(index)) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0) {
    throw new Error("Yahoo chart returned no numeric OHLCV rows");
  }

  return {
    ...evidenceBase({
      evidenceId,
      domain,
      featureGroup,
      symbol,
      now,
      sourceId: "YAHOO_CHART_FALLBACK",
      sourceIdentifier: url,
    }),
    DataDate: new Date(timestamps[targetIndex] * 1000).toISOString().slice(0, 10),
    Open: quote.open[targetIndex],
    High: quote.high[targetIndex],
    Low: quote.low[targetIndex],
    CloseLast: quote.close[targetIndex],
    Volume: quote.volume?.[targetIndex] ?? 0,
    SourceTier: "PUBLIC_FALLBACK",
    QualityTier: "OFFICIAL_RECONSTRUCTED",
    FreshnessStatus: targetIndex === timestamps.length - 1 ? "FRESH" : "STALE",
    TextValue: `Yahoo fallback for ${yahooSymbol}`,
  };
}

async function captureTaifexTx(date, now) {
  const url = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TAIFEX HTTP ${response.status}`);
  }
  const rows = await response.json();
  const txRows = rows
    .filter((row) => row.Contract === "TX" && row.TradingSession === "盤後" && !String(row["ContractMonth(Week)"]).includes("/"))
    .sort((a, b) => String(a["ContractMonth(Week)"]).localeCompare(String(b["ContractMonth(Week)"])));
  const selected = txRows.find((row) => row.Date === yyyymmdd(date)) || txRows[0];
  if (!selected) {
    throw new Error("TAIFEX TX after-hours row not found");
  }

  return {
    ...evidenceBase({
      evidenceId: `LIVE-${date}-TAIFEX-TX`,
      domain: "TX_OVERNIGHT",
      featureGroup: "OVERNIGHT_ENVIRONMENT",
      symbol: "",
      now,
      sourceId: "TAIFEX_OPENAPI_DAILY_MARKET_REPORT_FUT",
      sourceIdentifier: url,
    }),
    DataDate: `${selected.Date.slice(0, 4)}-${selected.Date.slice(4, 6)}-${selected.Date.slice(6, 8)}`,
    Open: parseNumber(selected.Open),
    High: parseNumber(selected.High),
    Low: parseNumber(selected.Low),
    CloseLast: parseNumber(selected.Last),
    Volume: parseNumber(selected.Volume),
    SourceTier: "OFFICIAL",
    QualityTier: "OFFICIAL_EXACT",
    FreshnessStatus: selected.Date === yyyymmdd(date) ? "FRESH" : "STALE",
    TextValue: `TAIFEX TX ${selected["ContractMonth(Week)"]} ${selected.TradingSession}`,
  };
}

function htmlText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

async function captureFubonBroker(symbol, date, now) {
  const url = `https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco_${symbol}.djhtm`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fubon HTTP ${response.status}`);
  }
  const html = new TextDecoder("big5").decode(await response.arrayBuffer());
  if (!html.includes("買超券商") || !html.includes("賣超券商")) {
    throw new Error("Fubon broker table not found");
  }
  const updateMatch = html.match(/最後更新日：(\d{4})\/(\d{2})\/(\d{2})/);
  const dataDate = updateMatch ? `${updateMatch[1]}-${updateMatch[2]}-${updateMatch[3]}` : date;
  const rowMatches = [...html.matchAll(/<TR>\s*<TD class="t4t1" nowrap>([\s\S]*?)<\/tr>/gi)];
  const buyRows = [];
  const sellRows = [];

  for (const match of rowMatches) {
    const cells = [...match[0].matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((cell) => htmlText(cell[1]));
    if (cells.length < 10 || cells[0].includes("合計") || cells[0].includes("平均")) {
      continue;
    }
    buyRows.push({
      broker: cells[0],
      buy: parseNumber(cells[1]),
      sell: parseNumber(cells[2]),
      net: parseNumber(cells[3]),
    });
    sellRows.push({
      broker: cells[5],
      buy: parseNumber(cells[6]),
      sell: parseNumber(cells[7]),
      net: parseNumber(cells[8]),
    });
  }

  if (buyRows.length < 3 || sellRows.length < 3) {
    throw new Error("Fubon broker table has fewer than 3 buy/sell rows");
  }

  const toEvidence = (side, row, index) => ({
    ...evidenceBase({
      evidenceId: `LIVE-${date}-FUBON-BROKER-${symbol}-${side}-${index + 1}`,
      domain: "BROKER_FLOW",
      featureGroup: "FLOW_POSITIONING",
      symbol,
      now,
      sourceId: "FUBON_EBROKERDJ_PUBLIC_HTML",
      sourceIdentifier: url,
    }),
    DataDate: dataDate,
    SourceTier: "PUBLIC_FALLBACK",
    QualityTier: "VERIFIED_PUBLIC_OR_BRIDGE",
    FreshnessStatus: dataDate === date ? "FRESH" : "STALE",
    ValueType: "BROKER_RANK",
    Open: "",
    High: "",
    Low: "",
    CloseLast: "",
    Volume: "",
    Side: side,
    Rank: index + 1,
    BrokerKey: row.broker,
    Lots: row.net,
    Shares: row.net * 1000,
    TextValue: `Fubon broker ${symbol} ${side}${index + 1}: buy=${row.buy}, sell=${row.sell}, net=${row.net}`,
  });

  return [
    ...buyRows.slice(0, 3).map((row, index) => toEvidence("BUY", row, index)),
    ...sellRows.slice(0, 3).map((row, index) => toEvidence("SELL", row, index)),
  ];
}

async function firstSuccessfulEvidence(layers, ignored) {
  const failures = [];
  for (const layer of layers) {
    try {
      const evidence = await layer.capture();
      evidence.TextValue = `${evidence.TextValue}; ${layer.name} succeeded`;
      return evidence;
    } catch (error) {
      failures.push(`${layer.name} failed: ${error.message}`);
    }
  }
  return ignored(failures);
}

export async function captureTodayEvidence({ date }) {
  const now = new Date().toISOString();
  const rows = [];

  for (const symbol of TWSE_SYMBOLS) {
    try {
      rows.push(await captureTwseSymbol(symbol, date, now));
    } catch (error) {
      rows.push(
        failedEvidence({
          evidenceId: `LIVE-${date}-TWSE-${symbol}-FAIL`,
          domain: "TW_STOCK_OHLCV",
          featureGroup: "PRICE_STRUCTURE",
          symbol,
          now,
          sourceId: "TWSE_STOCK_DAY",
          sourceIdentifier: "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY",
          errorCode: "TWSE_CAPTURE_FAILED",
          message: error.message,
        }),
      );
    }
  }

  for (const symbol of TPEX_SYMBOLS) {
    rows.push(
      await firstSuccessfulEvidence(
        [
          {
            name: "Layer1 YAHOO_CHART_FALLBACK",
            capture: () =>
              captureYahooOhlcv({
                evidenceId: `LIVE-${date}-YAHOO-${symbol}`,
                yahooSymbol: YAHOO_SYMBOLS[symbol],
                domain: "TW_STOCK_OHLCV",
                featureGroup: "PRICE_STRUCTURE",
                symbol,
                date,
                now,
              }),
          },
        ],
        (failures) =>
          ignoredEvidence({
            evidenceId: `LIVE-${date}-TPEX-${symbol}-IGNORED`,
            domain: "TW_STOCK_OHLCV",
            featureGroup: "PRICE_STRUCTURE",
            symbol,
            now,
            sourceId: "TPEX_FALLBACKS_EXHAUSTED",
            message: `${failures.join("; ")}. ${FALLBACK_NOT_AVAILABLE}`,
          }),
      ),
    );
  }

  for (const symbol of US_SYMBOLS) {
    rows.push(
      await firstSuccessfulEvidence(
        [
          {
            name: "Layer1 YAHOO_CHART_FALLBACK",
            capture: () =>
              captureYahooOhlcv({
                evidenceId: `LIVE-${date}-YAHOO-US-${symbol}`,
                yahooSymbol: YAHOO_SYMBOLS[symbol],
                domain: "US_EQUITY",
                featureGroup: "CROSS_MARKET",
                symbol,
                date,
                now,
              }),
          },
        ],
        (failures) =>
          ignoredEvidence({
            evidenceId: `LIVE-${date}-US-${symbol}-IGNORED`,
            domain: "US_EQUITY",
            featureGroup: "CROSS_MARKET",
            symbol,
            now,
            sourceId: "US4_FALLBACKS_EXHAUSTED",
            message: failures.join("; "),
          }),
      ),
    );
  }

  rows.push(
    await firstSuccessfulEvidence(
      [
        {
          name: "Layer1 YAHOO_CHART_FALLBACK",
          capture: () =>
            captureYahooOhlcv({
              evidenceId: `LIVE-${date}-YAHOO-VIX`,
              yahooSymbol: YAHOO_SYMBOLS.VIX_RISK,
              domain: "VIX_RISK",
              featureGroup: "CROSS_MARKET",
              symbol: "",
              date,
              now,
            }),
        },
      ],
      (failures) =>
        ignoredEvidence({
          evidenceId: `LIVE-${date}-VIX_RISK-IGNORED`,
          domain: "VIX_RISK",
          featureGroup: "CROSS_MARKET",
          now,
          sourceId: "VIX_FALLBACKS_EXHAUSTED",
          message: failures.join("; "),
        }),
    ),
  );

  rows.push(
    await firstSuccessfulEvidence(
      [
        {
          name: "Layer1 TAIFEX_OPENAPI_DAILY_MARKET_REPORT_FUT",
          capture: () => captureTaifexTx(date, now),
        },
      ],
      (failures) =>
        ignoredEvidence({
          evidenceId: `LIVE-${date}-TX_OVERNIGHT-IGNORED`,
          domain: "TX_OVERNIGHT",
          featureGroup: "OVERNIGHT_ENVIRONMENT",
          now,
          sourceId: "TX_FALLBACKS_EXHAUSTED",
          message: failures.join("; "),
        }),
    ),
  );

  for (const symbol of BROKER_SYMBOLS) {
    const brokerEvidence = await firstSuccessfulEvidence(
      [
        {
          name: "Layer1 FUBON_EBROKERDJ_PUBLIC_HTML",
          capture: () => captureFubonBroker(symbol, date, now),
        },
      ],
      (failures) =>
        ignoredEvidence({
          evidenceId: `LIVE-${date}-BROKER_FLOW-${symbol}-IGNORED`,
          domain: "BROKER_FLOW",
          featureGroup: "FLOW_POSITIONING",
          symbol,
          now,
          sourceId: "BROKER_FALLBACKS_EXHAUSTED",
          message: failures.join("; "),
        }),
    );
    rows.push(...(Array.isArray(brokerEvidence) ? brokerEvidence : [brokerEvidence]));
  }

  rows.push(...(await capturePolicyNews({ date, now })));
  rows.push(...(await captureSemiconductorUniverse({ date, now })));

  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = await captureTodayEvidence(args);
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${rows.length} evidence rows to ${args.output}\n`);
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 2;
  });
}
