"""Private Office adapter. Only structured text and bounded tables cross the model boundary."""
import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

ENGINE = Path(__file__).resolve().parent
sys.path.insert(0, str(ENGINE))
if (ENGINE / "app/office/build_docs.py").is_file():
    from app.office.xlsx_build import build_workbook
    from app.office.build_docs import build_docx, build_pptx
    node = next((ENGINE / "py/lib").glob("python*/site-packages/nodejs_wheel/bin/node"), None)
    if node:
        os.environ["PATH"] = str(node.parent) + os.pathsep + os.environ.get("PATH", "")
else:
    from open_office import build_workbook, build_docx, build_pptx

from office_finish import finish_word, finish_workbook, validate_formula

NUMBER_FORMATS = {"number": "#,##0.##", "integer": "#,##0", "percent": "0.0%", "text": "General"}

XML_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def clean(value, maximum):
    if not isinstance(value, str) or len(value) > maximum or XML_CONTROL.search(value):
        raise ValueError("无效文字")
    return value.strip()


def normalize(raw):
    fmt = raw["format"]
    if fmt not in ("docx", "pptx", "xlsx"):
        raise ValueError("未知格式")
    title = clean(raw["title"], 100)
    sections = []
    if not title or not isinstance(raw["sections"], list) or not 1 <= len(raw["sections"]) <= 20:
        raise ValueError("缺少标题或章节")
    for item in raw["sections"]:
        heading = clean(item["title"], 100)
        if not heading:
            raise ValueError("缺少章节标题")
        text = clean(item.get("text", ""), 2800)
        section = dict(title=heading, text=text)
        table = item.get("table")
        if table:
            columns = table["columns"]
            rows = table["rows"]
            if not isinstance(columns, list) or not 1 <= len(columns) <= 12 or not isinstance(rows, list) or len(rows) > 160:
                raise ValueError("表格大小无效")
            columns = [clean(c, 80) for c in columns]
            values = []
            for row in rows:
                if not isinstance(row, list) or len(row) != len(columns):
                    raise ValueError("表格列数不一致")
                values.append([cell if type(cell) in (float, int) and abs(cell) <= 1e15 else clean(cell, 600) for cell in row])
            formats = table.get("formats", [])
            if formats and (not isinstance(formats, list) or len(formats) != len(columns)
                            or any(f not in NUMBER_FORMATS for f in formats)):
                raise ValueError("每列应对应一种有效格式")
            section["table"] = dict(columns=columns, rows=values, formats=formats)
        if fmt == "pptx" and item.get("chart"):
            chart = item["chart"]
            if chart not in ("column", "bar", "line") or not table or not values or not 2 <= len(columns) <= 5:
                raise ValueError("图表需要类别列和数值列")
            if any(not str(row[0]).strip() or any(type(n) not in (int, float) for n in row[1:]) for row in values):
                raise ValueError("图表数值须为数字")
            section["chart"] = chart
        if (fmt == "xlsx" and not table) or not (text or table):
            raise ValueError("缺少正文或表格")
        sections.append(section)
    return fmt, title, sections


def display_row(table, row):
    formats = table["formats"] or ["text"] * len(row)
    return [f"{value:.1%}" if fmt == "percent" and type(value) in (int, float) else str(value)
            for value, fmt in zip(row, formats)]


def word(title, sections):
    blocks = [{"type":"h1", "text":title}]
    for s in sections:
        blocks.append({"type":"h2","text":s["title"]})
        blocks.extend({"type":"p","text":p} for p in s["text"].splitlines() if p.strip())
        if table := s.get("table"):
            widths = [9000 // len(table["columns"])] * len(table["columns"])
            blocks.append({"type":"table", "columnWidths":widths, "width":sum(widths),
                           "rows":[{"cells":[{"text":str(c), "width":w, "shading":"DBEAFE" if i == 0 else "FFFFFF"}
                                             for c,w in zip(row,widths)]} for i,row in enumerate([table["columns"], *(display_row(table, row) for row in table["rows"])])]})
    return {"default": {"font":"Microsoft YaHei","size":22},
            "styles": {"Heading1":{"size":42,"bold":True,"fontColor":"172D49"},
                       "Heading2":{"size":29,"bold":True,"fontColor":"2257A0"}},
            "sections":[{"properties":{"page":{"size":{"width":11906,"height":16838},
                         "margin":{"top":1240,"bottom":1240,"left":1453,"right":1453}}},
                         "footers":{"default":[{"runs":[{"text":"OFFICE_PAGE_FIELD"}]}]}, "children":blocks}]}


def slides(title, sections):
    result = []
    def text(value, x, y, w, h, size, color, bold=False):
        return dict(type="text", text=value, x=x, y=y, w=w, h=h, fontFace="Microsoft YaHei", fontSize=size,
                    bold=bold, color=color, margin=0, valign="mid", fit="shrink", breakLine=False)
    for index, s in enumerate(sections):
        table = s.get("table")
        if table and (len(table["columns"]) > 6 or len(table["rows"]) > 7):
            raise ValueError("幻灯片表格过大，请分成多页")
        dark = index == 0
        ink = "FFFFFF" if dark else "15243C"
        muted = "CDDCFA" if dark else "364B66"
        elements = [text(title, .62, .33, 8.7, .29, 11, "90B9FF" if dark else "225FB9", True),
                    text(s["title"], .62, .92, 8.7, .9, 31, ink, True),
                    text(f"{index+1:02d} / {len(sections):02d}", 8.35, 5.12, 1.02, .24, 10, muted)]
        chart = s.get("chart")
        beside = table and s["text"] and (chart or len(table["columns"]) <= 4)
        lines = [line.strip() for line in s["text"].splitlines() if line.strip()]
        numbered = [re.fullmatch(r"(\d{1,2})[.、．)]\s*(.+)", line) for line in lines]
        if not table and 2 <= len(lines) <= 4 and all(numbered) and all(len(m[2]) <= 85 for m in numbered):
            step = 2.88 / len(numbered)
            for j, match in enumerate(numbered):
                y = 1.95 + j * step
                elements.append(text(match[1].zfill(2), .65, y, .55, .48, 16,
                                     "90B9FF" if dark else "225FB9", True))
                elements.append(text(match[2], 1.35, y, 7.9, min(step-.05,.76), 17, muted))
        elif s["text"]:
            elements.append(text(s["text"], .65, 1.97, 3.45 if beside else 8.62,
                                 2.60 if beside or not table else .95, 18 if beside else 17, muted))
        if chart:
            data = [{"name":name, "labels":[str(row[0]) for row in table["rows"]],
                     "values":[row[i] for row in table["rows"]]} for i,name in enumerate(table["columns"][1:],1)]
            percent_axis = bool(table["formats"]) and all(f == "percent" for f in table["formats"][1:])
            elements.append(dict(type="chart", chart="line" if chart=="line" else "bar",
                                 barDir="bar" if chart=="bar" else "col", barGrouping="clustered", data=data,
                                 valAxisLabelFormatCode="0%" if percent_axis else "General",
                                 x=4.25 if beside else .65, y=1.96, w=5.12 if beside else 8.65, h=2.95,
                                 chartArea={"fill":{"color":"FFFFFF"}}, chartColors=["3069B2","148179","B67719","7556A3"],
                                 showLegend=len(data)>1, legendPos="b", legendFontSize=10,
                                 catAxisLabelFontSize=11, valAxisLabelFontSize=10,
                                 catAxisLabelColor="344B63", valAxisLabelColor="344B63", legendColor="344B63"))
        elif table:
            rows = [[{"text":str(cell),"options":{"bold":r == 0, "fill":"2357A1" if r == 0 else "EFF4FA",
                                                  "color":"FFFFFF" if r == 0 else "183250"}} for cell in row]
                    for r,row in enumerate([table["columns"], *(display_row(table, row) for row in table["rows"])])]
            elements.append(dict(type="table",rows=rows,x=4.49 if beside else .65,
                                 y=2.06 if beside or not s["text"] else 3.0,w=4.88 if beside else 8.65,
                                 rowH=min(.46,(2.78 if beside else 1.9)/len(rows)),fontFace="Microsoft YaHei",
                                 fontSize=13 if len(rows)<=5 else 10,margin=.055,autoPage=False))
        result.append({"background":{"color":"122846" if dark else "F8FAFD"},"elements":elements})
    return {"title":title,"layout":"LAYOUT_16x9","slides":result}


def workbook(sections):
    names = []
    used = set()
    for section in sections:
        base = re.sub(r"[\\/\[\]:*?]", "_", section["title"]).strip("'")[:31] or "Sheet"
        name = base
        i = 1
        while name.casefold() in used:
            i += 1
            name = base[:30-len(str(i))]+" "+str(i)
        used.add(name.casefold())
        names.append(name)

    sheets = []
    for name, section in zip(names, sections):
        t = section["table"]
        rows = [t["columns"][:], *[row[:] for row in t["rows"]]]
        cells = {}
        widths = {}
        for ci,col in enumerate(t["columns"]):
            letter = chr(65+ci)
            widths[letter] = min(55,max(13, max((len(str(row[ci]))*1.65 if not str(row[ci]).startswith("=") else 12) for row in rows)+2))
            cells[letter+"1"] = {"style":{"bold":True,"fill":"2257A0","fontColor":"FFFFFF","wrap":True}}
        for ri,row in enumerate(rows,1):
            for ci,v in enumerate(row):
                is_formula = isinstance(v,str) and v.startswith("=")
                if ri == 1:
                    if is_formula:
                        raise ValueError("表头应为文字")
                    continue
                key = chr(65+ci)+str(ri)
                style = {}
                if t["formats"]:
                    style["numberFormat"] = NUMBER_FORMATS[t["formats"][ci]]
                if is_formula:
                    validate_formula(v, used)
                    style["fontColor"] = "146653" if "!" in v else "172D49"
                    cells[key] = {"formula":v, "style":style}
                    row[ci] = None
                elif type(v) in (int, float) or style:
                    if type(v) in (int, float):
                        style["fontColor"] = "2257A0"
                    cells[key] = {"style":style}
        sheets.append(dict(name=name,rows=rows,cells=cells,colWidths=widths))
    return {"sheets":sheets}


def render(raw):
    fmt,title,sections = normalize(raw)
    with tempfile.TemporaryDirectory(prefix="workspace-office-") as tmp:
        folder = Path(tmp)
        out = folder / ("output."+fmt)
        if fmt == "xlsx":
            build_workbook(workbook(sections), out)
            finish_workbook(out)
        else:
            if fmt == "docx":
                build_docx(word(title, sections), [], out)
                finish_word(out)
            else:
                build_pptx(slides(title, sections), [], out)
        with ZipFile(out) as archive:
            if archive.testzip() or "[Content_Types].xml" not in archive.namelist():
                raise ValueError("无效文件包")
        if not 500 < out.stat().st_size < 620_000:
            raise ValueError("文件超出限制")
        return {"base64":base64.b64encode(out.read_bytes()).decode("ascii"),"size":out.stat().st_size}


if __name__ == "__main__":
    try:
        print(json.dumps(render(json.load(sys.stdin))))
    except (ValueError, KeyError, TypeError, OSError, RuntimeError):
        sys.exit(2)
