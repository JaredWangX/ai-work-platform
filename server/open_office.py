"""Portable Office writers for deployments using the public Python packages."""
from pathlib import Path
from docx import Document
from docx.shared import Twips, Pt as WordPt, RGBColor as WordColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from pptx.chart.data import CategoryChartData
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt


def build_docx(spec, assets, out: Path):
    doc=Document()
    normal = doc.styles["Normal"]
    normal.font.name = spec["default"]["font"]
    normal.font.size = WordPt(spec["default"]["size"] / 2)
    normal.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), normal.font.name)
    for level in (1, 2):
        style = doc.styles[f"Heading {level}"]
        settings = spec["styles"][f"Heading{level}"]
        style.font.size = WordPt(settings["size"] / 2)
        style.font.color.rgb = WordColor.from_string(settings["fontColor"])
    for section in spec["sections"]:
        page = doc.sections[-1]
        page.page_width, page.page_height = Twips(11906), Twips(16838)
        page.left_margin = page.right_margin = Twips(1453)
        page.top_margin = page.bottom_margin = Twips(1240)
        page.footer.paragraphs[0].add_run("OFFICE_PAGE_FIELD")
        for block in section["children"]:
            kind=block["type"]
            if kind in ("h1","h2"):
                doc.add_heading(block["text"],level=int(kind[-1]))
            elif kind=="p":
                doc.add_paragraph(block["text"])
            elif kind=="table":
                rows=block["rows"]
                table=doc.add_table(rows=0,cols=len(rows[0]["cells"]))
                table.style="Table Grid"
                for row in rows:
                    for cell,value in zip(table.add_row().cells,row["cells"]):
                        cell.text=value["text"]
                        shading = OxmlElement("w:shd")
                        shading.set(qn("w:fill"), value["shading"])
                        cell._tc.get_or_add_tcPr().append(shading)
    doc.save(out)


def build_pptx(spec, assets, out: Path):
    deck=Presentation()
    deck.slide_width,deck.slide_height=Inches(10),Inches(5.625)
    deck.core_properties.title=spec["title"]
    for page in spec["slides"]:
        slide=deck.slides.add_slide(deck.slide_layouts[6])
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb=RGBColor.from_string(page["background"]["color"])
        for el in page["elements"]:
            x,y,w=map(Inches,(el["x"],el["y"],el["w"]))
            if el["type"]=="text":
                frame=slide.shapes.add_textbox(x,y,w,Inches(el["h"])).text_frame
                frame.word_wrap=True
                frame.text=el["text"]
                for p in frame.paragraphs:
                    p.font.size=Pt(el["fontSize"]);p.font.bold=el["bold"]
                    p.font.color.rgb=RGBColor.from_string(el["color"])
            elif el["type"] == "chart":
                data = CategoryChartData()
                data.categories = el["data"][0]["labels"]
                for series in el["data"]:
                    data.add_series(series["name"], series["values"])
                kind = XL_CHART_TYPE.LINE_MARKERS if el["chart"] == "line" else (
                    XL_CHART_TYPE.BAR_CLUSTERED if el["barDir"] == "bar" else XL_CHART_TYPE.COLUMN_CLUSTERED)
                background = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, Inches(el["h"]))
                background.fill.solid()
                background.fill.fore_color.rgb = RGBColor.from_string("FFFFFF")
                background.line.fill.background()
                chart = slide.shapes.add_chart(kind, x, y, w, Inches(el["h"]), data).chart
                chart.has_legend = el["showLegend"]
                if chart.has_legend:
                    chart.legend.position = XL_LEGEND_POSITION.BOTTOM
                    chart.legend.include_in_layout = False
                    chart.legend.font.size = Pt(10)
                for axis in (chart.category_axis, chart.value_axis):
                    axis.tick_labels.font.size = Pt(11)
                chart.value_axis.tick_labels.number_format = el["valAxisLabelFormatCode"]
                for series, color in zip(chart.series, el["chartColors"]):
                    if el["chart"] == "line":
                        series.format.line.color.rgb = RGBColor.from_string(color)
                    else:
                        series.format.fill.solid()
                        series.format.fill.fore_color.rgb = RGBColor.from_string(color)
            else:
                rows=el["rows"];table=slide.shapes.add_table(len(rows),len(rows[0]),x,y,w,Inches(el["rowH"]*len(rows))).table
                for ri,row in enumerate(rows):
                    for ci,value in enumerate(row):
                        cell=table.cell(ri,ci);cell.text=value["text"]
                        cell.fill.solid();cell.fill.fore_color.rgb=RGBColor.from_string(value["options"]["fill"])
                        for p in cell.text_frame.paragraphs:
                            p.font.color.rgb=RGBColor.from_string(value["options"]["color"]);p.font.size=Pt(el["fontSize"])
    deck.save(out)


def build_workbook(spec,out: Path):
    wb=Workbook();wb.remove(wb.active)
    for sheet in spec["sheets"]:
        ws=wb.create_sheet(sheet["name"])
        for row in sheet["rows"]:ws.append(row)
        for col,width in sheet["colWidths"].items():ws.column_dimensions[col].width=width
        for key,value in sheet["cells"].items():
            cell=ws[key]
            if "formula" in value:cell.value=value["formula"]
            if "style" in value:
                style = value["style"]
                if "fill" in style:
                    cell.fill = PatternFill("solid", fgColor=style["fill"])
                cell.font = Font(bold=style.get("bold", False), color=style.get("fontColor","172D49"))
                cell.number_format = style.get("numberFormat", "General")
                if style.get("wrap"):
                    cell.alignment = Alignment(wrap_text=True)
        ws.freeze_panes="A2"
    wb.save(out)
