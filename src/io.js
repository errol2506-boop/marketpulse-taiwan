import { readFile } from "node:fs/promises";
import { extname } from "node:path";

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

export async function readEvidenceRows(filePath) {
  const text = await readFile(filePath, "utf8");
  const extension = extname(filePath).toLowerCase();

  if (extension === ".json") {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed.rows)) {
      return parsed.rows;
    }
    throw new Error("JSON input must be an array or an object with a rows array");
  }

  if (extension === ".csv") {
    return parseCsv(text);
  }

  throw new Error(`Unsupported input file extension: ${extension || "(none)"}`);
}

