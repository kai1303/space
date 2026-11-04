import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSearchQuery} from '@space/server/search-query';

test('parses phrases and supported filters without allowing raw engine filters',()=>{
 assert.deepEqual(parseSearchQuery('"deploy failed" in:#engineering from:me has:link is:thread after:2026-01-01'),{text:'"deploy failed"',channel:'engineering',from:'me',hasLink:true,threadsOnly:true,after:1767225600000});
 assert.equal(parseSearchQuery('https://example.com').text,'https://example.com');
 for(const query of ['"unclosed','in:','unknown:all','after:2026-02-31','a'.repeat(501),'a\0b'])assert.throws(()=>parseSearchQuery(query));
});
