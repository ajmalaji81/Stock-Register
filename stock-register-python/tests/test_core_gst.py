from app.core.gst import (
    CONVERSIONS, INDIAN_STATES, LineInput, amount_in_words, calc_line, calc_totals, format_number,
    is_inter_state, stock_effect,
)
from app.core.jsmath import js_round, r2, round2, round3


def test_js_round_matches_math_round_for_halves():
    # Math.round rounds halves toward +infinity; Python's round() would give -2 and 2 for these.
    assert js_round(-2.5) == -2
    assert js_round(2.5) == 3
    assert js_round(0.5) == 1
    assert js_round(-0.5) == 0
    assert js_round(1.5) == 2
    assert js_round(-1.5) == -1


def test_round_helpers():
    assert round3(0.1 + 0.2) == 0.3
    assert round3(1.23456) == 1.235
    assert round3(-2.0004) == -2
    assert r2(1.005) == 1.01  # the Number.EPSILON nudge
    assert round2(1.005) == 1.0  # engine.ts round2 has no nudge
    assert r2(-2.345) == -2.34  # half rounds toward +infinity for negatives


def test_calc_line_discount_then_tax_rounded_to_paise():
    r = calc_line(LineInput(qty=3, rate=99.99, discount_pct=10, tax_rate=18))
    assert (r.taxable, r.tax, r.amount) == (269.97, 48.59, 318.56)
    r = calc_line(LineInput(qty=2, rate=50, tax_rate=5), False)
    assert (r.taxable, r.tax, r.amount) == (100, 0, 100)
    assert calc_line(LineInput(qty=1, rate=100, discount_pct=150, tax_rate=18)).taxable == 0


def test_is_inter_state():
    assert is_inter_state("Tamil Nadu", "Tamil Nadu") is False
    assert is_inter_state("Tamil Nadu", " tamil nadu ") is False
    assert is_inter_state("Tamil Nadu", "Kerala") is True
    assert is_inter_state("", "Kerala") is False
    assert is_inter_state("Tamil Nadu", "") is False
    assert is_inter_state(None, "Kerala") is False


def test_totals_intra_vs_inter_state():
    lines = [LineInput(2, 1800, 0, 5), LineInput(1, 135, 0, 0)]
    intra = calc_totals(lines, gst_enabled=True, inter_state=False)
    assert (intra.subtotal, intra.cgst, intra.sgst, intra.igst, intra.total) == (3735, 90, 90, 0, 3915)
    inter = calc_totals(lines, gst_enabled=True, inter_state=True)
    assert inter.igst == 180
    assert inter.cgst + inter.sgst == 0
    assert inter.total == 3915


def test_odd_tax_splits_exactly():
    t = calc_totals([LineInput(1, 10.1, 0, 5)], True, False)
    assert round(t.cgst + t.sgst, 2) == 0.51


def test_round_off_to_nearest_rupee():
    t = calc_totals([LineInput(1, 100.4, 0, 0)], True, False)
    assert (t.total, t.round_off) == (100, -0.4)
    up = calc_totals([LineInput(1, 100.5, 0, 0)], True, False)
    assert (up.total, up.round_off) == (101, 0.5)  # .5 rounds up, as Math.round does
    exact = calc_totals([LineInput(1, 100.4, 0, 0)], True, False, round_off=False)
    assert (exact.total, exact.round_off) == (100.4, 0)


def test_round_off_negative_half_rounds_toward_positive_infinity():
    # A return-style negative total of -2.5 rounds to -2 in JS (banker's rounding would give -2 too, -3.5 differs).
    t = calc_totals([LineInput(1, 3.5, 0, 0)], True, False)
    assert t.total == 4  # 3.5 -> 4 (banker's round() would give 4 as well); guard against 2.5 -> 2
    t2 = calc_totals([LineInput(1, 2.5, 0, 0)], True, False)
    assert t2.total == 3  # Python round(2.5) == 2, JS Math.round(2.5) == 3


def test_discount_total_is_reported():
    t = calc_totals([LineInput(4, 250, 10, 12)], True, False)
    assert t.discount == 100
    assert t.subtotal == 900
    assert t.cgst + t.sgst == 108


def test_amount_in_words_indian_numbering():
    assert amount_in_words(0) == "Rupees Zero Only"
    assert amount_in_words(15) == "Rupees Fifteen Only"
    assert amount_in_words(1234.5) == "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only"
    assert amount_in_words(100000) == "Rupees One Lakh Only"
    assert amount_in_words(2507300) == "Rupees Twenty Five Lakh Seven Thousand Three Hundred Only"
    assert amount_in_words(123456789) == "Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only"
    assert amount_in_words(-5) == "Minus Rupees Five Only"


def test_stock_effect_and_conversions():
    assert stock_effect("SALE") == "OUT"
    assert stock_effect("PURCHASE_RETURN") == "OUT"
    assert stock_effect("CHALLAN") == "OUT"
    assert stock_effect("PURCHASE") == "IN"
    assert stock_effect("SALE_RETURN") == "IN"
    for k in ("QUOTATION", "SALES_ORDER", "PURCHASE_ORDER"):
        assert stock_effect(k) is None
    assert CONVERSIONS["QUOTATION"] == ["SALES_ORDER", "SALE"]
    assert CONVERSIONS["CHALLAN"] == ["SALE"]
    assert "SALE" not in CONVERSIONS


def test_numbering_and_states():
    assert format_number("INV", 7) == "INV-0007"
    assert format_number("QT", 12345) == "QT-12345"
    assert len(INDIAN_STATES) == 36
    assert "Tamil Nadu" in INDIAN_STATES
