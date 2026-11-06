"""Themed PDF reports.

The documents follow the web interface: warm-black paper, the brand yellow for the one accent, hairline rules instead of
boxes, a mono face for labels and a bold sans for headings, and the Ala Eh! logo. Only the PDF base-14 fonts are used, so
nothing has to be bundled (Courier stands in for the interface's mono face, Helvetica for its display and body faces).
"""
from __future__ import annotations

import io
import os
from dataclasses import dataclass, field
from typing import Sequence
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape as landscape_size
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

# The interface's tokens (frontend/src/tokens.css), as sRGB.
PAPER = colors.HexColor("#14120F")
PAPER_2 = colors.HexColor("#1B1A16")
INK = colors.HexColor("#EFEDE6")
INK_2 = colors.HexColor("#CFCCC2")
MUTED = colors.HexColor("#9A978C")
RULE = colors.HexColor("#3A3832")
ACCENT = colors.HexColor("#F5C000")

MONO = "Courier"
MONO_BOLD = "Courier-Bold"
SANS = "Helvetica"
SANS_BOLD = "Helvetica-Bold"

LOGO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "logo.png")

_hex = lambda c: "#%02X%02X%02X" % (int(c.red * 255), int(c.green * 255), int(c.blue * 255))

STYLES = {
    "title": ParagraphStyle("title", fontName=SANS_BOLD, fontSize=26, leading=30, textColor=INK),
    "meta": ParagraphStyle("meta", fontName=MONO, fontSize=8.5, leading=12.5, textColor=MUTED),
    "rule": ParagraphStyle("rule", fontName=MONO, fontSize=8.5, leading=12, textColor=INK_2),
    "heading": ParagraphStyle("heading", fontName=SANS_BOLD, fontSize=13, leading=17, textColor=INK, spaceBefore=4),
    "cell": ParagraphStyle("cell", fontName=SANS, fontSize=8.5, leading=11, textColor=INK),
    "cell_muted": ParagraphStyle("cell_muted", fontName=SANS, fontSize=8.5, leading=11, textColor=MUTED),
    "note": ParagraphStyle("note", fontName=MONO, fontSize=8, leading=11, textColor=MUTED),
}


@dataclass
class Stat:
    label: str
    value: str
    accent: bool = False


@dataclass
class Section:
    heading: str
    header: Sequence[str]
    rows: Sequence[Sequence[object]]
    widths_mm: Sequence[float]
    total_row: bool = False
    align_right: Sequence[int] = field(default_factory=tuple)


def _paper(canvas, doc):
    """First thing on every page, so everything else draws on top of it."""
    w, h = doc.pagesize
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, w, h, stroke=0, fill=1)
    canvas.restoreState()


class _NumberedCanvas(pdf_canvas.Canvas):
    """Draws the paper, the running header and 'page n / N' on every page (N is only known at the end)."""

    org_name = "Ala Eh! Food Products"
    footer_note = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved: list[dict] = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._decorate(total)
            super().showPage()
        super().save()

    def _decorate(self, total: int):
        w, h = self._pagesize
        margin = 15 * mm
        # Accent corner mark, the same bracket the sign-in uses
        self.setStrokeColor(ACCENT)
        self.setLineWidth(1.2)
        self.line(margin, h - 9 * mm, margin + 6 * mm, h - 9 * mm)
        self.line(margin, h - 9 * mm, margin, h - 14 * mm)
        # Running header
        self.setFont(MONO, 7.5)
        self.setFillColor(MUTED)
        self.drawString(margin + 9 * mm, h - 10.4 * mm, self.org_name)
        self.drawRightString(w - margin, h - 10.4 * mm, "attendance")
        # Footer
        self.setStrokeColor(RULE)
        self.setLineWidth(0.4)
        self.line(margin, 11 * mm, w - margin, 11 * mm)
        self.setFont(MONO, 7.5)
        self.setFillColor(MUTED)
        self.drawString(margin, 7 * mm, self.footer_note)
        self.drawRightString(w - margin, 7 * mm, f"page {self._pageNumber} / {total}")


def _rule_line(name: str) -> Paragraph:
    return Paragraph(escape("+- " + name + " " + "-" * 60), STYLES["rule"])


def _logo_flowable(size_mm: float = 14):
    """The logo as a small round mark; omitted if the file is missing."""
    if not os.path.exists(LOGO_PATH):
        return None
    from reportlab.platypus.flowables import Flowable

    class Logo(Flowable):
        def __init__(self, size):
            super().__init__()
            self.size = size
            self.width = size
            self.height = size

        def draw(self):
            c = self.canv
            c.saveState()
            path = c.beginPath()
            path.circle(self.size / 2, self.size / 2, self.size / 2)
            c.clipPath(path, stroke=0, fill=0)
            c.drawImage(ImageReader(LOGO_PATH), 0, 0, self.size, self.size, mask="auto")
            c.restoreState()

    return Logo(size_mm * mm)



def _nice_max(value: float) -> float:
    """Round an axis maximum up to 1, 2, 2.5, 5 or 10 times a power of ten."""
    if value <= 0:
        return 1.0
    import math
    exp = 10 ** math.floor(math.log10(value))
    for step in (1, 2, 2.5, 5, 10):
        if value <= step * exp:
            return step * exp
    return 10 * exp


def _bar_chart(values: Sequence[tuple[str, float]], width: float, height: float = 46 * mm):
    """Hours per day as yellow bars on hairline gridlines: no frame, like the interface's charts."""
    from reportlab.platypus.flowables import Flowable

    class Bars(Flowable):
        def __init__(self):
            super().__init__()
            self.width = width
            self.height = height

        def draw(self):
            c = self.canv
            left, bottom, top = 12 * mm, 6 * mm, height - 2 * mm
            area_w, area_h = width - left, top - bottom
            vmax = _nice_max(max((v for _, v in values), default=0))
            c.setFont(MONO, 7)
            for frac in (0, 0.5, 1):
                y = bottom + area_h * frac
                c.setStrokeColor(RULE)
                c.setLineWidth(0.3 if frac else 0.6)
                c.line(left, y, width, y)
                c.setFillColor(MUTED)
                c.drawRightString(left - 2 * mm, y - 2.2, f"{vmax * frac:g}h")
            n = max(1, len(values))
            slot = area_w / n
            bar_w = max(0.6, min(slot * 0.68, 9 * mm))
            c.setFillColor(ACCENT)
            for i, (_, v) in enumerate(values):
                if v <= 0:
                    continue
                h = area_h * min(1.0, v / vmax)
                c.rect(left + slot * i + (slot - bar_w) / 2, bottom, bar_w, h, stroke=0, fill=1)
            c.setFillColor(MUTED)
            every = max(1, round(n / 7))
            for i, (label, _) in enumerate(values):
                if i == n - 1 or (i % every == 0 and (n - 1 - i) >= max(2, every * 0.75)):
                    c.drawCentredString(left + slot * i + slot / 2, 0.4 * mm, label)

    return Bars()


def _stats_table(stats: Sequence[Stat], width: float) -> Table:
    n = len(stats)
    col = width / n
    label_style = ParagraphStyle("sl", fontName=SANS, fontSize=8.5, leading=11, textColor=MUTED)
    cells = [[Paragraph(escape(s.label), label_style) for s in stats],
             [Paragraph(f'<font name="{SANS_BOLD}" size="{22 if len(s.value) <= 7 else 15}" color="{_hex(ACCENT if s.accent else INK)}">{escape(s.value)}</font>',
                        ParagraphStyle("sv", leading=28)) for s in stats]]
    t = Table(cells, colWidths=[col] * n)
    style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
             ("RIGHTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, 0), 6),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]
    for i, s in enumerate(stats):
        style.append(("LINEABOVE", (i, 0), (i, 0), 0.9 if s.accent else 0.4, ACCENT if s.accent else RULE))
    t.setStyle(TableStyle(style))
    return t


def _data_table(section: Section) -> Table:
    head_style = ParagraphStyle("th", fontName=MONO_BOLD, fontSize=7.5, leading=10, textColor=MUTED)
    data = [[Paragraph(escape(h), head_style) for h in section.header]]
    total_style = ParagraphStyle("total", parent=STYLES["cell"], fontName=SANS_BOLD, textColor=ACCENT)
    last = len(section.rows) - 1
    for i, r in enumerate(section.rows):
        style = total_style if section.total_row and i == last else STYLES["cell"]
        data.append([c if isinstance(c, Paragraph) else Paragraph(escape(str(c if c is not None else "")), style) for c in r])
    widths = [w * mm for w in section.widths_mm]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, RULE),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, RULE),
    ]
    for col in section.align_right:
        for row in range(len(data)):
            style.append(("ALIGN", (col, row), (col, row), "RIGHT"))
    if section.total_row and len(data) > 1:
        style += [("LINEABOVE", (0, -1), (-1, -1), 0.9, ACCENT)]
    t.setStyle(TableStyle(style))
    return t


def render_report(*, title: str, slug: str, meta: Sequence[str], stats: Sequence[Stat] = (), sections: Sequence[Section],
                  empty_message: str = "Nothing to show for this period.", notes: Sequence[str] = (),
                  landscape: bool = False, footer_note: str = "",
                  chart: Sequence[tuple[str, float]] | None = None, chart_title: str = "") -> bytes:
    page = landscape_size(A4) if landscape else A4
    margin = 15 * mm
    content_width = page[0] - 2 * margin
    buf = io.BytesIO()

    class Canvas(_NumberedCanvas):
        pass

    Canvas.footer_note = footer_note

    doc = BaseDocTemplate(buf, pagesize=page, leftMargin=margin, rightMargin=margin, topMargin=20 * mm, bottomMargin=17 * mm,
                          title=title, author="Ala Eh! Food Products")
    doc.addPageTemplates([PageTemplate(id="themed", frames=[Frame(margin, 17 * mm, content_width, page[1] - 37 * mm, id="body",
                                                                   leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)],
                                      onPage=_paper)])

    story: list = [_rule_line(slug), Spacer(1, 3 * mm)]
    logo = _logo_flowable(13)
    title_par = Paragraph(f'{escape(title)}<font color="{_hex(ACCENT)}">_</font>', STYLES["title"])
    if logo is not None:
        head = Table([[logo, title_par]], colWidths=[17 * mm, content_width - 17 * mm])
        head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                  ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                                  ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
        story.append(head)
    else:
        story.append(title_par)
    story.append(Spacer(1, 2.5 * mm))
    for line in meta:
        story.append(Paragraph(escape(line).replace(" ", "&nbsp;"), STYLES["meta"]))
    story.append(Spacer(1, 7 * mm))
    if stats:
        story += [_stats_table(stats, content_width), Spacer(1, 8 * mm)]
    if chart:
        if chart_title:
            story += [Paragraph(escape(chart_title), STYLES["heading"]), Spacer(1, 3 * mm)]
        story += [_bar_chart(chart, content_width), Spacer(1, 8 * mm)]

    if not any(s.rows for s in sections):
        story.append(Paragraph(escape(empty_message), STYLES["cell_muted"]))
    for s in sections:
        if not s.rows:
            continue
        if s.heading:
            story += [Paragraph(escape(s.heading), STYLES["heading"]), Spacer(1, 2 * mm)]
        story += [_data_table(s), Spacer(1, 7 * mm)]
    for n in notes:
        story.append(Paragraph(escape(n), STYLES["note"]))

    doc.build(story, canvasmaker=Canvas)
    return buf.getvalue()
