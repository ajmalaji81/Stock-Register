import html as htmllib
import re
from datetime import date

from tests.conftest import signup

TODAY = date.today().isoformat()


def _world(client, openingQty=50):
    signup(client)
    g = client.get("/api/workspace").json()["godowns"][0]["id"]
    client.post("/api/items", json={"name": "Rice", "sku": "R1", "category": "Grocery", "unit": "pcs", "purchasePrice": 100,
                                    "salePrice": 150, "minStockAlert": 0, "openingQty": openingQty, "openingGodownId": g})
    item = client.get("/api/workspace").json()["items"][0]
    supplier = client.post("/api/parties", json={"name": "Gupta", "type": "SUPPLIER"}).json()["id"]
    return g, item, supplier


def _stock(client, item_id, g):
    return next(i for i in client.get("/api/workspace").json()["items"] if i["id"] == item_id)["stock"][g]


def _active(page: str) -> str:
    return re.search(r'<a href="[^"]*" data-nav="(\w+)" class="on', page).group(1)


# ---------------- item groups ----------------


def test_item_groups_create_rename_delete(client):
    _world(client)
    page = client.get("/app/masters/item-groups").text
    assert "Grocery" in page and _active(page) == "item_groups"  # the item's category became a group
    r = client.post("/app/masters/item-groups", data={"name": "Mobiles"}, follow_redirects=True)
    assert "Mobiles" in r.text
    assert "already exists" in client.post("/app/masters/item-groups", data={"name": "mobiles"}, follow_redirects=True).text
    page = client.get("/app/masters/item-groups").text
    ids = re.findall(r'data-rename="(\w+)" data-name="([^"]+)"', page)
    by_name = {htmllib.unescape(n): i for i, n in ids}
    # renaming a group renames the category of its items
    client.post(f"/app/masters/item-groups/{by_name['Grocery']}/rename", data={"name": "Food"})
    assert client.get("/api/workspace").json()["items"][0]["category"] == "Food"
    by_name = {htmllib.unescape(n): i for i, n in re.findall(r'data-rename="(\w+)" data-name="([^"]+)"', client.get("/app/masters/item-groups").text)}
    # a group with items can't be deleted, an empty one can
    assert "Move them" in client.post(f"/app/masters/item-groups/{by_name['Food']}/delete", follow_redirects=True).text
    client.post(f"/app/masters/item-groups/{by_name['Mobiles']}/delete")
    assert 'data-name="Mobiles"' not in client.get("/app/masters/item-groups").text
    # a new category typed on the item form becomes a group, and the form suggests the groups
    client.post("/app/items/save", data={"name": "Phone", "sku": "P1", "category": "Phones", "unit": "pcs"})
    assert "Phones" in client.get("/app/masters/item-groups").text
    assert '<datalist id="item-groups">' in client.get("/app/items").text and 'value="Phones"' in client.get("/app/items").text


# ---------------- purchase quotation ----------------


def test_purchase_quotation_has_no_stock_or_balance_effect_and_converts(client):
    g, item, supplier = _world(client)
    body = {"kind": "PURCHASE_QUOTATION", "date": TODAY, "partyId": supplier, "godownId": g, "gstEnabled": True,
            "lines": [{"itemId": item["id"], "qty": 10, "rate": 100, "taxRate": 5}]}
    r = client.post("/api/vouchers", json=body)
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["number"].startswith("PQ-") and v["kind"] == "PURCHASE_QUOTATION"
    assert _stock(client, item["id"], g) == 50
    assert client.get(f"/api/parties/{supplier}").json()["balance"] == 0
    # a supplier is required (purchase side)
    assert client.post("/api/vouchers", json={**body, "partyId": None}).status_code == 400
    # convert to a purchase order, then the order to a purchase
    page = client.get(f"/app/billing/{v['id']}").text
    assert 'value="PURCHASE_ORDER"' in page and 'value="PURCHASE"' in page and _active(page) == "purchase_quotation"
    r = client.post(f"/app/billing/{v['id']}/convert", data={"to": "PURCHASE_ORDER"}, follow_redirects=True)
    assert "purchase order" in r.text.lower()
    assert _stock(client, item["id"], g) == 50
    lst = client.get("/app/billing/documents?kind=PURCHASE_QUOTATION").text
    assert "PQ-0001" in lst and "Purchase quotations" in lst and _active(lst) == "purchase_quotation"
    # straight to a purchase on a fresh quotation: now stock comes in and the supplier is owed
    v2 = client.post("/api/vouchers", json=body).json()
    client.post(f"/app/billing/{v2['id']}/convert", data={"to": "PURCHASE"})
    assert _stock(client, item["id"], g) == 60
    assert client.get(f"/api/parties/{supplier}").json()["balance"] < 0
    # the quotation form asks for a supplier
    assert "Supplier" in client.get("/app/billing/new?kind=PURCHASE_QUOTATION").text


# ---------------- kind-specific lists ----------------


def test_each_kind_list_lights_its_own_menu_row_and_shows_only_that_kind(client):
    g, item, supplier = _world(client)
    base = {"date": TODAY, "partyId": supplier, "godownId": g, "gstEnabled": True, "lines": [{"itemId": item["id"], "qty": 1, "rate": 100, "taxRate": 5}]}
    client.post("/api/vouchers", json={**base, "kind": "PURCHASE"})
    client.post("/api/vouchers", json={**base, "kind": "PURCHASE_RETURN"})
    expect = {
        "/app/billing/purchases?kind=PURCHASE": ("purchases", "PB-0001", "PR-0001"),
        "/app/billing/purchases?kind=PURCHASE_RETURN": ("purchase_return", "PR-0001", "PB-0001"),
    }
    for url, (key, has, hasnt) in expect.items():
        page = client.get(url).text
        assert _active(page) == key and has in page and hasnt not in page, url
    assert "Purchase returns" in client.get("/app/billing/purchases?kind=PURCHASE_RETURN").text
    for url, key in [
        ("/app/billing/sales?kind=SALE", "sales"), ("/app/billing/sales?kind=SALE_RETURN", "sale_return"),
        ("/app/billing/documents?kind=QUOTATION", "documents"), ("/app/billing/documents?kind=SALES_ORDER", "sales_order"),
        ("/app/billing/documents?kind=PURCHASE_ORDER", "purchase_order"), ("/app/billing/documents?kind=CHALLAN", "challan"),
    ]:
        r = client.get(url)
        assert r.status_code == 200 and _active(r.text) == key, url
    # the "+ New" button of a single-kind page creates that kind
    page = client.get("/app/billing/documents?kind=SALES_ORDER").text
    main = page.split("<h1>")[1]
    assert "/app/billing/new?kind=SALES_ORDER" in main and "new?kind=CHALLAN" not in main
    assert "Sales quotation" in client.get("/app/billing/documents?kind=QUOTATION").text
    # without a kind the old behaviour stays
    assert client.get("/app/billing/purchases").status_code == 200


# ---------------- material in / out, transfers, stock journal ----------------


def test_material_in_out_and_transfer_pages(client):
    g, item, _ = _world(client)
    for path, key in (("/app/stock/material-in", "material_in"), ("/app/stock/material-out", "material_out"), ("/app/stock/transfers", "stock_transfer")):
        r = client.get(path)
        assert r.status_code == 200 and _active(r.text) == key, path
    r = client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "IN", "qty": "5", "rate": "90", "party": "Gupta", "next": "/app/stock/material-in"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/app/stock/material-in"
    assert "Gupta" in client.get("/app/stock/material-in").text and "Gupta" not in client.get("/app/stock/material-out").text
    client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "OUT", "qty": "2", "party": "Sharma", "next": "/app/stock/material-out"})
    assert "Sharma" in client.get("/app/stock/material-out").text and _stock(client, item["id"], g) == 53
    # an outside address in `next` is ignored
    r = client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "IN", "qty": "1", "next": "https://evil.example/"}, follow_redirects=False)
    assert r.headers["location"] == "/app/items"
    r = client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "IN", "qty": "1", "next": "//evil.example"}, follow_redirects=False)
    assert r.headers["location"] == "/app/items"
    # transfers
    client.post("/app/godowns", data={"name": "Godown B"})
    g2 = [x for x in client.get("/api/workspace").json()["godowns"] if x["id"] != g][0]["id"]
    r = client.post("/app/stock/transfer", data={"itemId": item["id"], "fromGodownId": g, "toGodownId": g2, "qty": "3", "remarks": "Shelf refill", "next": "/app/stock/transfers"}, follow_redirects=False)
    assert r.headers["location"] == "/app/stock/transfers"
    page = client.get("/app/stock/transfers").text
    assert "Shelf refill" in page and "Godown B" in page and page.count("Shelf refill") == 1  # one row per transfer
    # 20 per page
    for _ in range(22):
        client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "IN", "qty": "1"})
    page = client.get("/app/stock/material-in").text
    assert "Page 1 of 2" in page and client.get("/app/stock/material-in?page=2").status_code == 200
    # stock journal is the adjustments page
    adj = client.get("/app/adjustments").text
    assert "Stock journal" in adj and _active(adj) == "adjustments"
