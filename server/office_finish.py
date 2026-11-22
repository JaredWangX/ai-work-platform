"""Finish the files we generate, keeping their native elements editable."""
import os
import re
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from lxml import etree as ET
from openpyxl import load_workbook
from openpyxl.formula.tokenizer import Tokenizer, TokenizerError

WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
CELL = r"\$?[A-L]\$?[1-9]\d{0,2}"
REFERENCE = re.compile(rf"(?:(?:'((?:[^']|'')+)'|([^'!\[\]:]+))!)?{CELL}(?::{CELL})?", re.I)
FUNCTIONS = {"SUM", "AVERAGE", "MIN", "MAX", "COUNT", "ROUND", "ABS", "IF"}


def validate_formula(value, sheet_names):
    try:
        tokens = Tokenizer(value).items
    except (TokenizerError, IndexError) as exc:
        raise ValueError("公式格式无效") from exc
    if not tokens or len(tokens) > 100:
        raise ValueError("公式为空或过长")
    for token in tokens:
        kind, subtype, part = token.type, token.subtype, token.value
        if kind == "OPERAND" and subtype == "RANGE":
            match = REFERENCE.fullmatch(part)
            if match:
                sheet = match[1] or match[2]
                if not sheet or sheet.replace("''", "'").casefold() in sheet_names:
                    continue
        elif kind == "OPERAND" and subtype in {"NUMBER", "LOGICAL", "TEXT"}:
            continue
        elif kind == "FUNC" and (subtype == "CLOSE" or part[:-1].upper() in FUNCTIONS):
            continue
        elif kind in {"PAREN", "WSPACE"} or (kind == "SEP" and part == ","):
            continue
        elif kind.startswith("OPERATOR") and part in {"+", "-", "*", "/", "^", "%", "=", "<>", "<", ">", "<=", ">="}:
            continue
        raise ValueError("公式只能引用当前工作簿中的单元格并使用支持的函数")


def rewrite_parts(path, transform):
    staged = path.with_suffix(".new")
    with ZipFile(path) as source, ZipFile(staged, "w") as target:
        for info in source.infolist():
            target.writestr(info, transform(info.filename, source.read(info)))
    staged.replace(path)


def finish_word(path):
    def update(name, blob):
        if name == "word/document.xml":
            root = ET.fromstring(blob)
            body = root.find(WORD + "body")
            for paragraph in body.findall(WORD + "p"):
                props = paragraph.find(WORD + "pPr")
                if props is None:
                    props = ET.Element(WORD + "pPr")
                    paragraph.insert(0, props)
                style = props.find(WORD + "pStyle")
                name = style.get(WORD + "val") if style is not None else ""
                before, after = {"Heading1": (0, 220), "Heading2": (240, 100)}.get(name, (0, 95))
                spacing = props.find(WORD + "spacing")
                if spacing is None:
                    spacing = ET.SubElement(props, WORD + "spacing")
                for key, value in {"before":before, "after":after, "line":280, "lineRule":"auto"}.items():
                    spacing.set(WORD + key, str(value))
            for table in root.iter(WORD + "tbl"):
                for index, row in enumerate(table.findall(WORD + "tr")):
                    props = row.find(WORD + "trPr")
                    if props is None:
                        props = ET.Element(WORD + "trPr")
                        row.insert(0, props)
                    if props.find(WORD + "cantSplit") is None:
                        ET.SubElement(props, WORD + "cantSplit")
                    if index == 0 and props.find(WORD + "tblHeader") is None:
                        ET.SubElement(props, WORD + "tblHeader")
        elif re.fullmatch(r"word/footer\d+\.xml", name):
            root = ET.fromstring(blob)
            for node in root.iter(WORD + "t"):
                if node.text == "OFFICE_PAGE_FIELD":
                    run = node.getparent()
                    field = ET.Element(WORD + "fldSimple", {WORD + "instr": "PAGE"})
                    run.getparent().replace(run, field)
                    field.append(run)
                    node.text = "1"
        else:
            return blob
        return ET.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=True)
    rewrite_parts(path, update)


def finish_workbook(path):
    book = load_workbook(path)
    formulas = {}
    for index, sheet in enumerate(book, 1):
        sheet.freeze_panes = "A2"
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0
        sheet.print_title_rows = "1:1"
        sheet.page_setup.orientation = "landscape" if sheet.max_column > 4 else "portrait"
        sheet_name = f"xl/worksheets/sheet{index}.xml"
        formulas[sheet_name] = (sheet.title, [c.coordinate for row in sheet for c in row if c.data_type == "f"])
    book.save(path)
    book.close()
    if not any(cells for _, cells in formulas.values()):
        return
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        raise RuntimeError("Excel 公式重算需要 LibreOffice Calc")
    with TemporaryDirectory(dir=path.parent) as directory:
        temp = Path(directory)
        try:
            subprocess.run([binary, "-env:UserInstallation=" + (temp / "profile").as_uri(),
                            "--headless", "--convert-to", "xlsx", "--outdir", str(temp), str(path)],
                           env={k: os.environ[k] for k in ("PATH","HOME","LANG","TMPDIR","LD_LIBRARY_PATH") if k in os.environ},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=True)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
            raise ValueError("工作簿重算失败") from exc
        calculated = load_workbook(temp / path.name, data_only=True)

        # Only copy the evaluated values. Keep Excel's original formula syntax,
        # formatting, and print settings even when Calc rewrites its own copy.
        def cache(name, blob):
            if name not in formulas or not formulas[name][1]:
                return blob
            title, coords = formulas[name]
            root = ET.fromstring(blob)
            nodes = {c.get("r"): c for c in root.iter(SHEET + "c")}
            for ref in coords:
                result = calculated[title][ref]
                value = result.value
                if result.data_type == "e" or (value is None and result.data_type not in ("s", "str", "inlineStr")):
                    raise ValueError(f"公式计算出错：{title}!{ref}")
                cell = nodes[ref]
                cached = cell.find(SHEET + "v")
                if cached is None:
                    cached = ET.SubElement(cell, SHEET + "v")
                if isinstance(value, bool):
                    kind, text = "b", str(int(value))
                elif isinstance(value, (int, float)):
                    kind, text = "n", str(value)
                else:
                    kind, text = "str", "" if value is None else str(value)
                cell.set("t", kind)
                cached.text = text
            return ET.tostring(root, encoding="UTF-8", xml_declaration=True)
        try:
            rewrite_parts(path, cache)
        finally:
            calculated.close()
