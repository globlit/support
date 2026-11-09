import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {NumberField,clampNumber} from '../src/NumberField.js';

test('clampNumber clamps, rounds and falls back on invalid input',()=>{
 assert.equal(clampNumber('200',1,120,30),120);
 assert.equal(clampNumber('0',1,120,30),1);
 assert.equal(clampNumber(' 45 ',1,120,30),45);
 assert.equal(clampNumber('12.6',1,120,30),13);
 assert.equal(clampNumber('',1,120,30),30);
 assert.equal(clampNumber('abc',1,120,30),30);
});

test('NumberField renders a typeable input between decrease and increase buttons',()=>{
 const html=renderToStaticMarkup(createElement(NumberField,{label:'Timeout',value:1,min:1,max:120,onChange:()=>{}}));
 assert.match(html,/inputMode="numeric"|inputmode="numeric"/);
 assert.match(html,/aria-label="Decrease Timeout" disabled=""/);
 assert.match(html,/aria-label="Increase Timeout"/);
 assert.doesNotMatch(html,/type="number"/);
});
