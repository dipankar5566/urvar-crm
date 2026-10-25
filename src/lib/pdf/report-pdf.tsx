import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { ReportSheet } from "@/lib/accounting/report-registry";

/**
 * One shared tabular PDF template for every accounting report (Vyapar
 * parity step 4, G13's "PDF via @react-pdf/renderer"). Vyapar prints each
 * report with its own bespoke layout; building 30+ of those here isn't
 * proportionate, so this renders whichever `ReportSheet` the registry
 * already produced for the XLSX — the same rows and the same derived
 * columns (`Object.keys(rows[0])`) — as a landscape, auto-width table.
 * Multi-sheet reports (R1/R2/R3's "Item Details") print their first sheet
 * only; a spreadsheet is what multi-sheet output actually needs.
 */

const styles = StyleSheet.create({
  page: { padding: 24, fontSize: 8, fontFamily: "Helvetica", color: "#1a1a1a" },
  title: { fontSize: 14, fontWeight: 700, marginBottom: 4 },
  subtitle: { fontSize: 9, color: "#6b7280", marginBottom: 10 },
  headerRow: { flexDirection: "row", backgroundColor: "#f3f4f6", paddingVertical: 4, borderBottomWidth: 1, borderColor: "#d1d5db" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#e5e7eb", paddingVertical: 3 },
  cell: { flex: 1, paddingHorizontal: 3 },
  headerCell: { flex: 1, paddingHorizontal: 3, fontWeight: 700 },
  empty: { padding: 12, color: "#6b7280" },
});

export async function renderReportPdf(title: string, subtitle: string, sheet: ReportSheet): Promise<Buffer> {
  const columns = sheet.rows[0] ? Object.keys(sheet.rows[0]) : [];
  return renderToBuffer(
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        {columns.length === 0 ? (
          <Text style={styles.empty}>No rows in this range.</Text>
        ) : (
          <>
            <View style={styles.headerRow}>
              {columns.map((c) => (
                <Text key={c} style={styles.headerCell}>{c}</Text>
              ))}
            </View>
            {sheet.rows.map((row, i) => (
              <View key={i} style={styles.row}>
                {columns.map((c) => (
                  <Text key={c} style={styles.cell}>{String(row[c] ?? "")}</Text>
                ))}
              </View>
            ))}
          </>
        )}
      </Page>
    </Document>,
  );
}
