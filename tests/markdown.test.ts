import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../src/Markdown.js';
import {markdownText,markdownCode} from '../server/markdown.js';
const render=(text:string)=>renderToStaticMarkup(createElement(Markdown,{children:text}));
test('renders headings, nested lists, tasks, fenced code, tables and emphasis',()=>{
 const html=render('# Plan\n\n## Checks\n\n### Cluster\n\n1. Inspect\n   - Logs\n\n- [ ] Review\n- [x] Read\n\n```yaml\nkind: Secret\n```\n\n**Bold** and *italic* and `code`\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
 for(const tag of ['<h1>Plan','<h2>Checks','<h3>Cluster','<ol>','<ul>','type="checkbox"','disabled=""','checked=""','<pre><code class="language-yaml">','<table>','<strong>Bold','<em>italic'])assert.ok(html.includes(tag),tag);
});
test('untrusted Markdown cannot execute HTML, navigate unsafe schemes or load remote images',()=>{
 const html=render('<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel">\n\n[bad](javascript:alert%281%29) [file](file:///etc/passwd) [local](/api/vault) [good](https://example.org)\n\n![tracker](https://tracker.example/pixel)');
 assert.doesNotMatch(html,/<script|<img|javascript:|file:|href="\/api|src=/);
 assert.match(html,/href="https:\/\/example.org"/);assert.match(html,/rel="noopener noreferrer"/);
});
test('Markdown preserves literal commands and source text, machine template values cannot inject markup',()=>{
 assert.match(render('```sh\necho "<script>"\n```'),/&lt;script&gt;/);
 assert.equal(markdownText('x\n# fake [link](bad)'), 'x \\# fake \\[link\\]\\(bad\\)');
 const html=render(markdownCode('path`with`backticks.md'));assert.match(html,/<code>path`with`backticks.md<\/code>/);
});
