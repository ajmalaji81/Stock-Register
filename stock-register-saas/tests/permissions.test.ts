import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES, roleCan, roleLabel, type Permission, type Role } from "../lib/permissions.ts";

const allowed = (role: Role) => PERMISSIONS.filter((p) => roleCan(role, p)).sort();

test("owner can do everything", () => {
  assert.deepEqual(allowed("OWNER"), [...PERMISSIONS].sort());
});

test("store admin: everything except staff, settings and buying the plan", () => {
  const denied = PERMISSIONS.filter((p) => !roleCan("STORE_ADMIN", p)).sort();
  assert.deepEqual(denied, ["billing.upgrade", "settings.manage", "staff.manage"]);
});

test("sales & purchase operator", () => {
  const expected: Permission[] = [
    "costs.view", "documents.manage", "parties.manage", "payments.manage", "purchases.create",
    "reports.view", "sales.create", "stock.move", "stock.transfer",
  ];
  assert.deepEqual(allowed("SALES_PURCHASE"), expected.sort());
  for (const p of ["items.manage", "godowns.manage", "stock.adjust", "expenses.manage", "staff.manage", "settings.manage", "activity.view", "billing.upgrade"] as Permission[])
    assert.equal(roleCan("SALES_PURCHASE", p), false, p);
});

test("sales operator can't see costs or purchase", () => {
  assert.deepEqual(allowed("SALES"), ["documents.manage", "parties.manage", "payments.manage", "sales.create"]);
  for (const p of ["costs.view", "purchases.create", "reports.view", "stock.move", "staff.manage"] as Permission[])
    assert.equal(roleCan("SALES", p), false, p);
});

test("no staff role can manage staff; every staff role has a label and summary", () => {
  for (const r of STAFF_ROLES) {
    assert.equal(roleCan(r.role, "staff.manage"), false, r.role);
    assert.ok(r.summary.length > 10);
    assert.equal(roleLabel(r.role), r.label);
  }
  assert.equal(roleLabel("OWNER"), "Owner");
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), ["OWNER", "SALES", "SALES_PURCHASE", "STORE_ADMIN"]);
});
