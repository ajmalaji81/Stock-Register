"""Display > day book, ledger, summaries, receivables, ageing and bill-wise outstanding."""
from sqlalchemy import select

from app.db import session_scope
from app.models import Account, AccountEntry, AccountVoucher, User
from app.services.display_books import Bill, Settlement, allocate, bucket_of_age
from tests.conftest import signup

ALL = "frm=2000-01-01&to=2100-12-31"


# ---------------------------------------------------------------- pure FIFO allocation


def _bills(*amounts, start=1):
    return [Bill(key=f"b{i}", date=f"2026-0{i}-10", ref=f"B{i}", amount=a, seq=i) for i, a in enumerate(amounts, start)]


def test_allocate_partial_payment_settles_oldest_first():
    bills, extra = allocate(_bills(100, 200), [Settlement(150)])
    assert [(b.settled, b.outstanding) for b in bills] == [(100, 0), (50, 150)] and extra == 0


def test_allocate_with_bill_payment_settles_its_own_bill_first():
    bills, extra = allocate(_bills(100, 200), [Settlement(200, bill_key="b2"), Settlement(50)])
    assert [b.outstanding for b in bills] == [50, 0] and extra == 0  # b2 took its own 200, the other 50 went to the oldest bill


def test_allocate_excess_of_a_with_bill_payment_joins_the_pool():
    bills, extra = allocate(_bills(100, 200), [Settlement(300, bill_key="b2")])
    assert [b.outstanding for b in bills] == [0, 0] and extra == 0


def test_allocate_opening_balance_is_the_oldest_bill_and_leftover_is_an_advance():
    opening = Bill(key="OPENING", date="", ref="Opening balance", amount=100, seq=-1)
    bills, extra = allocate([*_bills(200), opening], [Settlement(130)])
    assert [(b.ref, b.outstanding) for b in bills] == [("Opening balance", 0), ("B1", 170)] and extra == 0
    bills, extra = allocate(_bills(100), [Settlement(250)])
    assert bills[0].outstanding == 0 and extra == 150


def test_ageing_buckets():
    assert [bucket_of_age(a) for a in (0, 30, 31, 60, 61, 90, 91, 400, None)] == ["b0", "b0", "b1", "b1", "b2", "b2", "b3", "b3", "b3"]


# ---------------------------------------------------------------- the pages


def _uid():
    with session_scope() as db:
        return db.execute(select(User.id)).scalar_one()


def _world(c):
    """Opening 500; sale S1 (Apr 10) 1890; sale S2 (Jun 10) 1890 with 400 taken at billing; receipt 1000 (Jul 1); credit note 100 (Jul 5)."""
    signup(c)
    c.put("/api/settings", json={"state": "Tamil Nadu", "businessName": "Test Traders"})
    g = c.get("/api/workspace").json()["godowns"][0]["id"]
    c.post("/api/items", json={"name": "Rice", "sku": "R1", "unit": "Bag", "purchasePrice": 1500, "salePrice": 1800,
                               "minStockAlert": 0, "gstRate": 5, "openingQty": 50, "openingGodownId": g})
    item = c.get("/api/workspace").json()["items"][0]
    party = c.post("/api/parties", json={"name": "Sharma", "type": "CUSTOMER", "state": "Tamil Nadu", "openingBalance": 500}).json()["id"]

    def bill(kind="SALE", date="2026-04-10", party_id=party, **over):
        body = {"kind": kind, "date": date, "partyId": party_id, "godownId": g, "gstEnabled": True,
                "lines": [{"itemId": item["id"], "qty": 1, "rate": 1800, "taxRate": 5}], **over}
        r = c.post("/api/vouchers", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    s1 = bill()
    s2 = bill(date="2026-06-10", paymentSplit=[{"mode": "CASH", "amount": 400}])
    assert c.post("/api/payments", json={"partyId": party, "direction": "IN", "amount": 1000, "mode": "UPI", "date": "2026-07-01"}).status_code == 201
    with session_scope() as db:
        db.add(AccountVoucher(userId=_uid(), kind="CREDIT_NOTE", number="CN-0001", date="2026-07-05", partyId=party, amount=100, narration="Rate difference"))
    return {"g": g, "item": item, "party": party, "s1": s1, "s2": s2, "bill": bill}


def test_pages_need_login_and_load(client):
    assert client.get("/app/display/day-book", follow_redirects=False).headers["location"] == "/login"
    _world(client)
    for path in ("day-book", "ledger", "transaction-summary", "monthly-summary", "receivables", "ageing", "bill-outstanding"):
        assert client.get(f"/app/display/{path}").status_code == 200, path


def test_day_book_lists_every_kind_of_entry_with_day_totals(client):
    w = _world(client)
    client.post("/api/expenses", json={"category": "Rent", "amount": 250, "mode": "CASH", "date": "2026-06-10"})
    with session_scope() as db:
        db.add(AccountVoucher(userId=_uid(), kind="JOURNAL", number="JV-0001", date="2026-06-10", amount=75, narration="Adjust"))
        db.add(AccountVoucher(userId=_uid(), kind="DEBIT_NOTE", number="DN-0001", date="2026-06-10", amount=20, partyId=w["party"], status="CANCELLED"))
    page = client.get(f"/app/display/day-book?{ALL}").text
    for text in (w["s1"]["number"], w["s2"]["number"], "Receipt", "Expense", "Journal", "Credit note", "CN-0001", "JV-0001"):
        assert text in page, text
    assert "DN-0001" not in page  # cancelled entries are left out
    # 10 Jun: sale 1890 Dr + expense 250 Dr + receipt of the 400 taken with the bill (Cr)
    assert "Dr <b>₹2,140</b> · Cr <b>₹400</b>" in page
    only = client.get(f"/app/display/day-book?{ALL}&type=EXPENSE").text
    assert "Rent" in only and w["s1"]["number"] not in only
    csv = client.get(f"/app/display/day-book?{ALL}&format=csv")
    assert csv.headers["content-type"].startswith("text/csv") and csv.text.splitlines()[0] == "Date,Type,Number / ref,Party / account,Amount,Dr/Cr,By"
    assert "Rent" in csv.text


def test_party_ledger_matches_the_parties_page_and_account_ledger_runs(client):
    w = _world(client)
    assert client.get(f"/api/parties/{w['party']}").json()["balance"] == 2780
    page = client.get(f"/app/display/ledger?kind=party&id={w['party']}&{ALL}").text
    assert "Sharma" in page and "₹2,780 Dr" in page and "Credit note #CN-0001" in page
    with session_scope() as db:
        uid = _uid()
        led = Account(userId=uid, name="Test Ledger", type="ASSET", depth=2, openingBalance=100, isGroup=False)
        grp = Account(userId=uid, name="Test Group", type="ASSET", depth=1, isGroup=True)
        db.add_all([led, grp])
        db.flush()
        for n, d, dr, cr in (("JV-1", "2026-05-01", 300, 0), ("JV-2", "2026-08-01", 0, 150)):
            v = AccountVoucher(userId=uid, kind="JOURNAL", number=n, date=d, amount=max(dr, cr))
            v.entries = [AccountEntry(accountId=led.id, debit=dr, credit=cr)]
            db.add(v)
        cancelled = AccountVoucher(userId=uid, kind="JOURNAL", number="JV-3", date="2026-09-01", amount=999, status="CANCELLED")
        cancelled.entries = [AccountEntry(accountId=led.id, debit=999, credit=0)]
        db.add(cancelled)
        led_id, grp_id = led.id, grp.id
    page = client.get(f"/app/display/ledger?kind=account&id={led_id}&{ALL}").text
    assert "Opening balance" in page and "₹400 Dr" in page and "₹250 Dr" in page and "JV-3" not in page  # 100 + 300, then - 150
    after = client.get(f"/app/display/ledger?kind=account&id={led_id}&frm=2026-07-01&to=2100-01-01").text
    assert "Balance b/f" in after and "₹400 Dr" in after and "₹250 Dr" in after and "JV-1" not in after
    picker = client.get("/app/display/ledger").text
    assert "Test Ledger" in picker and "Test Group" not in picker and "Sharma" in picker  # groups are not ledgers
    assert "Account not found" in client.get(f"/app/display/ledger?kind=account&id=nope&{ALL}").text
    assert client.get(f"/app/display/ledger?kind=party&id={w['party']}&{ALL}&format=csv").text.startswith("Date,Particulars,Debit,Credit,Balance,Dr/Cr")


def test_summaries_add_up(client):
    w = _world(client)
    client.post("/api/expenses", json={"category": "Rent", "amount": 250, "mode": "CASH", "date": "2026-06-20"})
    w["bill"](kind="SALE_RETURN", date="2026-06-25")  # 1890 back
    page = client.get(f"/app/display/transaction-summary?{ALL}").text
    assert "₹3,780" in page  # sales
    assert "Net sales" in page and "₹1,890" in page  # 3780 - 1890
    # receipts: the 400 taken with the bill + 1000
    assert "₹1,400" in page and "₹250" in page and "₹100" in page
    csv = client.get(f"/app/display/transaction-summary?{ALL}&format=csv").text.splitlines()
    assert csv[0] == "Type,Count,Amount" and "Sales,2,3780" in csv and "Receipts,2,1400" in csv

    m = client.get("/app/display/monthly-summary?frm=2026-04-01&to=2027-03-31").text
    assert m.index("Apr 2026") < m.index("Jun 2026") < m.index("Mar 2027")
    rows = client.get("/app/display/monthly-summary?frm=2026-04-01&to=2027-03-31&format=csv").text.splitlines()
    by = {r.split(",")[0]: r.split(",") for r in rows}
    assert by["Apr 2026"][1] == "1890" and by["Jun 2026"][1] == "1890" and by["Jun 2026"][2] == "1890"
    assert by["Jun 2026"][7] == "250" and by["Jul 2026"][5] == "1000"
    assert by["Total"][1] == "3780" and by["Total"][8] == str(3780 - 1890 - 250)  # net = net sales - net purchases - expenses
    assert len(rows) == 1 + 12 + 1


def test_receivables_match_the_parties_page(client):
    w = _world(client)
    supplier = client.post("/api/parties", json={"name": "Gupta Traders", "type": "SUPPLIER", "openingBalance": -700}).json()["id"]
    page = client.get("/app/display/receivables").text
    assert "Sharma" in page and "₹2,780" in page and "Gupta Traders" in page and "₹700" in page
    assert client.get(f"/api/parties/{supplier}").json()["balance"] == -700
    csv = client.get("/app/display/receivables?format=csv").text
    assert "To receive,Sharma,,2780" in csv and "To pay,Gupta Traders,,700" in csv


def test_bill_outstanding_fifo_with_opening_with_bill_payment_and_credit_note(client):
    w = _world(client)
    page = client.get("/app/display/bill-outstanding?as_on=2026-12-31").text
    # 400 settles S2 first; pool = receipt 1000 + credit note 100 -> opening 500, then S1 600
    assert "Opening balance" not in page  # fully settled, so no longer outstanding
    s1, s2 = w["s1"]["number"], w["s2"]["number"]
    assert s1 in page and s2 in page and "₹1,290" in page and "₹1,490" in page and "₹2,780" in page
    csv = client.get("/app/display/bill-outstanding?as_on=2026-12-31&format=csv").text.splitlines()
    rows = {r.split(",")[1]: r.split(",") for r in csv[1:]}
    assert rows[s1][4:] == ["1890", "600", "1290"] and rows[s2][4:] == ["1890", "400", "1490"]
    assert rows[s1][3] == str((__import__("datetime").date(2026, 12, 31) - __import__("datetime").date(2026, 4, 10)).days)
    # the bills add up to the party balance
    assert 1290 + 1490 == client.get(f"/api/parties/{w['party']}").json()["balance"]
    # payables: a supplier bill part-paid
    sup = client.post("/api/parties", json={"name": "Gupta", "type": "SUPPLIER"}).json()["id"]
    w["bill"](kind="PURCHASE", date="2026-05-01", party_id=sup)
    client.post("/api/payments", json={"partyId": sup, "direction": "OUT", "amount": 500, "mode": "CASH", "date": "2026-05-05"})
    pay = client.get("/app/display/bill-outstanding?side=payable&as_on=2026-12-31").text
    assert "Gupta" in pay and "₹1,390" in pay
    assert "Sharma" not in pay  # a customer owes us; nothing payable


def test_ageing_buckets_page(client):
    w = _world(client)
    page = client.get("/app/display/ageing?as_on=2026-07-31").text
    # S1 (Apr 10) is 112 days old -> over 90; S2 (Jun 10) is 51 days old -> 31-60; opening is settled
    assert "₹1,290" in page and "₹1,490" in page and "₹2,780" in page
    rows = client.get("/app/display/ageing?as_on=2026-07-31&format=csv").text.splitlines()
    assert rows[0].startswith("Party,0-30 days,31-60 days,61-90 days,Over 90 days,Total")
    sharma = rows[1].split(",")
    assert sharma[0] == "Sharma" and sharma[1:6] == ["0", "1490", "0", "1290", "2780"]
    # as on a date before the receipt and credit note, the opening balance (undated) and S1 are older money
    early = client.get("/app/display/ageing?as_on=2026-06-30&format=csv").text.splitlines()[1].split(",")
    assert early[0] == "Sharma" and early[1:6] == ["1490", "0", "1890", "500", "3880"]  # S2 20 days, S1 81 days, undated opening 500 in the oldest bucket
