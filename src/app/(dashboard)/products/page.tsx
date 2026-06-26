import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { ProductFormDialog } from "./product-form-dialog";
import { ProductActiveToggle } from "./product-active-toggle";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PRODUCT_CATEGORY_LABELS, inr } from "@/lib/constants/labels";

export default async function ProductsPage() {
  const user = await requireUser();
  const canWrite = can(user.role, "products", "write") !== "none";

  const products = await prisma.product.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        subtitle={`${products.length} product${products.length === 1 ? "" : "s"} in the catalog.`}
        action={canWrite && <ProductFormDialog />}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Unit / Pack</TableHead>
                <TableHead>MRP</TableHead>
                <TableHead>Dealer Price</TableHead>
                <TableHead>Distributor Price</TableHead>
                <TableHead>GST %</TableHead>
                <TableHead>Status</TableHead>
                {canWrite && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canWrite ? 9 : 8} className="py-10 text-center text-muted-foreground">
                    No products yet.
                  </TableCell>
                </TableRow>
              )}
              {products.map((product) => (
                <TableRow key={product.id} className={product.isActive ? "" : "opacity-60"}>
                  <TableCell>
                    <div className="font-medium">{product.name}</div>
                    <div className="text-xs text-muted-foreground">{product.sku}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {PRODUCT_CATEGORY_LABELS[product.category] ?? product.category}
                  </TableCell>
                  <TableCell className="text-sm">
                    {product.unit}
                    {product.packSize ? ` · ${product.packSize}` : ""}
                  </TableCell>
                  <TableCell className="text-sm">{inr(Number(product.mrp))}</TableCell>
                  <TableCell className="text-sm">
                    {inr(product.dealerPrice ? Number(product.dealerPrice) : null)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {inr(product.distributorPrice ? Number(product.distributorPrice) : null)}
                  </TableCell>
                  <TableCell className="text-sm">{Number(product.gstPercent)}%</TableCell>
                  <TableCell>
                    <Badge variant={product.isActive ? "default" : "secondary"}>
                      {product.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <ProductFormDialog
                          productId={product.id}
                          initialValues={{
                            sku: product.sku,
                            name: product.name,
                            category: product.category,
                            hsnCode: product.hsnCode ?? "",
                            description: product.description ?? "",
                            unit: product.unit,
                            packSize: product.packSize ?? "",
                            mrp: product.mrp.toString(),
                            dealerPrice: product.dealerPrice?.toString() ?? "",
                            distributorPrice: product.distributorPrice?.toString() ?? "",
                            gstPercent: product.gstPercent.toString(),
                          }}
                        />
                        <ProductActiveToggle productId={product.id} isActive={product.isActive} />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
