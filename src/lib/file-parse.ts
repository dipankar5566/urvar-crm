import ExcelJS from "exceljs";
import Papa from "papaparse";

const MAX_ROWS = 1000;

export type ParsedSheet = { headers: string[]; rows: Record<string, string>[] };

async function parseCsv(text: string): Promise<ParsedSheet> {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = result.meta.fields ?? [];
  return { headers, rows: result.data.slice(0, MAX_ROWS) };
}

async function parseXlsx(buffer: ArrayBuffer): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.text ?? "").trim();
  });

  const rows: Record<string, string>[] = [];
  for (let i = 2; i <= sheet.rowCount && rows.length < MAX_ROWS; i++) {
    const row = sheet.getRow(i);
    if (row.cellCount === 0) continue;
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, idx) => {
      if (!header) return;
      const cell = row.getCell(idx + 1);
      // cell.value can be an object for hyperlinks/rich text/formulas
      // (e.g. {text, hyperlink}) — cell.text always gives the rendered string.
      const text = String(cell.text ?? "").trim();
      if (text !== "") hasValue = true;
      record[header] = text;
    });
    if (hasValue) rows.push(record);
  }

  return { headers: headers.filter(Boolean), rows };
}

/** Parses an uploaded .xlsx/.xls/.csv File into headers + raw string rows. Throws on unsupported type or parse failure. */
export async function parseSpreadsheetFile(file: File): Promise<ParsedSheet> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    return parseCsv(await file.text());
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return parseXlsx(await file.arrayBuffer());
  }
  throw new Error("Unsupported file type. Upload a .xlsx, .xls, or .csv file.");
}

/** Builds a single-sheet .xlsx containing just a bold header row, for import templates. */
export async function buildTemplateWorkbook(headers: string[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Template");
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.columns = headers.map(() => ({ width: 22 }));
  return workbook.xlsx.writeBuffer();
}
