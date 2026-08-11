export const SEMICONDUCTOR_SEGMENTS = [
  {
    id: "AI_SERVER",
    name: "AI Server",
    constituents: [
      { code: "2382", yahoo: "2382.TW", name: "Quanta" },
      { code: "3231", yahoo: "3231.TW", name: "Wistron" },
      { code: "6669", yahoo: "6669.TW", name: "Wiwynn" },
      { code: "2356", yahoo: "2356.TW", name: "Inventec" },
      { code: "3017", yahoo: "3017.TW", name: "Asia Vital Components" },
    ],
  },
  {
    id: "ADVANCED_FOUNDRY",
    name: "Advanced Foundry / TSMC Supply Chain",
    constituents: [
      { code: "2330", yahoo: "2330.TW", name: "TSMC" },
      { code: "2303", yahoo: "2303.TW", name: "UMC" },
      { code: "3443", yahoo: "3443.TW", name: "Global Unichip" },
      { code: "3661", yahoo: "3661.TW", name: "Alchip" },
      { code: "2454", yahoo: "2454.TW", name: "MediaTek" },
    ],
  },
  {
    id: "COWOS_ADVANCED_PACKAGING",
    name: "CoWoS / Advanced Packaging",
    constituents: [
      { code: "3711", yahoo: "3711.TW", name: "ASE Technology" },
      { code: "2449", yahoo: "2449.TW", name: "King Yuan Electronics" },
      { code: "6515", yahoo: "6515.TW", name: "WinWay" },
      { code: "3450", yahoo: "3450.TW", name: "Elite Advanced Laser" },
    ],
  },
  {
    id: "MEMORY_DRAM_HBM",
    name: "Memory / DRAM / HBM Proxy",
    constituents: [
      { code: "2408", yahoo: "2408.TW", name: "Nanya Technology" },
      { code: "2344", yahoo: "2344.TW", name: "Winbond" },
      { code: "8299", yahoo: "8299.TWO", name: "Phison" },
      { code: "MU", yahoo: "MU", name: "Micron" },
      { code: "NVDA", yahoo: "NVDA", name: "Nvidia" },
    ],
  },
  {
    id: "PCB_CCL_HIGH_SPEED",
    name: "PCB / CCL / High-Speed Materials",
    constituents: [
      { code: "6538", yahoo: "6538.TWO", name: "Cheer Time" },
      { code: "2368", yahoo: "2368.TW", name: "Gold Circuit" },
      { code: "3037", yahoo: "3037.TW", name: "Unimicron" },
      { code: "2383", yahoo: "2383.TW", name: "Elite Material" },
      { code: "6213", yahoo: "6213.TW", name: "ITEQ" },
      { code: "6274", yahoo: "6274.TW", name: "Taiwan Union" },
    ],
  },
  {
    id: "THERMAL_COOLING",
    name: "Thermal / Cooling",
    constituents: [
      { code: "3017", yahoo: "3017.TW", name: "Asia Vital Components" },
      { code: "3324", yahoo: "3324.TW", name: "Auras" },
      { code: "3653", yahoo: "3653.TW", name: "Jentech" },
      { code: "2421", yahoo: "2421.TW", name: "Sunonwealth" },
    ],
  },
  {
    id: "POWER_SUPPLY",
    name: "Power Supply",
    constituents: [
      { code: "2308", yahoo: "2308.TW", name: "Delta Electronics" },
      { code: "2317", yahoo: "2317.TW", name: "Hon Hai" },
      { code: "6412", yahoo: "6412.TW", name: "Chicony Power" },
      { code: "1513", yahoo: "1513.TW", name: "Chung-Hsin Electric" },
    ],
  },
];

function unixSeconds(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

function isNumericValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

async function captureYahooIndustryOhlcv({ stock, segment, date, now }) {
  const period1 = unixSeconds(date) - 86400 * 5;
  const period2 = unixSeconds(date) + 86400 * 2;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stock.yahoo}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;
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

  const isValidAt = (index) =>
    [quote.open, quote.high, quote.low, quote.close].every((series) => isNumericValue(series?.[index])) &&
    isNumericValue(quote.volume?.[index] ?? 0);
  let targetIndex = -1;
  for (let index = 0; index < timestamps.length; index += 1) {
    const day = new Date(timestamps[index] * 1000).toISOString().slice(0, 10);
    if (day === date && isValidAt(index)) {
      targetIndex = index;
    }
  }
  if (targetIndex < 0) {
    for (let index = timestamps.length - 1; index >= 0; index -= 1) {
      if (isValidAt(index)) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0) {
    throw new Error("Yahoo chart returned no numeric OHLCV rows");
  }

  const dataDate = new Date(timestamps[targetIndex] * 1000).toISOString().slice(0, 10);
  return {
    EvidenceID: `LIVE-${date}-SEMI-${segment.id}-${stock.code}`,
    Domain: "SEMICONDUCTOR_INDUSTRY",
    FeatureGroup: "RELATIVE_STRENGTH",
    Symbol: stock.code,
    DataDate: dataDate,
    ObservedAt: now,
    RetrievedAt: now,
    AvailableAsOf: now,
    SourceID: "YAHOO_CHART_FALLBACK",
    SourceIdentifier: url,
    SourceTier: "PUBLIC_FALLBACK",
    ValueType: "OHLCV",
    Open: quote.open[targetIndex],
    High: quote.high[targetIndex],
    Low: quote.low[targetIndex],
    CloseLast: quote.close[targetIndex],
    Volume: quote.volume?.[targetIndex] ?? 0,
    TextValue: JSON.stringify({
      segmentId: segment.id,
      segmentName: segment.name,
      companyName: stock.name,
      yahooSymbol: stock.yahoo,
    }),
    QualityTier: "PUBLIC_CONTEXT",
    FreshnessStatus: targetIndex === timestamps.length - 1 ? "FRESH" : "STALE",
    ChampionEligible: false,
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

export async function captureSemiconductorUniverse({ date, now = new Date().toISOString() } = {}) {
  const unique = new Map();
  for (const segment of SEMICONDUCTOR_SEGMENTS) {
    for (const stock of segment.constituents) {
      const key = `${segment.id}:${stock.code}`;
      unique.set(key, { segment, stock });
    }
  }

  const rows = [];
  for (const { segment, stock } of unique.values()) {
    try {
      rows.push(await captureYahooIndustryOhlcv({ stock, segment, date, now }));
    } catch {
      // Optional industry context must not block the core evidence pipeline.
    }
  }
  return rows;
}

export function parseIndustryPayload(row) {
  try {
    return JSON.parse(row.TextValue || "{}");
  } catch {
    return {};
  }
}
