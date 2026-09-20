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
  | "ai_calls"
  | "followups"
  | "tasks"
  | "customers"
  | "quotations"
  | "products"
  | "purchases"
  | "field_visits"
  | "reports"
  | "users"
  | "audit"
  // Accounting (Phase 1+). `accounting` is the ledger itself — chart of
  // accounts, journal entries, financial periods. The other three are the
  // documents that post into it.
  | "accounting"
  | "invoices"
  | "payments"
  | "gst"
  // Phase 3: expense approval workflow. Separate from `purchases` (supplier
  // bills, which already existed) because expenses have their own
  // separation-of-duties requirement — submit != approve — and mixing the
  // two would force purchases' RBAC history to be reinterpreted.
  | "expenses";

/**
 * `approve` exists for separation of duties on financial documents: the right
 * to create a payment and the right to release it are different rights. It is
 * "none" on every non-financial module, which is deliberate rather than
 * lazy — those modules have no approval step to gate.
 *
 * Holding the scope is only half of it. Whether a user may approve a document
 * they themselves created is a separate runtime question — see
 * `canSelfApprove()` below.
 */
export type Action = "read" | "write" | "delete" | "approve";
export type Scope = "none" | "own" | "territory" | "all";

type ModulePerms = Record<Action, Scope>;
type RolePerms = Record<Module, ModulePerms>;

const FULL: ModulePerms = { read: "all", write: "all", delete: "all", approve: "all" };
const READ_ALL: ModulePerms = { read: "all", write: "none", delete: "none", approve: "none" };
const OWN_RW: ModulePerms = { read: "own", write: "own", delete: "none", approve: "none" };
const TERRITORY_R: ModulePerms = { read: "territory", write: "none", delete: "none", approve: "none" };
const NONE: ModulePerms = { read: "none", write: "none", delete: "none", approve: "none" };

export const PERMISSIONS: Record<Role, RolePerms> = {
  SUPER_ADMIN: {
    leads: FULL,
    pipeline: FULL,
    calls: FULL,
    ai_calls: FULL,
    followups: FULL,
    tasks: FULL,
    customers: FULL,
    quotations: FULL,
    products: FULL,
    // Not FULL for either: once a PurchaseInvoice or Expense is posted, it
    // carries a postedEntryId into the immutable ledger (see accounting's
    // delete: "none" above) — deleting the row would orphan that entry.
    // Correction is cancelPurchaseInvoice()/cancelExpense(), a reversal,
    // never a delete, for every role including Super Admin.
    purchases: { read: "all", write: "all", delete: "none", approve: "all" },
    expenses: { read: "all", write: "all", delete: "none", approve: "all" },
    field_visits: FULL,
    reports: READ_ALL,
    users: FULL,
    audit: READ_ALL,
    // Accounting. Note `delete` is "none" even for SUPER_ADMIN: a posted
    // journal entry is corrected by a linked reversing entry, never removed.
    // That is stricter than this file's usual "delete is Super Admin only"
    // rule, and is the one place the rule is tightened rather than relaxed.
    accounting: { read: "all", write: "all", delete: "none", approve: "all" },
    invoices: { read: "all", write: "all", delete: "none", approve: "all" },
    payments: { read: "all", write: "all", delete: "none", approve: "all" },
    gst: { read: "all", write: "all", delete: "none", approve: "all" },
  },
  SALES_MANAGER: {
    // Delete is Super Admin only, across every module — removing a record is
    // the one action no sales role gets, however senior.
    leads: { read: "all", write: "all", delete: "none", approve: "none" },
    pipeline: { read: "all", write: "all", delete: "none", approve: "none" },
    calls: { read: "all", write: "all", delete: "none", approve: "none" },
    ai_calls: { read: "all", write: "all", delete: "none", approve: "none" },
    followups: { read: "all", write: "all", delete: "none", approve: "none" },
    tasks: { read: "all", write: "all", delete: "none", approve: "none" },
    customers: { read: "all", write: "all", delete: "none", approve: "none" },
    quotations: { read: "all", write: "all", delete: "none", approve: "none" },
    products: { read: "all", write: "all", delete: "none", approve: "none" },
    // Supplier prices reveal margin: a sales role that can see both the
    // purchase price and the quoted price knows the markup on every deal.
    purchases: NONE,
    expenses: NONE,
    // Reads every rep's visits — the point of check-ins is oversight — but
    // cannot delete one, so the record of who was where cannot be rewritten.
    field_visits: { read: "all", write: "all", delete: "none", approve: "none" },
    reports: READ_ALL,
    users: NONE,
    audit: NONE,
    // Sees what was invoiced and what came in — that is sales oversight — but
    // cannot raise a document or release a payment.
    accounting: NONE,
    invoices: { read: "all", write: "none", delete: "none", approve: "none" },
    payments: { read: "all", write: "none", delete: "none", approve: "none" },
    gst: NONE,
  },
  SALES_EXECUTIVE: {
    leads: OWN_RW,
    pipeline: OWN_RW,
    calls: OWN_RW,
    ai_calls: OWN_RW,
    followups: OWN_RW,
    tasks: OWN_RW,
    customers: OWN_RW,
    quotations: OWN_RW,
    products: READ_ALL,
    purchases: NONE,
    expenses: NONE,
    field_visits: OWN_RW,
    reports: { read: "own", write: "none", delete: "none", approve: "none" },
    users: NONE,
    audit: NONE,
    // Their own deals only, read-only: enough to answer "has this customer
    // paid?" on a call without exposing the books.
    accounting: NONE,
    invoices: { read: "own", write: "none", delete: "none", approve: "none" },
    payments: { read: "own", write: "none", delete: "none", approve: "none" },
    gst: NONE,
  },
  DISTRIBUTOR_MANAGER: {
    leads: TERRITORY_R,
    pipeline: TERRITORY_R,
    calls: { read: "own", write: "own", delete: "none", approve: "none" },
    ai_calls: NONE,
    followups: { read: "own", write: "own", delete: "none", approve: "none" },
    tasks: { read: "own", write: "own", delete: "none", approve: "none" },
    // Distributor/dealer customers within territory
    customers: { read: "territory", write: "territory", delete: "none", approve: "none" },
    quotations: TERRITORY_R,
    products: READ_ALL,
    purchases: NONE,
    expenses: NONE,
    field_visits: { read: "own", write: "own", delete: "none", approve: "none" },
    reports: TERRITORY_R,
    users: NONE,
    audit: NONE,
    accounting: NONE,
    invoices: TERRITORY_R,
    payments: TERRITORY_R,
    gst: NONE,
  },
  ACCOUNTS_TEAM: {
    leads: READ_ALL,
    pipeline: READ_ALL,
    calls: READ_ALL,
    ai_calls: READ_ALL,
    followups: READ_ALL,
    tasks: READ_ALL,
    customers: { read: "all", write: "all", delete: "none", approve: "none" }, // financial fields
    quotations: { read: "all", write: "all", delete: "none", approve: "none" }, // status/payment
    products: READ_ALL,
    // Procurement is finance's job — deleting an invoice is not, so no delete.
    purchases: { read: "all", write: "all", delete: "none", approve: "none" },
    // approve: "all" — this is the module the DRAFT->SUBMITTED->APPROVED
    // workflow actually exercises. assertCanApprove() still blocks a user
    // approving their own submission unless they hold the Super Admin
    // exemption, so the role grant alone is not the whole control.
    expenses: { read: "all", write: "all", delete: "none", approve: "all" },
    // Field visits are a sales-supervision record with nothing financial in
    // them; accounts has no reason to see which rep stood where.
    field_visits: NONE,
    reports: READ_ALL,
    users: NONE,
    audit: NONE,
    // Finance's own modules. `approve` is granted at role level; whether a
    // given user may approve a document they created is enforced separately
    // by canSelfApprove().
    accounting: { read: "all", write: "all", delete: "none", approve: "all" },
    invoices: { read: "all", write: "all", delete: "none", approve: "all" },
    payments: { read: "all", write: "all", delete: "none", approve: "all" },
    gst: { read: "all", write: "all", delete: "none", approve: "all" },
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
 * Compose a scope restriction with request-controlled filters, safely.
 *
 * The hazard this exists to remove: spreading `scopeWhere(...)` into an object
 * and then setting a sibling key is a plain JS key collision that *replaces*
 * the scope restriction instead of narrowing it. It does not error, it does
 * not warn, and it silently widens access — a rep passing ?repId= reads
 * another rep's data.
 *
 * Prisma ANDs duplicate keys across array elements rather than letting one win,
 * so a conflicting filter returns zero rows instead of someone else's. Use this
 * for every query that combines a scope with anything the request controls.
 */
export function scopedWhere(
  scope: Scope,
  user: ScopeUser,
  ownerField: string,
  filters: Record<string, unknown> = {},
  stateField = "state",
): { AND: Record<string, unknown>[] } {
  return { AND: [scopeWhere(scope, user, ownerField, stateField), filters] };
}

/**
 * Separation of duties: may `approverId` approve a document created by
 * `createdById`?
 *
 * Holding `approve` scope is necessary but not sufficient. The control that
 * actually matters on a payment is that the person who raised it is not the
 * person who releases it — a role check alone cannot express that, because it
 * is a fact about the specific document, not about the role.
 *
 * SUPER_ADMIN is exempt: on a five-person company there has to be someone who
 * can unblock a stuck document, and pretending otherwise just means the
 * control gets worked around by sharing a login. The exemption is logged like
 * any other approval, so it is visible rather than silent.
 */
export function canSelfApprove(role: Role): boolean {
  return role === "SUPER_ADMIN";
}

export function assertCanApprove(
  role: Role,
  module: Module,
  approverId: string,
  createdById: string,
): Scope {
  const scope = assertCan(role, module, "approve");
  if (approverId === createdById && !canSelfApprove(role)) {
    throw new Error(
      "You cannot approve a document you created. Ask someone else to approve it.",
    );
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

/**
 * AI Voice Agent outbound campaigns (Phase 3, not yet built) dial leads
 * unattended, so CRUD is restricted the same way bulk import is — the two
 * roles with unrestricted "all" scope, not the broader set of roles that can
 * initiate a single ai_calls call.
 */
export function canManageCampaigns(role: Role): boolean {
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
