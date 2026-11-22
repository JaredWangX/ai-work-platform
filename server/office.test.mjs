import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requestedOffice} from './office.mjs';
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
