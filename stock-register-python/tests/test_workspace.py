from tests.conftest import signup


def test_workspace_page_and_nav(client):
    assert client.get("/app/workspace", follow_redirects=False).status_code == 303  # needs login
    signup(client)
    r = client.get("/app/workspace")
    assert r.status_code == 200 and "ws-frames" in r.text and "/static/workspace.js" in r.text
    assert "/app/workspace" in client.get("/app").text  # menu entry


def test_bill_form_keeps_input_script(client):
    signup(client)
    js = client.get("/static/billing.js").text
    assert "gb-bill-draft" in js and "flash.err" in js
    page = client.get("/app/billing/new?kind=PURCHASE").text
    assert 'id="bill"' in page


def test_static_files_are_revalidated(client):
    r = client.get("/static/app.css")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache" and r.headers.get("etag")
    assert client.get("/static/app.css", headers={"If-None-Match": r.headers["etag"]}).status_code == 304


def test_asset_urls_carry_a_version(client):
    import re

    html = client.get("/login").text
    assert re.search(r'/static/app\.css\?v=[0-9a-f]{10}"', html) and re.search(r'/static/theme\.js\?v=[0-9a-f]{10}"', html)
    url = re.search(r'(/static/app\.css\?v=[0-9a-f]{10})', html).group(1)
    assert client.get(url).status_code == 200


def test_sidebar_groups_can_be_hidden_and_shown(client):
    signup(client)
    page = client.get("/app").text
    for group in ("Stock", "Billing", "Money", "Reports", "Business"):
        assert f'data-group="{group}"' in page
    assert page.count('class="grp" aria-expanded="true"') >= 4 and "/static/nav.js?v=" in page
    js = client.get("/static/nav.js").text
    assert "gb-nav-collapsed" in js and "a.on" in js  # remembered per browser; the current page's group never hides


def test_sidebar_groups_animate(client):
    signup(client)
    assert client.get("/app").text.count('class="navinner"') >= 4
    css = client.get("/static/app.css").text
    assert "grid-template-rows:0fr" in css and "transition:grid-template-rows" in css and ".side.nonav" in css
    assert "nonav" in client.get("/static/nav.js").text
