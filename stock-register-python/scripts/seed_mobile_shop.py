"""Rebuild the demo account as a mobile retailer: 5 shops, ~90 days of purchases, internal transfers, sales and returns,
every phone tracked by IMEI.   Run from the project root:   python -m scripts.seed_mobile_shop

Login: demo@godownbook.com / 12345678.  This DELETES the demo account's existing data first (and only that account's).
"""
import os
import random
from collections import defaultdict
from datetime import date, timedelta

os.environ.setdefault("AUTH_SECRET", "demo-secret-demo-secret-demo-secret-1234")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import db as dbmod  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.serials import with_check_digit  # noqa: E402

EMAIL, PASSWORD = "demo@godownbook.com", "12345678"
rnd = random.Random(7)

SHOPS = [  # (name, state)
    ("Chennai - T Nagar (HQ)", "Tamil Nadu"),
    ("Coimbatore - RS Puram", "Tamil Nadu"),
    ("Madurai - Anna Nagar", "Tamil Nadu"),
    ("Bengaluru - Indiranagar", "Karnataka"),
    ("Hyderabad - Ameerpet", "Telangana"),
]
PHONES = [  # name, sku, cost, sale
    ("Samsung Galaxy A15 5G", "SM-A156", 15500, 18999), ("Samsung Galaxy M34 5G", "SM-M346", 16200, 19999),
    ("Samsung Galaxy S23 FE", "SM-S711", 44000, 52999), ("Redmi 13C 5G", "RM-13C", 9300, 11499),
    ("Redmi Note 13 Pro", "RM-N13P", 23800, 27999), ("Poco X6 5G", "PC-X6", 19800, 23999),
    ("Realme 12x 5G", "RL-12X", 10900, 13499), ("Realme Narzo 70 Pro", "RL-N70P", 16400, 19999),
    ("Vivo Y28 5G", "VV-Y28", 12100, 14999), ("Vivo T3x 5G", "VV-T3X", 12000, 14499), ("Oppo A18", "OP-A18", 8000, 9999),
    ("OnePlus Nord CE3 Lite", "OP-NCE3", 16300, 19999), ("Moto G54 5G", "MT-G54", 13000, 15999),
    ("iPhone 13 128GB", "AP-13", 49500, 58900), ("iPhone 15 128GB", "AP-15", 65000, 72900), ("Tecno Spark 20 Pro", "TC-S20", 10800, 12999),
]
ACCESSORIES = [
    ("Fast Charger 25W", "AC-CHG", 350, 699), ("Type-C Cable", "AC-CBL", 90, 249), ("Back Cover", "AC-CVR", 70, 299),
    ("Tempered Glass", "AC-TG", 30, 199), ("Wireless Earbuds", "AC-EAR", 650, 1299), ("Power Bank 10000mAh", "AC-PB", 700, 1399),
]
SUPPLIERS = [("Redington India Ltd", "Tamil Nadu"), ("Ingram Micro India", "Karnataka"), ("Cellcom Distributors", "Tamil Nadu"),
             ("Sri Balaji Mobile Wholesale", "Telangana")]
CUSTOMERS = {  # shop index -> names
    0: ["Ravi Kumar", "Priya Natarajan", "Karthik Subramanian", "Meena Iyer", "Arjun Reddy", "Deepa Krishnan"],
    1: ["Suresh Palanisamy", "Lakshmi Narayanan", "Gokul Raj", "Anitha Devi", "Senthil Murugan"],
    2: ["Pandian Selvam", "Muthulakshmi R", "Vignesh Kannan", "Fathima Beevi", "Ramesh Babu"],
    3: ["Rahul Gowda", "Sneha Hegde", "Kiran Shetty", "Divya Prakash", "Manjunath K"],
    4: ["Srinivas Rao", "Haritha Chowdary", "Naveen Goud", "Farhan Ali", "Swathi Reddy"],
}
FINANCE = ["Bajaj Finance", "HDFC Bank", "TVS Credit", "IDFC First Bank", "Home Credit"]
SCHEMES = ["", "", "", "Festival offer: free cover + glass", "Exchange bonus Rs 2000", "Cashback Rs 1000 on HDFC card", "0% EMI 6 months"]


def wipe_demo() -> None:
    with dbmod.session_scope() as s:
        row = s.execute(text('SELECT id FROM "User" WHERE email = :e'), {"e": EMAIL}).first()
        if not row:
            return
        p = {"u": row[0]}
        vs = 'SELECT id FROM "Voucher" WHERE userId = :u'
        for sql in (
            'DELETE FROM "SerialEvent" WHERE serialId IN (SELECT id FROM "SerialUnit" WHERE userId = :u)',
            'DELETE FROM "SerialUnit" WHERE userId = :u',
            'DELETE FROM "PartyPayment" WHERE userId = :u',
            f'DELETE FROM "VoucherLine" WHERE voucherId IN ({vs})',
            'DELETE FROM "Voucher" WHERE userId = :u',
            'DELETE FROM "LedgerEntry" WHERE userId = :u',
            'DELETE FROM "Stock" WHERE itemId IN (SELECT id FROM "Item" WHERE userId = :u)',
            'DELETE FROM "Item" WHERE userId = :u',
            'DELETE FROM "Party" WHERE userId = :u',
            'DELETE FROM "Expense" WHERE userId = :u',
            'DELETE FROM "ActivityLog" WHERE userId = :u',
            'DELETE FROM "StaffMember" WHERE userId = :u',
            'DELETE FROM "Godown" WHERE userId = :u',
            'DELETE FROM "Payment" WHERE userId = :u',
            'DELETE FROM "User" WHERE id = :u',
        ):
            s.execute(text(sql), p)
        bad = s.execute(text("PRAGMA foreign_key_check")).fetchall()
        assert not bad, bad
    print("Old demo data removed.")


def main() -> None:
    dbmod.init_db()
    wipe_demo()
    counter = [0]

    def new_imei() -> str:
        counter[0] += 1
        return with_check_digit(f"35{rnd.randint(100000, 999999)}{counter[0]:06d}")

    with TestClient(create_app()) as c:
        r = c.post("/api/auth/signup", json={"name": "Demo Owner", "email": EMAIL, "password": PASSWORD})
        assert r.status_code == 201, r.text
        c.put("/api/settings", json={"businessName": "Mobile Hub Retail", "state": "Tamil Nadu", "phone": "9840000000",
                                     "address": "45, Usman Road, T Nagar, Chennai", "gstin": "33ABCDE1234F1Z5",
                                     "invoicePrefix": "MH"})
        with dbmod.session_scope() as s:  # rename the default godown to the HQ shop
            s.execute(text('UPDATE "Godown" SET name = :n WHERE userId = (SELECT id FROM "User" WHERE email = :e)'),
                      {"n": SHOPS[0][0], "e": EMAIL})
        for name, _ in SHOPS[1:]:
            assert c.post("/api/godowns", json={"name": name}).status_code in (200, 201)
        godowns = {g["name"]: g["id"] for g in c.get("/api/workspace").json()["godowns"]}
        gid = [godowns[n] for n, _ in SHOPS]

        for name, sku, cost, sale in PHONES:
            assert c.post("/api/items", json={"name": name, "sku": sku, "category": "Mobiles", "unit": "pcs", "purchasePrice": cost,
                                              "salePrice": sale, "minStockAlert": 2, "gstRate": 18, "hsn": "8517",
                                              "trackSerial": True}).status_code in (200, 201)
        for name, sku, cost, sale in ACCESSORIES:
            assert c.post("/api/items", json={"name": name, "sku": sku, "category": "Accessories", "unit": "pcs", "purchasePrice": cost,
                                              "salePrice": sale, "minStockAlert": 10, "gstRate": 18, "hsn": "8504"}).status_code in (200, 201)
        items = {i["sku"]: i for i in c.get("/api/workspace").json()["items"]}
        sup_ids = [c.post("/api/parties", json={"name": n, "type": "SUPPLIER", "state": st,
                                                "phone": f"9{rnd.randint(100000000, 999999999)}"}).json()["id"] for n, st in SUPPLIERS]
        cust = {}  # shop -> [(id, name)]
        for si, names in CUSTOMERS.items():
            for n in names:
                pid = c.post("/api/parties", json={"name": n, "type": "CUSTOMER", "state": SHOPS[si][1],
                                                   "phone": f"9{rnd.randint(100000000, 999999999)}"}).json()["id"]
                cust.setdefault(si, []).append((pid, n))

        units = defaultdict(lambda: defaultdict(list))  # shop index -> sku -> [imei]
        acc = defaultdict(lambda: defaultdict(int))  # shop index -> sku -> qty
        sold = []  # (day_index, shop, sku, imei, party_id)
        stats = defaultdict(int)

        def api(path, body, what):
            r = c.post(path, json=body)
            if r.status_code not in (200, 201):
                stats["fail"] += 1
                print("skip", what, r.status_code, r.json().get("error"))
                return None
            stats[what] += 1
            return r.json()

        def purchase(iso, shop, lines_spec, supplier):
            lines, total = [], 0
            for sku, qty in lines_spec:
                it = items[sku]
                tokens = [new_imei() for _ in range(qty)] if it["sku"] in PHONE_SKUS else []
                lines.append({"itemId": it["id"], "qty": qty, "rate": it["purchasePrice"], "taxRate": 18, "serials": tokens, "_sku": sku})
                total += qty * it["purchasePrice"] * 1.18
            body_lines = [{k: v for k, v in l.items() if k != "_sku"} for l in lines]
            pay = rnd.choice([0, 0.5, 1.0])
            body = {"kind": "PURCHASE", "date": iso, "godownId": gid[shop], "partyId": supplier, "lines": body_lines,
                    "paymentSplit": [{"mode": rnd.choice(["BANK", "UPI", "CHEQUE"]), "amount": int(total * pay)}] if pay else []}
            if api("/api/vouchers", body, "purchases"):
                for l in lines:
                    if l["serials"]:
                        units[shop][l["_sku"]].extend(l["serials"])
                    else:
                        acc[shop][l["_sku"]] += l["qty"]

        def transfer(iso, src, dst, sku, qty):
            it = items[sku]
            if sku in PHONE_SKUS:
                if len(units[src][sku]) < qty:
                    return
                picked = units[src][sku][:qty]
                body = {"itemId": it["id"], "fromGodownId": gid[src], "toGodownId": gid[dst], "qty": qty, "date": iso, "serials": picked,
                        "remarks": "Stock for shop"}
                if api("/api/transfers", body, "transfers"):
                    del units[src][sku][:qty]
                    units[dst][sku].extend(picked)
            else:
                if acc[src][sku] < qty:
                    return
                body = {"itemId": it["id"], "fromGodownId": gid[src], "toGodownId": gid[dst], "qty": qty, "date": iso, "remarks": "Stock for shop"}
                if api("/api/transfers", body, "transfers"):
                    acc[src][sku] -= qty
                    acc[dst][sku] += qty

        def sale(iso, day_i, shop):
            avail = [s for s in PHONE_SKUS if units[shop][s]]
            lines, total, sold_now = [], 0, []
            if avail:
                sku = rnd.choice(avail)
                it = items[sku]
                imei = units[shop][sku][0]
                pct = rnd.choice([0, 0, 0, 2, 3, 5])
                lines.append({"itemId": it["id"], "qty": 1, "rate": it["salePrice"], "discountPct": pct, "taxRate": 18, "serials": [imei]})
                total += it["salePrice"] * (1 - pct / 100) * 1.18
                sold_now.append((sku, imei))
            for sku in rnd.sample([a[1] for a in ACCESSORIES], rnd.choice([0, 0, 1, 2])):
                if acc[shop][sku] >= 1:
                    it = items[sku]
                    lines.append({"itemId": it["id"], "qty": 1, "rate": it["salePrice"], "taxRate": 18})
                    total += it["salePrice"] * 1.18
            if not lines:
                return
            total = int(total)
            walk_in = rnd.random() < 0.35
            party = None if walk_in else rnd.choice(cust[shop])
            roll, split = rnd.random(), []
            if total > 15000 and roll < 0.2:
                fin = int(total * rnd.choice([0.6, 0.7, 0.8]))
                split = [{"mode": "FINANCE", "amount": fin, "finance": rnd.choice(FINANCE)},
                         {"mode": rnd.choice(["CASH", "UPI"]), "amount": total - fin}]
            elif roll < 0.45:
                a, b = int(total * 0.5), int(total * 0.3)
                split = [{"mode": "CARD", "amount": a}, {"mode": "UPI", "amount": b}, {"mode": "CASH", "amount": total - a - b}]
            elif roll < 0.9 or walk_in:
                split = [{"mode": rnd.choice(["CASH", "UPI", "CARD"]), "amount": total}]
            else:
                split = [{"mode": "CASH", "amount": int(total * 0.5)}]
            body = {"kind": "SALE", "date": iso, "godownId": gid[shop], "partyId": party[0] if party else None, "lines": lines,
                    "paymentSplit": [s for s in split if s["amount"] > 0], "schemeInfo": rnd.choice(SCHEMES),
                    "paymentInfo": f"UPI ref {rnd.randint(100000, 999999)}" if any(s["mode"] == "UPI" for s in split) else ""}
            if api("/api/vouchers", body, "sales"):
                for sku, imei in sold_now:
                    units[shop][sku].remove(imei)
                    sold.append((day_i, shop, sku, imei, party[0] if party else None))
                for l in lines[len(sold_now):]:
                    sku = next(k for k, v in items.items() if v["id"] == l["itemId"])
                    acc[shop][sku] -= 1

        start = date.today() - timedelta(days=90)
        for d in range(91):
            day = start + timedelta(days=d)
            iso = day.isoformat()
            if d == 0:  # opening purchase: every model, plus accessories
                for i in range(0, len(PHONES), 4):
                    purchase(iso, 0, [(p[1], rnd.randint(14, 20)) for p in PHONES[i:i + 4]], rnd.choice(sup_ids))
                purchase(iso, 0, [(a[1], rnd.randint(150, 250)) for a in ACCESSORIES], rnd.choice(sup_ids))
            elif d % 7 == 0:  # weekly restock at HQ
                for chunk in (rnd.sample(PHONES, 4), rnd.sample(PHONES, 4)):
                    purchase(iso, 0, [(p[1], rnd.randint(8, 14)) for p in chunk], rnd.choice(sup_ids))
                purchase(iso, 0, [(a[1], rnd.randint(60, 120)) for a in rnd.sample(ACCESSORIES, 3)], rnd.choice(sup_ids))
            if d % 7 in (0, 1) or d == 1:  # HQ distributes to the other shops
                for shop in range(1, 5):
                    for p in rnd.sample(PHONES, 7):
                        transfer(iso, 0, shop, p[1], rnd.randint(2, 5))
                    for a in rnd.sample(ACCESSORIES, 3):
                        transfer(iso, 0, shop, a[1], rnd.randint(10, 25))
            if d % 9 == 4:  # shop-to-shop rebalancing
                for _ in range(3):
                    src, dst = rnd.sample(range(1, 5), 2)
                    rich = [s for s in PHONE_SKUS if len(units[src][s]) >= 3]
                    if rich:
                        transfer(iso, src, dst, rnd.choice(rich), rnd.randint(1, 2))
            if day.weekday() == 6 and rnd.random() < 0.5:
                continue
            for shop in range(5):
                for _ in range(rnd.randint(1, 4)):
                    sale(iso, d, shop)
            if d % 11 == 6 and sold:  # a customer brings a phone back
                pool = [x for x in sold if x[0] <= d - 2 and x[4]]
                if pool:
                    day_i, shop, sku, imei, party = rnd.choice(pool)
                    it = items[sku]
                    if api("/api/vouchers", {"kind": "SALE_RETURN", "date": iso, "godownId": gid[shop], "partyId": party,
                                             "lines": [{"itemId": it["id"], "qty": 1, "rate": it["salePrice"], "taxRate": 18, "serials": [imei]}]},
                           "returns"):
                        sold.remove((day_i, shop, sku, imei, party))
                        units[shop][sku].append(imei)
            if d % 25 == 20:  # a faulty unit goes back to the supplier
                sku = next((s for s in PHONE_SKUS if units[0][s]), None)
                if sku:
                    imei = units[0][sku][-1]
                    it = items[sku]
                    if api("/api/vouchers", {"kind": "PURCHASE_RETURN", "date": iso, "godownId": gid[0], "partyId": sup_ids[0],
                                             "lines": [{"itemId": it["id"], "qty": 1, "rate": it["purchasePrice"], "taxRate": 18, "serials": [imei]}]},
                           "purchase_returns"):
                        units[0][sku].pop()
        print(dict(stats))

    with dbmod.session_scope() as s:  # invariant: IN_STOCK units == stock quantity for every tracked item and shop
        bad = s.execute(text('''
            SELECT i.name, st.godownId, st.quantity, COALESCE(u.n, 0) FROM "Stock" st JOIN "Item" i ON i.id = st.itemId
            LEFT JOIN (SELECT itemId, godownId, COUNT(*) n FROM "SerialUnit" WHERE status = 'IN_STOCK' GROUP BY itemId, godownId) u
              ON u.itemId = st.itemId AND u.godownId = st.godownId
            WHERE i.trackSerial = 1 AND st.quantity != COALESCE(u.n, 0)''')).fetchall()
        n_units = s.execute(text('SELECT COUNT(*) FROM "SerialUnit"')).scalar()
    print(f"IMEIs registered: {n_units}; stock/IMEI mismatches: {len(bad)}")
    print(f"Demo account ready: {EMAIL} / {PASSWORD}")


PHONE_SKUS = {p[1] for p in PHONES}

if __name__ == "__main__":
    main()
