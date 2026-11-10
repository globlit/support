import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {ProfileMenu,initials} from '../src/ProfileMenu.js';

test('the profile shows up to two initials',()=>{
 assert.equal(initials('Support engineer'),'SE');assert.equal(initials('  ada  '),'A');assert.equal(initials('Jean Pierre Martin'),'JP');assert.equal(initials(''),'?');
});

test('the profile button opens a menu and keeps the tour focus target',()=>{
 const html=renderToStaticMarkup(createElement(ProfileMenu,{name:'Support engineer',theme:'auto',vaultUnlocked:true,busy:false,onTheme:()=>{},onSettings:()=>{},onLock:()=>{}}));
 assert.match(html,/data-tour="settings"/);assert.match(html,/aria-haspopup="menu"/);assert.match(html,/aria-expanded="false"/);
 assert.match(html,/<span class="profile-avatar" aria-hidden="true">SE<\/span>/);assert.match(html,/title="Support engineer · Vault unlocked"/);assert.match(html,/class="profile-status unlocked"/);assert.match(html,/<span class="profile-sub">Vault unlocked<\/span>/);
 assert.doesNotMatch(html,/role="menu"/);
});
