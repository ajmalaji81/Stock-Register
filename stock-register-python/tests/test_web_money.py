from tests.conftest import signup


def _login_ok(c):
    signup(c)


def test_pages_require_login(client):
    for path in ("/app/parties", "/app/expenses", "/app/staff", "/app/activity", "/app/settings"):
        r = client.get(path, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/login", path


def test_parties_flow(client):
    _login_ok(client)
    r = client.post("/app/parties", data={"name": "Sharma", "type": "CUSTOMER", "phone": "9876543210", "openingBalance": "500"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/app/parties/")
    pid = r.headers["location"].rsplit("/", 1)[1]
    page = client.get("/app/parties")
    assert page.status_code == 200 and "Sharma" in page.text
    d = client.get(f"/app/parties/{pid}")
    assert d.status_code == 200 and "wa.me" in d.text and "Balance b/f" not in d.text
    client.post("/app/payments", data={"partyId": pid, "direction": "IN", "amount": "200", "mode": "CASH"})
    d = client.get(f"/app/parties/{pid}")
    assert "Reverse" in d.text
    csv = client.get(f"/app/parties/{pid}/ledger.csv")
    assert csv.status_code == 200 and csv.text.startswith("Date,Particulars")
    pay_id = client.get("/api/payments").json()[0]["id"]
    client.post(f"/app/payments/{pay_id}/reverse", data={"partyId": pid})
    assert client.get(f"/api/parties/{pid}").json()["balance"] == 500
    # duplicate name flashes an error
    r = client.post("/app/parties", data={"name": "Sharma"}, follow_redirects=True)
    assert "already exists" in r.text
    client.post(f"/app/parties/{pid}/update", data={"name": "Sharma 2", "type": "BOTH"})
    assert client.get(f"/api/parties/{pid}").json()["name"] == "Sharma 2"


def test_expenses_cashbook_activity_settings(client):
    _login_ok(client)
    client.post("/app/expenses", data={"category": "Rent", "amount": "100", "mode": "CASH"})
    page = client.get("/app/expenses")
    assert page.status_code == 200 and "Rent" in page.text and "Cash book" in page.text
    eid = client.get("/api/expenses").json()["expenses"][0]["id"]
    client.post(f"/app/expenses/{eid}/delete")
    assert client.get("/api/expenses").json()["expenses"] == []

    r = client.post("/app/settings", data={"businessName": "Test Co", "state": "Kerala", "invoicePrefix": "BL"}, follow_redirects=True)
    assert "Settings saved" in r.text and "Test Co" in r.text
    r = client.post("/app/settings", data={"gstin": "bad", "invoicePrefix": "INV"}, follow_redirects=True)
    assert "GSTIN must be 15" in r.text

    act = client.get("/app/activity")
    assert act.status_code == 200 and "Expense added" in act.text and "Settings changed" in act.text
    assert client.get("/app/activity?page=1&action=expense").status_code == 200


def test_staff_pages(client):
    _login_ok(client)
    r = client.post("/app/staff", data={"name": "Ravi", "email": "ravi@example.com", "password": "password123", "role": "SALES"}, follow_redirects=True)
    assert "Staff added" in r.text and "Ravi" in r.text
    sid = client.get("/api/staff").json()["staff"][0]["id"]
    client.post(f"/app/staff/{sid}/update", data={"name": "Ravi K", "role": "SALES_PURCHASE"})
    assert client.get("/api/staff").json()["staff"][0]["role"] == "SALES_PURCHASE"
    client.post(f"/app/staff/{sid}/delete")
    assert client.get("/api/staff").json()["staff"] == []
    r = client.post("/app/staff", data={"name": "X", "email": "x@example.com", "password": "short", "role": "SALES"}, follow_redirects=True)
    assert "at least 8" in r.text
