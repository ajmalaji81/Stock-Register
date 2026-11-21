from tests.conftest import signup


def test_ledger_paging(client):
    signup(client)
    g = client.get("/api/workspace").json()["godowns"][0]["id"]
    client.post("/app/items/save", data={"name": "Rice", "sku": "R1", "unit": "Bag", "purchasePrice": "100", "salePrice": "150",
                                          "minStockAlert": "1", "openingQty": "500", "openingGodownId": g})
    item = client.get("/api/workspace").json()["items"][0]
    for _ in range(45):
        client.post("/app/stock/move", data={"itemId": item["id"], "godownId": g, "type": "OUT", "qty": "1", "rate": "150", "party": "P"})
    r = client.get("/app/ledger")
    assert r.status_code == 200, r.text
    assert "Page 1 of 3" in r.text
    r = client.get("/app/ledger?page=3&type=OUT&from=2020-01-01")
    assert r.status_code == 200 and "Page 3 of 3" in r.text
    assert client.get("/app/ledger?page=99").status_code == 200
