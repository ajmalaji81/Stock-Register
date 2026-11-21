from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import make_free, signup

TODAY = "2026-11-17"


def item_body(sku="R1", **over):
    base = {"name": f"Item {sku}", "sku": sku, "category": "", "unit": "pcs", "purchasePrice": 100, "salePrice": 150, "minStockAlert": 0}
    return {**base, **over}


def workspace(c):
    r = c.get("/api/workspace")
    assert r.status_code == 200, r.text
    return r.json()


def test_auth_flow_and_errors(client):
    assert client.get("/api/workspace").status_code == 401
    r = client.post("/api/auth/signup", json={"name": "A", "email": "bad", "password": "x"})
    assert r.status_code == 400 and r.json() == {"error": "Enter a valid email"}
    signup(client)
    assert client.post("/api/auth/signup", json={"name": "A", "email": "owner@example.com", "password": "password123"}).status_code == 409
    ws = workspace(client)
    assert ws["user"]["plan"] == "TRIAL" and ws["godowns"][0]["name"] == "Main Shop"
    assert ws["actor"]["isOwner"] is True
    client.post("/api/auth/logout")
    assert client.get("/api/workspace").status_code == 401
    assert client.post("/api/auth/login", json={"email": "owner@example.com", "password": "nope"}).json() == {"error": "Wrong email or password"}
    r = client.post("/api/auth/login", json={"email": "OWNER@example.com", "password": "password123"})
    assert r.status_code == 200 and r.json() == {"ok": True, "kind": "owner"}
    assert client.get("/api/me").json()["actor"]["role"] == "OWNER"


def test_invalid_json_and_validation_messages(client):
    signup(client)
    r = client.post("/api/items", content=b"{nope", headers={"content-type": "application/json"})
    assert r.status_code == 400 and r.json() == {"error": "Invalid JSON body"}
    r = client.post("/api/items", json=item_body(name=""))
    assert r.json() == {"error": "Item name is required"}


def test_item_opening_stock_movements_and_ledger(client):
    signup(client)
    g = workspace(client)["godowns"][0]["id"]
    assert client.post("/api/items", json=item_body(openingQty=10, openingGodownId=g)).status_code == 201
    item = workspace(client)["items"][0]
    assert item["stock"][g] == 10

    mv = {"itemId": item["id"], "godownId": g, "type": "OUT", "qty": 4, "rate": 150, "party": "Sharma", "remarks": "", "date": TODAY}
    assert client.post("/api/movements", json=mv).status_code == 201
    r = client.post("/api/movements", json={**mv, "qty": 7})
    assert r.status_code == 400
    assert r.json() == {"error": 'Not enough stock of "Item R1" in Main Shop: available 6, requested 7.', "code": "INSUFFICIENT_STOCK"}
    assert workspace(client)["items"][0]["stock"][g] == 6

    entries = client.get("/api/ledger").json()
    assert [(e["type"], e["qtyIn"], e["qtyOut"], e["balance"]) for e in entries] == [("OPENING", 10, 0, 10), ("OUT", 0, 4, 6)]
    assert client.get("/api/ledger", params={"type": "OUT"}).json()[0]["party"] == "Sharma"
    acts = client.get("/api/activity").json()
    assert {"item.create", "stock.out"} <= {a["action"] for a in acts["items"]}


def test_transfer_keeps_item_total(client):
    signup(client)
    assert client.post("/api/godowns", json={"name": "Godown A"}).status_code == 201
    ws = workspace(client)
    main, ga = ws["godowns"][0]["id"], ws["godowns"][1]["id"]
    client.post("/api/items", json=item_body(openingQty=20, openingGodownId=main))
    item = workspace(client)["items"][0]
    tr = {"itemId": item["id"], "fromGodownId": main, "toGodownId": ga, "qty": 5, "date": TODAY, "remarks": ""}
    assert client.post("/api/transfers", json=tr).status_code == 201
    stock = workspace(client)["items"][0]["stock"]
    assert stock == {main: 15, ga: 5}
    out, inn = client.get("/api/ledger", params={"type": "TRANSFER_OUT"}).json()[0], client.get("/api/ledger", params={"type": "TRANSFER_IN"}).json()[0]
    assert out["transferId"] == inn["transferId"] and out["itemBalance"] == inn["itemBalance"] == 20
    assert client.post("/api/transfers", json={**tr, "toGodownId": main}).json() == {"error": "Choose two different godowns"}
    assert client.post("/api/transfers", json={**tr, "qty": 99}).json()["code"] == "INSUFFICIENT_STOCK"


def test_free_plan_limits_return_402(client):
    signup(client)
    make_free()
    for i in range(5):
        assert client.post("/api/items", json=item_body(f"S{i}")).status_code == 201
    r = client.post("/api/items", json=item_body("S5"))
    assert r.status_code == 402 and r.json()["code"] == "LIMIT"
    assert client.post("/api/godowns", json={"name": "G2"}).status_code == 201
    r = client.post("/api/godowns", json={"name": "G3"})
    assert r.status_code == 402 and r.json()["code"] == "LIMIT"
    assert client.post("/api/items", json=item_body("S0")).status_code in (402, 409)


def test_duplicate_sku_is_409(client):
    signup(client)
    client.post("/api/items", json=item_body("DUP"))
    assert client.post("/api/items", json=item_body("DUP")).status_code == 409


def _setup_sale_world(client):
    client.post("/api/settings", json={})  # no such route: ignored
    assert client.put("/api/settings", json={"state": "Tamil Nadu", "businessName": "Test Traders", "gstin": "33abcde1234f1z5"}).status_code == 200
    g = workspace(client)["godowns"][0]["id"]
    client.post("/api/items", json=item_body("RICE", salePrice=1800, purchasePrice=1500, gstRate=5, openingQty=50, openingGodownId=g))
    item = workspace(client)["items"][0]
    party = client.post("/api/parties", json={"name": "Sharma Kirana", "type": "CUSTOMER", "state": "Tamil Nadu"}).json()["id"]
    return g, item, party


def sale_body(g, item, party, qty=10, **over):
    body = {
        "kind": "SALE", "date": TODAY, "partyId": party, "godownId": g, "gstEnabled": True,
        "lines": [{"itemId": item["id"], "qty": qty, "rate": 1800, "taxRate": 5}],
    }
    return {**body, **over}


def test_sale_totals_stock_party_balance_and_cancel(client):
    signup(client)
    g, item, party = _setup_sale_world(client)
    r = client.post("/api/vouchers", json=sale_body(g, item, party, paidNow=5000))
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["number"] == "INV-0001" and v["subtotal"] == 18000 and v["cgst"] == 450 and v["sgst"] == 450 and v["total"] == 18900
    assert v["interState"] is False and v["paid"] == 5000 and v["costTotal"] == 15000 and v["profit"] == 3000
    assert workspace(client)["items"][0]["stock"][g] == 40
    row = client.get(f"/api/parties/{party}").json()
    assert row["balance"] == 13900 and row["sales"] == 18900

    ledger = client.get(f"/api/parties/{party}/ledger").json()
    assert ledger["closing"] == 13900 and [x["kind"] for x in ledger["rows"]] == ["SALE", "PAYMENT_IN"]

    # Same bill number sequence, then cancel reverses stock and removes the linked payment.
    assert client.post("/api/vouchers", json=sale_body(g, item, party, qty=1)).json()["number"] == "INV-0002"
    c = client.post(f"/api/vouchers/{v['id']}/cancel")
    assert c.status_code == 200 and c.json()["status"] == "CANCELLED"
    assert workspace(client)["items"][0]["stock"][g] == 49
    assert client.get(f"/api/parties/{party}").json()["balance"] == 1890
    assert client.post(f"/api/vouchers/{v['id']}/cancel").json() == {"error": "This is already cancelled"}


def test_inter_state_sale_uses_igst(client):
    signup(client)
    g, item, party = _setup_sale_world(client)
    r = client.post("/api/vouchers", json=sale_body(g, item, party, qty=1, placeOfSupply="Kerala")).json()
    assert r["interState"] is True and r["igst"] == 90 and r["cgst"] == 0 and r["sgst"] == 0 and r["total"] == 1890


def test_tax_type_on_the_bill_decides_igst_or_local(client):
    signup(client)
    g, item, party = _setup_sale_world(client)
    a = client.post("/api/vouchers", json=sale_body(g, item, party, qty=1, taxType="IGST")).json()
    assert a["interState"] is True and a["igst"] == 90 and a["cgst"] == 0
    b = client.post("/api/vouchers", json=sale_body(g, item, party, qty=1, placeOfSupply="Kerala", taxType="LOCAL")).json()
    assert b["interState"] is False and b["igst"] == 0 and b["cgst"] == 45 and b["sgst"] == 45
    assert client.post("/api/vouchers", json=sale_body(g, item, party, qty=1, taxType="bad")).status_code == 400


def test_sale_cannot_oversell_and_rolls_back(client):
    signup(client)
    g, item, party = _setup_sale_world(client)
    r = client.post("/api/vouchers", json=sale_body(g, item, party, qty=51))
    assert r.status_code == 400 and r.json()["code"] == "INSUFFICIENT_STOCK"
    assert client.get("/api/vouchers").json() == []
    assert workspace(client)["items"][0]["stock"][g] == 50


def test_document_conversion_and_challan_does_not_double_deduct(client):
    signup(client)
    g, item, party = _setup_sale_world(client)
    qt = client.post("/api/vouchers", json=sale_body(g, item, party, qty=5, kind="QUOTATION")).json()
    assert qt["number"] == "QT-0001" and workspace(client)["items"][0]["stock"][g] == 50
    sale = client.post(f"/api/vouchers/{qt['id']}/convert", json={"to": "SALE"}).json()
    assert sale["sourceNumber"] == "QT-0001" and workspace(client)["items"][0]["stock"][g] == 45
    assert client.get(f"/api/vouchers/{qt['id']}").json()["status"] == "CONVERTED"
    assert client.post(f"/api/vouchers/{qt['id']}/cancel").status_code == 409
    client.post(f"/api/vouchers/{sale['id']}/cancel")
    assert client.get(f"/api/vouchers/{qt['id']}").json()["status"] == "OPEN"  # re-opened

    ch = client.post("/api/vouchers", json=sale_body(g, item, party, qty=4, kind="CHALLAN")).json()
    assert workspace(client)["items"][0]["stock"][g] == 46  # challan moves stock out
    s2 = client.post(f"/api/vouchers/{ch['id']}/convert", json={"to": "SALE"}).json()
    assert workspace(client)["items"][0]["stock"][g] == 46  # converting does not deduct again
    client.post(f"/api/vouchers/{s2['id']}/cancel")
    assert workspace(client)["items"][0]["stock"][g] == 46  # and cancelling it restores nothing
    assert client.post(f"/api/vouchers/{ch['id']}/convert", json={"to": "PURCHASE"}).status_code == 400


def test_payments_reversal_and_cashbook(client):
    signup(client)
    party = client.post("/api/parties", json={"name": "Gupta", "type": "SUPPLIER", "openingBalance": -1000}).json()["id"]
    pay = {"partyId": party, "direction": "OUT", "amount": 400, "mode": "CASH", "date": TODAY}
    pid = client.post("/api/payments", json=pay).json()["id"]
    assert client.get(f"/api/parties/{party}").json()["balance"] == -600
    rev = client.post(f"/api/payments/{pid}/reverse")
    assert rev.status_code == 201
    assert client.get(f"/api/parties/{party}").json()["balance"] == -1000
    assert client.post(f"/api/payments/{pid}/reverse").status_code == 409
    assert client.post(f"/api/payments/{rev.json()['id']}/reverse").status_code == 400
    cash = client.get("/api/cashbook").json()
    # the reversal is dated today (real clock), the original payment TODAY
    assert cash["closingCash"] == 0 and sum(d["cashOut"] for d in cash["days"]) == 400 and sum(d["cashIn"] for d in cash["days"]) == 400
    ex = client.post("/api/expenses", json={"category": "Rent", "amount": 250.5, "mode": "UPI", "date": TODAY})
    assert ex.status_code == 201
    e = client.get("/api/expenses").json()
    assert e["total"] == 250.5 and e["expenses"][0]["canDelete"] is True
    assert client.delete(f"/api/expenses/{ex.json()['id']}").status_code == 200
    assert client.get("/api/cashbook").json()["closingBank"] == 0


def test_party_delete_blocked_when_it_has_history_and_import(client):
    signup(client)
    p = client.post("/api/parties", json={"name": "A"}).json()["id"]
    client.post("/api/payments", json={"partyId": p, "direction": "IN", "amount": 1, "date": TODAY})
    assert client.delete(f"/api/parties/{p}").status_code == 409
    imp = client.post("/api/parties/import", json={"rows": [{"Party Name": "B", "Type": "supplier", "Opening Balance": "-5"}, {"name": "A"}, {"name": ""}]})
    j = imp.json()
    assert j["created"] == 1 and j["failed"] == 2
    assert j["results"][0] == {"line": 1, "ok": True} and j["results"][1]["error"] == '"A" already exists'
    row = [x for x in client.get("/api/parties").json()["parties"] if x["name"] == "B"][0]
    assert row["type"] == "SUPPLIER" and row["balance"] == -5


def test_item_import_rows(client):
    signup(client)
    g = workspace(client)["godowns"][0]["id"]
    rows = [
        {"name": "A", "sku": "A1", "openingQty": 3, "line": 2},
        {"name": "B", "sku": "A1", "line": 3},
        {"name": "C", "sku": "C1", "openingQty": 1, "openingGodown": "Nowhere", "line": 4},
    ]
    j = client.post("/api/items/import", json={"rows": rows}).json()
    assert j["created"] == 1 and j["failed"] == 2
    assert [r["line"] for r in j["results"]] == [2, 3, 4]
    assert j["results"][1]["error"] == 'SKU "A1" already exists'
    assert j["results"][2]["error"] == 'Godown "Nowhere" not found'
    assert workspace(client)["items"][0]["stock"][g] == 3


def test_accounts_are_isolated(client):
    signup(client, "a@example.com", "A")
    g = workspace(client)["godowns"][0]["id"]
    client.post("/api/items", json=item_body("X", openingQty=5, openingGodownId=g))
    item_id = workspace(client)["items"][0]["id"]
    party = client.post("/api/parties", json={"name": "P"}).json()["id"]
    sale = client.post("/api/vouchers", json={"kind": "SALE", "date": TODAY, "godownId": g, "lines": [{"itemId": item_id, "qty": 1, "rate": 1}]}).json()

    other = TestClient(create_app())
    signup(other, "b@example.com", "B")
    assert other.get(f"/api/vouchers/{sale['id']}").status_code == 404
    assert other.get(f"/api/parties/{party}").status_code == 404
    assert other.patch(f"/api/items/{item_id}", json=item_body("X")).status_code == 404
    assert other.delete(f"/api/items/{item_id}").status_code == 404
    mv = {"itemId": item_id, "godownId": g, "type": "IN", "qty": 1, "rate": 1, "date": TODAY}
    assert other.post("/api/movements", json=mv).status_code == 404
    assert workspace(other)["items"] == []


def test_item_used_on_bill_cannot_be_deleted(client):
    signup(client)
    g = workspace(client)["godowns"][0]["id"]
    client.post("/api/items", json=item_body("X", openingQty=5, openingGodownId=g))
    item_id = workspace(client)["items"][0]["id"]
    client.post("/api/vouchers", json={"kind": "SALE", "date": TODAY, "godownId": g, "lines": [{"itemId": item_id, "qty": 1, "rate": 1}]})
    assert client.delete(f"/api/items/{item_id}").status_code == 409
    assert client.delete(f"/api/godowns/{g}").status_code == 400  # only godown
    client.post("/api/godowns", json={"name": "G2"})
    assert client.delete(f"/api/godowns/{g}").status_code == 409  # has history


def test_reports_gst_summary_and_profit(client):
    signup(client)
    g, item, party = _setup_sale_world(client)
    client.post("/api/vouchers", json=sale_body(g, item, party, qty=10))
    client.post("/api/vouchers", json=sale_body(g, item, party, qty=2, kind="SALE_RETURN"))
    rep = client.get("/api/reports/sales").json()
    assert rep["totals"]["taxable"] == 14400 and rep["totals"]["total"] == 15120
    assert rep["byRate"][0]["rate"] == 5 and rep["byRate"][0]["cgst"] == 360
    assert rep["profit"]["total"] == 2400
    assert rep["b2c"]["count"] == 2 and rep["b2b"]["count"] == 0
    purchases = client.get("/api/reports/sales", params={"side": "purchases"}).json()
    assert purchases["profit"] is None and purchases["register"] == []


def test_staff_permissions_cost_hiding_and_godown_filter(client):
    signup(client)
    g1 = workspace(client)["godowns"][0]["id"]
    client.post("/api/godowns", json={"name": "Second"})
    g2 = workspace(client)["godowns"][1]["id"]
    client.post("/api/items", json=item_body("Z", purchasePrice=70, openingQty=9, openingGodownId=g1))
    item = workspace(client)["items"][0]
    client.post("/api/movements", json={"itemId": item["id"], "godownId": g1, "type": "IN", "qty": 1, "rate": 70, "date": TODAY})
    r = client.post("/api/staff", json={"name": "Ravi", "email": "ravi@example.com", "password": "password123", "role": "SALES", "godownIds": [g2]})
    assert r.status_code == 201, r.text
    assert client.post("/api/staff", json={"name": "X", "email": "ravi@example.com", "password": "password123", "role": "SALES"}).status_code == 409
    assert client.post("/api/staff", json={"name": "X", "email": "x@example.com", "password": "password123", "role": "BOSS"}).json() == {"error": "Choose a role"}

    staff_client = TestClient(create_app())
    assert staff_client.post("/api/auth/login", json={"email": "ravi@example.com", "password": "password123"}).json()["kind"] == "staff"
    ws = workspace(staff_client)
    assert [g["id"] for g in ws["godowns"]] == [g2]
    assert ws["items"][0]["purchasePrice"] == 0 and ws["items"][0]["stock"] == {g2: 0}
    assert staff_client.get("/api/staff").status_code == 403
    assert staff_client.post("/api/items", json=item_body("N")).status_code == 403
    assert staff_client.get("/api/activity").status_code == 403
    mv = {"itemId": item["id"], "godownId": g1, "type": "IN", "qty": 1, "rate": 1, "date": TODAY}
    assert staff_client.post("/api/movements", json=mv).status_code == 403  # role has no stock.move
    # ledger: only their godown; rates hidden for non-OUT entries
    assert staff_client.get("/api/ledger").json() == []
    assert staff_client.get("/api/ledger", params={"godownId": g1}).status_code == 403
    # purchase documents are hidden from a sales operator
    assert staff_client.get("/api/vouchers", params={"kind": "PURCHASE"}).json() == []
    assert staff_client.get("/api/reports/sales").status_code == 403

    # deactivate -> signed out and cannot log in
    sid = client.get("/api/staff").json()["staff"][0]["id"]
    assert client.patch(f"/api/staff/{sid}", json={"active": False}).status_code == 200
    assert staff_client.get("/api/workspace").status_code == 401
    assert staff_client.post("/api/auth/login", json={"email": "ravi@example.com", "password": "password123"}).status_code == 401


def test_staff_requires_pro_or_trial(client):
    signup(client)
    make_free()
    r = client.post("/api/staff", json={"name": "R", "email": "r@example.com", "password": "password123", "role": "SALES"})
    assert r.status_code == 402 and r.json()["code"] == "LIMIT"


def test_adjustment_by_count_and_delta(client):
    signup(client)
    g = workspace(client)["godowns"][0]["id"]
    client.post("/api/items", json=item_body("A", openingQty=10, openingGodownId=g))
    item = workspace(client)["items"][0]
    base = {"itemId": item["id"], "godownId": g, "reason": "Recount", "date": TODAY}
    assert client.post("/api/adjustments", json={**base, "newQty": 7}).json() == {"delta": -3, "balance": 7}
    assert client.post("/api/adjustments", json={**base, "delta": 2.5}).json() == {"delta": 2.5, "balance": 9.5}
    assert client.post("/api/adjustments", json={**base, "newQty": 9.5}).json() == {"error": "No change: the count matches the current stock."}
    assert client.post("/api/adjustments", json={**base, "newQty": 1, "delta": 1}).json() == {"error": "Give either the new count or the change, not both"}
    assert client.post("/api/adjustments", json={**base, "delta": -99}).json()["code"] == "INSUFFICIENT_STOCK"
    assert len(client.get("/api/adjustments").json()) == 2


def test_share_token_and_profile_avatar(client):
    from app.services.vouchers import share_token, valid_share_token

    signup(client)
    t = share_token("abc")
    assert len(t) == 32 and valid_share_token("abc", t) and not valid_share_token("abd", t)
    assert client.patch("/api/profile", json={"avatar": "javascript:1"}).status_code == 400
    assert client.patch("/api/profile", json={"avatar": "data:image/png;base64,iVBORw0KGgo="}).status_code == 200
    assert client.get("/api/profile").json()["avatar"].startswith("data:image/png")
    assert client.patch("/api/profile", json={"avatar": None}).json() == {"ok": True, "avatar": None}


def test_jwt_cookie_claims_match_ts_app(client):
    import jwt

    signup(client)
    token = client.cookies.get("sr_session")
    claims = jwt.decode(token, "test-secret-test-secret-test-secret-123456", algorithms=["HS256"])
    assert claims["kind"] == "owner" and claims["sub"] and claims["exp"] - claims["iat"] == 60 * 60 * 24 * 30
    client.cookies.set("sr_session", jwt.encode({"sub": claims["sub"], "kind": "owner"}, "wrong-secret-wrong-secret-wrong-123456", algorithm="HS256"))
    assert client.get("/api/workspace").status_code == 401
