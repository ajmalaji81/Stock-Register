"""PDF downloads for every table that can be downloaded as CSV / Excel.

`to_pdf(title, rows)` turns the same rows the CSV export uses (first row = headings) into a landscape A4 table.
app/main.py turns `?format=pdf` (or a `.pdf` URL) on any CSV export into this, so each report needs no code of its own.
"""
from __future__ import annotations

import csv
import io
import os
import re
from datetime import datetime
from typing import Any, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

# A font with the rupee sign and accented letters; the first one found is used, else the built-in Helvetica.
_FONT_CANDIDATES = [
    ("GB-Regular", ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                    "/usr/share/fonts/dejavu/DejaVuSans.ttf", "/Library/Fonts/Arial Unicode.ttf"]),
    ("GB-Bold", ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]),
]
_fonts: dict[str, str] = {}
_NUM = re.compile(r"^-?[\d,]+(\.\d+)?%?$")


def _font(bold: bool) -> str:
    key = "bold" if bold else "regular"
    if key not in _fonts:
        name, paths = _FONT_CANDIDATES[1 if bold else 0]
        for p in paths:
            if os.path.exists(p):
                try:
                    pdfmetrics.registerFont(TTFont(name, p))
                    _fonts[key] = name
                    break
                except Exception:  # noqa: BLE001 - a bad font file just means we try the next one
                    continue
        else:
            _fonts[key] = "Helvetica-Bold" if bold else "Helvetica"
    return _fonts[key]


def _text(v: Any) -> str:
    s = "" if v is None else str(v)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if _font(False) == "Helvetica":  # the built-in font has no rupee sign or non-Latin letters
        s = s.replace("\u20b9", "Rs ").encode("latin-1", "replace").decode("latin-1")
    return s


def rows_from_csv(text: str) -> list[list[str]]:
    return [r for r in csv.reader(io.StringIO(text))]


def to_pdf(title: str, rows: Sequence[Sequence[Any]], business: str = "") -> bytes:
    rows = [list(r) for r in rows] or [["No data"]]
    ncols = max(len(r) for r in rows)
    rows = [r + [""] * (ncols - len(r)) for r in rows]
    page = landscape(A4) if ncols > 5 else A4
    buf = io.BytesIO()
    margin = 12 * mm
    doc = SimpleDocTemplate(buf, pagesize=page, leftMargin=margin, rightMargin=margin, topMargin=14 * mm, bottomMargin=14 * mm, title=title)
    width = page[0] - 2 * margin

    regular, bold = _font(False), _font(True)
    small = 8 if ncols <= 9 else 7
    cell = ParagraphStyle("cell", fontName=regular, fontSize=small, leading=small + 2)
    cell_r = ParagraphStyle("cell_r", parent=cell, alignment=2)
    head = ParagraphStyle("head", parent=cell, fontName=bold, textColor=colors.white)
    head_r = ParagraphStyle("head_r", parent=head, alignment=2)

    numeric = [sum(1 for r in rows[1:] if _NUM.match(str(r[c]).strip())) > max(1, (len(rows) - 1) // 2) for c in range(ncols)]
    # column widths in proportion to the longest text (capped), so wide notes don't squeeze the numbers
    weight = [max(4, min(34, max(len(str(r[c])) for r in rows))) for c in range(ncols)]
    total = sum(weight)
    widths = [width * w / total for w in weight]

    data = []
    for i, r in enumerate(rows):
        data.append([Paragraph(_text(v), (head_r if numeric[c] else head) if i == 0 else (cell_r if numeric[c] else cell)) for c, v in enumerate(r)])
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f6f43")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f6f3")]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#d0d5dd")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    title_style = ParagraphStyle("title", fontName=bold, fontSize=14, leading=18)
    sub_style = ParagraphStyle("sub", fontName=regular, fontSize=8, leading=11, textColor=colors.HexColor("#667085"))
    story = [Paragraph(_text(title), title_style),
             Paragraph(_text((business + " · " if business else "") + "Generated " + datetime.now().strftime("%d-%m-%Y %H:%M")), sub_style),
             Spacer(1, 6), table]

    def footer(canvas, d):  # noqa: ANN001
        canvas.saveState()
        canvas.setFont(regular, 7.5)
        canvas.setFillColor(colors.HexColor("#667085"))
        canvas.drawRightString(page[0] - margin, 8 * mm, f"Page {d.page}")
        canvas.drawString(margin, 8 * mm, "GodownBook")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
