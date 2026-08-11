const POLICY_NEWS_QUERIES = [
  {
    id: "US_CHINA_SEMICONDUCTOR_POLICY",
    query: "Taiwan semiconductor export controls US China",
    riskTags: ["EXPORT_CONTROL", "US_CHINA", "SEMICONDUCTOR_POLICY"],
  },
  {
    id: "TAIWAN_GEOPOLITICS",
    query: "Taiwan China military geopolitics market",
    riskTags: ["TAIWAN_STRAIT", "GEOPOLITICS"],
  },
  {
    id: "AI_CHIP_POLICY",
    query: "AI chips semiconductor policy Nvidia TSMC",
    riskTags: ["AI_CHIPS", "SEMICONDUCTOR_POLICY"],
  },
  {
    id: "TAIWAN_OFFICIAL_POLICY",
    query: "Taiwan government semiconductor policy trade",
    riskTags: ["TAIWAN_POLICY", "TRADE_POLICY"],
  },
];

const RISK_KEYWORDS = [
  ["sanction", 3],
  ["export control", 3],
  ["restriction", 2],
  ["tariff", 2],
  ["military", 3],
  ["war", 3],
  ["conflict", 3],
  ["china", 1],
  ["taiwan strait", 3],
  ["chip", 1],
  ["semiconductor", 1],
  ["ai", 1],
  ["tsmc", 1],
  ["nvidia", 1],
];

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function stripTags(value) {
  return decodeXml(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function tagValue(itemXml, tagName) {
  const match = itemXml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function parseRssItems(xml) {
  return [...String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => {
    const itemXml = match[0];
    return {
      title: tagValue(itemXml, "title"),
      link: tagValue(itemXml, "link"),
      publishedAt: tagValue(itemXml, "pubDate"),
      source: tagValue(itemXml, "source"),
      description: tagValue(itemXml, "description"),
    };
  });
}

function queryUrl(query) {
  const params = new URLSearchParams({
    q: `${query} when:3d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

function riskScore(item, query) {
  const text = `${item.title} ${item.description} ${query.query}`.toLowerCase();
  const keywordScore = RISK_KEYWORDS.reduce(
    (sum, [keyword, weight]) => sum + (text.includes(keyword) ? weight : 0),
    0,
  );
  return Math.min(10, keywordScore + query.riskTags.length);
}

function riskLevel(score) {
  if (score >= 8) return "HIGH";
  if (score >= 5) return "MEDIUM";
  if (score >= 2) return "LOW";
  return "WATCH";
}

function evidenceBase({ evidenceId, date, now, sourceIdentifier, textValue }) {
  return {
    EvidenceID: evidenceId,
    Domain: "POLICY_NEWS",
    FeatureGroup: "GEOPOLITICAL_POLICY",
    Symbol: "",
    DataDate: date,
    ObservedAt: now,
    RetrievedAt: now,
    AvailableAsOf: now,
    SourceID: "GOOGLE_NEWS_RSS_PUBLIC",
    SourceIdentifier: sourceIdentifier,
    SourceTier: "PUBLIC_RSS",
    ValueType: "NEWS_EVENT",
    Open: "",
    High: "",
    Low: "",
    CloseLast: "",
    Volume: "",
    TextValue: textValue,
    QualityTier: "PUBLIC_CONTEXT",
    FreshnessStatus: "FRESH",
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

export async function capturePolicyNews({ date, now = new Date().toISOString(), maxItemsPerQuery = 4 } = {}) {
  const rows = [];
  const seenTitles = new Set();

  for (const query of POLICY_NEWS_QUERIES) {
    const url = queryUrl(query.query);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 EvidenceDecisionPipeline/0.1",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const xml = await response.text();
      const items = parseRssItems(xml).slice(0, maxItemsPerQuery);
      for (const [index, item] of items.entries()) {
        const titleKey = item.title.toLowerCase();
        if (!item.title || seenTitles.has(titleKey)) {
          continue;
        }
        seenTitles.add(titleKey);
        const score = riskScore(item, query);
        const payload = {
          queryId: query.id,
          title: item.title,
          source: item.source,
          publishedAt: item.publishedAt,
          riskTags: query.riskTags,
          riskScore: score,
          riskLevel: riskLevel(score),
          link: item.link,
        };
        rows.push(
          evidenceBase({
            evidenceId: `LIVE-${date}-POLICY-${query.id}-${index + 1}`,
            date,
            now,
            sourceIdentifier: item.link || url,
            textValue: JSON.stringify(payload),
          }),
        );
      }
    } catch (error) {
      rows.push(
        evidenceBase({
          evidenceId: `LIVE-${date}-POLICY-${query.id}-UNAVAILABLE`,
          date,
          now,
          sourceIdentifier: url,
          textValue: JSON.stringify({
            queryId: query.id,
            title: "Policy news query unavailable",
            riskTags: query.riskTags,
            riskScore: 0,
            riskLevel: "UNAVAILABLE",
            error: error.message,
          }),
        }),
      );
    }
  }

  return rows;
}

export function parsePolicyNewsPayload(row) {
  try {
    return JSON.parse(row.TextValue || "{}");
  } catch {
    return {};
  }
}
