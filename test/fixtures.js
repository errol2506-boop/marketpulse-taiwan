export function baseEvidenceRow(overrides) {
  return {
    EvidenceID: overrides.EvidenceID,
    Domain: overrides.Domain,
    FeatureGroup: overrides.FeatureGroup || "PRICE_STRUCTURE",
    Symbol: overrides.Symbol || "",
    DataDate: overrides.DataDate || "2026-08-10",
    ObservedAt: overrides.ObservedAt || "2026-08-10T13:30:00+08:00",
    RetrievedAt: overrides.RetrievedAt || "2026-08-11T06:00:00+08:00",
    AvailableAsOf: overrides.AvailableAsOf || "2026-08-11T06:00:00+08:00",
    SourceID: overrides.SourceID || "OFFICIAL",
    SourceIdentifier: overrides.SourceIdentifier || "fixture-official",
    SourceTier: overrides.SourceTier || "OFFICIAL",
    ValueType: overrides.ValueType || "OHLCV",
    Open: overrides.Open ?? 10,
    High: overrides.High ?? 11,
    Low: overrides.Low ?? 9,
    CloseLast: overrides.CloseLast ?? 10.5,
    Volume: overrides.Volume ?? 1000,
    TextValue: overrides.TextValue || "",
    QualityTier: overrides.QualityTier || "OFFICIAL_EXACT",
    FreshnessStatus: overrides.FreshnessStatus || "FRESH",
    ChampionEligible: overrides.ChampionEligible ?? true,
    ResearchEligible: overrides.ResearchEligible ?? true,
    CaptureStatus: overrides.CaptureStatus || "OK",
    ErrorCode: overrides.ErrorCode || "",
    Side: overrides.Side || "",
    Rank: overrides.Rank || "",
    BrokerKey: overrides.BrokerKey || "",
    Lots: overrides.Lots || "",
    Shares: overrides.Shares || "",
  };
}

export function completeFixture() {
  const rows = [];
  for (const symbol of ["3711", "2408", "1303", "6538"]) {
    rows.push(
      baseEvidenceRow({
        EvidenceID: `TW-${symbol}`,
        Domain: "TW_STOCK_OHLCV",
        Symbol: symbol,
        FeatureGroup: "PRICE_STRUCTURE",
      }),
    );
  }
  for (const symbol of ["TSM", "NVDA", "AMD", "AVGO"]) {
    rows.push(
      baseEvidenceRow({
        EvidenceID: `US-${symbol}`,
        Domain: "US_EQUITY",
        Symbol: symbol,
        FeatureGroup: "CROSS_MARKET",
      }),
    );
  }
  rows.push(
    baseEvidenceRow({
      EvidenceID: "TX-1",
      Domain: "TX_OVERNIGHT",
      FeatureGroup: "OVERNIGHT_ENVIRONMENT",
      SourceTier: "OFFICIAL_RECONSTRUCTED",
      QualityTier: "OFFICIAL_RECONSTRUCTED",
    }),
  );
  rows.push(
    baseEvidenceRow({
      EvidenceID: "VIX-1",
      Domain: "VIX_RISK",
      FeatureGroup: "CROSS_MARKET",
      SourceTier: "OFFICIAL_EXACT",
    }),
  );
  for (const side of ["BUY", "SELL"]) {
    for (const rank of [1, 2, 3]) {
      rows.push(
        baseEvidenceRow({
          EvidenceID: `BROKER-${side}-${rank}`,
          Domain: "BROKER_FLOW",
          FeatureGroup: "FLOW_POSITIONING",
          ValueType: "BROKER_RANK",
          Open: "",
          High: "",
          Low: "",
          CloseLast: "",
          Volume: "",
          SourceTier: "VERIFIED_PUBLIC_OR_BRIDGE",
          QualityTier: "VERIFIED_PUBLIC_OR_BRIDGE",
          Side: side,
          Rank: rank,
          BrokerKey: `${side}-BROKER-${rank}`,
          Lots: 100 - rank,
          Shares: (100 - rank) * 1000,
        }),
      );
    }
  }
  return rows;
}
