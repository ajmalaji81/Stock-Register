from datetime import date

from tests.conftest import signup

TODAY = date.today().isoformat()


def _tree(client):
    return client.get("/app/accounts/journal/new").text


def _ids(client):
    """name -> id, read from the page's journal form options (path labels)."""
    import html as htmllib
    import re

    page = client.get("/app/accounts/journal/new").text
    out = {}
    for m in re.finditer(r'<option value="(\w+)">([^<]+)</option>', page):
        out[htmllib.unescape(m.group(2))] = m.group(1)
    return out


def _party(client, name="Sharma", opening=0):
    return client.post("/api/parties", json={"name": name, "type": "CUSTOMER", "openingBalance": opening}).json()["id"]


def test_journal_must_balance(client):
    signup(client)
    ids = _ids(client)
    cash, rent = ids["Assets › Cash in hand"], ids["Expenses › Rent"]
    bad = client.post("/app/accounts/journal", data={"date": TODAY, "narration": "x", "accountId": [rent, cash], "debit": ["100", ""], "credit": ["", "90"]}, follow_redirects=True)
    assert "must be equal" in bad.text
    one = client.post("/app/accounts/journal", data={"date": TODAY, "accountId": [rent, ""], "debit": ["100", ""], "credit": ["", ""]}, follow_redirects=True)
    assert "at least two lines" in one.text
    both = client.post("/app/accounts/journal", data={"date": TODAY, "accountId": [rent, cash], "debit": ["100", "5"], "credit": ["", "100"]}, follow_redirects=True)
    assert "either a debit or a credit" in both.text
    ok = client.post("/app/accounts/journal", data={"date": TODAY, "narration": "Shop rent", "accountId": [rent, cash], "debit": ["100", ""], "credit": ["", "100"]}, follow_redirects=True)
    assert "JV-0001" in ok.text and "Shop rent" in ok.text
    page = client.get("/app/accounts/vouchers?kind=JOURNAL").text
    assert "Dr " in page and "Cr " in page and "Cancelled" not in page
    jid = page.split("/app/accounts/vouchers/")[1].split("/")[0]
    client.post(f"/app/accounts/vouchers/{jid}/cancel", data={"kind": "JOURNAL"})
    assert "Cancelled" in client.get("/app/accounts/vouchers?kind=JOURNAL").text
    # an account that was never used by another business's id is refused
    assert "Account not found" in client.post("/app/accounts/journal", data={"date": TODAY, "accountId": ["nope", cash], "debit": ["5", ""], "credit": ["", "5"]}, follow_redirects=True).text


def test_credit_and_debit_notes_move_party_balance(client):
    signup(client)
    ids = _ids(client)
    pid = _party(client, opening=1000)
    acct = ids["Expenses › Sales returns & discounts"]
    r = client.post("/app/accounts/notes", data={"kind": "CREDIT_NOTE", "date": TODAY, "partyId": pid, "accountId": acct, "amount": "300", "narration": "Rate difference"}, follow_redirects=True)
    assert "CN-0001" in r.text
    assert client.get(f"/api/parties/{pid}").json()["balance"] == 700
    client.post("/app/accounts/notes", data={"kind": "DEBIT_NOTE", "date": TODAY, "partyId": pid, "accountId": acct, "amount": "50"})
    assert client.get(f"/api/parties/{pid}").json()["balance"] == 750
    # the party's statement agrees with the list
    stmt = client.get(f"/app/parties/{pid}").text
    assert "Credit note #CN-0001" in stmt and "Debit note #DN-0001" in stmt
    listing = client.get("/api/parties").json()
    rows = listing["parties"] if isinstance(listing, dict) else listing
    assert next(p for p in rows if p["id"] == pid)["balance"] == 750
    # cancelling restores the balance
    cn = client.get("/app/accounts/vouchers?kind=CREDIT_NOTE").text.split("/app/accounts/vouchers/")[1].split("/")[0]
    client.post(f"/app/accounts/vouchers/{cn}/cancel", data={"kind": "CREDIT_NOTE"})
    assert client.get(f"/api/parties/{pid}").json()["balance"] == 1050
    # validation + a party with notes can't be deleted
    assert "more than 0" in client.post("/app/accounts/notes", data={"kind": "CREDIT_NOTE", "date": TODAY, "partyId": pid, "accountId": acct, "amount": "0"}, follow_redirects=True).text
    assert client.delete(f"/api/parties/{pid}").status_code == 409
