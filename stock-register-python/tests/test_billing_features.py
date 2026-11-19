from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_web_billing import form, world


def body(g, item, party, qty=2, **over):
    d = {"kind": "SALE", "date": "2026-11-17", "partyId": party, "godownId": g, "gstEnabled": True,
         "lines": [{"itemId": item["id"], "qty": qty, "rate": 1800, "discountPct": 0, "taxRate": 5}]}
    return {**d, **over}


def stock_of(c, item_id):
    led = c.get("/api/ledger").json()
    rows = [e for e in led if e["itemId"] == item_id]
    return max(rows, key=lambda e: e["createdAt"])["itemBalance"] if rows else None


def test_split_payment_with_finance(client):
    g, item, party = world(client)
    split = [{"mode": "CARD", "amount": 1000}, {"mode": "UPI", "amount": 1500}, {"mode": "FINANCE", "amount": 1280, "finance": "Bajaj Finance"}]
    r = client.post("/api/vouchers", json=body(g, item, party, paymentSplit=split, paymentInfo="UPI ref 123", schemeInfo="Festival offer"))
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["total"] == 3780 and v["paid"] == 3780
    assert [p["mode"] for p in v["paymentSplit"]] == ["CARD", "UPI", "FINANCE"]
    assert v["paymentInfo"] == "UPI ref 123" and v["schemeInfo"] == "Festival offer"
    html = client.get(f"/print/voucher/{v['id']}").text
    assert "Bajaj Finance" in html and "Festival offer" in html and "UPI ref 123" in html
    assert "Bajaj Finance" in client.get(f"/print/voucher/{v['id']}?format=t80").text


def test_finance_validation_and_overpay(client):
    g, item, party = world(client)
    bad = client.post("/api/vouchers", json=body(g, item, party, paymentSplit=[{"mode": "FINANCE", "amount": 100}]))
    assert bad.status_code == 400 and "finance company" in bad.json()["error"]
    bad = client.post("/api/vouchers", json=body(g, item, party, paymentSplit=[{"mode": "FINANCE", "amount": 0, "finance": "HDFC Bank"}]))
    assert bad.status_code == 400 and "disbursed" in bad.json()["error"]
    bad = client.post("/api/vouchers", json=body(g, item, party, paymentSplit=[{"mode": "CASH", "amount": 3000}, {"mode": "UPI", "amount": 1000}]))
    assert bad.status_code == 400
    # legacy single paidNow still works
    ok = client.post("/api/vouchers", json=body(g, item, party, paidNow=500, paymentMode="CASH"))
    assert ok.json()["paid"] == 500


def test_web_form_split_rows(client):
    g, item, party = world(client)
    d = form(g, item, party, paidNow="0")
    d.update({"payMode": ["CASH", "FINANCE"], "payAmount": ["780", "3000"], "payFinance": ["", "TVS Credit"],
              "paymentInfo": "ref", "schemeInfo": "gift"})
    r = client.post("/app/billing/new", data=d, follow_redirects=False)
    vid = r.headers["location"].rsplit("/", 1)[1]
    v = client.get(f"/api/vouchers/{vid}").json()
    assert v["paid"] == 3780 and v["paymentSplit"][1]["finance"] == "TVS Credit"
    page = client.get(f"/app/billing/{vid}").text
    assert "TVS Credit" in page and "Created by" in page


def test_edit_owner_only_and_cancel_restores_stock(client):
    g, item, party = world(client)
    v = client.post("/api/vouchers", json=body(g, item, party, qty=2)).json()
    assert v["modifiedBy"] == "" and stock_of(client, item["id"]) == 18

    e = client.put(f"/api/vouchers/{v['id']}", json=body(g, item, party, qty=5, schemeInfo="x"))
    assert e.status_code == 200, e.text
    e = e.json()
    assert e["number"] == v["number"] and e["createdBy"] == "Owner" and e["modifiedBy"] == "Owner"
    assert e["total"] == 9450 and stock_of(client, item["id"]) == 15
    assert "Last modified by" in client.get(f"/app/billing/{v['id']}").text

    client.post(f"/api/vouchers/{v['id']}/cancel")
    assert stock_of(client, item["id"]) == 20  # exact original stock, not double-reversed
    assert client.put(f"/api/vouchers/{v['id']}", json=body(g, item, party)).status_code == 409


def test_edit_replaces_bill_payments_keeps_later_receipts(client):
    g, item, party = world(client)
    v = client.post("/api/vouchers", json=body(g, item, party, paidNow=1000)).json()
    client.post("/api/payments", json={"partyId": party, "direction": "IN", "amount": 500, "mode": "CASH", "date": "2026-11-17", "voucherId": v["id"]})
    e = client.put(f"/api/vouchers/{v['id']}", json=body(g, item, party, paymentSplit=[{"mode": "UPI", "amount": 700}])).json()
    assert e["paid"] == 1200  # 700 new + 500 later receipt; the old 1000 was replaced


def test_staff_cannot_edit(client):
    g, item, party = world(client)
    v = client.post("/api/vouchers", json=body(g, item, party)).json()
    client.post("/api/staff", json={"name": "Ravi", "email": "ravi@example.com", "password": "password123", "role": "STORE_ADMIN"})
    s = TestClient(create_app())
    s.post("/api/auth/login", json={"email": "ravi@example.com", "password": "password123"})
    assert s.put(f"/api/vouchers/{v['id']}", json=body(g, item, party)).status_code == 403
    assert "/edit" not in s.get(f"/app/billing/{v['id']}").text
    r = s.get(f"/app/billing/{v['id']}/edit", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == f"/app/billing/{v['id']}"


def test_edit_page_and_form_post(client):
    g, item, party = world(client)
    v = client.post("/api/vouchers", json=body(g, item, party)).json()
    assert "/edit" in client.get(f"/app/billing/{v['id']}").text
    page = client.get(f"/app/billing/{v['id']}/edit")
    assert page.status_code == 200 and "Edit sales invoice" in page.text and "Sharma" in page.text
    d = form(g, item, party, qty="3")
    r = client.post(f"/app/billing/{v['id']}/edit", data=d, follow_redirects=False)
    assert r.status_code == 303 and client.get(f"/api/vouchers/{v['id']}").json()["total"] == 5670


def test_old_database_gets_new_columns(tmp_path):
    import sqlite3

    from app import db as dbmod

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute('CREATE TABLE "Voucher" ("id" TEXT PRIMARY KEY)')
    con.execute('CREATE TABLE "PartyPayment" ("id" TEXT PRIMARY KEY, "voucherId" TEXT, "notes" TEXT)')
    con.execute("INSERT INTO PartyPayment VALUES ('a','v','With sales invoice INV-1'), ('b','v','Later receipt')")
    con.commit(); con.close()
    eng = dbmod.make_engine(f"sqlite:///{path.as_posix()}")
    dbmod._add_missing_columns(eng)
    dbmod._add_missing_columns(eng)  # idempotent
    with eng.connect() as c:
        from sqlalchemy import text
        assert c.execute(text('SELECT "withBill" FROM "PartyPayment" ORDER BY id')).scalars().all() == [1, 0]
        c.execute(text('SELECT "modifiedBy","paymentSplit","schemeInfo" FROM "Voucher"'))
    eng.dispose()
