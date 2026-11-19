"""Bulk import: a small CSV / tab-separated parser and row mapping for items and parties (port of lib/import.ts)."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


def parse_delimited(text: str) -> list[list[str]]:
    """Parses CSV or tab-separated text (pasted from Excel). Handles quotes, "" escapes, CRLF and a BOM."""
    src = text[1:] if text.startswith("﻿") else text
    first_line = re.split(r"\r?\n", src, maxsplit=1)[0]
    delim = "\t" if first_line.count("\t") > first_line.count(",") else ","
    rows: list[list[str]] = []
    row: list[str] = []
    cell = ""
    quoted = False
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if quoted:
            if c == '"':
                if i + 1 < n and src[i + 1] == '"':
                    cell += '"'
                    i += 1
                else:
                    quoted = False
            else:
                cell += c
            i += 1
            continue
        if c == '"' and cell == "":
            quoted = True
        elif c == delim:
            row.append(cell)
            cell = ""
        elif c in "\n\r":
            if c == "\r" and i + 1 < n and src[i + 1] == "\n":
                i += 1
            row.append(cell)
            rows.append(row)
            row = []
            cell = ""
        else:
            cell += c
        i += 1
    if cell != "" or row:
        row.append(cell)
        rows.append(row)
    cleaned = [[v.strip() for v in r] for r in rows]
    return [r for r in cleaned if any(v != "" for v in r)]


def _norm(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "", h.lower())


ITEM_FIELDS: dict[str, list[str]] = {
    "name": ["name", "itemname", "item", "product", "productname"],
    "sku": ["sku", "barcode", "code", "itemcode", "skubarcode"],
    "category": ["category", "group", "itemgroup"],
    "unit": ["unit", "uom", "units"],
    "purchasePrice": ["purchaseprice", "costprice", "cost", "buyprice", "purchaserate", "buy"],
    "salePrice": ["saleprice", "sellingprice", "mrp", "price", "salerate", "sell"],
    "minStockAlert": ["minstockalert", "minstock", "minimum", "minimumstock", "reorderlevel", "min", "lowstock"],
    "hsn": ["hsn", "hsncode", "sac", "hsnsac"],
    "gstRate": ["gstrate", "gst", "gstpercent", "tax", "taxrate"],
    "openingQty": ["openingqty", "openingstock", "opening", "qty", "quantity", "stock"],
    "openingGodown": ["openinggodown", "godown", "location", "store", "warehouse"],
}

PARTY_FIELDS: dict[str, list[str]] = {
    "name": ["name", "partyname", "party", "customer", "supplier"],
    "type": ["type", "partytype"],
    "phone": ["phone", "mobile", "phoneno", "mobileno", "contact", "whatsapp"],
    "email": ["email", "emailid", "mail"],
    "gstin": ["gstin", "gst", "gstno", "gstnumber"],
    "state": ["state", "statename"],
    "address": ["address", "addr", "city"],
    "openingBalance": ["openingbalance", "opening", "balance", "outstanding"],
}


def _header_map(header: list[str], spec: dict[str, list[str]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for idx, h in enumerate(header):
        n = _norm(h)
        for key, names in spec.items():
            if key not in out and n in names:
                out[key] = idx
                break
    return out


_NAN = float("nan")


def _num(v: Optional[str]) -> Optional[float]:
    """None when blank, NaN when not a number."""
    if v is None or v.strip() == "":
        return None
    cleaned = re.sub(r"[₹,\s%]", "", v)
    try:
        n = float(cleaned)
    except ValueError:
        return _NAN
    return n if math.isfinite(n) else _NAN


@dataclass
class Mapped:
    line: int  # 1-based line number in the file, counting the header as line 1
    data: dict[str, Any]
    errors: list[str] = field(default_factory=list)


@dataclass
class MapResult:
    rows: list[Mapped]
    header_errors: list[str]
    ignored: list[str]


def _map_rows(
    table: list[list[str]], spec: dict[str, list[str]], required: list[str],
    build: Callable[[Callable[[str], Optional[str]]], tuple[dict[str, Any], list[str]]],
) -> MapResult:
    if not table:
        return MapResult([], ["The file is empty."], [])
    header, body = table[0], table[1:]
    mapping = _header_map(header, spec)
    header_errors = [f'Missing column "{k}".' for k in required if k not in mapping]
    known = set(mapping.values())
    ignored = [h for i, h in enumerate(header) if i not in known and h != ""]
    if header_errors:
        return MapResult([], header_errors, ignored)
    rows: list[Mapped] = []
    for i, r in enumerate(body):
        def get(k: str, r: list[str] = r) -> Optional[str]:
            idx = mapping.get(k)
            return None if idx is None or idx >= len(r) else r[idx]

        data, errors = build(get)
        rows.append(Mapped(i + 2, data, errors))
    return MapResult(rows, header_errors, ignored)


def map_item_rows(table: list[list[str]]) -> MapResult:
    def build(get: Callable[[str], Optional[str]]) -> tuple[dict[str, Any], list[str]]:
        errors: list[str] = []

        def n(k: str, label: str, maximum: float = 1e10) -> float:
            v = _num(get(k))
            if v is None:
                return 0
            if math.isnan(v) or v < 0 or v > maximum:
                errors.append(f"{label} must be a number of 0 or more")
                return 0
            return v

        data = {
            "name": (get("name") or "")[:120],
            "sku": (get("sku") or "")[:60],
            "category": (get("category") or "")[:60],
            "unit": (get("unit") or "pcs")[:20],
            "purchasePrice": n("purchasePrice", "Purchase price"),
            "salePrice": n("salePrice", "Sale price"),
            "minStockAlert": n("minStockAlert", "Min stock"),
            "hsn": (get("hsn") or "")[:20],
            "gstRate": n("gstRate", "GST rate", 100),
            "openingQty": n("openingQty", "Opening qty"),
            "openingGodown": get("openingGodown") or "",
        }
        if not data["name"]:
            errors.append("Name is required")
        if not data["sku"]:
            errors.append("SKU / barcode is required")
        return data, errors

    result = _map_rows(table, ITEM_FIELDS, ["name", "sku"], build)
    seen: dict[str, int] = {}
    for r in result.rows:  # duplicate SKUs inside the same file
        key = r.data["sku"].lower()
        if not key:
            continue
        if key in seen:
            r.errors.append(f"Duplicate SKU (also on line {seen[key]})")
        else:
            seen[key] = r.line
    return result


def _party_type(v: Optional[str]) -> Optional[str]:
    t = _norm(v or "")
    if not t or t.startswith("cust") or t in ("c", "buyer"):
        return "CUSTOMER"
    if t.startswith("supp") or t in ("s", "vendor", "seller"):
        return "SUPPLIER"
    if t in ("both", "b"):
        return "BOTH"
    return None


def map_party_rows(table: list[list[str]]) -> MapResult:
    def build(get: Callable[[str], Optional[str]]) -> tuple[dict[str, Any], list[str]]:
        errors: list[str] = []
        ptype = _party_type(get("type"))
        if not ptype:
            errors.append('Type must be "customer", "supplier" or "both"')
        bal = _num(get("openingBalance"))
        if bal is not None and math.isnan(bal):
            errors.append("Opening balance must be a number")
        email = get("email") or ""
        if email and not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
            errors.append("Email looks invalid")
        data = {
            "name": (get("name") or "")[:120],
            "type": ptype or "CUSTOMER",
            "phone": (get("phone") or "")[:30],
            "email": email[:120],
            "gstin": (get("gstin") or "").upper()[:15],
            "state": (get("state") or "")[:60],
            "address": (get("address") or "")[:300],
            "openingBalance": 0 if bal is None or math.isnan(bal) else bal,
        }
        if not data["name"]:
            errors.append("Name is required")
        return data, errors

    result = _map_rows(table, PARTY_FIELDS, ["name"], build)
    seen: dict[str, int] = {}
    for r in result.rows:
        key = r.data["name"].lower()
        if not key:
            continue
        if key in seen:
            r.errors.append(f"Duplicate name (also on line {seen[key]})")
        else:
            seen[key] = r.line
    return result


ITEM_TEMPLATE = (
    "name,sku,category,unit,purchasePrice,salePrice,minStockAlert,hsn,gstRate,openingQty,openingGodown\r\n"
    "Basmati Rice 25kg,GR-25KG,Grains,Bag,1800,2150,10,1006,5,40,Main Shop\r\n"
    "Sunflower Oil 15L,OIL-15L,Oils,Tin,1950,2200,6,1512,5,12,Main Shop\r\n"
)

PARTY_TEMPLATE = (
    "name,type,phone,email,gstin,state,address,openingBalance\r\n"
    'Sharma Kirana,customer,9876543210,,,Tamil Nadu,"12, Market Road, Chennai",2500\r\n'
    "Gupta Oil Traders,supplier,9123456780,orders@example.com,33ABCDE1234F1Z5,Tamil Nadu,,-12000\r\n"
)
