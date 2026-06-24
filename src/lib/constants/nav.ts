import type { Role } from "@/generated/prisma/enums";
import type { Module } from "@/lib/permissions";

export type NavItem = {
  label: string;
  href: string;
  icon: string; // lucide-react icon name
  module: Module; // used to check read access via permissions matrix
};

/**
 * Sidebar navigation. Each item is shown only if the user's role has read
 * access to its `module` (checked against the permissions matrix at render).
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard", module: "reports" },
  { label: "Leads", href: "/leads", icon: "UserPlus", module: "leads" },
  { label: "Pipeline", href: "/pipeline", icon: "KanbanSquare", module: "pipeline" },
  { label: "Calls", href: "/calls", icon: "Phone", module: "calls" },
  { label: "Follow-ups", href: "/follow-ups", icon: "CalendarClock", module: "followups" },
  { label: "Tasks", href: "/tasks", icon: "ListChecks", module: "tasks" },
  { label: "Customers", href: "/customers", icon: "Building2", module: "customers" },
  { label: "Distributors", href: "/customers/distributors", icon: "Network", module: "customers" },
  { label: "Products", href: "/products", icon: "Package", module: "products" },
  { label: "Quotations", href: "/quotations", icon: "FileText", module: "quotations" },
  { label: "Reports", href: "/reports", icon: "BarChart3", module: "reports" },
  { label: "Users", href: "/users", icon: "Users", module: "users" },
  { label: "Audit Logs", href: "/audit-logs", icon: "ScrollText", module: "audit" },
];

/** Dashboard is visible to every role regardless of module mapping. */
export const ALWAYS_VISIBLE_HREFS = new Set<string>(["/dashboard"]);

export const ROLE_HOME: Record<Role, string> = {
  SUPER_ADMIN: "/dashboard",
  SALES_MANAGER: "/dashboard",
  SALES_EXECUTIVE: "/dashboard",
  DISTRIBUTOR_MANAGER: "/dashboard",
  ACCOUNTS_TEAM: "/dashboard",
};
