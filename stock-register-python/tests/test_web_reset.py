import re

from tests.conftest import signup


def _capture(monkeypatch):
    sent = []
    monkeypatch.setattr("app.web.auth_pages.send_mail", lambda to, subj, body: sent.append((to, body)))
    return sent


def test_reset_flow_single_use(client, monkeypatch):
    sent = _capture(monkeypatch)
    signup(client)
    client.cookies.clear()
    a = client.post("/forgot-password", data={"email": "owner@example.com"})
    b = client.post("/forgot-password", data={"email": "nobody@example.com"})
    assert a.status_code == b.status_code == 200 and "we've sent a link" in a.text and "we've sent a link" in b.text
    assert len(sent) == 1 and sent[0][0] == "owner@example.com"
    token = re.search(r"token=(\S+)", sent[0][1]).group(1)
    assert "New password" in client.get(f"/reset-password?token={token}").text
    assert client.post("/reset-password", data={"token": token, "password": "short"}).status_code == 400
    r = client.post("/reset-password", data={"token": token, "password": "newpassword99"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert client.post("/login", data={"email": "owner@example.com", "password": "newpassword99"}, follow_redirects=False).status_code == 303
    client.cookies.clear()
    assert client.post("/reset-password", data={"token": token, "password": "another12345"}).status_code == 400
    assert "invalid or has expired" in client.get(f"/reset-password?token={token}").text
    assert "invalid or has expired" in client.get("/reset-password?token=garbage").text
