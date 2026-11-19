from tests.test_serials import bill, imei, world


def test_available_and_pos_find(client):
    hq, shop, item, sup, cust = world(client)
    a, b, c = imei(1), imei(2), imei(3)
    assert client.post("/api/vouchers", json=bill(hq, item, sup, "PURCHASE", [a, b, c])).status_code == 201
    sale = client.post("/api/vouchers", json=bill(hq, item, cust, "SALE", [b]))
    assert sale.status_code == 201

    # the list only offers units that are in stock at that godown
    r = client.get(f"/app/serial-lookup/available?item={item['id']}&godown={hq}")
    assert [u["imei"] for u in r.json()] == [a, c]
    assert client.get(f"/app/serial-lookup/available?item={item['id']}&godown={shop}").json() == []
    assert [u["imei"] for u in client.get(f"/app/serial-lookup/available?item={item['id']}&godown={hq}&q={c[-4:]}").json()] == [c]
    # editing the sale: its own unit is selectable again
    vid = sale.json()["id"]
    got = [u["imei"] for u in client.get(f"/app/serial-lookup/available?item={item['id']}&godown={hq}&voucher={vid}").json()]
    assert sorted(got) == sorted([a, b, c])

    # POS scan finds the model
    f = client.get(f"/app/serial-lookup/find?code={a}&godown={hq}").json()
    assert f["ok"] and f["itemId"] == item["id"] and f["name"] == "Redmi 13C" and f["imei"] == a
    assert "sold" in client.get(f"/app/serial-lookup/find?code={b}&godown={hq}").json()["error"]
    assert "Madurai shop" in client.get(f"/app/serial-lookup/find?code={a}&godown={shop}").json()["error"]
    assert "isn't in your IMEI register" in client.get("/app/serial-lookup/find?code=99999999999&godown=" + hq).json()["error"]


def test_lookup_needs_login(client):
    r = client.get("/app/serial-lookup/find?code=1&godown=x", follow_redirects=False)
    assert r.status_code == 303


def test_sales_form_has_picker_and_pos(client):
    hq, shop, item, sup, cust = world(client)
    page = client.get("/app/billing/new?kind=SALE").text
    assert "pos-toggle" in page and "f-sview" in page and "spick-modal" in page and "Upload IMEI file" not in page
    p = client.get("/app/billing/new?kind=PURCHASE").text
    assert "pos-toggle" not in p and "f-sview" not in p and "Upload IMEI file" in p
