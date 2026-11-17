// Bulk import: a small CSV / tab-separated parser and row mapping for items and parties.
// Pure (no imports) so it runs in the browser for the preview, on the server, and in tests.

/** Parses CSV or tab-separated text (pasted from Excel). Handles quotes, "" escapes, CRLF and a BOM. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ""));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

type FieldSpec<K extends string> = Record<K, string[]>;

const ITEM_FIELDS: FieldSpec<
  "name" | "sku" | "category" | "unit" | "purchasePrice" | "salePrice" | "minStockAlert" | "hsn" | "gstRate" | "openingQty" | "openingGodown"
> = {
  name: ["name", "itemname", "item", "product", "productname"],
  sku: ["sku", "barcode", "code", "itemcode", "skubarcode"],
  category: ["category", "group", "itemgroup"],
  unit: ["unit", "uom", "units"],
  purchasePrice: ["purchaseprice", "costprice", "cost", "buyprice", "purchaserate", "buy"],
  salePrice: ["saleprice", "sellingprice", "mrp", "price", "salerate", "sell"],
  minStockAlert: ["minstockalert", "minstock", "minimum", "minimumstock", "reorderlevel", "min", "lowstock"],
  hsn: ["hsn", "hsncode", "sac", "hsnsac"],
  gstRate: ["gstrate", "gst", "gstpercent", "tax", "taxrate"],
  openingQty: ["openingqty", "openingstock", "opening", "qty", "quantity", "stock"],
  openingGodown: ["openinggodown", "godown", "location", "store", "warehouse"],
};

const PARTY_FIELDS: FieldSpec<"name" | "type" | "phone" | "email" | "gstin" | "state" | "address" | "openingBalance"> = {
  name: ["name", "partyname", "party", "customer", "supplier"],
  type: ["type", "partytype"],
  phone: ["phone", "mobile", "phoneno", "mobileno", "contact", "whatsapp"],
  email: ["email", "emailid", "mail"],
  gstin: ["gstin", "gst", "gstno", "gstnumber"],
  state: ["state", "statename"],
  address: ["address", "addr", "city"],
  openingBalance: ["openingbalance", "opening", "balance", "outstanding"],
};

function headerMap<K extends string>(header: string[], spec: FieldSpec<K>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  header.forEach((h, idx) => {
    const n = norm(h);
    for (const key of Object.keys(spec) as K[]) {
      if (out[key] === undefined && spec[key].includes(n)) {
        out[key] = idx;
        break;
      }
    }
  });
  return out;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(/[₹,\s%]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

export interface ItemRow {
  name: string;
  sku: string;
  category: string;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  minStockAlert: number;
  hsn: string;
  gstRate: number;
  openingQty: number;
  openingGodown: string;
}

export interface PartyRow {
  name: string;
  type: "CUSTOMER" | "SUPPLIER" | "BOTH";
  phone: string;
  email: string;
  gstin: string;
  state: string;
  address: string;
  openingBalance: number;
}

export interface Mapped<T> {
  /** 1-based line number in the file, counting the header as line 1. */
  line: number;
  data: T;
  errors: string[];
}

export interface MapResult<T> {
  rows: Mapped<T>[];
  /** Problems with the header itself (e.g. missing required column). */
  headerErrors: string[];
  /** Header names that weren't recognised (ignored). */
  ignored: string[];
}

function mapRows<K extends string, T>(
  table: string[][],
  spec: FieldSpec<K>,
  required: NoInfer<K>[],
  build: (get: (k: K) => string | undefined) => { data: T; errors: string[] },
): MapResult<T> {
  if (table.length === 0) return { rows: [], headerErrors: ["The file is empty."], ignored: [] };
  const [header, ...body] = table;
  const map = headerMap(header, spec);
  const headerErrors = required.filter((k) => map[k] === undefined).map((k) => `Missing column "${k}".`);
  const known = new Set(Object.values(map) as number[]);
  const ignored = header.filter((_, i) => !known.has(i) && header[i] !== "");
  if (headerErrors.length) return { rows: [], headerErrors, ignored };
  const rows = body.map((r, i) => {
    const get = (k: K) => {
      const idx = map[k];
      return idx === undefined ? undefined : r[idx];
    };
    const { data, errors } = build(get);
    return { line: i + 2, data, errors };
  });
  return { rows, headerErrors, ignored };
}

export function mapItemRows(table: string[][]): MapResult<ItemRow> {
  const result = mapRows(table, ITEM_FIELDS, ["name", "sku"], (get) => {
    const errors: string[] = [];
    const n = (k: keyof typeof ITEM_FIELDS, label: string, max = 1e10) => {
      const v = num(get(k));
      if (v === null) return 0;
      if (Number.isNaN(v) || v < 0 || v > max) {
        errors.push(`${label} must be a number of 0 or more`);
        return 0;
      }
      return v;
    };
    const data: ItemRow = {
      name: (get("name") ?? "").slice(0, 120),
      sku: (get("sku") ?? "").slice(0, 60),
      category: (get("category") ?? "").slice(0, 60),
      unit: (get("unit") || "pcs").slice(0, 20),
      purchasePrice: n("purchasePrice", "Purchase price"),
      salePrice: n("salePrice", "Sale price"),
      minStockAlert: n("minStockAlert", "Min stock"),
      hsn: (get("hsn") ?? "").slice(0, 20),
      gstRate: n("gstRate", "GST rate", 100),
      openingQty: n("openingQty", "Opening qty"),
      openingGodown: get("openingGodown") ?? "",
    };
    if (!data.name) errors.push("Name is required");
    if (!data.sku) errors.push("SKU / barcode is required");
    return { data, errors };
  });
  // Duplicate SKUs inside the same file.
  const seen = new Map<string, number>();
  for (const r of result.rows) {
    const key = r.data.sku.toLowerCase();
    if (!key) continue;
    if (seen.has(key)) r.errors.push(`Duplicate SKU (also on line ${seen.get(key)})`);
    else seen.set(key, r.line);
  }
  return result;
}

function partyType(v: string | undefined): PartyRow["type"] | null {
  const t = norm(v ?? "");
  if (!t || t.startsWith("cust") || t === "c" || t === "buyer") return "CUSTOMER";
  if (t.startsWith("supp") || t === "s" || t === "vendor" || t === "seller") return "SUPPLIER";
  if (t === "both" || t === "b") return "BOTH";
  return null;
}

export function mapPartyRows(table: string[][]): MapResult<PartyRow> {
  const result = mapRows(table, PARTY_FIELDS, ["name"], (get) => {
    const errors: string[] = [];
    const type = partyType(get("type"));
    if (!type) errors.push('Type must be "customer", "supplier" or "both"');
    const bal = num(get("openingBalance"));
    if (bal !== null && Number.isNaN(bal)) errors.push("Opening balance must be a number");
    const email = get("email") ?? "";
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email looks invalid");
    const data: PartyRow = {
      name: (get("name") ?? "").slice(0, 120),
      type: type ?? "CUSTOMER",
      phone: (get("phone") ?? "").slice(0, 30),
      email: email.slice(0, 120),
      gstin: (get("gstin") ?? "").toUpperCase().slice(0, 15),
      state: (get("state") ?? "").slice(0, 60),
      address: (get("address") ?? "").slice(0, 300),
      openingBalance: bal === null || Number.isNaN(bal) ? 0 : bal,
    };
    if (!data.name) errors.push("Name is required");
    return { data, errors };
  });
  const seen = new Map<string, number>();
  for (const r of result.rows) {
    const key = r.data.name.toLowerCase();
    if (!key) continue;
    if (seen.has(key)) r.errors.push(`Duplicate name (also on line ${seen.get(key)})`);
    else seen.set(key, r.line);
  }
  return result;
}

export const ITEM_TEMPLATE =
  "name,sku,category,unit,purchasePrice,salePrice,minStockAlert,hsn,gstRate,openingQty,openingGodown\r\n" +
  "Basmati Rice 25kg,GR-25KG,Grains,Bag,1800,2150,10,1006,5,40,Main Shop\r\n" +
  "Sunflower Oil 15L,OIL-15L,Oils,Tin,1950,2200,6,1512,5,12,Main Shop\r\n";

export const PARTY_TEMPLATE =
  "name,type,phone,email,gstin,state,address,openingBalance\r\n" +
  "Sharma Kirana,customer,9876543210,,,Tamil Nadu,\"12, Market Road, Chennai\",2500\r\n" +
  "Gupta Oil Traders,supplier,9123456780,orders@example.com,33ABCDE1234F1Z5,Tamil Nadu,,-12000\r\n";
