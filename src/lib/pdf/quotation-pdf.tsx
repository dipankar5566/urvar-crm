import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { PRODUCT_CATEGORY_LABELS, QUOTATION_STATUS_LABELS, inr } from "@/lib/constants/labels";

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: "Helvetica", color: "#1a1a1a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  companyName: { fontSize: 16, fontWeight: 700 },
  muted: { color: "#6b7280" },
  sectionTitle: { fontSize: 11, fontWeight: 700, marginBottom: 4 },
  infoBlock: { marginBottom: 16, flexDirection: "row", justifyContent: "space-between" },
  table: { marginTop: 8, borderTopWidth: 1, borderColor: "#d1d5db" },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: "#e5e7eb", paddingVertical: 6 },
  tableHeaderRow: { flexDirection: "row", backgroundColor: "#f3f4f6", paddingVertical: 6, fontWeight: 700 },
  colProduct: { width: "32%", paddingHorizontal: 4 },
  colQty: { width: "10%", paddingHorizontal: 4, textAlign: "right" },
  colPrice: { width: "16%", paddingHorizontal: 4, textAlign: "right" },
  colDiscount: { width: "12%", paddingHorizontal: 4, textAlign: "right" },
  colGst: { width: "10%", paddingHorizontal: 4, textAlign: "right" },
  colTotal: { width: "20%", paddingHorizontal: 4, textAlign: "right" },
  totals: { marginTop: 12, alignItems: "flex-end" },
  totalsRow: { flexDirection: "row", width: 220, justifyContent: "space-between", paddingVertical: 2 },
  totalsLabel: { color: "#6b7280" },
  grandTotalRow: {
    flexDirection: "row",
    width: 220,
    justifyContent: "space-between",
    paddingTop: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderColor: "#1a1a1a",
  },
  footer: { marginTop: 24 },
  footerTitle: { fontWeight: 700, marginBottom: 4 },
});

export type QuotationPdfData = {
  quotationNumber: string;
  status: string;
  createdAt: Date;
  validUntil: Date | null;
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  freightAmount: string;
  taxAmount: string;
  totalAmount: string;
  termsAndConditions: string | null;
  notes: string | null;
  recipientName: string;
  recipientReference: string;
  recipientLocation: string;
  items: {
    productName: string;
    sku: string;
    category: string;
    unit: string;
    quantity: string;
    unitPrice: string;
    discountPercent: string;
    lineTotal: string;
  }[];
};

function QuotationDocument({ data }: { data: QuotationPdfData }) {
  return (
    <Document title={`Quotation ${data.quotationNumber}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.companyName}>URVAR NATURAL PRIVATE LIMITED</Text>
            <Text style={styles.muted}>Organic & Bio Agricultural Inputs</Text>
          </View>
          <View>
            <Text>Quotation: {data.quotationNumber}</Text>
            <Text style={styles.muted}>
              Date: {data.createdAt.toLocaleDateString("en-IN")}
            </Text>
            <Text style={styles.muted}>
              Status: {QUOTATION_STATUS_LABELS[data.status] ?? data.status}
            </Text>
          </View>
        </View>

        <View style={styles.infoBlock}>
          <View>
            <Text style={styles.sectionTitle}>Quoted To</Text>
            <Text>{data.recipientName}</Text>
            <Text style={styles.muted}>{data.recipientReference}</Text>
            <Text style={styles.muted}>{data.recipientLocation}</Text>
          </View>
          {data.validUntil && (
            <View>
              <Text style={styles.sectionTitle}>Valid Until</Text>
              <Text>{data.validUntil.toLocaleDateString("en-IN")}</Text>
            </View>
          )}
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={styles.colProduct}>Product</Text>
            <Text style={styles.colQty}>Qty</Text>
            <Text style={styles.colPrice}>Unit Price</Text>
            <Text style={styles.colDiscount}>Disc %</Text>
            <Text style={styles.colGst}>Unit</Text>
            <Text style={styles.colTotal}>Line Total</Text>
          </View>
          {data.items.map((item, index) => (
            <View key={index} style={styles.tableRow}>
              <View style={styles.colProduct}>
                <Text>{item.productName}</Text>
                <Text style={styles.muted}>
                  {item.sku} · {PRODUCT_CATEGORY_LABELS[item.category] ?? item.category}
                </Text>
              </View>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>{inr(item.unitPrice)}</Text>
              <Text style={styles.colDiscount}>{item.discountPercent}%</Text>
              <Text style={styles.colGst}>{item.unit}</Text>
              <Text style={styles.colTotal}>{inr(item.lineTotal)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Subtotal</Text>
            <Text>{inr(data.subtotal)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Discount ({data.discountPercent}%)</Text>
            <Text>− {inr(data.discountAmount)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Tax (GST)</Text>
            <Text>{inr(data.taxAmount)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Freight</Text>
            <Text>{inr(data.freightAmount)}</Text>
          </View>
          <View style={styles.grandTotalRow}>
            <Text style={{ fontWeight: 700 }}>Total</Text>
            <Text style={{ fontWeight: 700 }}>{inr(data.totalAmount)}</Text>
          </View>
        </View>

        {data.termsAndConditions && (
          <View style={styles.footer}>
            <Text style={styles.footerTitle}>Terms & Conditions</Text>
            <Text>{data.termsAndConditions}</Text>
          </View>
        )}
      </Page>
    </Document>
  );
}

export async function renderQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
  return renderToBuffer(<QuotationDocument data={data} />);
}
