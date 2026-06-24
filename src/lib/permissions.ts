import type { Role } from "@/generated/prisma/enums";

/**
 * Central RBAC matrix for Urvar CRM.
 *
 * Scope semantics for a (role, module, action):
 *   - "all"       : may act on every record in the module
 *   - "territory" : limited to records in the user's territoryStates
 *   - "own"       : limited to records assigned to / created by the user
 *   - "none"      : no access
 *
 * Server Actions call `can(role, module, action)` once and branch their Prisma
 * `where` clause on the returned scope via `scopeWhere(...)`.
 */

export type Module =
  | "leads"
  | "pipeline"
  | "calls"
  | "followups"
  | "tasks"
  | "customers"
  | "quotations"
  | "products"
  | "reports"
  | "users"
  | "audit";

export type Action = "read" | "write" | "delete";
export type Scope = "none" | "own" | "territory" | "all";

type ModulePerms = Record<Action, Scope>;
type RolePerms = Record<Module, ModulePerms>;

const FULL: ModulePerms = { read: "all", write: "all", delete: "all" };
const READ_ALL: ModulePerms = { read: "all", write: "none", delete: "none" };
const OWN_RW: ModulePerms = { read: "own", write: "own", delete: "none" };
const TERRITORY_R: ModulePerms = { read: "territory", write: "none", delete: "none" };
const NONE: ModulePerms = { read: "none", write: "none", delete: "none" };

export const PERMISSIONS: Record<Role, RolePerms> = {
  SUPER_ADMIN: {
    leads: FULL,
    pipeline: FULL,
    calls: FULL,
    followups: FULL,
    tasks: FULL,
    customers: FULL,
    quotations: FULL,
    products: FULL,
    reports: READ_ALL,
    users: FULL,
    audit: READ_ALL,
  },
  SALES_MANAGER: {
    leads: { read: "all", write: "all", delete: "all" },
    pipeline: { read: "all", write: "all", delete: "none" },
    calls: { read: "all", write: "all", delete: "none" },
    followups: { read: "all", write: "all", delete: "none" },
    tasks: { read: "all", write: "all", delete: "none" },
    customers: { read: "all", write: "all", delete: "none" },
    quotations: { read: "all", write: "all", delete: "none" },
    products: { read: "all", write: "all", delete: "none" },
    reports: READ_ALL,
    users: NONE,
    audit: NONE,
  },
  SALES_EXECUTIVE: {
    leads: OWN_RW,
    pipeline: OWN_RW,
    calls: OWN_RW,
    followups: OWN_RW,
    tasks: OWN_RW,
    customers: OWN_RW,
    quotations: OWN_RW,
    products: READ_ALL,
    reports: { read: "own", write: "none", delete: "none" },
    users: NONE,
    audit: NONE,
  },
  DISTRIBUTOR_MANAGER: {
    leads: TERRITORY_R,
    pipeline: TERRITORY_R,
    calls: { read: "own", write: "own", delete: "none" },
    followups: { read: "own", write: "own", delete: "none" },
    tasks: { read: "own", write: "own", delete: "none" },
    // Distributor/dealer customers within territory
    customers: { read: "territory", write: "territory", delete: "none" },
    quotations: TERRITORY_R,
    products: READ_ALL,
    reports: TERRITORY_R,
    users: NONE,
    audit: NONE,
  },
  ACCOUNTS_TEAM: {
    leads: READ_ALL,
    pipeline: READ_ALL,
    calls: READ_ALL,
    followups: READ_ALL,
    tasks: READ_ALL,
    customers: { read: "all", write: "all", delete: "none" }, // financial fields
    quotations: { read: "all", write: "all", delete: "none" }, // status/payment
    products: READ_ALL,
    reports: READ_ALL,
    users: NONE,
    audit: NONE,
  },
};

export function can(role: Role, module: Module, action: Action): Scope {
  return PERMISSIONS[role]?.[module]?.[action] ?? "none";
}

export function canAccess(role: Role, module: Module, action: Action): boolean {
  return can(role, module, action) !== "none";
}

/** Throw if the role has no access for (module, action). Use in Server Actions. */
export function assertCan(role: Role, module: Module, action: Action): Scope {
  const scope = can(role, module, action);
  if (scope === "none") {
    throw new Error(`Forbidden: ${role} cannot ${action} ${module}`);
  }
  return scope;
}

/**
 * Bulk spreadsheet import (Customers, Leads) creates rows with no per-row
 * owner, so it's restricted to the two roles with unrestricted "all" write
 * scope rather than the broader set of roles that can write a single record.
 */
export function canBulkImport(role: Role): boolean {
  return role === "SUPER_ADMIN" || role === "SALES_MANAGER";
}

type ScopeUser = { id: string; territoryStates: string[] };

/**
 * Builds a Prisma `where` fragment for a given scope. `ownerField` is the FK
 * that represents ownership for the entity (e.g. "assignedToId" for Lead /
 * Customer, "userId" for Call, "createdById" for Quotation). `stateField`
 * defaults to "state".
 */
export function scopeWhere(
  scope: Scope,
  user: ScopeUser,
  ownerField: string,
  stateField = "state",
): Record<string, unknown> {
  switch (scope) {
    case "all":
      return {};
    case "territory":
      return { [stateField]: { in: user.territoryStates } };
    case "own":
      return { [ownerField]: user.id };
    case "none":
    default:
      // Impossible match — returns no rows.
      return { id: "__no_access__" };
  }
}
