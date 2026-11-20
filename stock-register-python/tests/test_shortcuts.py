import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import signup

ROOT = Path(__file__).resolve().parent.parent


def shortcut_ids(page: str) -> dict:
    data = json.loads(re.search(r'id="gb-shortcuts-data">(.*?)</script>', page, re.S).group(1))
    return {a["id"]: a for a in data}


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_shortcut_rules_in_the_browser_script():
    r = subprocess.run(["node", str(ROOT / "tests" / "js" / "shortcuts.test.js")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_pages_carry_the_shortcut_list_panel_and_badges(client):
    signup(client)
    page = client.get("/app").text
    by_id = shortcut_ids(page)
    assert by_id["sales.new"]["key"] == "Alt+S" and by_id["sales.new"]["url"] == "/app/billing/new?kind=SALE"
    assert by_id["receipt.new"]["url"] == "/app/payments/new?direction=IN" and by_id["payment.new"]["key"] == "Alt+Y"
    assert by_id["stock.report"]["url"] == "/app/reports" and by_id["search"]["url"] is None
    keys = [a["key"] for a in by_id.values()]
    assert len(keys) == len(set(keys)), "default shortcuts must not clash"
    assert 'id="sc-modal"' in page and 'id="sc-open"' in page and "/static/shortcuts.js?v=" in page
    assert 'data-nav="items"' in page and by_id["items"]["nav"] == "items"
    assert client.get("/static/shortcuts.js").status_code == 200


def test_only_allowed_shortcuts_are_offered_to_a_sales_clerk(client):
    signup(client)
    client.post("/api/staff", json={"name": "Clerk", "email": "clerk@example.com", "password": "password123", "role": "SALES"})
    s = TestClient(create_app())
    s.post("/api/auth/login", json={"email": "clerk@example.com", "password": "password123"})
    ids = set(shortcut_ids(s.get("/app").text))
    assert {"sales.new", "receipt.new", "dashboard", "search", "help"} <= ids
    assert not ids & {"purchase.new", "stock.report", "bill.report", "approvals", "ledger", "expenses"}


def test_receipt_and_payment_pages(client):
    signup(client)
    cust = client.post("/api/parties", json={"name": "Sharma", "type": "CUSTOMER"}).json()["id"]
    client.post("/api/parties", json={"name": "Redington", "type": "SUPPLIER"})
    rec = client.get("/app/payments/new?direction=IN").text
    assert "Add receipt" in rec and "Sharma" in rec and "Redington" not in rec  # receipts come from customers
    pay = client.get("/app/payments/new?direction=OUT").text
    assert "Add payment" in pay and "Redington" in pay and "Sharma" not in pay
    r = client.post("/app/payments", data={"partyId": cust, "direction": "IN", "amount": "500", "mode": "UPI", "date": "2026-11-20"},
                    follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == f"/app/parties/{cust}"
    assert "Add receipt" in client.get("/app/payments/new?direction=junk").text  # a bad value falls back to a receipt


def test_receipt_page_needs_login_and_the_payments_permission(client):
    signup(client)
    client.post("/api/staff", json={"name": "Seller", "email": "seller@example.com", "password": "password123", "role": "SALES"})
    seller = TestClient(create_app())
    seller.post("/api/auth/login", json={"email": "seller@example.com", "password": "password123"})
    assert seller.get("/app/payments/new").status_code == 200  # the Sales role records receipts
    anon = TestClient(create_app())
    assert anon.get("/app/payments/new", follow_redirects=False).status_code == 303
