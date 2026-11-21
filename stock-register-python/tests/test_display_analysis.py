from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.core.errors import StockError
from app.db import session_scope
from app.main import create_app
from app.models import User
from app.services import display_analysis as da
from app.services.actor import Actor
from tests.conftest import signup
from tests.test_serials import bill as serial_bill, imei, world as serial_world

TODAY = date.today().isoformat()
PAGES = ["/app/display/stock-status", "/app/display/inventory-summary", "/app/display/sales-analysis",
         "/app/display/purchase-analysis", "/app/display/serial-stock"]


def ws(c):
    return c.get("/api/workspace").json()


def voucher(c, g, item, party, kind, qty, rate, **over):
    body = {"kind": kind, "date": TODAY, "godownId": g, "partyId": party, "gstEnabled": True,
            "lines": [{"itemId": item["id"], "qty": qty, "rate": rate, "taxRate": 18}]}
    r = c.post("/api/vouchers", json={**body, **over})
    assert r.status_code == 201, r.text
    return r.json()


def trade_world(c):
    """Rice (stock 100, alert 20) in two godowns; a purchase, two sales and a return; a transfer, a stock-out and an adjustment."""
    signup(c)
    g1 = ws(c)["godowns"][0]["id"]
    c.post("/api/godowns", json={"name": "Shop B"})
    g2 = [g["id"] for g in ws(c)["godowns"] if g["id"] != g1][0]
    c.post("/api/items", json={"name": "Rice", "sku": "R1", "unit": "Bag", "category": "Grocery", "purchasePrice": 60, "salePrice": 100,
                               "minStockAlert": 20, "gstRate": 18, "openingQty": 100, "openingGodownId": g1})
    c.post("/api/items", json={"name": "Soap", "sku": "S1", "unit": "pcs", "purchasePrice": 10, "salePrice": 20, "minStockAlert": 0,
                               "gstRate": 18, "openingQty": 0, "openingGodownId": g1})
    item = [i for i in ws(c)["items"] if i["sku"] == "R1"][0]
    cust = c.post("/api/parties", json={"name": "Sharma", "type": "CUSTOMER", "state": "Tamil Nadu"}).json()["id"]
    sup = c.post("/api/parties", json={"name": "Gupta", "type": "SUPPLIER", "state": "Tamil Nadu"}).json()["id"]
    voucher(c, g1, item, sup, "PURCHASE", 20, 60)
    voucher(c, g1, item, cust, "SALE", 5, 100)
    voucher(c, g1, item, None, "SALE", 10, 100)  # a cash sale
    voucher(c, g1, item, cust, "SALE_RETURN", 2, 100)
    assert c.post("/api/transfers", json={"itemId": item["id"], "fromGodownId": g1, "toGodownId": g2, "qty": 8, "date": TODAY}).status_code in (200, 201)
    assert c.post("/api/movements", json={"itemId": item["id"], "godownId": g1, "type": "OUT", "qty": 4, "rate": 100, "date": TODAY}).status_code in (200, 201)
    c.post("/app/adjustments", data={"itemId": item["id"], "godownId": g1, "mode": "delta", "value": "-1", "reason": "Damaged"})
    return g1, g2, item, cust, sup


def owner_actor(**over) -> Actor:
    with session_scope() as db:
        u = db.query(User).first()
        db.expunge(u)
    base = dict(account_id=u.id, owner=u, actor_id=u.id, name=u.name, email=u.email, avatar=None, role="OWNER", is_owner=True, godown_ids=None)
    return Actor(**{**base, **over})


def total_stock(c, sku="R1"):
    return sum([i for i in ws(c)["items"] if i["sku"] == sku][0]["stock"].values())


def test_all_pages_render(client):
    trade_world(client)
    for p in PAGES:
        assert client.get(p).status_code == 200, p
    for by in ("item", "party", "month", "group", "nonsense"):
        assert client.get(f"/app/display/sales-analysis?by={by}").status_code == 200
        assert client.get(f"/app/display/purchase-analysis?by={by}").status_code == 200
    assert 'data-nav="stock_status"' in client.get("/app/display/stock-status").text


def test_stock_status_groups_low_and_godown(client):
    g1, g2, item, *_ = trade_world(client)
    page = client.get("/app/display/stock-status").text
    assert "Grocery" in page and "Ungrouped" in page and "Rice" in page and "Soap" in page
    # 100 + 20 - 5 - 10 + 2 - 4 - 1 = 102 in total, so Rice is OK; Soap has no stock
    assert total_stock(client) == 102 and "Out of stock" in page
    assert "Rice" not in client.get("/app/display/stock-status?low=1").text and "Soap" in client.get("/app/display/stock-status?low=1").text
    only_g2 = client.get(f"/app/display/stock-status?godown={g2}").text
    assert "Rice" in only_g2 and "8 Bag" in only_g2 and "102 Bag" not in only_g2
    assert "Rice" in client.get("/app/display/stock-status?q=gro").text and "Soap" not in client.get("/app/display/stock-status?q=gro").text
    d = _service(lambda db, a: da.stock_status(db, a))
    rice = [r for g in d["groups"] for r in g["rows"] if r["name"] == "Rice"][0]
    assert rice["qty"] == 102 and rice["value"] == 102 * 60 and d["value"] == 102 * 60


def _service(fn, **actor_over):
    a = owner_actor(**actor_over)
    with session_scope() as db:
        return fn(db, a)


def test_inventory_summary_reconciles_with_stock(client):
    g1, g2, item, *_ = trade_world(client)
    d = _service(lambda db, a: da.inventory_summary(db, a, "2000-01-01", TODAY))
    rice = [r for r in d["rows"] if r["name"] == "Rice"][0]
    assert rice["closing"] == total_stock(client) == 102
    assert (rice["opening"], rice["inward"], rice["outward"], rice["adj"]) == (0, 100 + 20 + 2, 5 + 10 + 4, -1)
    assert rice["tin"] == rice["tout"] == 8  # a transfer nets to zero over all godowns
    assert d["totals"]["value"] == 102 * 60
    # one godown: transfers no longer cancel, and closing equals that godown's stock
    only2 = _service(lambda db, a: da.inventory_summary(db, a, "2000-01-01", TODAY, g2))
    r2_ = [r for r in only2["rows"] if r["name"] == "Rice"][0]
    assert (r2_["tin"], r2_["tout"], r2_["closing"]) == (8, 0, 8)
    # a later period folds earlier movement into the opening balance
    nxt = _service(lambda db, a: da.inventory_summary(db, a, "2999-01-01", "2999-12-31"))
    assert [r for r in nxt["rows"] if r["name"] == "Rice"][0]["opening"] == 102
    # the page renders with its date defaults and the filters
    page = client.get(f"/app/display/inventory-summary?from=2000-01-01&to={TODAY}").text
    assert "Rice" in page and "102" in page
    assert "Soap" not in client.get(f"/app/display/inventory-summary?from=2000-01-01&to={TODAY}&q=rice").text


@pytest.mark.parametrize("by", ["item", "party", "month", "group"])
def test_sales_analysis_nets_returns_and_matches_the_bills(client, by):
    trade_world(client)
    d = _service(lambda db, a: da.trade_analysis(db, a, "sale", by, "2000-01-01", TODAY))
    # 5 + 10 sold, 2 returned, all at 100 + 18%
    assert d["totals"]["qty"] == 13 and d["totals"]["taxable"] == 1300 and d["totals"]["tax"] == 234
    assert d["totals"]["gross"] == 1770 and d["totals"]["returns"] == 236 and d["totals"]["net"] == 1534
    assert d["bills"] == 3 and round(d["totals"]["net"] + d["roundOff"], 2) == d["billTotal"] == 1534
    # cost 13 x 60 -> profit 1300 - 780
    assert d["totals"]["cost"] == 780 and d["totals"]["profit"] == 520 and d["totals"]["margin"] == 40.0
    labels = {r["label"] for r in d["rows"]}
    expect = {"item": {"Rice"}, "party": {"Sharma", "Cash sale"}, "month": {TODAY[:7]}, "group": {"Grocery"}}[by]
    assert labels == expect
    assert round(sum(r["share"] for r in d["rows"])) == 100 and d["bars"]


def test_purchase_analysis_and_cost_hiding(client):
    trade_world(client)
    d = _service(lambda db, a: da.trade_analysis(db, a, "purchase", "party", "2000-01-01", TODAY))
    assert d["rows"][0]["label"] == "Gupta" and d["totals"]["net"] == 1416 and d["billTotal"] == 1416 and "cost" not in d["totals"]
    # a role that can see reports but not costs: no cost / profit on sales, and no purchase analysis at all
    can = lambda p: p in {"reports.view", "stock.move", "sales.create"}  # noqa: E731
    s = _service(lambda db, a: da.trade_analysis(db, a, "sale", "item", "2000-01-01", TODAY), _can=can, is_owner=False, role="X")
    assert "cost" not in s["totals"] and "profit" not in s["rows"][0] and s["costs"] is False
    with pytest.raises(StockError):
        _service(lambda db, a: da.trade_analysis(db, a, "purchase", "item", "", ""), _can=can, is_owner=False, role="X")
    st = _service(lambda db, a: da.stock_status(db, a), _can=can, is_owner=False, role="X")
    assert st["value"] is None and st["groups"][0]["rows"][0]["value"] is None
    inv = _service(lambda db, a: da.inventory_summary(db, a, "2000-01-01", TODAY), _can=can, is_owner=False, role="X")
    assert inv["totals"]["value"] is None


def test_csv_downloads(client):
    trade_world(client)
    for p in PAGES:
        r = client.get(p + "?format=csv")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv"), p
    assert client.get("/app/display/stock-status?format=csv").text.splitlines()[0].startswith("Group,Item")
    assert client.get("/app/display/sales-analysis?format=csv").text.splitlines()[0].startswith("Item,Bills")
    assert "Net bill total" in client.get("/app/display/sales-analysis?format=csv").text
    assert "Download Excel" in client.get("/app/display/inventory-summary").text


def staff_client(owner, role, godowns):
    owner.post("/api/staff", json={"name": "Staff", "email": "s@example.com", "password": "password123", "role": role, "godownIds": godowns})
    s = TestClient(create_app())
    assert s.post("/api/auth/login", json={"email": "s@example.com", "password": "password123"}).status_code == 200
    return s


def test_staff_godown_restriction_and_role_gate(client):
    g1, g2, item, *_ = trade_world(client)
    s = staff_client(client, "SALES_PURCHASE", [g2])
    page = s.get("/app/display/stock-status").text
    assert "Rice" in page and "Shop B" in page and "Main Shop" not in page
    assert s.get(f"/app/display/stock-status?godown={g1}").status_code == 403
    assert s.get(f"/app/display/inventory-summary?from=2000-01-01&to={TODAY}&godown={g1}").status_code == 403
    inv = s.get(f"/app/display/inventory-summary?from=2000-01-01&to={TODAY}").text
    assert "<b>8</b>" in inv  # only the 8 bags that reached Shop B
    sales = s.get("/app/display/sales-analysis")
    assert sales.status_code == 200 and "Sharma" not in s.get("/app/display/sales-analysis?by=party").text  # the bills were at Main Shop
    assert s.get(f"/app/display/sales-analysis?godown={g1}").status_code == 403
    # a sales clerk may not open the stock and analysis reports, but may look up IMEIs
    client.post("/api/staff", json={"name": "Clerk", "email": "c@example.com", "password": "password123", "role": "SALES"})
    c = TestClient(create_app())
    c.post("/api/auth/login", json={"email": "c@example.com", "password": "password123"})
    for p in ("/app/display/stock-status", "/app/display/inventory-summary", "/app/display/sales-analysis", "/app/display/purchase-analysis"):
        assert c.get(p).status_code == 403, p
    assert c.get("/app/display/serial-stock").status_code == 200
    assert 'href="/app/display/stock-status"' not in c.get("/app").text  # hidden from their sidebar


def test_serial_stock_counts_imeis_per_item_and_godown(client):
    hq, shop, item, sup, cust = serial_world(client)
    a, b, c3 = imei(1), imei(2), imei(3)
    assert client.post("/api/vouchers", json=serial_bill(hq, item, sup, "PURCHASE", [a, b, c3])).status_code == 201
    assert client.post("/api/transfers", json={"itemId": item["id"], "fromGodownId": hq, "toGodownId": shop, "qty": 1,
                                               "date": "2026-11-17", "serials": [b]}).status_code in (200, 201)
    assert client.post("/api/vouchers", json=serial_bill(hq, item, cust, "SALE", [a])).status_code == 201
    d = _service(lambda db, a_: da.serial_stock(db, a_))
    by_g = {r["godown"]: r for r in d["rows"]}
    assert (by_g["Main Shop"]["inStock"], by_g["Main Shop"]["sold"], by_g["Main Shop"]["total"]) == (1, 1, 2)
    assert (by_g["Madurai shop"]["inStock"], by_g["Madurai shop"]["sold"]) == (1, 0)
    assert d["totals"]["inStock"] == 2 and d["totals"]["sold"] == 1 and d["mismatches"] == []
    assert all(not r["mismatch"] for r in d["rows"])
    page = client.get("/app/display/serial-stock").text
    assert "Redmi 13C" in page and "IMEI wise stock" in page
    listing = client.get(f"/app/display/serial-stock?item={item['id']}&godown={shop}").text
    assert f'href="/app/serials/{b}"' in listing and f'href="/app/serials/{c3}"' not in listing
    assert f'href="/app/serials/{a}"' not in client.get(f"/app/display/serial-stock?item={item['id']}").text  # sold, not in stock
    assert f'href="/app/serials/{c3}"' in client.get(f"/app/display/serial-stock?item={item['id']}&q={c3[-4:]}").text
    csv = client.get(f"/app/display/serial-stock?item={item['id']}&format=csv").text
    assert csv.splitlines()[0].startswith("Item,Godown") and b in csv
    # a manual count change makes the stock and IMEI counts disagree, and the page says so
    client.post("/app/adjustments", data={"itemId": item["id"], "godownId": hq, "mode": "delta", "value": "1", "reason": "Oops"})
    assert "Stock and IMEI counts differ" in client.get("/app/display/serial-stock").text
