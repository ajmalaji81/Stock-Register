"""Chennai bills Puducherry; Puducherry approves; the purchase appears there by itself."""
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.serials import with_check_digit
from tests.conftest import signup

TODAY = "2026-11-17"
CHN_GSTIN, PUD_GSTIN = "33ABCDE1234F1Z5", "34ABCDE1234F1Z6"


def imei(n):
    return with_check_digit(f"35{n:012d}")


def world(c):
    signup(c)
    c.put("/api/settings", json={"state": "Tamil Nadu", "businessName": "Mobile Hub", "gstin": CHN_GSTIN})
    chn = c.get("/api/workspace").json()["godowns"][0]["id"]
    assert c.post("/api/godowns", json={"name": "Puducherry"}).status_code == 201
    pud = [g["id"] for g in c.get("/api/workspace").json()["godowns"] if g["id"] != chn][0]
    assert c.patch(f"/api/godowns/{chn}", json={"name": "Chennai", "state": "Tamil Nadu", "gstin": CHN_GSTIN}).status_code == 200
    assert c.patch(f"/api/godowns/{pud}", json={"name": "Puducherry", "state": "Puducherry", "gstin": PUD_GSTIN, "address": "Beach Rd"}).status_code == 200
    c.post("/api/items", json={"name": "Redmi 13C", "sku": "RM13", "unit": "pcs", "purchasePrice": 8000, "salePrice": 9999,
                               "minStockAlert": 0, "gstRate": 18, "trackSerial": True})
    item = [i for i in c.get("/api/workspace").json()["items"] if i["sku"] == "RM13"][0]
    sup = c.post("/api/parties", json={"name": "Redington", "type": "SUPPLIER"}).json()["id"]
    parties = {p["name"]: p["id"] for p in c.get("/api/parties").json()["parties"]}
    return chn, pud, item, sup, parties["Chennai (branch)"], parties["Puducherry (branch)"]


def bill(g, item, party, kind, serials, rate=9999):
    return {"kind": kind, "date": TODAY, "godownId": g, "partyId": party, "gstEnabled": True,
            "lines": [{"itemId": item["id"], "qty": len(serials), "rate": rate, "taxRate": 18, "serials": serials}]}


def stock_of(c, item_id, g):
    return [i for i in c.get("/api/workspace").json()["items"] if i["id"] == item_id][0]["stock"][g]


def setup_stock(c, chn, item, sup, units):
    r = c.post("/api/vouchers", json=bill(chn, item, sup, "PURCHASE", units, 8000))
    assert r.status_code == 201, r.text


def where(c, im):
    return next(r for r in c.get("/app/serials").text.split("<tr>") if im in r)


def test_branch_parties_carry_state_and_gstin(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    p = {x["id"]: x for x in client.get("/api/parties").json()["parties"]}[p_pud]
    assert p["state"] == "Puducherry" and p["gstin"] == PUD_GSTIN


def test_sale_pending_then_approved_creates_matching_purchase(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    a, b = imei(1), imei(2)
    setup_stock(client, chn, item, sup, [a, b])

    sale = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [a, b]))
    assert sale.status_code == 201, sale.text
    s = sale.json()
    assert s["branchStatus"] == "PENDING" and s["branchGodownId"] == pud
    assert s["interState"] is True and s["igst"] == 3599.64 and s["cgst"] == 0  # Tamil Nadu -> Puducherry
    assert s["godownGstin"] == CHN_GSTIN and s["godownState"] == "Tamil Nadu"
    assert stock_of(client, item["id"], chn) == 0 and stock_of(client, item["id"], pud) == 0  # in transit

    pend = client.get("/api/branch/pending").json()
    assert [(p["number"], p["to"]) for p in pend] == [(s["number"], "Puducherry")]
    assert pend[0]["lines"][0]["serials"] == [a, b] and "costRate" not in pend[0]["lines"][0]

    r = client.post(f"/api/vouchers/{s['id']}/branch/approve")
    assert r.status_code == 200, r.text
    purchase = client.get(f"/api/vouchers/{r.json()['purchaseId']}").json()
    assert purchase["kind"] == "PURCHASE" and purchase["godownId"] == pud and purchase["partyName"] == "Chennai (branch)"
    assert (purchase["total"], purchase["igst"], purchase["subtotal"]) == (s["total"], s["igst"], s["subtotal"])
    assert purchase["interState"] is True and purchase["linkedVoucherId"] == s["id"]
    assert stock_of(client, item["id"], pud) == 2 and stock_of(client, item["id"], chn) == 0

    again = client.get(f"/api/vouchers/{s['id']}").json()
    assert again["branchStatus"] == "APPROVED" and again["branchVoucherId"] == purchase["id"] and again["branchBy"] == "Owner"
    assert client.get("/api/branch/pending").json() == []
    # IMEIs now live in Puducherry
    sold = client.get(f"/app/serial-lookup/available?item={item['id']}&godown={pud}").json()
    assert sorted(u["imei"] for u in sold) == sorted([a, b])


def test_second_approve_is_refused(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    setup_stock(client, chn, item, sup, [imei(1)])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [imei(1)])).json()
    assert client.post(f"/api/vouchers/{s['id']}/branch/approve").status_code == 200
    r = client.post(f"/api/vouchers/{s['id']}/branch/approve")
    assert r.status_code == 409
    purchases = [v for v in client.get("/api/vouchers?kind=PURCHASE").json() if v["partyName"] == "Chennai (branch)"]
    assert len(purchases) == 1


def test_reject_returns_stock_even_for_staff_of_the_receiving_godown_only(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    a = imei(1)
    setup_stock(client, chn, item, sup, [a, imei(2)])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [a])).json()
    assert stock_of(client, item["id"], chn) == 1
    r = client.post("/api/staff", json={"name": "Pondy Mgr", "email": "pondy@example.com", "password": "password123",
                                        "role": "SALES_PURCHASE", "godownIds": [pud]})
    assert r.status_code in (200, 201), r.text
    staff = TestClient(create_app())
    assert staff.post("/api/auth/login", json={"email": "pondy@example.com", "password": "password123"}).status_code == 200
    # the Puducherry-only person sees it and may reject it, although Chennai's godown isn't theirs
    assert [p["number"] for p in staff.get("/api/branch/pending").json()] == [s["number"]]
    assert staff.get(f"/api/vouchers/{s['id']}").status_code == 404  # not their godown's bill
    assert staff.post(f"/api/vouchers/{s['id']}/branch/reject").status_code == 200
    back = client.get(f"/api/vouchers/{s['id']}").json()
    assert back["status"] == "CANCELLED" and back["branchStatus"] == "REJECTED" and back["branchBy"] == "Pondy Mgr"
    assert stock_of(client, item["id"], chn) == 2
    assert a in [u["imei"] for u in client.get(f"/app/serial-lookup/available?item={item['id']}&godown={chn}").json()]


def test_only_the_receiving_side_can_decide(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    setup_stock(client, chn, item, sup, [imei(1)])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [imei(1)])).json()
    client.post("/api/staff", json={"name": "Chennai Mgr", "email": "chn@example.com", "password": "password123",
                                    "role": "SALES_PURCHASE", "godownIds": [chn]})
    staff = TestClient(create_app())
    staff.post("/api/auth/login", json={"email": "chn@example.com", "password": "password123"})
    assert staff.post(f"/api/vouchers/{s['id']}/branch/approve").status_code == 403  # billing godown can't approve its own invoice
    client.post("/api/staff", json={"name": "Clerk", "email": "clerk@example.com", "password": "password123", "role": "SALES", "godownIds": [pud]})
    clerk = TestClient(create_app())
    clerk.post("/api/auth/login", json={"email": "clerk@example.com", "password": "password123"})
    assert clerk.post(f"/api/vouchers/{s['id']}/branch/approve").status_code == 403  # SALES role lacks branch.approve


def test_cancelling_the_purchase_reopens_the_invoice_and_it_can_be_approved_again(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    a = imei(1)
    setup_stock(client, chn, item, sup, [a])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [a])).json()
    pid = client.post(f"/api/vouchers/{s['id']}/branch/approve").json()["purchaseId"]
    assert client.post(f"/api/vouchers/{pid}/cancel").status_code == 200
    assert stock_of(client, item["id"], pud) == 0
    assert client.get(f"/api/vouchers/{s['id']}").json()["branchStatus"] == "PENDING"
    r2 = client.post(f"/api/vouchers/{s['id']}/branch/approve")
    assert r2.status_code == 200 and r2.json()["purchaseId"] != pid
    assert stock_of(client, item["id"], pud) == 1


def test_approved_sale_cannot_be_cancelled_or_edited_and_auto_purchase_cannot_be_edited(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    a = imei(1)
    setup_stock(client, chn, item, sup, [a])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [a])).json()
    pid = client.post(f"/api/vouchers/{s['id']}/branch/approve").json()["purchaseId"]
    assert client.post(f"/api/vouchers/{s['id']}/cancel").status_code == 409
    assert client.put(f"/api/vouchers/{s['id']}", json=bill(chn, item, p_pud, "SALE", [a])).status_code == 409
    assert client.put(f"/api/vouchers/{pid}", json=bill(pud, item, p_chn, "PURCHASE", [a], 9999)).status_code == 409


def test_pending_invoice_can_be_cancelled_or_edited(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    a, b = imei(1), imei(2)
    setup_stock(client, chn, item, sup, [a, b])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [a])).json()
    e = client.put(f"/api/vouchers/{s['id']}", json=bill(chn, item, p_pud, "SALE", [a, b]))
    assert e.status_code == 200 and e.json()["branchStatus"] == "PENDING" and e.json()["total"] > s["total"]
    c = client.post(f"/api/vouchers/{s['id']}/cancel").json()
    assert c["status"] == "CANCELLED" and c["branchStatus"] == "CANCELLED"
    assert stock_of(client, item["id"], chn) == 2
    assert client.get("/api/branch/pending").json() == []


def test_same_gstin_or_same_godown_is_refused_and_payment_is_refused(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    setup_stock(client, chn, item, sup, [imei(1), imei(2)])
    r = client.post("/api/vouchers", json=bill(chn, item, p_chn, "SALE", [imei(1)]))
    assert r.status_code == 400 and "itself" in r.json()["error"]
    r = client.post("/api/vouchers", json={**bill(chn, item, p_pud, "SALE", [imei(1)]), "paidNow": 100})
    assert r.status_code == 400 and "payment" in r.json()["error"]
    client.patch(f"/api/godowns/{pud}", json={"name": "Puducherry", "state": "Tamil Nadu", "gstin": CHN_GSTIN})
    r = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [imei(1)]))
    assert r.status_code == 400 and "internal transfer" in r.json()["error"]
    # nobody can buy / return against a branch party by hand
    r = client.post("/api/vouchers", json=bill(pud, item, p_chn, "PURCHASE", [imei(2)], 100))
    assert r.status_code == 400


def test_godown_rename_keeps_gst_details(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    client.patch(f"/api/godowns/{pud}", json={"name": "Pondicherry"})
    g = {x["id"]: x for x in client.get("/api/workspace").json()["godowns"]}[pud]
    assert g["name"] == "Pondicherry" and g["gstin"] == PUD_GSTIN and g["state"] == "Puducherry"
    assert {p["id"]: p for p in client.get("/api/parties").json()["parties"]}[p_pud]["name"] == "Pondicherry (branch)"


def test_single_godown_business_gets_no_branch_party(client):
    signup(client)
    assert client.get("/api/parties").json()["parties"] == []


def test_print_uses_the_godowns_gstin_and_address(client):
    chn, pud, item, sup, p_chn, p_pud = world(client)
    setup_stock(client, chn, item, sup, [imei(1)])
    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [imei(1)])).json()
    html = client.get(f"/print/voucher/{s['id']}").text
    assert CHN_GSTIN in html and PUD_GSTIN in html and "Puducherry" in html


def test_web_pages_for_godowns_approvals_and_detail(client):
    from tests.test_web_billing import form

    chn, pud, item, sup, p_chn, p_pud = world(client)
    client.patch(f"/api/godowns/{chn}", json={"name": "Chennai", "state": "Tamil Nadu", "gstin": "33ZZZZZ9999Z1Z9"})
    page = client.get("/app/godowns").text
    assert "33ZZZZZ9999Z1Z9" in page and PUD_GSTIN in page and "/details" in page
    r = client.post(f"/app/godowns/{pud}/details", data={"name": "Puducherry", "state": "Puducherry", "gstin": PUD_GSTIN, "address": "New road"}, follow_redirects=False)
    assert r.status_code == 303 and client.get("/app/godowns").text.count("New road") == 1
    bad = client.post(f"/app/godowns/{pud}/details", data={"name": "Puducherry", "state": "Puducherry", "gstin": "BAD"}, follow_redirects=False)
    assert bad.status_code == 303  # flashed back

    setup_stock(client, chn, item, sup, [imei(1), imei(2)])
    form_page = client.get("/app/billing/new?kind=SALE").text
    assert 'data-state="Puducherry"' in form_page and "Puducherry (branch)" in form_page and '"branch"' in form_page

    s = client.post("/api/vouchers", json=bill(chn, item, p_pud, "SALE", [imei(1)])).json()
    assert "waiting for their approval" in client.get(f"/app/billing/{s['id']}").text
    ap = client.get("/app/billing/approvals").text
    assert s["number"] in ap and imei(1) in ap and "Approve" in ap and "Reject" in ap
    assert "/app/billing/approvals" in client.get("/app").text  # menu entry

    r = client.post(f"/app/billing/{s['id']}/branch/approve", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/app/billing/approvals"
    detail = client.get(f"/app/billing/{s['id']}").text
    assert "approved by Owner" in detail and "purchase" in detail
    assert "Nothing is waiting" in client.get("/app/billing/approvals").text
    # the invoice prints under Chennai's own GSTIN, not the business profile's
    html = client.get(f"/print/voucher/{s['id']}").text
    assert "33ZZZZZ9999Z1Z9" in html and PUD_GSTIN in html
    assert CHN_GSTIN not in html.replace(PUD_GSTIN, "")
