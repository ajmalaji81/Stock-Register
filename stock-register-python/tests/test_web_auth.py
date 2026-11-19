def test_landing_login_signup_flow(client):
    r = client.get("/")
    assert r.status_code == 200 and "Lifetime Pro" in r.text and "$29" in r.text
    assert client.get("/login").status_code == 200 and client.get("/signup").status_code == 200

    r = client.post("/signup", data={"name": "A", "email": "bad", "password": "password123"})
    assert r.status_code == 400 and "Enter a valid email" in r.text
    r = client.post("/signup", data={"name": "A", "email": "a@example.com", "password": "password123"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/app" and "sr_session" in r.headers["set-cookie"]
    assert client.post("/signup", data={"name": "A", "email": "a@example.com", "password": "password123"}, follow_redirects=False).status_code == 409
    assert client.get("/api/workspace").status_code == 200  # same cookie works for the API
    assert client.get("/login", follow_redirects=False).headers["location"] == "/app"

    r = client.post("/logout", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"
    client.cookies.clear()
    r = client.post("/login", data={"email": "a@example.com", "password": "nope"})
    assert r.status_code == 401 and "Wrong email or password" in r.text
    r = client.post("/login", data={"email": "A@example.com", "password": "password123"}, follow_redirects=False)
    assert r.status_code == 303 and client.get("/api/me").status_code == 200


def test_ppp_price_on_landing(client):
    r = client.get("/", headers={"x-vercel-ipcountry": "IN"})
    assert "$12" in r.text and "59% off" in r.text


def test_upgrade_pages(client):
    assert "Sign up to upgrade" in client.get("/upgrade").text
    assert client.get("/upgrade/success", follow_redirects=False).headers["location"] == "/login"
    client.post("/signup", data={"name": "A", "email": "u@example.com", "password": "password123"}, follow_redirects=False)
    r = client.get("/upgrade")
    assert "Get Lifetime Pro" in r.text and "days left" in r.text
    r = client.post("/upgrade/checkout", follow_redirects=False)  # Dodo not configured
    assert r.status_code == 303 and r.headers["location"] == "/upgrade"
    assert "refresh" in client.get("/upgrade/success").text


def test_avatar_upload(client):
    client.post("/signup", data={"name": "A", "email": "v@example.com", "password": "password123"}, follow_redirects=False)
    png = bytes.fromhex("89504e470d0a1a0a")
    r = client.post("/app/profile/avatar", files={"file": ("a.png", png, "image/png")}, follow_redirects=False)
    assert r.status_code == 303
    assert client.get("/api/profile").json()["avatar"].startswith("data:image/png;base64,")
    client.post("/app/profile/avatar", files={"file": ("a.svg", b"<svg/>", "image/svg+xml")}, follow_redirects=False)
    assert client.get("/api/profile").json()["avatar"].startswith("data:image/png")  # rejected, unchanged
    client.post("/app/profile/avatar", data={"remove": "1"}, follow_redirects=False)
    assert client.get("/api/profile").json()["avatar"] is None
