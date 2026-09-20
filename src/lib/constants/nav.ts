import type { Role } from "@/generated/prisma/enums";
import type { Module } from "@/lib/permissions";

export type NavSection = "sales" | "accounts" | "admin";

export type NavItem = {
  label: string;
  href: string;
  icon: string; // lucide-react icon name
  module: Module; // used to check read access via permissions matrix
  section?: NavSection; // groups the item under a labeled section in the sidebar
};

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  sales: "Sales",
  accounts: "Accounts",
  admin: "Admin",
};

/**
 * Render order of the labelled sections. Derived from NAV_SECTION_LABELS so
 * adding a section here is the only step — the sidebar previously carried its
 * own hardcoded copy of this list, which would silently drop any section not
 * added to both places.
 */
export const NAV_SECTION_ORDER: NavSection[] = ["sales", "accounts", "admin"];

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
  { label: "Field Visits", href: "/field-visits", icon: "MapPin", module: "field_visits" },
  { label: "Customers", href: "/customers", icon: "Building2", module: "customers", section: "sales" },
  { label: "Distributors", href: "/customers/distributors", icon: "Network", module: "customers", section: "sales" },
  { label: "Products", href: "/products", icon: "Package", module: "products", section: "sales" },
  { label: "Quotations", href: "/quotations", icon: "FileText", module: "quotations", section: "sales" },
  // Accounts. Gated by the `accounting` module, which is NONE for all three
  // sales roles — so this whole section is invisible to them, the same way
  // Purchases already is.
  { label: "Invoices", href: "/invoices", icon: "FileSpreadsheet", module: "invoices", section: "accounts" },
  { label: "Receipts", href: "/receipts", icon: "Wallet", module: "payments", section: "accounts" },
  { label: "Chart of Accounts", href: "/accounting", icon: "BookOpen", module: "accounting", section: "accounts" },
  { label: "Journal", href: "/accounting/journal", icon: "BookText", module: "accounting", section: "accounts" },
  { label: "Periods", href: "/accounting/periods", icon: "CalendarRange", module: "accounting", section: "accounts" },
  // Procurement sits under Admin, not Sales: only SUPER_ADMIN and
  // ACCOUNTS_TEAM have `purchases` read access, so sales roles never see it.
  { label: "Purchases", href: "/purchases", icon: "Receipt", module: "purchases", section: "admin" },
  { label: "Supplier Payments", href: "/supplier-payments", icon: "Landmark", module: "purchases", section: "admin" },
  { label: "Expenses", href: "/expenses", icon: "ReceiptText", module: "expenses", section: "admin" },
  { label: "Reports", href: "/reports", icon: "BarChart3", module: "reports", section: "admin" },
  { label: "Users", href: "/users", icon: "Users", module: "users", section: "admin" },
  { label: "Audit Logs", href: "/audit-logs", icon: "ScrollText", module: "audit", section: "admin" },
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
