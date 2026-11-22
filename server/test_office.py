import io
import shutil
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from lxml import etree as ET
from openpyxl import load_workbook

from office_finish import WORD, finish_word, finish_workbook, validate_formula
from office_render import build_docx, build_pptx, build_workbook, normalize, slides, word, workbook


class OfficeFiles(unittest.TestCase):
    def test_percentage_tables_preserve_display_units(self):
        section = {"title":"增幅","table":{"columns":["门店","增长率"],"formats":["text","percent"],
                   "rows":[["甲",.25],["乙",-.1]]}}
        _, title, sections = normalize({"format":"docx","title":"复盘","sections":[section]})
        rows = word(title, sections)["sections"][0]["children"][-1]["rows"]
        self.assertEqual([r["cells"][1]["text"] for r in rows[1:]], ["25.0%","-10.0%"])

    def test_pages_and_editable_chart(self):
        sample = {"title":"甲店增长，乙店下降", "text":"金额以万元计。",
                  "chart":"column", "table":{"columns":["门店","上期","本期"],"rows":[["甲",40,50],["乙",60,54]]}}
        _, title, sections = normalize({"format":"pptx","title":"门店复盘","sections":[sample]})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "review.pptx")
            build_pptx(slides(title, sections), [], path)
            with ZipFile(path) as package:
                chart = ET.fromstring(package.read("ppt/charts/chart1.xml"))
                ns = {"c":"http://schemas.openxmlformats.org/drawingml/2006/chart"}
                self.assertEqual(len(chart.xpath("//c:barChart/c:ser", namespaces=ns)), 2)
                book = next(n for n in package.namelist() if n.endswith(".xlsx"))
                source = load_workbook(io.BytesIO(package.read(book)), data_only=True)
                self.assertEqual(source.active["C3"].value, 54)
            path = Path(directory, "brief.docx")
            build_docx(word(title, sections), [], path)
            finish_word(path)
            with ZipFile(path) as package:
                root = ET.fromstring(package.read("word/document.xml"))
                self.assertEqual(len(list(root.iter(WORD+"tblHeader"))),1)
                self.assertEqual(len(list(root.iter(WORD+"cantSplit"))),3)
                footer = ET.fromstring(package.read("word/footer1.xml"))
                self.assertEqual(footer.find(".//"+WORD+"fldSimple").get(WORD+"instr"),"PAGE")

    @unittest.skipUnless(shutil.which("soffice"), "requires LibreOffice Calc")
    def test_recalculated_totals_and_formats(self):
        spec = {"format":"xlsx", "title":"门店复盘", "sections":[
            {"title":"原始数据", "table":{"columns":["门店","上期","本期"],"rows":[["甲",40,50],["乙",60,54]]}},
            {"title":"汇总", "table":{"columns":["基期","本期","增幅"],"formats":["integer","integer","percent"],
             "rows":[["=SUM('原始数据'!$B$2:$B$3)","=SUM(原始数据!C2:C3)",'=IF(A2=0,"",(B2-A2)/A2)']]}}]}
        _, _, sections = normalize(spec)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "sales.xlsx")
            build_workbook(workbook(sections), path)
            finish_workbook(path)
            book = load_workbook(path, data_only=True)
            self.assertEqual([c.value for c in book["汇总"][2]], [100,104,.04])
            source = load_workbook(path)
            self.assertEqual(source["汇总"]["C2"].number_format, "0.0%")
            source["原始数据"]["C3"] = 60
            source.save(path)
            finish_workbook(path)
            self.assertEqual(load_workbook(path, data_only=True)["汇总"]["C2"].value, .1)
            source["汇总"]["C2"] = "=1/0"
            source.save(path)
            with self.assertRaisesRegex(ValueError,"公式计算出错"):
                finish_workbook(path)

    def test_unknown_sheets_functions_and_external_links_are_rejected(self):
        for formula in ["=Other!A2", "='[other.xlsx]Data'!A1", "=INDIRECT(A1)", "=ZZ888"]:
            with self.subTest(formula=formula), self.assertRaises(ValueError):
                validate_formula(formula, {"data"})
