"""Portable Office writers for deployments using the public Python packages."""
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt


def build_docx(spec, assets, out: Path):
    doc=Document()
    for section in spec["sections"]:
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
                cell.fill=PatternFill("solid",fgColor=value["style"]["fill"])
                cell.font=Font(bold=True,color="FFFFFF")
        ws.freeze_panes="A2"
    wb.save(out)
