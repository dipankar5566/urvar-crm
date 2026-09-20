import { describe, it, expect } from "vitest";
import {
  PERMISSIONS, can, assertCan, assertCanApprove, canSelfApprove, scopeWhere, scopedWhere,
} from "@/lib/permissions";
import type { Module, Action } from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";

const ROLES: Role[] = [
  "SUPER_ADMIN", "SALES_MANAGER", "SALES_EXECUTIVE", "DISTRIBUTOR_MANAGER", "ACCOUNTS_TEAM",
];
const ACTIONS: Action[] = ["read", "write", "delete", "approve"];
const ACCOUNTING_MODULES: Module[] = ["accounting", "invoices", "payments", "gst"];
const SALES_ROLES: Role[] = ["SALES_MANAGER", "SALES_EXECUTIVE", "DISTRIBUTOR_MANAGER"];

describe("the matrix is complete", () => {
  it("defines every action of every module for every role", () => {
    const modules = Object.keys(PERMISSIONS.SUPER_ADMIN) as Module[];
    for (const role of ROLES) {
      for (const mod of modules) {
        for (const action of ACTIONS) {
          expect(
            PERMISSIONS[role][mod][action],
            `${role}.${mod}.${action} is undefined`,
          ).toBeDefined();
        }
      }
    }
  });

  it("covers the four accounting modules", () => {
    const modules = Object.keys(PERMISSIONS.SUPER_ADMIN);
    for (const m of ACCOUNTING_MODULES) expect(modules).toContain(m);
  });
});

describe("the ledger is append-only for everyone", () => {
  it("grants nobody delete on accounting, Super Admin included", () => {
    for (const role of ROLES) {
      expect(can(role, "accounting", "delete"), `${role} can delete accounting`).toBe("none");
    }
  });

  it("grants nobody delete on invoices or payments either", () => {
    for (const role of ROLES) {
      expect(can(role, "invoices", "delete")).toBe("none");
      expect(can(role, "payments", "delete")).toBe("none");
    }
  });
});

describe("sales roles cannot reach the books", () => {
  it("gives every sales role no access at all to the ledger", () => {
    for (const role of SALES_ROLES) {
      for (const action of ACTIONS) {
        expect(can(role, "accounting", action), `${role}.accounting.${action}`).toBe("none");
      }
      expect(can(role, "gst", "read")).toBe("none");
    }
  });

  it("throws for a sales executive attempting any accounting action", () => {
    for (const action of ACTIONS) {
      expect(() => assertCan("SALES_EXECUTIVE", "accounting", action)).toThrow(/Forbidden/);
    }
  });

  it("still lets sales see invoices and payments, scoped, read-only", () => {
    expect(can("SALES_EXECUTIVE", "invoices", "read")).toBe("own");
    expect(can("SALES_EXECUTIVE", "invoices", "write")).toBe("none");
    expect(can("SALES_MANAGER", "payments", "read")).toBe("all");
    expect(can("SALES_MANAGER", "payments", "write")).toBe("none");
    expect(can("DISTRIBUTOR_MANAGER", "invoices", "read")).toBe("territory");
  });
});

describe("accounts team", () => {
  it("can read, write and approve the ledger", () => {
    expect(can("ACCOUNTS_TEAM", "accounting", "read")).toBe("all");
    expect(can("ACCOUNTS_TEAM", "accounting", "write")).toBe("all");
    expect(can("ACCOUNTS_TEAM", "accounting", "approve")).toBe("all");
  });
});

describe("separation of duties", () => {
  it("stops a non-admin approving a document they created", () => {
    expect(() => assertCanApprove("ACCOUNTS_TEAM", "payments", "user-1", "user-1")).toThrow(
      /cannot approve a document you created/i,
    );
  });

  it("allows a non-admin to approve someone else's document", () => {
    expect(assertCanApprove("ACCOUNTS_TEAM", "payments", "user-1", "user-2")).toBe("all");
  });

  it("exempts Super Admin, so a stuck document can always be unblocked", () => {
    expect(canSelfApprove("SUPER_ADMIN")).toBe(true);
    expect(canSelfApprove("ACCOUNTS_TEAM")).toBe(false);
    expect(assertCanApprove("SUPER_ADMIN", "payments", "user-1", "user-1")).toBe("all");
  });

  it("still requires approve scope in the first place", () => {
    expect(() => assertCanApprove("SALES_EXECUTIVE", "payments", "user-1", "user-2")).toThrow(
      /Forbidden/,
    );
  });
});

describe("scopeWhere() still behaves after the matrix change", () => {
  const user = { id: "u1", territoryStates: ["West Bengal", "Odisha"] };

  it("returns an impossible match for no access, never an empty filter", () => {
    expect(scopeWhere("none", user, "createdById")).toEqual({ id: "__no_access__" });
  });

  it("scopes by owner and by territory", () => {
    expect(scopeWhere("own", user, "createdById")).toEqual({ createdById: "u1" });
    expect(scopeWhere("territory", user, "createdById")).toEqual({
      state: { in: ["West Bengal", "Odisha"] },
    });
    expect(scopeWhere("all", user, "createdById")).toEqual({});
  });
});

describe("scopedWhere(): the R2 regression", () => {
  const exec = { id: "rep-1", territoryStates: [] as string[] };
  const dm = { id: "dm-1", territoryStates: ["West Bengal"] };

  it("keeps the owner restriction when a request supplies the same key", () => {
    // The old code spread scopeWhere and then assigned where.assignedToId,
    // so ?repId=<someone else> replaced the restriction outright.
    const where = scopedWhere("own", exec, "assignedToId", { assignedToId: "rep-2" });
    expect(where.AND[0]).toEqual({ assignedToId: "rep-1" });
    expect(where.AND[1]).toEqual({ assignedToId: "rep-2" });
    // Both survive. Prisma ANDs them, so the result is zero rows — not rep-2's.
    expect(where.AND).toHaveLength(2);
  });

  it("keeps the territory restriction when a request supplies a state", () => {
    const where = scopedWhere("territory", dm, "createdById", { state: "Karnataka" });
    expect(where.AND[0]).toEqual({ state: { in: ["West Bengal"] } });
    expect(where.AND[1]).toEqual({ state: "Karnataka" });
  });

  it("never lets a filter key reach the same object as the scope key", () => {
    const where = scopedWhere("own", exec, "assignedToId", { assignedToId: "rep-2" });
    for (const fragment of where.AND) {
      const keys = Object.keys(fragment);
      expect(keys.length).toBeLessThanOrEqual(1);
    }
  });

  it("preserves the impossible-match fragment for a none scope", () => {
    const where = scopedWhere("none", exec, "assignedToId", { assignedToId: "rep-2" });
    expect(where.AND[0]).toEqual({ id: "__no_access__" });
  });

  it("passes filters through untouched for an all scope", () => {
    const where = scopedWhere("all", exec, "assignedToId", { state: "Odisha" });
    expect(where.AND[0]).toEqual({});
    expect(where.AND[1]).toEqual({ state: "Odisha" });
  });
});

describe("expenses module (Phase 3)", () => {
  it("is visible only to finance roles, same as purchases", () => {
    for (const role of ["SALES_MANAGER", "SALES_EXECUTIVE", "DISTRIBUTOR_MANAGER"] as const) {
      expect(can(role, "expenses", "read")).toBe("none");
    }
    expect(can("SUPER_ADMIN", "expenses", "approve")).toBe("all");
    expect(can("ACCOUNTS_TEAM", "expenses", "approve")).toBe("all");
  });

  it("grants no delete on expenses, matching the ledger's append-only rule", () => {
    for (const role of ROLES) {
      expect(can(role, "expenses", "delete")).toBe("none");
    }
  });
});
