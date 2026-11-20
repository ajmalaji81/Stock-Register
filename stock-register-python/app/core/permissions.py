"""Roles and what each may do. Pure: the server enforces it, templates use it to hide buttons."""
from __future__ import annotations

PERMISSIONS: tuple[str, ...] = (
    "items.manage",  # create / edit / delete items, bulk import
    "godowns.manage",  # create / rename / delete godowns
    "stock.move",  # manual Stock IN / OUT
    "stock.transfer",  # godown-to-godown transfer
    "stock.adjust",  # stock adjustment entries
    "sales.create",  # sales bills + sales returns
    "purchases.create",  # purchase bills + purchase returns
    "documents.manage",  # quotations, sales orders, purchase orders, challans
    "parties.manage",  # customers / suppliers
    "payments.manage",  # record payments in / out
    "expenses.manage",  # expenses
    "reports.view",  # stock / sales / GST / profit reports, ledger
    "costs.view",  # see purchase prices, stock value and profit
    "staff.manage",  # add / edit staff
    "settings.manage",  # business profile, invoice settings
    "billing.upgrade",  # buy Lifetime Pro
    "activity.view",  # activity timeline
    "branch.approve",  # approve / reject invoices another godown billed to your godown
)

STAFF_ROLES: list[dict[str, str]] = [
    {"role": "STORE_ADMIN", "label": "Store admin", "summary": "Everything except staff, business settings and payments for the app"},
    {"role": "SALES_PURCHASE", "label": "Sales & purchase operator", "summary": "Bills, documents, parties, payments, stock IN/OUT and transfers"},
    {"role": "SALES", "label": "Sales operator", "summary": "Sales bills, quotations, challans, customers and receipts. Cannot see purchase prices or profit"},
]

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "OWNER": frozenset(PERMISSIONS),
    "STORE_ADMIN": frozenset(p for p in PERMISSIONS if p not in ("staff.manage", "settings.manage", "billing.upgrade")),
    "SALES_PURCHASE": frozenset(
        {
            "stock.move", "stock.transfer", "sales.create", "purchases.create", "documents.manage",
            "parties.manage", "payments.manage", "reports.view", "costs.view", "branch.approve",
        }
    ),
    "SALES": frozenset({"sales.create", "documents.manage", "parties.manage", "payments.manage"}),
}


def role_can(role: str, permission: str) -> bool:
    return permission in ROLE_PERMISSIONS.get(role, frozenset())


def role_label(role: str) -> str:
    if role == "OWNER":
        return "Owner"
    for r in STAFF_ROLES:
        if r["role"] == role:
            return r["label"]
    return role
