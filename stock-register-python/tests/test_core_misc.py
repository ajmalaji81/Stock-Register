from datetime import datetime, timedelta, timezone

import pytest

from app.core.avatar import AVATAR_MAX_CHARS, avatar_error
from app.core.bulk_import import (
    ITEM_TEMPLATE, PARTY_TEMPLATE, map_item_rows, map_party_rows, parse_delimited,
)
from app.core.engine import (
    StockError, assert_can_remove, assert_within_limit, is_low_stock, item_total, matches_filter, qty_in_scope,
    stock_value, summarize_today, to_csv, today_iso,
)
from app.core.permissions import PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES, role_can, role_label
from app.core.plans import (
    FREE_LIMITS, PRO_LIMITS, TRIAL_DAYS, effective_plan, limits_for, trial_days_left, trial_end_from,
)
from app.core.ppp import country_from_headers, price_for

# ---------------- engine ----------------


def test_today_iso():
    assert today_iso(datetime(2026, 1, 5)) == "2026-01-05"
    assert len(today_iso()) == 10


def test_item_total_and_scope():
    stock = {"g1": 4, "g2": 6}
    assert item_total(stock) == 10
    assert qty_in_scope(stock, "ALL") == 10
    assert qty_in_scope(stock, "g2") == 6
    assert qty_in_scope(stock, "missing") == 0


def test_is_low_stock():
    stock = {"g1": 4, "g2": 6}
    assert is_low_stock(stock, 5, "ALL") is False
    assert is_low_stock(stock, 5, "g1") is True
    assert is_low_stock(stock, 10, "ALL") is True
    assert is_low_stock({"g1": 0}, 0, "ALL") is False


def test_stock_value():
    items = [{"purchasePrice": 100, "stock": {"g1": 4, "g2": 6}}, {"purchasePrice": 2.5, "stock": {"g1": 3}}]
    assert stock_value(items, "ALL") == 1007.5
    assert stock_value(items, "g1") == 407.5


def test_assert_can_remove():
    assert_can_remove(5, 5, "Rice", "Main")
    assert_can_remove(0.1 + 0.2, 0.3, "Rice", "Main")
    with pytest.raises(StockError) as e:
        assert_can_remove(5, 5.001, "Rice", "Main")
    assert (e.value.status, e.value.code) == (400, "INSUFFICIENT_STOCK")
    with pytest.raises(StockError, match="available 2, requested 3"):
        assert_can_remove(2, 3, "Rice", "Main")


def test_assert_within_limit():
    assert_within_limit(10_000, None, "items")
    assert_within_limit(4, 5, "items")
    with pytest.raises(StockError) as e:
        assert_within_limit(5, 5, "items")
    assert (e.value.status, e.value.code) == (402, "LIMIT")


def _entry(**over):
    base = {"type": "IN", "qtyIn": 1, "qtyOut": 0, "rate": 10, "date": "2026-11-17", "godownId": "g1", "itemId": "i1"}
    return {**base, **over}


def test_summarize_today():
    today = "2026-11-17"
    rows = [
        _entry(type="IN", qtyIn=2, rate=10),
        _entry(type="OUT", qtyIn=0, qtyOut=3, rate=5),
        _entry(type="OPENING", qtyIn=100),
        _entry(type="TRANSFER_IN", qtyIn=7),
        _entry(type="TRANSFER_OUT", qtyOut=7, qtyIn=0),
        _entry(type="IN", qtyIn=9, date="2026-11-16"),
        _entry(type="IN", qtyIn=4, rate=1, godownId="g2"),
    ]
    assert summarize_today(rows, today, "ALL") == {"inCount": 2, "outCount": 1, "inValue": 24, "outValue": 15}
    assert summarize_today(rows, today, "g1") == {"inCount": 1, "outCount": 1, "inValue": 20, "outValue": 15}
    assert summarize_today(rows, today, "g2") == {"inCount": 1, "outCount": 0, "inValue": 4, "outValue": 0}


def test_matches_filter():
    e = _entry(date="2026-11-10")
    assert matches_filter(e, {})
    assert matches_filter(e, {"itemId": "i1"}) and not matches_filter(e, {"itemId": "x"})
    assert matches_filter(e, {"godownId": "ALL"}) and not matches_filter(e, {"godownId": "g2"})
    assert matches_filter(e, {"type": "IN"}) and not matches_filter(e, {"type": "OUT"})
    assert matches_filter(e, {"from": "2026-11-10", "to": "2026-11-10"})
    assert not matches_filter(e, {"from": "2026-11-11"})
    assert not matches_filter(e, {"to": "2026-11-09"})


def test_to_csv():
    assert to_csv([["a", 1], ["b", 2.5]]) == "a,1\r\nb,2.5"
    assert to_csv([['say "hi"', "x,y", "line1\nline2"]]) == '"say ""hi""","x,y","line1\nline2"'
    assert to_csv([["=SUM(A1)", "+cmd", "@x", "-foo"]]) == "'=SUM(A1),'+cmd,'@x,'-foo"
    assert to_csv([[-5, "-5", "-3.2"]]) == "-5,-5,-3.2"


# ---------------- bulk import ----------------


def test_parse_delimited_quotes():
    assert parse_delimited('a,b,c\n"x, y","say ""hi""","line1\nline2"\n') == [["a", "b", "c"], ["x, y", 'say "hi"', "line1\nline2"]]


def test_parse_delimited_crlf_bom_blank_lines():
    rows = parse_delimited("﻿name,sku\r\n Rice , R1 \r\n\r\n,\r\nOil,O1")
    assert rows == [["name", "sku"], ["Rice", "R1"], ["Oil", "O1"]]


def test_parse_delimited_tab_separated():
    assert parse_delimited("Name\tSKU\tAddress\nRice\tR1\t12, Market Rd\n") == [["Name", "SKU", "Address"], ["Rice", "R1", "12, Market Rd"]]


def test_map_item_rows_aliases_and_numbers():
    t = parse_delimited('Item Name,Barcode,MRP,Cost Price,GST %,Opening Stock,Godown\nRice,R1,"₹2,150",1800,5%,40,Main Shop\n')
    r = map_item_rows(t)
    assert r.header_errors == [] and len(r.rows) == 1
    d = r.rows[0].data
    assert (d["name"], d["sku"], d["salePrice"], d["purchasePrice"], d["gstRate"], d["openingQty"]) == ("Rice", "R1", 2150, 1800, 5, 40)
    assert d["openingGodown"] == "Main Shop" and d["unit"] == "pcs"
    assert r.rows[0].errors == [] and r.rows[0].line == 2


def test_map_item_rows_errors():
    assert map_item_rows(parse_delimited("name,price\nRice,10")).header_errors == ['Missing column "sku".']
    r = map_item_rows(parse_delimited("name,sku,purchasePrice,colour\nRice,R1,abc,red\nOil,r1,5,blue\n,X,1,\n"))
    assert r.ignored == ["colour"]
    assert "Purchase price" in ",".join(r.rows[0].errors)
    assert "Duplicate SKU (also on line 2)" in ",".join(r.rows[1].errors)
    assert "Name is required" in ",".join(r.rows[2].errors)
    assert map_item_rows([]).header_errors[0] == "The file is empty."


def test_map_party_rows():
    r = map_party_rows(parse_delimited(
        "Party Name,Type,Mobile,GSTIN,Opening Balance,Email\nA,Supplier,999,33abcde1234f1z5,-1200,\nB,,1,,500,bad\nC,friend,,,,\n"
    ))
    assert r.rows[0].data["type"] == "SUPPLIER"
    assert r.rows[0].data["gstin"] == "33ABCDE1234F1Z5"
    assert r.rows[0].data["openingBalance"] == -1200
    assert r.rows[0].errors == []
    assert r.rows[1].data["type"] == "CUSTOMER" and "Email" in ",".join(r.rows[1].errors)
    assert "Type must be" in ",".join(r.rows[2].errors)


def test_templates_parse_cleanly():
    items = map_item_rows(parse_delimited(ITEM_TEMPLATE))
    assert len(items.rows) == 2 and all(not r.errors for r in items.rows)
    parties = map_party_rows(parse_delimited(PARTY_TEMPLATE))
    assert len(parties.rows) == 2 and all(not r.errors for r in parties.rows)
    assert parties.rows[0].data["address"] == "12, Market Road, Chennai"


# ---------------- permissions ----------------


def _allowed(role):
    return sorted(p for p in PERMISSIONS if role_can(role, p))


def test_permissions_by_role():
    assert _allowed("OWNER") == sorted(PERMISSIONS)
    assert sorted(p for p in PERMISSIONS if not role_can("STORE_ADMIN", p)) == ["billing.upgrade", "settings.manage", "staff.manage"]
    assert _allowed("SALES_PURCHASE") == sorted([
        "costs.view", "documents.manage", "parties.manage", "payments.manage", "purchases.create",
        "reports.view", "sales.create", "stock.move", "stock.transfer",
    ])
    assert _allowed("SALES") == ["documents.manage", "parties.manage", "payments.manage", "sales.create"]
    for p in ("costs.view", "purchases.create", "reports.view", "stock.move", "staff.manage"):
        assert not role_can("SALES", p)


def test_staff_roles_have_labels_and_cannot_manage_staff():
    for r in STAFF_ROLES:
        assert not role_can(r["role"], "staff.manage")
        assert len(r["summary"]) > 10
        assert role_label(r["role"]) == r["label"]
    assert role_label("OWNER") == "Owner"
    assert sorted(ROLE_PERMISSIONS) == ["OWNER", "SALES", "SALES_PURCHASE", "STORE_ADMIN"]


# ---------------- plans ----------------

NOW = datetime(2026, 11, 17, 10, 0, tzinfo=timezone.utc)
DAY = timedelta(days=1)


def test_trial_lasts_90_days():
    assert TRIAL_DAYS == 90
    assert trial_end_from(NOW) - NOW == 90 * DAY


def test_effective_plan_and_limits():
    future, past = NOW + DAY, NOW - timedelta(microseconds=1)
    assert effective_plan("PRO", past, NOW) == "PRO"
    assert effective_plan("FREE", future, NOW) == "TRIAL"
    assert effective_plan("FREE", past, NOW) == "FREE"
    assert effective_plan("FREE", None, NOW) == "FREE"
    assert limits_for("FREE", future, NOW) == PRO_LIMITS
    assert limits_for("FREE", past, NOW) == FREE_LIMITS
    assert limits_for("PRO", None, NOW) == PRO_LIMITS


def test_effective_plan_accepts_naive_datetimes_from_sqlite():
    naive_future = (NOW + DAY).replace(tzinfo=None)
    assert effective_plan("FREE", naive_future, NOW) == "TRIAL"


def test_trial_days_left_rounds_up_never_negative():
    assert trial_days_left(trial_end_from(NOW), NOW) == 90
    assert trial_days_left(NOW + timedelta(microseconds=1), NOW) == 1
    assert trial_days_left(NOW - DAY, NOW) == 0
    assert trial_days_left(None, NOW) == 0


# ---------------- ppp ----------------


def test_price_for_base_and_tiers():
    env = {"LIFETIME_PRICE_CENTS": "2900"}
    assert price_for(None, env) == {"country": None, "baseCents": 2900, "amountCents": 2900, "discountPct": 0}
    assert price_for("US", env)["amountCents"] == 2900
    assert price_for("ZZ", env)["amountCents"] == 2900
    p = price_for("IN", env)
    assert p["amountCents"] == 1200 and p["discountPct"] == 59
    assert price_for("BR", env)["amountCents"] == 2000


def test_invalid_base_price_falls_back():
    assert price_for(None, {"LIFETIME_PRICE_CENTS": "abc"})["baseCents"] == 2900


def test_country_from_headers():
    prod = {"APP_ENV": "production"}
    assert country_from_headers({"x-vercel-ipcountry": "in"}, prod) == "IN"
    assert country_from_headers({"cf-ipcountry": "IN"}, prod) is None
    cf = {"APP_ENV": "production", "PPP_COUNTRY_HEADER": "CF-IPCountry"}
    assert country_from_headers({"cf-ipcountry": "BR"}, cf) == "BR"
    assert country_from_headers({"x-vercel-ipcountry": "IN"}, cf) is None
    for v in ("XX", "T1", "IND", "1N", "", "I N"):
        assert country_from_headers({"x-vercel-ipcountry": v}, prod) is None, v
    assert country_from_headers({}, prod) is None


def test_ppp_dev_country_only_outside_production():
    dev = {"APP_ENV": "development", "PPP_DEV_COUNTRY": "in"}
    assert country_from_headers({"x-vercel-ipcountry": "US"}, dev) == "IN"
    prod = {"APP_ENV": "production", "PPP_DEV_COUNTRY": "IN"}
    assert country_from_headers({"x-vercel-ipcountry": "US"}, prod) == "US"
    assert country_from_headers({}, prod) is None


# ---------------- avatar ----------------


def test_avatar_accepts_small_images():
    assert avatar_error("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==") is None
    assert avatar_error("data:image/png;base64,iVBORw0KGgo=") is None
    assert avatar_error("data:image/webp;base64,UklGRg==") is None


def test_avatar_rejects_bad_values():
    for v in (
        "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGgxPg==", "javascript:alert(1)",
        "https://example.com/me.jpg", "data:image/png;base64,abc def",
        "data:image/png;base64," + "A" * AVATAR_MAX_CHARS,
    ):
        assert avatar_error(v), v
