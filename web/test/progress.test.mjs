import {test} from 'node:test';
import assert from 'node:assert/strict';
import {progressOutput} from '../src/progress.ts';
test('CR updates remain visible before completion with CRLF split across chunks',()=>{
  const chunks=[{sequence:0,stream:'stdout',text:'Scan 10%\r'},{sequence:1,stream:'stdout',text:'\nScan 25.5%\rScan 30%'}];
  const before=JSON.stringify(chunks);const view=progressOutput(chunks);
  assert.equal(view.display.map(c=>c.text).join(''),'Scan 10%\nScan 25.5%\nScan 30%');
  assert.equal(view.percent,30);assert.equal(JSON.stringify(chunks),before);
});
test('partial percentages are reassembled across chunk boundaries; absent progress is not invented',()=>{
  assert.equal(progressOutput([{sequence:0,stream:'stdout',text:'Scan 4'},{sequence:1,stream:'stdout',text:'2.1%'}]).percent,42.1);
  assert.equal(progressOutput([{sequence:0,stream:'system',text:'100% system message'}]).percent,null);
  assert.equal(progressOutput([{sequence:0,stream:'stdout',text:'No percentage emitted'}]).percent,null);
});
