from app.services.serials import with_check_digit
from tests.conftest import signup

TODAY = "2026-11-17"


def imei(n: int) -> str:
    return with_check_digit(f"35{n:012d}")


def world(c):
    signup(c)
    c.put("/api/settings", json={"state": "Tamil Nadu", "businessName": "Mobile Hub"})
    hq = c.get("/api/workspace").json()["godowns"][0]["id"]
    c.post("/api/godowns", json={"name": "Madurai shop"})
    ws = c.get("/api/workspace").json()
    shop = [g["id"] for g in ws["godowns"] if g["id"] != hq][0]
    r = c.post("/api/items", json={"name": "Redmi 13C", "sku": "RM13", "unit": "pcs", "purchasePrice": 8000, "salePrice": 9999,
                                   "minStockAlert": 0, "gstRate": 18, "trackSerial": True})
    assert r.status_code in (200, 201), r.text
    item = [i for i in c.get("/api/workspace").json()["items"] if i["sku"] == "RM13"][0]
    sup = c.post("/api/parties", json={"name": "Redington", "type": "SUPPLIER"}).json()["id"]
    cust = c.post("/api/parties", json={"name": "Ravi", "state": "Tamil Nadu"}).json()["id"]
    return hq, shop, item, sup, cust


def bill(g, item, party, kind, serials, **over):
    qty = over.pop("qty", len(serials))
    d = {"kind": kind, "date": TODAY, "godownId": g, "partyId": party, "gstEnabled": True,
         "lines": [{"itemId": item["id"], "qty": qty, "rate": 8000 if kind.startswith("PURCHASE") else 9999, "taxRate": 18,
                    "serials": serials}]}
    return {**d, **over}


def history(c, im):
    return c.get(f"/app/serials/{im}")


def stock_of(c, item_id, g):
    return [i for i in c.get("/api/workspace").json()["items"] if i["id"] == item_id][0]["stock"][g]


def test_count_mismatch_and_bad_check_digit(client):
    hq, shop, item, sup, cust = world(client)
    r = client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [imei(1)], qty=2))
    assert r.status_code == 400 and "exactly 2 IMEI" in r.json()["error"]
    r = client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", ["123456789012345"]))
    assert r.status_code == 400 and "check digit" in r.json()["error"]
    r = client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [imei(1), imei(1)]))
    assert r.status_code == 400 and "twice" in r.json()["error"]
    assert client.post("/api/movements", json={"itemId": item["id"], "godownId": hq, "type": "IN", "qty": 1, "rate": 1, "date": TODAY}).status_code in (400, 404)


def test_transfer_then_sale_and_wrong_shop(client):
    hq, shop, item, sup, cust = world(client)
    a, b = imei(1), imei(2)
    assert client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [a, b])).status_code == 201
    r = client.post("/api/vouchers", json=bill(shop, item, cust, "SALE", [a]))
    assert r.status_code == 400 and "Main Shop" in r.json()["error"] and "Madurai shop" in r.json()["error"]
    t = client.post("/api/transfers", json={"itemId": item["id"], "fromGodownId": hq, "toGodownId": shop, "qty": 1, "date": TODAY, "serials": [a]})
    assert t.status_code in (200, 201), t.text
    assert client.post("/api/vouchers", json=bill(shop, item, cust, "SALE", [a])).status_code == 201
    assert stock_of(client, item["id"], shop) == 0 and stock_of(client, item["id"], hq) == 1
    page = history(client, a).text
    assert "Redington" in page and "Madurai shop" in page and "Ravi" in page and "Sold" in page
    listing = client.get("/app/serials?q=" + a[-6:]).text
    assert a in listing and "Redington" in listing


def test_cancel_sale_returns_unit_and_edit_swaps_imei(client):
    hq, shop, item, sup, cust = world(client)
    a, b = imei(1), imei(2)
    client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [a, b]))
    s = client.post("/api/vouchers", json=bill(hq, item, cust, "SALE", [a])).json()
    # same IMEI can be re-saved, and swapped for the other phone
    assert client.put(f"/api/vouchers/{s['id']}", json=bill(hq, item, cust, "SALE", [a])).status_code == 200
    assert client.put(f"/api/vouchers/{s['id']}", json=bill(hq, item, cust, "SALE", [b])).status_code == 200
    assert "In stock" in client.get(f"/app/serials?q={a}").text
    assert client.post(f"/api/vouchers/{s['id']}/cancel").status_code == 200
    assert stock_of(client, item["id"], hq) == 2
    assert "Sold" not in client.get(f"/app/serials?q={b}").text.split("<table")[1]


def test_cancel_purchase_blocked_when_unit_sold(client):
    hq, shop, item, sup, cust = world(client)
    a = imei(1)
    p = client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [a])).json()
    client.post("/api/vouchers", json=bill(hq, item, cust, "SALE", [a]))
    r = client.post(f"/api/vouchers/{p['id']}/cancel")
    assert r.status_code >= 400
    assert client.get(f"/api/vouchers/{p['id']}").json()["status"] == "OPEN"


def test_return_then_resale_updates_last_sale(client):
    hq, shop, item, sup, cust = world(client)
    a = imei(1)
    client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [a]))
    client.post("/api/vouchers", json=bill(hq, item, cust, "SALE", [a]))
    assert client.post("/api/vouchers", json=bill(hq, item, cust, "SALE_RETURN", [a])).status_code == 201
    cust2 = client.post("/api/parties", json={"name": "Anwar"}).json()["id"]
    assert client.post("/api/vouchers", json=bill(hq, item, cust2, "SALE", [a])).status_code == 201
    h = history(client, a).text
    assert "Anwar" in h and "Sale returned" in h


def test_register_reconciles_and_hides_cost_from_sales_staff(client):
    hq, shop, item, sup, cust = world(client)
    a = imei(1)
    client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [a]))
    assert "differs" not in client.get("/app/serials").text
    staff = client.post("/api/staff", json={"name": "Sam", "email": "sam@example.com", "password": "password123", "role": "SALES", "godownIds": []})
    assert staff.status_code in (200, 201), staff.text
    assert "8,000" in history(client, a).text  # owner sees the purchase rate
    client.cookies.clear()
    assert client.post("/login", data={"email": "sam@example.com", "password": "password123"}, follow_redirects=False).status_code == 303
    h = history(client, a)
    assert h.status_code == 200 and "Redington" in h.text and "8,000" not in h.text


def test_web_bill_form_with_imei_textarea_and_transfer_form(client):
    hq, shop, item, sup, cust = world(client)
    a, b = imei(1), imei(2)
    form = {"kind": "PURCHASE", "date": TODAY, "godownId": hq, "partyId": sup, "gstEnabled": "1", "itemId": item["id"], "qty": "2",
            "rate": "8000", "discountPct": "0", "taxRate": "18", "description": "", "serials": f"{a}\n{b}"}
    r = client.post("/app/billing/new", data=form, follow_redirects=False)
    assert r.status_code == 303 and "/app/billing/" in r.headers["location"]
    page = client.get(r.headers["location"]).text
    assert a in page and b in page  # IMEIs shown on the bill
    assert a in client.get(f"/print/voucher/{r.headers['location'].rsplit('/', 1)[1]}").text
    bad = client.post("/app/billing/new", data={**form, "serials": a}, follow_redirects=False)
    assert bad.status_code == 303 and bad.headers["location"].startswith("/app/billing/new")
    t = client.post("/app/stock/transfer", data={"itemId": item["id"], "fromGodownId": hq, "toGodownId": shop, "qty": "1",
                                                  "date": TODAY, "serials": a}, follow_redirects=False)
    assert t.status_code == 303 and "Madurai shop" in client.get(f"/app/serials/{a}").text
