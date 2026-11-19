from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import make_free, signup


def ws(c):
    return c.get("/api/workspace").json()


def test_pages_require_login(client):
    r = client.get("/app", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"


def test_stock_pages_end_to_end(client):
    signup(client)
    g = ws(client)["godowns"][0]["id"]
    for path in ("/app", "/app/items", "/app/ledger", "/app/godowns", "/app/adjustments", "/app/reports", "/app/import"):
        assert client.get(path).status_code == 200, path

    r = client.post("/app/items/save", data={"name": "Rice", "sku": "R1", "unit": "Bag", "purchasePrice": "100", "salePrice": "150",
                                              "minStockAlert": "20", "openingQty": "10", "openingGodownId": g}, follow_redirects=False)
    assert r.status_code == 303
    item = ws(client)["items"][0]
    assert item["stock"][g] == 10
    page = client.get("/app/items").text
    assert "Rice" in page and "R1" in page
    assert "Rice" in client.get("/app").text  # low stock (10 <= 20)
    assert "Rice" in client.get(f"/app/items?edit={item['id']}").text

    # duplicate SKU flashes an error instead of crashing
    r = client.post("/app/items/save", data={"name": "X", "sku": "R1"}, follow_redirects=True)
    assert r.status_code == 200 and "already exists" in r.text

    mv = {"itemId": item["id"], "godownId": g, "type": "OUT", "qty": "4", "rate": "150", "party": "Sharma"}
    client.post("/app/stock/move", data=mv)
    assert ws(client)["items"][0]["stock"][g] == 6
    r = client.post("/app/stock/move", data={**mv, "qty": "50"}, follow_redirects=True)
    assert "Not enough stock" in r.text

    client.post("/app/godowns", data={"name": "Godown A"})
    g2 = ws(client)["godowns"][1]["id"]
    client.post("/app/stock/transfer", data={"itemId": item["id"], "fromGodownId": g, "toGodownId": g2, "qty": "2"})
    assert ws(client)["items"][0]["stock"] == {g: 4, g2: 2}
    assert "Godown A" in client.get("/app/godowns").text
    client.post(f"/app/godowns/{g2}/rename", data={"name": "Back"})
    assert "Back" in client.get("/app/godowns").text

    client.post("/app/adjustments", data={"itemId": item["id"], "godownId": g, "mode": "count", "value": "9", "reason": "Recount"})
    assert ws(client)["items"][0]["stock"][g] == 9
    assert "Recount" in client.get("/app/adjustments").text

    led = client.get("/app/ledger?type=OUT")
    assert "Sharma" in led.text
    csv = client.get("/app/ledger.csv")
    assert csv.headers["content-type"].startswith("text/csv") and csv.text.splitlines()[0].startswith("Date,Item")
    rep = client.get("/app/reports.csv")
    assert "Rice" in rep.text and "Stock value" in rep.text

    client.post(f"/app/items/{item['id']}/delete")
    assert ws(client)["items"] == []


def test_scope_param_and_free_limit_message(client):
    signup(client)
    make_free()
    assert client.get("/app?scope=bogus").status_code == 200
    for i in range(5):
        client.post("/app/items/save", data={"name": f"I{i}", "sku": f"S{i}"})
    r = client.post("/app/items/save", data={"name": "Six", "sku": "S6"}, follow_redirects=True)
    assert "limited to 5 items" in r.text and "Upgrade" in r.text


def test_import_preview_and_commit(client):
    signup(client)
    csv = "name,sku,openingQty\nA,A1,3\nB,A1,1\n,Z,0\n"
    r = client.post("/app/import/preview", data={"kind": "items", "text": csv})
    assert r.status_code == 200 and "Duplicate SKU" in r.text and "Name is required" in r.text
    r = client.post("/app/import/commit", data={"kind": "items", "text": csv}, follow_redirects=True)
    assert "Imported 1 items" in r.text
    assert [i["sku"] for i in ws(client)["items"]] == ["A1"]

    pcsv = "name,type,openingBalance\nSharma,customer,100\nGupta,supplier,-50\n"
    r = client.post("/app/import/commit", data={"kind": "parties", "text": pcsv}, follow_redirects=True)
    assert "Imported 2 parties" in r.text
    assert client.get("/app/import/template/items.csv").text.startswith("name,sku")
    # file upload path
    r = client.post("/app/import/preview", data={"kind": "parties"}, files={"file": ("p.csv", b"name\nNew One\n", "text/csv")})
    assert "New One" in r.text


def test_staff_without_permission_is_blocked_and_costs_hidden(client):
    signup(client)
    g = ws(client)["godowns"][0]["id"]
    client.post("/app/items/save", data={"name": "Rice", "sku": "R1", "purchasePrice": "77", "openingQty": "5", "openingGodownId": g})
    client.post("/api/staff", json={"name": "Ravi", "email": "ravi@example.com", "password": "password123", "role": "SALES"})
    s = TestClient(create_app())
    s.post("/api/auth/login", json={"email": "ravi@example.com", "password": "password123"})
    assert "77" not in s.get("/app/items").text and "Stock value" not in s.get("/app").text
    r = s.post("/app/items/save", data={"name": "N", "sku": "N1"}, follow_redirects=True)
    assert "doesn&#39;t allow" in r.text or "doesn't allow" in r.text
    assert [i["sku"] for i in ws(client)["items"]] == ["R1"]
    assert s.get("/app/godowns").status_code == 403
    assert s.get("/app/reports").status_code == 403
