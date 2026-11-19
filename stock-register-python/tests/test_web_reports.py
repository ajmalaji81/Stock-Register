from tests.test_web_billing import form, world


def test_report_charts_and_payment_modes(client):
    g, item, party = world(client)
    client.post("/app/billing/new", data=form(g, item, party, paidNow="1000", paymentMode="UPI"))
    client.post("/app/billing/new", data=form(g, item, party))
    r = client.get("/app/billing/reports")
    assert r.status_code == 200
    assert "Sales by day" in r.text and "Top items" in r.text and "Rice" in r.text and "Sharma" in r.text
    assert "UPI" in r.text and "Unspecified" in r.text
