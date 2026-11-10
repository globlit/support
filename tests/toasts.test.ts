import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {ToastProvider,addToast,toastLimit} from '../src/Toasts.js';

test('toasts merge duplicates, keep the latest four, and default to info',()=>{
 let list=addToast([],{message:'Saved',tone:'success'},1);
 list=addToast(list,{message:'Saved',tone:'success'},2);assert.equal(list.length,1);assert.equal(list[0].round,1);assert.equal(list[0].id,1);
 list=addToast(list,{message:'Saved',tone:'error'},3);assert.equal(list.length,2);
 for(let i=0;i<6;i++)list=addToast(list,{message:'m'+i},10+i);
 assert.equal(list.length,toastLimit);assert.deepEqual(list.map(t=>t.message),['m2','m3','m4','m5']);assert.equal(list[0].tone,'info');
});

test('the provider renders its children and a live region for toasts',()=>{
 const html=renderToStaticMarkup(createElement(ToastProvider,null,createElement('main',null,'app')));
 assert.match(html,/<main>app<\/main><div class="toasts" aria-live="polite"><\/div>/);
});
