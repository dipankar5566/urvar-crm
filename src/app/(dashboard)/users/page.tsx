import { requireRole } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { UserFormDialog } from "./user-form-dialog";
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
import { ROLE_LABELS } from "@/lib/constants/labels";

export default async function UsersPage() {
  // Super Admin only — defense in depth alongside the sidebar/middleware.
  const actor = await requireRole(["SUPER_ADMIN"]);

  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        subtitle={`${users.length} team member${users.length === 1 ? "" : "s"}.`}
        action={<UserFormDialog />}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} className={u.isActive ? "" : "opacity-60"}>
                  <TableCell>
                    <div className="font-medium">
                      {u.name}
                      {u.id === actor.id && (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{u.phone}</div>
                  </TableCell>
                  <TableCell className="text-sm">{u.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{ROLE_LABELS[u.role] ?? u.role}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs text-sm text-muted-foreground">
                    {u.territoryStates.length > 0 ? u.territoryStates.join(", ") : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.isActive ? "default" : "secondary"}>
                      {u.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <UserFormDialog
                      userId={u.id}
                      isSelf={u.id === actor.id}
                      initialValues={{
                        name: u.name,
                        email: u.email,
                        role: u.role,
                        phone: u.phone ?? "",
                        territoryStates: u.territoryStates,
                        isActive: u.isActive,
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
