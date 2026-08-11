const REQUIRED_COLUMNS = [
  "EvidenceID",
  "Domain",
  "FeatureGroup",
  "Symbol",
  "DataDate",
  "ObservedAt",
  "RetrievedAt",
  "AvailableAsOf",
  "SourceID",
  "SourceIdentifier",
  "SourceTier",
  "ValueType",
  "QualityTier",
  "FreshnessStatus",
  "ChampionEligible",
  "ResearchEligible",
  "CaptureStatus",
];

const TARGET_TW_SYMBOLS = ["3711", "2408", "1303", "6538"];
const REQUIRED_US_SYMBOLS = ["TSM", "NVDA", "AMD", "AVGO"];
const BROKER_SIDES = ["BUY", "SELL"];
const ALLOWED_DOMAINS = new Set([
  "TW_STOCK_OHLCV",
  "TX_OVERNIGHT",
  "VIX_RISK",
  "BROKER_FLOW",
  "US_EQUITY",
  "TAIEX_SECTOR",
  "POLICY_NEWS",
  "SEMICONDUCTOR_INDUSTRY",
]);
const ALLOWED_FRESHNESS = new Set(["FRESH", "STALE", "T_MINUS_1", "UNKNOWN"]);
const CHAMPION_QUALITY = new Set([
  "OFFICIAL_EXACT",
  "OFFICIAL_RECONSTRUCTED",
  "VERIFIED_PUBLIC_OR_BRIDGE",
]);

function toMillis(value, fieldName, issues, rowId) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    issues.push({
      severity: "ERROR",
      code: "INVALID_TIMESTAMP",
      rowId,
      message: `${fieldName} is not a valid timestamp: ${value}`,
    });
  }
  return millis;
}

function isTrue(value) {
  return value === true || String(value).toUpperCase() === "TRUE";
}

function isOkCapture(row) {
  return String(row.CaptureStatus || "").toUpperCase() === "OK";
}

function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
}

function hasTestMarker(row) {
  return [
    row.EvidenceID,
    row.SourceID,
    row.SourceIdentifier,
    row.CaptureStatus,
    row.TextValue,
  ]
    .filter(Boolean)
    .some((value) => String(value).toUpperCase().includes("TEST"));
}

function hasNumericOhlcv(row) {
  return ["Open", "High", "Low", "CloseLast", "Volume"].every((field) => {
    const value = row[field];
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  });
}

function hasValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function addIssue(issues, severity, code, message, rowId = undefined) {
  issues.push({ severity, code, message, rowId });
}

function validateRowShape(row, issues) {
  const rowId = row.EvidenceID || "(missing EvidenceID)";
  for (const column of REQUIRED_COLUMNS) {
    if (row[column] === undefined || row[column] === null) {
      addIssue(issues, "ERROR", "MISSING_REQUIRED_COLUMN", `${column} is required`, rowId);
    }
  }

  const observedAt = toMillis(row.ObservedAt, "ObservedAt", issues, rowId);
  const retrievedAt = toMillis(row.RetrievedAt, "RetrievedAt", issues, rowId);
  const availableAsOf = toMillis(row.AvailableAsOf, "AvailableAsOf", issues, rowId);

  if (!ALLOWED_DOMAINS.has(row.Domain)) {
    addIssue(issues, "ERROR", "UNKNOWN_DOMAIN", `Unknown evidence domain ${row.Domain}`, rowId);
  }

  if (!hasValidDateOnly(row.DataDate)) {
    addIssue(issues, "ERROR", "INVALID_DATA_DATE", `DataDate must be YYYY-MM-DD: ${row.DataDate}`, rowId);
  }

  if (Number.isFinite(observedAt) && Number.isFinite(retrievedAt) && observedAt > retrievedAt) {
    addIssue(issues, "ERROR", "OBSERVED_AFTER_RETRIEVED", "ObservedAt cannot be after RetrievedAt", rowId);
  }

  if (Number.isFinite(availableAsOf) && Number.isFinite(retrievedAt) && availableAsOf > retrievedAt) {
    addIssue(issues, "WARN", "AVAILABLE_AFTER_RETRIEVED", "AvailableAsOf is after RetrievedAt; verify source timing policy", rowId);
  }

  if (!isOkCapture(row)) {
    addIssue(issues, "ERROR", "CAPTURE_NOT_OK", `CaptureStatus is ${row.CaptureStatus}`, rowId);
    return;
  }

  if (!ALLOWED_FRESHNESS.has(normalizeText(row.FreshnessStatus))) {
    addIssue(issues, "WARN", "UNKNOWN_FRESHNESS", `Unknown FreshnessStatus ${row.FreshnessStatus}`, rowId);
  }

  if (isTrue(row.ChampionEligible) && !CHAMPION_QUALITY.has(normalizeText(row.QualityTier))) {
    addIssue(issues, "ERROR", "CHAMPION_INELIGIBLE_QUALITY", `QualityTier ${row.QualityTier} cannot feed CB1.0`, rowId);
  }

  if (
    ["TW_STOCK_OHLCV", "US_EQUITY", "VIX_RISK", "TX_OVERNIGHT", "SEMICONDUCTOR_INDUSTRY"].includes(row.Domain) &&
    !hasNumericOhlcv(row)
  ) {
    addIssue(issues, "ERROR", "INVALID_OHLCV", `${row.Domain} requires numeric Open/High/Low/CloseLast/Volume`, rowId);
  }

  if (row.Domain === "BROKER_FLOW") {
    if (!BROKER_SIDES.includes(String(row.Side || "").toUpperCase())) {
      addIssue(issues, "ERROR", "INVALID_BROKER_SIDE", "Broker flow Side must be BUY or SELL", rowId);
    }
    if (!Number.isFinite(Number(row.Rank)) || Number(row.Rank) < 1 || Number(row.Rank) > 3) {
      addIssue(issues, "ERROR", "INVALID_BROKER_RANK", "Broker flow Rank must be 1, 2, or 3", rowId);
    }
    if (!row.BrokerKey) {
      addIssue(issues, "ERROR", "MISSING_BROKER_KEY", "Broker flow requires BrokerKey", rowId);
    }
  }
}

function selectSnapshotRows(rows, cutoffMillis, issues, environment, timePolicy) {
  const selected = [];
  const lateExcluded = [];
  const seenEvidenceIds = new Set();

  for (const row of rows) {
    const rowId = row.EvidenceID || "(missing EvidenceID)";
    if (seenEvidenceIds.has(row.EvidenceID)) {
      addIssue(issues, "ERROR", "DUPLICATE_EVIDENCE_ID", "EvidenceID must be unique", rowId);
      continue;
    }
    seenEvidenceIds.add(row.EvidenceID);

    if (environment === "PRODUCTION" && hasTestMarker(row)) {
      addIssue(issues, "ERROR", "TEST_DATA_IN_PRODUCTION", "TEST evidence cannot enter production validation", rowId);
      continue;
    }

    if (!isOkCapture(row)) {
      continue;
    }

    const availableAsOf = Date.parse(row.AvailableAsOf);
    if (!Number.isFinite(availableAsOf)) {
      continue;
    }

    if (timePolicy === "LATEST" || availableAsOf <= cutoffMillis) {
      selected.push(row);
    } else {
      lateExcluded.push(row);
    }
  }

  const pitViolations =
    timePolicy === "LATEST" ? [] : selected.filter((row) => Date.parse(row.AvailableAsOf) > cutoffMillis);
  return { selected, lateExcluded, pitViolations };
}

function findRows(rows, predicate) {
  return rows.filter(predicate);
}

function hasChampionRow(rows, predicate) {
  return rows.some((row) => isTrue(row.ChampionEligible) && predicate(row));
}

function evaluateRequiredInputs(selected, issues) {
  const missing = [];

  for (const symbol of TARGET_TW_SYMBOLS) {
    if (
      !hasChampionRow(
        selected,
        (row) => row.Domain === "TW_STOCK_OHLCV" && row.Symbol === symbol && hasNumericOhlcv(row),
      )
    ) {
      missing.push(`TW_STOCK_OHLCV:${symbol}`);
    }
  }

  for (const symbol of REQUIRED_US_SYMBOLS) {
    if (!hasChampionRow(selected, (row) => row.Domain === "US_EQUITY" && row.Symbol === symbol)) {
      missing.push(`US_EQUITY:${symbol}`);
    }
  }

  if (!hasChampionRow(selected, (row) => row.Domain === "TX_OVERNIGHT")) {
    missing.push("TX_OVERNIGHT");
  }

  if (!hasChampionRow(selected, (row) => row.Domain === "VIX_RISK")) {
    missing.push("VIX_RISK");
  }

  for (const side of BROKER_SIDES) {
    const sideRows = findRows(
      selected,
      (row) =>
        row.Domain === "BROKER_FLOW" &&
        String(row.Side || "").toUpperCase() === side &&
        Number(row.Rank) >= 1 &&
        Number(row.Rank) <= 3 &&
        row.BrokerKey &&
        isTrue(row.ChampionEligible),
    );
    const ranks = new Set(sideRows.map((row) => Number(row.Rank)));
    const rankCounts = new Map();
    for (const row of sideRows) {
      const rank = Number(row.Rank);
      const key = `${row.Symbol || "MARKET"}:${rank}`;
      rankCounts.set(key, (rankCounts.get(key) || 0) + 1);
    }
    for (const [key, count] of rankCounts) {
      if (count > 1) {
        addIssue(issues, "ERROR", "DUPLICATE_BROKER_RANK", `Broker ${side}${key} has ${count} rows`);
      }
    }
    for (const rank of [1, 2, 3]) {
      if (!ranks.has(rank)) {
        missing.push(`BROKER_FLOW:${side}${rank}`);
      }
    }
  }

  for (const item of missing) {
    addIssue(issues, "ERROR", "MISSING_MODEL_INPUT", `Missing required CB1.0 input ${item}`);
  }

  return missing;
}

export function validateEvidenceDecisionFlow(rows, options = {}) {
  const cutoff = options.cutoff || "2026-08-11T06:30:00+08:00";
  const environment = options.environment || "PRODUCTION";
  const timePolicy = options.timePolicy || "PIT";
  const cutoffMillis = Date.parse(cutoff);
  const issues = [];

  if (!Array.isArray(rows)) {
    throw new TypeError("rows must be an array of Evidence Store row objects");
  }
  if (!Number.isFinite(cutoffMillis)) {
    throw new TypeError(`Invalid cutoff timestamp: ${cutoff}`);
  }

  for (const row of rows) {
    validateRowShape(row, issues);
  }

  const { selected, lateExcluded, pitViolations } = selectSnapshotRows(
    rows,
    cutoffMillis,
    issues,
    environment,
    timePolicy,
  );
  for (const row of pitViolations) {
    addIssue(issues, "ERROR", "PIT_VIOLATION", "Selected evidence is after cutoff", row.EvidenceID);
  }

  const missingInputs = evaluateRequiredInputs(selected, issues);
  const hasCriticalError = issues.some((issue) => issue.severity === "ERROR");
  const coverageLevel =
    missingInputs.length === 0 && pitViolations.length === 0 ? "FULL" : selected.length > 0 ? "PARTIAL" : "NO_DECISION";

  return {
    cutoff,
    environment,
    timePolicy,
    selectedCount: selected.length,
    lateExcludedCount: lateExcluded.length,
    pitViolationCount: pitViolations.length,
    coverageLevel,
    cb10: coverageLevel === "FULL" && !hasCriticalError ? "READY" : "NO_PRODUCTION",
    v4r12: coverageLevel === "FULL" && !hasCriticalError ? "READY" : "UNASSESSED",
    selectedEvidenceIds: selected.map((row) => row.EvidenceID),
    lateExcludedEvidenceIds: lateExcluded.map((row) => row.EvidenceID),
    selectedEvidence: selected.map((row) => ({ ...row })),
    lateExcludedEvidence: lateExcluded.map((row) => ({ ...row })),
    missingInputs,
    issues,
  };
}

export function formatReport(result) {
  const lines = [
    `Evidence Decision Guard`,
    `cutoff: ${result.cutoff}`,
    `environment: ${result.environment}`,
    `timePolicy: ${result.timePolicy}`,
    `coverage: ${result.coverageLevel}`,
    `cb10: ${result.cb10}`,
    `v4r12: ${result.v4r12}`,
    `selected: ${result.selectedCount}`,
    `lateExcluded: ${result.lateExcludedCount}`,
    `pitViolations: ${result.pitViolationCount}`,
  ];

  if (result.missingInputs.length > 0) {
    lines.push("", "Missing inputs:");
    for (const item of result.missingInputs) {
      lines.push(`- ${item}`);
    }
  }

  if (result.lateExcludedEvidenceIds.length > 0) {
    lines.push("", "Late excluded:");
    for (const id of result.lateExcludedEvidenceIds) {
      lines.push(`- ${id}`);
    }
  }

  if (result.issues.length > 0) {
    lines.push("", "Issues:");
    for (const issue of result.issues) {
      const row = issue.rowId ? ` [${issue.rowId}]` : "";
      lines.push(`- ${issue.severity} ${issue.code}${row}: ${issue.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
