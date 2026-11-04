import { beforeEach, expect, it } from 'vitest';
import { readComposerDrafts, persistComposerDrafts } from './composer-drafts.js';
beforeEach(()=>localStorage.clear());
it('keeps drafts isolated by user, drops sent/empty documents and survives reloads',()=>{
  persistComposerDrafts('kai',{channel:{ops:[{insert:'Draft'}]},sent:{ops:[]}});
  expect(readComposerDrafts('kai')).toEqual({channel:{ops:[{insert:'Draft'}]}});
  expect(readComposerDrafts('other')).toEqual({});
  persistComposerDrafts('kai',{channel:{ops:[]}});
  expect(readComposerDrafts('kai')).toEqual({});
});
it('bounds stored drafts and ignores corrupt or oversized input',()=>{
  persistComposerDrafts('kai',Object.fromEntries(Array.from({length:120},(_,i)=>[String(i),{ops:[{insert:'Draft'}]}])));
  expect(Object.keys(readComposerDrafts('kai'))).toHaveLength(100);
  localStorage.setItem('space:composer-drafts:kai','bad json');expect(readComposerDrafts('kai')).toEqual({});
  localStorage.setItem('space:composer-drafts:kai','x'.repeat(500001));expect(readComposerDrafts('kai')).toEqual({});
});
