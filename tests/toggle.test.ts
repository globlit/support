import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {Toggle} from '../src/Toggle.js';
import {clampSize} from '../src/AgentConsole.js';

test('a toggle renders a labelled switch with its hint',()=>{
 const html=renderToStaticMarkup(createElement(Toggle,{label:'Let the agent run commands',hint:'No credentials.',checked:true,onChange:()=>{}}));
 assert.match(html,/<label class="toggle"><input type="checkbox" role="switch" aria-checked="true" checked=""/);
 assert.match(html,/<span class="toggle-text">Let the agent run commands<small>No credentials\.<\/small><\/span>/);
});

test('the console size stays between 320 × 180 px and the viewport minus 32 px',()=>{
 assert.deepEqual(clampSize(100,50,1440,900),{w:320,h:180});
 assert.deepEqual(clampSize(5000,5000,1440,900),{w:1408,h:868});
 assert.deepEqual(clampSize(700.4,400.6,1440,900),{w:700,h:401});
});
