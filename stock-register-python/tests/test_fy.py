"""Financial years (April-March) and old-year records."""
from datetime import date

from app.core.fy import current_fy, fy_label, fy_of, fy_options, fy_range, parse_fy
from tests.conftest import signup
from tests.test_serials import imei

CUR = current_fy()
OLD_DATE = f"{CUR - 1}-09-15"  # always before the current financial year
OLD_FY = CUR - 1


def test_fy_helpers():
    assert fy_of(date(2026, 3, 31)) == 2025 and fy_of(date(2026, 4, 1)) == 2026 and fy_of(date(2026, 12, 31)) == 2026
    assert fy_label(2025) == "2025-26" and fy_label(1999) == "1999-00" and fy_label(2099) == "2099-00"
    assert fy_range(2025) == ("2025-04-01", "2026-03-31")
    assert parse_fy("2024", today=date(2026, 11, 20)) == 2024 and parse_fy("junk", today=date(2026, 11, 20)) == 2026
    assert parse_fy("2099", today=date(2026, 11, 20)) == 2026  # not the future
    opts = fy_options(2026, today=date(2026, 11, 20))
    assert opts[0] == {"year": 2026, "label": "2026-27", "current": True} and len(opts) == 7


def world(c):
    signup(c)
    c.put("/api/settings", json={"state": "Tamil Nadu", "businessName": "Test Traders"})
    g = c.get("/api/workspace").json()["godowns"][0]["id"]
    c.post("/api/items", json={"name": "Rice", "sku": "R1", "unit": "Bag", "purchasePrice": 1500, "salePrice": 1800,
                               "minStockAlert": 0, "gstRate": 5, "openingQty": 20, "openingGodownId": g})
    item = c.get("/api/workspace").json()["items"][0]
    party = c.post("/api/parties", json={"name": "Sharma", "state": "Tamil Nadu"}).json()["id"]
    return g, item, party


def bill(g, item, party, kind="SALE", date=OLD_DATE, qty=5, **over):
    d = {"kind": kind, "date": date, "partyId": party, "godownId": g, "gstEnabled": True,
         "lines": [{"itemId": item["id"], "qty": qty, "rate": 1800, "taxRate": 5}]}
    return {**d, **over}


def stock(c, item_id, g):
    return [i for i in c.get("/api/workspace").json()["items"] if i["id"] == item_id][0]["stock"][g]


def test_old_year_bill_changes_nothing_physical_but_is_reported(client):
    g, item, party = world(client)
    before = client.get("/api/parties").json()["parties"][0]
    ledger_before = len(client.get("/api/ledger").json())
    r = client.post("/api/vouchers", json=bill(g, item, party, history=True, oldNumber="OLD-45",
                                               paymentSplit=[{"mode": "UPI", "amount": 4000}, {"mode": "CASH", "amount": 5450}]))
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["history"] is True and v["number"] == "OLD-45" and v["total"] == 9450 and v["paid"] == 9450
    assert stock(client, item["id"], g) == 20  # nothing left the godown
    assert len(client.get("/api/ledger").json()) == ledger_before
    assert client.get("/api/parties").json()["parties"][0] == before  # the customer owes nothing more
    rep = client.get(f"/api/reports/sales?from={CUR - 1}-04-01&to={CUR}-03-31").json()
    assert [x["number"] for x in rep["register"]] == ["OLD-45"] and rep["totals"]["total"] == 9450
    # and it doesn't disturb the live number series or today's figures
    new = client.post("/api/vouchers", json=bill(g, item, party, date=date.today().isoformat(), qty=1)).json()
    assert new["number"].endswith("-0001") and stock(client, item["id"], g) == 19


def test_old_year_rules(client):
    g, item, party = world(client)
    ok = lambda **kw: client.post("/api/vouchers", json=bill(g, item, party, history=True, **kw))  # noqa: E731
    r = ok(date=date.today().isoformat(), oldNumber="X-1")
    assert r.status_code == 400 and "before the current financial year" in r.json()["error"]
    r = ok(oldNumber="")
    assert r.status_code == 400 and "old invoice number" in r.json()["error"]
    assert ok(oldNumber="OLD-1").status_code == 201
    r = ok(oldNumber="OLD-1")
    assert r.status_code == 400 and "already exists" in r.json()["error"]
    r = client.post("/api/vouchers", json=bill(g, item, party, kind="QUOTATION", history=True, oldNumber="Q-1"))
    assert r.status_code == 400 and "Only sales and purchase" in r.json()["error"]
    # purchases and returns are fine
    assert client.post("/api/vouchers", json=bill(g, item, party, kind="PURCHASE", history=True, oldNumber="P-9")).status_code == 201
    assert stock(client, item["id"], g) == 20


def test_old_year_phones_need_no_imei_and_leave_the_register_alone(client):
    from tests.test_serials import world as serial_world, bill as sbill

    hq, shop, item, sup, cust = serial_world(client)
    assert client.post("/api/vouchers", json=sbill(hq, item, sup, "PURCHASE", [imei(1)])).status_code == 201
    r = client.post("/api/vouchers", json={"kind": "SALE", "date": OLD_DATE, "partyId": cust, "godownId": hq, "gstEnabled": True,
                                           "history": True, "oldNumber": "OLD-7",
                                           "lines": [{"itemId": item["id"], "qty": 3, "rate": 9999, "taxRate": 18}]})
    assert r.status_code == 201, r.text
    avail = client.get(f"/app/serial-lookup/available?item={item['id']}&godown={hq}").json()
    assert [u["imei"] for u in avail] == [imei(1)]  # the real phone is still in stock


def test_edit_and_cancel_old_year_bill(client):
    g, item, party = world(client)
    v = client.post("/api/vouchers", json=bill(g, item, party, history=True, oldNumber="OLD-3")).json()
    e = client.put(f"/api/vouchers/{v['id']}", json=bill(g, item, party, qty=2))  # the edit form re-sends no flag
    assert e.status_code == 200 and e.json()["history"] is True and e.json()["number"] == "OLD-3" and e.json()["total"] == 3780
    assert stock(client, item["id"], g) == 20
    assert client.post(f"/api/vouchers/{v['id']}/cancel").json()["status"] == "CANCELLED"
    assert stock(client, item["id"], g) == 20
    # a normal bill can't be turned into a history record
    n = client.post("/api/vouchers", json=bill(g, item, party, date=date.today().isoformat(), qty=1)).json()
    r = client.put(f"/api/vouchers/{n['id']}", json=bill(g, item, party, date=OLD_DATE, qty=1, history=True, oldNumber="Z"))
    assert r.status_code == 400 and "can't be turned" in r.json()["error"]


def test_year_switch_filters_lists_and_reports(client):
    g, item, party = world(client)
    client.post("/api/vouchers", json=bill(g, item, party, history=True, oldNumber="OLD-45"))
    client.post("/api/vouchers", json=bill(g, item, party, date=date.today().isoformat(), qty=1))
    page = client.get("/app/billing/sales").text
    assert "OLD-45" not in page and "INV-0001" in page and f"FY {CUR}-" in page
    assert 'name="fy"' in page and f"FY {fy_label(CUR)} (current)" in page  # switcher next to the profile

    r = client.post("/app/fy", data={"fy": str(OLD_FY), "next": "/app/billing/sales"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/app/billing/sales" and f"sr_fy={OLD_FY}" in r.headers["set-cookie"]
    old = client.get("/app/billing/sales").text
    assert "OLD-45" in old and "INV-0001" not in old and "Old year" in old
    assert "OLD-45" in client.get("/app/billing/sales?q=OLD").text and "INV-0001" in client.get("/app/billing/sales?q=INV").text  # search spans years
    assert "9,450" in client.get("/app/billing/reports").text and f"FY {fy_label(OLD_FY)}" in client.get("/app/billing/reports").text
    detail = client.get("/app/billing/" + client.get("/api/vouchers?q=OLD-45").json()[0]["id"]).text
    assert "Old year" in detail and "did not change stock" in detail

    form = client.get("/app/billing/new?kind=SALE").text  # an old year opens the form as an old-year record
    assert f'value="{OLD_FY + 1}-03-31"' in form and 'id="hist"' in form and "checked" in form.split('id="hist"')[1][:120]
    client.post("/app/fy", data={"fy": str(CUR), "next": "/app"})
    cur_form = client.get("/app/billing/new?kind=SALE").text
    assert date.today().isoformat() in cur_form and "checked" not in cur_form.split('id="hist"')[1][:120]


def test_fy_redirect_is_safe_and_junk_year_falls_back(client):
    signup(client)
    for bad in ("//evil.example.com", "https://evil.example.com", "/login", "/app\\evil"):
        r = client.post("/app/fy", data={"fy": "2025", "next": bad}, follow_redirects=False)
        assert r.headers["location"] == "/app"  # anything that isn't an in-app path goes to the dashboard
    r = client.post("/app/fy", data={"fy": "abc", "next": "/app"}, follow_redirects=False)
    assert f"sr_fy={CUR}" in r.headers["set-cookie"]


def test_web_form_creates_an_old_year_record(client):
    g, item, party = world(client)
    form = {"kind": "SALE", "date": OLD_DATE, "godownId": g, "partyId": party, "gstEnabled": "1", "itemId": item["id"], "qty": "2",
            "rate": "1800", "discountPct": "0", "taxRate": "5", "description": "", "history": "1", "oldNumber": "OLD-77",
            "payMode": ["CASH"], "payAmount": ["3780"], "payFinance": [""]}
    r = client.post("/app/billing/new", data=form, follow_redirects=False)
    assert r.status_code == 303, r.text
    v = client.get("/api/vouchers?q=OLD-77").json()[0]
    assert v["history"] is True and v["paid"] == 3780 and stock(client, item["id"], g) == 20


def test_dashboard_follows_the_financial_year(client):
    g, item, party = world(client)
    client.post("/api/vouchers", json=bill(g, item, party, history=True, oldNumber="OLD-45"))  # 9,450 in the old year
    client.post("/api/vouchers", json=bill(g, item, party, date=date.today().isoformat(), qty=1))  # 1,890 this year
    cur = client.get("/app").text
    assert f"FY {fy_label(CUR)}" in cur and "1,890" in cur and "9,450" not in cur
    client.post("/app/fy", data={"fy": str(OLD_FY), "next": "/app"})
    old = client.get("/app").text
    assert f"FY {fy_label(OLD_FY)}" in old and "9,450" in old and "1,890" not in old
    assert f"Sep {str(OLD_FY)[2:]}" in old  # the month the old bill is dated in, on the monthly chart
    assert "Stock right now" in old  # stock figures are today's, whatever year is selected
