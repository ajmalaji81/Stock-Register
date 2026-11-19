from urllib.parse import unquote

from app.core.money import (
    BalanceParts, CashFlow, LedgerSource, bucket_of, build_party_ledger, ledger_sign, party_balance, payment_sign,
    reminder_message, summarize_cash, wa_phone, whatsapp_link,
)


def test_party_balance():
    assert party_balance(BalanceParts(sale=1000)) == 1000
    assert party_balance(BalanceParts(sale=1000, sale_return=200, paid_in=300)) == 500
    assert party_balance(BalanceParts(purchase=5000, paid_out=2000)) == -3000
    assert party_balance(BalanceParts(purchase=5000, purchase_return=500)) == -4500
    assert party_balance(BalanceParts(opening_balance=-250, sale=250)) == 0
    assert party_balance(BalanceParts(sale=0.1, paid_in=0.3, opening_balance=0.2)) == 0


def test_signs():
    assert payment_sign("IN") == -1 and payment_sign("OUT") == 1
    assert [ledger_sign(k) for k in ("SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN", "PAYMENT_IN", "PAYMENT_OUT")] == [1, -1, -1, 1, -1, 1]


def src(id_, date, kind, amount):
    return LedgerSource(id=id_, date=date, created_at=f"{date}T10:00:00.000Z", kind=kind, ref=id_, amount=amount, notes="")


def test_ledger_sorted_with_opening_row():
    rows = build_party_ledger(100, [src("p1", "2026-11-05", "PAYMENT_IN", 300), src("s1", "2026-11-01", "SALE", 500)])
    assert [(r.ref, r.debit, r.credit, r.balance) for r in rows] == [
        ("Opening balance", 100, 0, 100), ("s1", 500, 0, 600), ("p1", 0, 300, 300),
    ]


def test_ledger_date_filter_folds_earlier_rows():
    allrows = [
        src("s1", "2026-10-01", "SALE", 1000), src("p1", "2026-10-15", "PAYMENT_IN", 400),
        src("s2", "2026-11-02", "SALE", 200), src("s3", "2026-12-01", "SALE", 50),
    ]
    rows = build_party_ledger(0, allrows, "2026-11-01", "2026-11-30")
    assert [(r.ref, r.balance) for r in rows] == [("Balance b/f", 600), ("s2", 800)]
    assert [(r.ref, r.balance) for r in build_party_ledger(0, allrows, "2026-11-10", "2026-11-20")] == [("Balance b/f", 800)]
    pay = build_party_ledger(-500, [])
    assert (pay[0].debit, pay[0].credit, pay[0].balance) == (0, 500, -500)


def test_wa_phone_and_link():
    assert wa_phone("98765 43210") == "919876543210"
    assert wa_phone("09876543210") == "919876543210"
    assert wa_phone("+91-98765-43210") == "919876543210"
    assert wa_phone("+1 415 555 0100") == "14155550100"
    assert wa_phone("12345") is None
    assert whatsapp_link("", "hi") is None
    link = whatsapp_link("9876543210", reminder_message("Sharma Kirana", 1500, "Gupta Traders"))
    assert link and link.startswith("https://wa.me/919876543210?text=")
    text = unquote(link.split("text=")[1])
    assert "Sharma Kirana" in text and "Gupta Traders" in text and "1,500" in text


def test_reminder_uses_indian_grouping():
    assert "₹1,50,000" in reminder_message("A", 150000, "B")


def test_summarize_cash():
    assert bucket_of("CASH") == "cash" and bucket_of("UPI") == "bank" and bucket_of("CHEQUE") == "bank"
    s = summarize_cash(
        [
            CashFlow("2026-10-30", "CASH", 1000), CashFlow("2026-10-31", "BANK", 5000),
            CashFlow("2026-11-01", "CASH", 300), CashFlow("2026-11-01", "CASH", -120),
            CashFlow("2026-11-02", "UPI", -2000), CashFlow("2026-12-01", "CASH", 9999),
        ],
        "2026-11-01", "2026-11-30",
    )
    assert (s.opening_cash, s.opening_bank, s.closing_cash, s.closing_bank) == (1000, 5000, 1180, 3000)
    assert [(d.date, d.cash_in, d.cash_out, d.bank_in, d.bank_out) for d in s.days] == [
        ("2026-11-01", 300, 120, 0, 0), ("2026-11-02", 0, 0, 0, 2000),
    ]
