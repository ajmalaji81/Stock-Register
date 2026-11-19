from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import signup

TODAY = "2026-11-17"


def world(c):
    signup(c)
    c.put("/api/settings", json={"state": "Tamil Nadu", "businessName": "Test Traders"})
    g = c.get("/api/workspace").json()["godowns"][0]["id"]
    c.post("/api/items", json={"name": "Rice", "sku": "R1", "unit": "Bag", "purchasePrice": 1500, "salePrice": 1800, "minStockAlert": 0,
                               "gstRate": 5, "openingQty": 20, "openingGodownId": g})
    item = c.get("/api/workspace").json()["items"][0]
    party = c.post("/api/parties", json={"name": "Sharma", "state": "Tamil Nadu"}).json()["id"]
    return g, item, party


def form(g, item, party, kind="SALE", qty="2", **over):
    d = {"kind": kind, "date": TODAY, "godownId": g, "partyId": party, "gstEnabled": "1", "itemId": item["id"], "qty": qty,
         "rate": "1800", "discountPct": "0", "taxRate": "5", "description": "", "paidNow": "0", "paymentMode": "CASH"}
    return {**d, **over}


def test_pages_require_login(client):
    for url in ("/app/billing/sales", "/app/billing/new", "/app/billing/reports"):
        r = client.get(url, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/login"


def test_create_list_detail_cancel_convert_print(client):
    g, item, party = world(client)
    assert "Sales invoice" in client.get("/app/billing/new?kind=SALE").text
    r = client.post("/app/billing/new", data=form(g, item, party), follow_redirects=False)
    assert r.status_code == 303
    vid = r.headers["location"].rsplit("/", 1)[1]
    assert client.get("/api/vouchers/" + vid).json()["total"] == 3780
    assert "INV-0001" in client.get("/app/billing/sales").text
    assert "INV-0001" in client.get("/app/billing/sales?q=Sharma&status=OPEN").text
    d = client.get(f"/app/billing/{vid}")
    assert d.status_code == 200 and "Rice" in d.text and "?t=" in d.text

    # errors flash back to the form
    bad = client.post("/app/billing/new", data=form(g, item, party, qty="500"), follow_redirects=False)
    assert bad.status_code == 303 and bad.headers["location"].startswith("/app/billing/new")

    # quotation -> sale conversion
    q = client.post("/app/billing/new", data=form(g, item, party, kind="QUOTATION"), follow_redirects=False)
    qid = q.headers["location"].rsplit("/", 1)[1]
    assert "Convert to sales order" in client.get(f"/app/billing/{qid}").text
    c = client.post(f"/app/billing/{qid}/convert", data={"to": "SALE"}, follow_redirects=False)
    assert c.status_code == 303 and client.get(f"/api/vouchers/{qid}").json()["status"] == "CONVERTED"

    # cancel
    client.post(f"/app/billing/{vid}/cancel")
    assert client.get(f"/api/vouchers/{vid}").json()["status"] == "CANCELLED"

    # print pages, owner session
    p = client.get(f"/print/voucher/{vid}")
    assert p.status_code == 200 and "CANCELLED" in p.text and "Rupees" in p.text
    assert client.get(f"/print/voucher/{vid}?format=t58").status_code == 200


def test_public_share_link_and_bad_token(client):
    g, item, party = world(client)
    vid = client.post("/app/billing/new", data=form(g, item, party), follow_redirects=False).headers["location"].rsplit("/", 1)[1]
    tok = client.get(f"/api/vouchers/{vid}").json()["shareToken"]
    anon = TestClient(create_app())
    ok = anon.get(f"/print/voucher/{vid}?t={tok}")
    assert ok.status_code == 200 and "TAX INVOICE" in ok.text and "Cost" not in ok.text
    assert anon.get(f"/print/voucher/{vid}?t=wrong").status_code == 404
    assert anon.get(f"/print/voucher/{vid}", follow_redirects=False).status_code == 303


def test_reports_page_and_csv(client):
    g, item, party = world(client)
    client.post("/app/billing/new", data=form(g, item, party))
    r = client.get("/app/billing/reports")
    assert r.status_code == 200 and "By GST rate" in r.text and "Profit by item" in r.text
    csv = client.get("/app/billing/reports?format=csv")
    assert csv.headers["content-type"].startswith("text/csv") and "INV-0001" in csv.text
