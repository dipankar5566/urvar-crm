import { describe, it, expect } from "vitest";
import {
  PERMISSIONS, can, assertCan, assertCanApprove, canSelfApprove, scopeWhere,
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
