import type { Scope } from "@/lib/permissions";

type ScopeUser = { id: string };

/**
 * Scope fragment for models keyed by an owner column but with no `state`
 * column of their own (Call, FollowUp, Task, FieldVisit).
 *
 * `scopeWhere("territory")` in `src/lib/permissions.ts` emits
 * `{ state: { in: [...] } }`, which is a Prisma validation error on these
 * models. No role is granted a territory scope on any of them today (it is
 * only ever `all` / `own` / `none`), but a future matrix edit would turn that
 * into a runtime crash on the dashboard. Treating `territory` as `own` here
 * fails narrow instead — the safe direction for a scope.
 *
 * Always combine with request-controlled filters via `AND`, never a spread:
 * `{ AND: [ownerScopeWhere(...), filters] }`.
 */
export function ownerScopeWhere(
  scope: Scope,
  user: ScopeUser,
  ownerField: string,
): Record<string, unknown> {
  switch (scope) {
    case "all":
      return {};
    case "own":
    case "territory":
      return { [ownerField]: user.id };
    case "none":
    default:
      // Impossible match — returns no rows.
      return { id: "__no_access__" };
  }
}

/**
 * Scope fragment for SalesInvoice. It has `createdById` but no `state` column
 * (only `placeOfSupply`, which is the tax jurisdiction, not the sales
 * territory), so a territory scope resolves through the customer instead of
 * the generic `{ state: { in } }` that `scopedWhere()` would emit.
 */
export function invoiceScopeWhere(
  scope: Scope,
  user: ScopeUser & { territoryStates: string[] },
): Record<string, unknown> {
  switch (scope) {
    case "all":
      return {};
    case "own":
      return { createdById: user.id };
    case "territory":
      return { customer: { state: { in: user.territoryStates } } };
    case "none":
    default:
      return { id: "__no_access__" };
  }
}
