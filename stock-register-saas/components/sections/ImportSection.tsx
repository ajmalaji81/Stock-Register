"use client";

import { useState, type ChangeEvent } from "react";
import { ITEM_TEMPLATE, PARTY_TEMPLATE, mapItemRows, mapPartyRows, parseDelimited, type MapResult } from "@/lib/import";
import { api } from "../staff/api";
import { Badge, Button, Card, Empty, SectionHeader, Tabs, downloadCsv } from "../ui";
import type { SectionProps } from "./types";

type Kind = "items" | "parties";
type Row = Record<string, string | number>;
interface Result {
  created: number;
  failed: number;
  results: { line: number; ok: boolean; error?: string }[];
}

const COLUMNS: Record<Kind, [string, string][]> = {
  items: [["name", "Name"], ["sku", "SKU"], ["category", "Category"], ["unit", "Unit"], ["purchasePrice", "Buy"], ["salePrice", "Sell"], ["gstRate", "GST %"], ["openingQty", "Opening"], ["openingGodown", "Godown"]],
  parties: [["name", "Name"], ["type", "Type"], ["phone", "Phone"], ["gstin", "GSTIN"], ["state", "State"], ["openingBalance", "Opening bal."]],
};

export default function ImportSection({ can, refresh, notify, ws }: SectionProps) {
  const tabs = ([["items", "Items"], ["parties", "Parties"]] as [Kind, string][]).filter(([k]) => can(k === "items" ? "items.manage" : "parties.manage"));
  const [kind, setKind] = useState<Kind>(tabs[0]?.[0] ?? "items");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mapped: MapResult<Row> | null = text.trim()
    ? ((kind === "items" ? mapItemRows(parseDelimited(text)) : mapPartyRows(parseDelimited(text))) as unknown as MapResult<Row>)
    : null;
  const valid = mapped?.rows.filter((r) => r.errors.length === 0) ?? [];
  const invalid = (mapped?.rows.length ?? 0) - valid.length;
  const resultByLine = new Map(result?.results.map((r) => [r.line, r]) ?? []);

  function switchKind(k: Kind) {
    setKind(k);
    setText("");
    setFileName("");
    setResult(null);
    setError(null);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setResult(null);
    setError(null);
    if (/\.xlsx?$/i.test(f.name)) {
      setError('Excel files (.xlsx) can\'t be read directly. In Excel choose File → Save As → "CSV UTF-8", then upload that file — or copy the cells and paste them below.');
      return;
    }
    if (f.size > 2_000_000) {
      setError("File is larger than 2 MB. Split it into smaller files.");
      return;
    }
    setFileName(f.name);
    setText(await f.text());
  }

  async function runImport() {
    if (!valid.length) return;
    setBusy(true);
    setError(null);
    try {
      const rows = valid.map((r) => ({ ...r.data, line: r.line }));
      const res = await api<Result>("POST", kind === "items" ? "/api/items/import" : "/api/parties/import", { rows });
      setResult(res);
      notify(`${res.created} ${kind} imported${res.failed ? `, ${res.failed} failed` : ""}`, res.created === 0);
      if (res.created > 0) await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (tabs.length === 0) return <Empty>Your role can&apos;t import items or parties.</Empty>;

  return (
    <div>
      <SectionHeader
        title="Bulk import"
        subtitle="Bring in your item list or customers & suppliers from a spreadsheet."
        actions={
          <Button variant="ghost" onClick={() => downloadCsv(`godownbook-${kind}-template.csv`, kind === "items" ? ITEM_TEMPLATE : PARTY_TEMPLATE)}>
            ⬇ Sample {kind} CSV
          </Button>
        }
      />
      {tabs.length > 1 && <div className="mb-4"><Tabs tabs={tabs} value={kind} onChange={switchKind} label="Import type" /></div>}

      <Card className="mb-4 space-y-3 p-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink/75">
          <li>Download the sample CSV and fill it in (Excel, Google Sheets, anything).</li>
          <li>In Excel use <b>File → Save As → CSV UTF-8</b>. Or just copy the cells, header row included, and paste below.</li>
          <li>Check the preview, then import. Rows with errors are skipped.</li>
        </ol>
        {kind === "items" && (
          <p className="text-xs text-ink/60">
            Opening stock goes into the godown named in the <b>openingGodown</b> column (or your first godown: {ws.godowns[0]?.name ?? "—"}).
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer">
            <input type="file" accept=".csv,.tsv,.txt,text/csv,.xlsx,.xls" className="sr-only" onChange={onFile} />
            <span className="inline-flex rounded-lg border-2 border-ink px-3.5 py-2 text-sm font-semibold hover:bg-muted">📂 Choose CSV file</span>
          </label>
          {fileName && <span className="text-sm text-ink/70">{fileName}</span>}
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setFileName(""); setResult(null); }}
          rows={5}
          placeholder="…or paste rows here (with the header row)"
          className="well w-full rounded-lg border-2 border-ink/20 p-3 font-mono text-xs outline-none focus:border-ink"
          aria-label="Paste spreadsheet rows"
        />
      </Card>

      {error && <p role="alert" className="mb-4 rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm font-medium text-out">{error}</p>}

      {mapped && (
        <>
          {mapped.headerErrors.length > 0 ? (
            <p role="alert" className="mb-4 rounded-lg border-2 border-out bg-out/10 px-3 py-2 text-sm text-out">
              {mapped.headerErrors.join(" ")} Download the sample CSV to see the expected columns.
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <b>{mapped.rows.length}</b> rows · <span className="text-in">{valid.length} ready</span>
                  {invalid > 0 && <> · <span className="text-out">{invalid} with errors</span></>}
                  {mapped.ignored.length > 0 && <span className="text-ink/55"> · ignored columns: {mapped.ignored.join(", ")}</span>}
                </p>
                <Button variant="in" onClick={runImport} disabled={busy || valid.length === 0 || !!result}>
                  {busy ? "Importing…" : result ? "Imported" : `Import ${valid.length} ${kind}`}
                </Button>
              </div>
              <div className="overflow-x-auto rounded-xl border-2 border-ink/20">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted text-left text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2">Line</th>
                      {COLUMNS[kind].map(([, l]) => <th key={l} className="px-3 py-2">{l}</th>)}
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/10">
                    {mapped.rows.slice(0, 500).map((r) => {
                      const res = resultByLine.get(r.line);
                      return (
                        <tr key={r.line} className={r.errors.length || res?.ok === false ? "bg-out/5" : ""}>
                          <td className="px-3 py-1.5 tabular-nums text-ink/55">{r.line}</td>
                          {COLUMNS[kind].map(([k]) => <td key={k} className="px-3 py-1.5">{String(r.data[k] ?? "")}</td>)}
                          <td className="px-3 py-1.5">
                            {r.errors.length ? (
                              <span className="text-xs text-out">{r.errors.join("; ")}</span>
                            ) : res ? (
                              res.ok ? <Badge tone="in">Imported</Badge> : <span className="text-xs text-out">{res.error}</span>
                            ) : (
                              <Badge tone="ink">Ready</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {mapped.rows.length > 500 && <p className="mt-2 text-xs text-ink/60">Showing the first 500 rows of {mapped.rows.length}.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}
