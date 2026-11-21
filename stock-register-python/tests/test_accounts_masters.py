import re
from datetime import date

from sqlalchemy import select

from app.db import session_scope
from app.models import Account
from tests.conftest import signup

TODAY = date.today().isoformat()


def test_journal_cannot_post_to_an_account_group(client):
    signup(client)
    client.get("/app/accounts/journal/new")  # opens the default accounts
    with session_scope() as db:
        group = db.execute(select(Account.id).where(Account.isGroup.is_(True))).scalars().first()
        ledger = db.execute(select(Account.id).where(Account.isGroup.is_(False))).scalars().first()
    r = client.post("/app/accounts/journal", data={"date": TODAY, "accountId": [group, ledger], "debit": ["5", ""], "credit": ["", "5"]}, follow_redirects=True)
    assert "group" in r.text and "JV-0001" not in r.text


def test_receipts_and_payments_lists_respect_the_financial_year(client):
    signup(client)
    cust = client.post("/api/parties", json={"name": "Sharma", "type": "CUSTOMER"}).json()["id"]
    supp = client.post("/api/parties", json={"name": "Gupta", "type": "SUPPLIER"}).json()["id"]
    client.post("/app/payments", data={"partyId": cust, "direction": "IN", "amount": "500", "mode": "UPI", "date": TODAY, "reference": "UTR1"})
    client.post("/app/payments", data={"partyId": supp, "direction": "OUT", "amount": "200", "mode": "CASH", "date": TODAY})
    client.post("/app/payments", data={"partyId": cust, "direction": "IN", "amount": "77", "mode": "CASH", "date": "2019-05-05"})
    rec = client.get("/app/accounts/receipts")
    assert rec.status_code == 200 and "Sharma" in rec.text and "UTR1" in rec.text and "₹500" in rec.text
    assert "Gupta" not in rec.text and "₹77" not in rec.text  # other direction, and an older year
    assert "/app/payments/new?direction=IN" in rec.text
    assert "₹77" in client.get("/app/accounts/receipts?frm=2019-04-01&to=2020-03-31").text
    pay = client.get("/app/accounts/payments")
    assert "Gupta" in pay.text and "₹200" in pay.text and "Sharma" not in pay.text
    assert "/app/payments/new?direction=OUT" in pay.text
    # reversing from the list marks the receipt reversed
    pid = re.search(r'/app/payments/(\w+)/reverse', rec.text).group(1)
    client.post(f"/app/payments/{pid}/reverse", data={"partyId": cust})
    assert "Reversed" in client.get("/app/accounts/receipts").text
