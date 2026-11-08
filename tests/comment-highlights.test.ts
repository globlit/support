import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../src/Markdown.js';
import {commentRanges} from '../src/comment-highlights.js';
import type {PlanAnnotation} from '../src/model.js';
const annotation=(quote:string):PlanAnnotation=>({quote,version:1,kind:'comment'});
test('anchors identify the selected occurrence and overlapping comments merge',()=>{
 const text='Check pods, then check pods';const start=text.lastIndexOf('pods');
 assert.deepEqual(commentRanges(text,[{...annotation('pods'),start,end:start+4}]),[{start,end:start+4}]);
 assert.deepEqual(commentRanges('abc def ghi',[annotation('abc def'),annotation('def ghi')]),[{start:0,end:11}]);
 assert.deepEqual(commentRanges('a\n\n  b',[annotation('a b')]),[{start:0,end:6}]);
});
test('highlights span rich inline text without flattening formatting or changing content',()=>{
 const html=renderToStaticMarkup(createElement(Markdown,{children:'Check **pods** and `logs`.',annotations:[annotation('pods and logs')]}));
 assert.match(html,/<strong><mark[^>]+>pods<\/mark><\/strong>/);assert.match(html,/<code><mark[^>]+>logs<\/mark><\/code>/);assert.match(html,/comment-highlight/);assert.doesNotMatch(html,/<blockquote/);
 const plain=renderToStaticMarkup(createElement(Markdown,{children:'Check **pods** and `logs`.'}));assert.doesNotMatch(plain,/<mark/);
});
test('highlighting keeps Markdown safety and task-list rendering intact',()=>{
 const html=renderToStaticMarkup(createElement(Markdown,{children:'- [x] Check pods\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)',annotations:[annotation('Check pods')]}));
 assert.match(html,/checked=""/);assert.match(html,/<mark/);assert.doesNotMatch(html,/<script|javascript:/);
});
