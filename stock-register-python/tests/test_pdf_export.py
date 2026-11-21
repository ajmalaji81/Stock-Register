from tests.conftest import signup


def _seed(client):
    g = client.get("/api/workspace").json()["godowns"][0]["id"]
    client.post("/app/items/save", data={"name": "Rice", "sku": "R1", "unit": "Bag", "purchasePrice": "100", "salePrice": "150",
                                          "minStockAlert": "1", "openingQty": "20", "openingGodownId": g})
    item = client.get("/api/workspace").json()["items"][0]
    client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "OUT", "qty": "2", "rate": "150", "party": "Sharma ₹"})


def _is_pdf(r):
    return r.status_code == 200 and r.headers["content-type"].startswith("application/pdf") and r.content.startswith(b"%PDF") and ".pdf" in r.headers["content-disposition"]


def test_every_csv_download_also_comes_as_a_pdf(client):
    signup(client)
    _seed(client)
    for url in ("/app/ledger.pdf", "/app/reports.pdf", "/app/display/stock-status?format=pdf", "/app/display/day-book?format=pdf",
                "/app/display/inventory-summary?format=pdf", "/app/display/transaction-summary?format=pdf", "/app/billing/reports?format=pdf"):
        assert _is_pdf(client.get(url)), url
    # the CSV itself is unchanged
    assert client.get("/app/ledger.csv").headers["content-type"].startswith("text/csv")
    # the download buttons are on the pages
    assert "/app/ledger.pdf" in client.get("/app/ledger").text and "format=pdf" in client.get("/app/display/day-book").text


def test_pdf_of_a_page_you_cannot_open_is_not_a_pdf(client):
    r = client.get("/app/ledger.pdf", follow_redirects=False)  # not signed in
    assert r.status_code == 303 and r.headers["location"] == "/login"
