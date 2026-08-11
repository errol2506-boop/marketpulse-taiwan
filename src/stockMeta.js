const STOCK_META = {
  3711: { code: "3711", companyName: "日月光投控" },
  2408: { code: "2408", companyName: "南亞科" },
  1303: { code: "1303", companyName: "南亞" },
  6538: { code: "6538", companyName: "倉和" },
};

export function stockMeta(symbol) {
  const code = String(symbol || "");
  return STOCK_META[code] || { code, companyName: "" };
}

export function stockDisplayName(symbol) {
  const meta = stockMeta(symbol);
  return meta.companyName ? `${meta.companyName} ${meta.code}` : meta.code;
}
