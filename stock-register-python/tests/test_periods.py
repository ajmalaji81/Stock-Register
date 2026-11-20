from datetime import date

from app.core.periods import months_of_fy, resolve
from tests.conftest import signup

TODAY = date(2026, 11, 20)  # a Friday, in Q3 of FY 2026-27


def test_default_is_the_current_month():
    p = resolve("month", "", 2026, TODAY)
    assert (p.start, p.end, p.title, p.anchor, p.unit) == (date(2026, 11, 1), date(2026, 11, 30), "November 2026", "2026-11", "day")
    assert len(p.buckets) == 30 and p.prev == "2026-10" and p.next is None  # no future months
    assert resolve("nonsense", "", 2026, TODAY).view == "month"


def test_week_starts_on_monday():
    p = resolve("week", "", 2026, TODAY)
    assert (p.start, p.end) == (date(2026, 11, 16), date(2026, 11, 22)) and len(p.buckets) == 7
    assert p.title == "16 Nov – 22 Nov 2026" and p.prev == "2026-11-09" and p.next is None
    assert resolve("week", "2026-11-09", 2026, TODAY).next == "2026-11-16"


def test_quarters_follow_the_financial_year():
    p = resolve("quarter", "", 2026, TODAY)
    assert (p.start, p.end, p.anchor) == (date(2026, 10, 1), date(2026, 12, 31), "2026-Q3") and p.unit == "week"
    assert p.buckets[0][0] == date(2026, 10, 1) and p.buckets[-1][1] == date(2026, 12, 31)
    q4 = resolve("quarter", "2025-Q4", 2026, TODAY)
    assert (q4.start, q4.end) == (date(2026, 1, 1), date(2026, 3, 31)) and q4.next == "2026-Q1" and q4.prev == "2025-Q3"
    q1 = resolve("quarter", "2026-Q1", 2026, TODAY)
    assert (q1.start, q1.end) == (date(2026, 4, 1), date(2026, 6, 30)) and q1.prev == "2025-Q4"
    assert "Q3" in p.title and "FY 2026-27" in p.title


def test_year_has_twelve_months_from_april():
    p = resolve("year", "", 2026, TODAY)
    assert (p.start, p.end, p.title, p.unit) == (date(2026, 4, 1), date(2027, 3, 31), "FY 2026-27", "month")
    assert [b[2] for b in p.buckets][:2] == ["Apr 26", "May 26"] and p.buckets[-1][2] == "Mar 27" and p.next is None and p.prev == "2025"
    assert resolve("year", "2024", 2026, TODAY).next == "2025"


def test_an_older_selected_year_opens_on_its_last_period():
    assert resolve("month", "", 2024, TODAY).anchor == "2025-03"
    assert resolve("quarter", "", 2024, TODAY).anchor == "2024-Q4"
    assert resolve("year", "", 2024, TODAY).anchor == "2024"
    w = resolve("week", "", 2024, TODAY)  # the week containing 31 Mar 2025 (a Monday)
    assert (w.start, w.end) == (date(2025, 3, 31), date(2025, 4, 6))


def test_bad_or_future_p_falls_back():
    assert resolve("month", "2030-01", 2026, TODAY).anchor == "2026-11"
    assert resolve("month", "garbage", 2026, TODAY).anchor == "2026-11"
    assert resolve("quarter", "2026-Q4", 2026, TODAY).anchor == "2026-Q3"
    assert resolve("week", "2026-13-45", 2026, TODAY).start == date(2026, 11, 16)
    assert resolve("year", "2099", 2026, TODAY).anchor == "2026"


def test_bucket_index_covers_every_day_once():
    p = resolve("quarter", "2026-Q1", 2026, TODAY)
    idx = p.index_by_day()
    assert len(idx) == 91 and idx["2026-04-01"] == 0 and idx["2026-06-30"] == len(p.buckets) - 1


def test_month_picker_lists_the_fy():
    m = months_of_fy(2026, TODAY)
    assert [x["p"] for x in m][:2] == ["2026-04", "2026-05"] and m[-1]["p"] == "2027-03"
    assert not m[7]["future"] and m[8]["future"]  # Nov is this month; Dec hasn't started


def test_dashboard_tabs_and_navigation(client):
    from tests.test_fy import bill, world

    g, item, party = world(client)
    today = date.today()
    client.post("/api/vouchers", json=bill(g, item, party, date=today.isoformat(), qty=1))  # 1,890 today
    for view, word in (("", "Monthly"), ("week", "Weekly"), ("quarter", "Quarterly"), ("year", "Yearly")):
        page = client.get("/app" + (f"?view={view}" if view else "")).text
        assert all(w in page for w in ("Weekly", "Monthly", "Quarterly", "Yearly")) and "1,890" in page
    home = client.get("/app").text
    assert f"{today:%B %Y}" in home and 'aria-selected="true" class="on" href="/app?view=month' in home
    assert 'aria-label="Choose month"' in home and "view=month&p=" in home
    last = client.get(f"/app?view=month&p={date(today.year - 1, 1, 1):%Y-%m}").text  # a month with no bills
    assert "1,890" not in last and "Today" in last
    assert "/app/billing/reports?from=" in home
    assert "FY " in client.get("/app?view=quarter").text and "Q" in client.get("/app?view=quarter").text
    assert client.get("/app?view=month&p=junk").status_code == 200  # falls back, never an error


def test_welcome_message_shows_once_after_login(client):
    signup(client)  # the API signup sets no welcome flag
    assert "Welcome back" not in client.get("/app").text
    client.post("/logout")
    r = client.post("/login", data={"email": "owner@example.com", "password": "password123"}, follow_redirects=False)
    assert r.status_code == 303
    first = client.get("/app")
    assert "Welcome back, Owner" in first.text and "how your business is doing" in first.text
    assert "Welcome back" not in client.get("/app").text  # not on the next visit
    assert "Welcome back" not in client.get("/app?view=week").text
    client.post("/logout")
    client.post("/login", data={"email": "owner@example.com", "password": "password123"}, follow_redirects=False)
    assert "Welcome back" in client.get("/app").text  # a new login greets again
