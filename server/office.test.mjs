import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkOfficeComparisons,requestedOffice} from './office.mjs';
const ask=(content,history=[])=>requestedOffice([...history,{role:'user',content}]);

test('requested output formats exclude reference files and ordinary questions',()=>{
  assert.deepEqual(ask('帮我根据这份 Excel 生成两页 PPT'),['pptx']);
  assert.deepEqual(ask('将 Word 转成 Excel'),['xlsx']);
  assert.deepEqual(ask('把 Word 里的订单放入一个可编辑的 Excel 表'),['xlsx']);
  assert.deepEqual(ask('如何把订单放入 Excel？'),[]);
  assert.deepEqual(ask('生成 Word、PPT 和 Excel'),['docx','pptx','xlsx']);
  assert.deepEqual(ask('生成一份渠道周报'),['docx']);
  assert.deepEqual(ask('帮我分析这份 Excel'),[]);
  assert.deepEqual(ask('如何生成 Word 报告？'),[]);
  assert.deepEqual(ask('不要生成文件，告诉我差额'),[]);
});
test('revision of a delivered workbook keeps the format without naming it again',()=>{
  const history=[{role:'assistant',content:'已生成。',officeFormats:['xlsx']}];
  assert.deepEqual(ask('再加一行雨鞋并计算合计',history),['xlsx']);
  assert.deepEqual(ask('解释这些变化',history),[]);
  assert.deepEqual(ask('再加一行',[]),[]);
});

test('narrated percentage changes agree with the stated before and after values',()=>{
  const check=text=>checkOfficeComparisons([{sections:[{title:'经营表现',text}]}]);
  assert.equal(check('由 100 万元增至 104 万元，整体增幅 10%。').length,1);
  assert.equal(check('由100万元增至104万元，整体增幅4%。').length,0);
  assert.equal(check('从60万元降至54万元，降幅10%。').length,0);
  assert.equal(check('从3件增加到4件，增长33.3%。').length,0);
  assert.equal(check('由 1 亿元增至 11000 万元，增长 10%。').length,0);
  assert.equal(check('收入由 100 万元增至 104 万元，毛利率为10%。').length,0);
});

test('a summary in a separate file uses the same unambiguous period pair',()=>{
  const files=[
    {sections:[{text:'两店合计销售额由 100 万元增至 104 万元。'}]},
    {sections:[{title:'整体销售额较上期增长 10%'}]},
  ];
  assert.equal(checkOfficeComparisons(files).length,1);
  files[1].sections[0].title='整体销售额较上期增长 4%';
  assert.equal(checkOfficeComparisons(files).length,0);
});
