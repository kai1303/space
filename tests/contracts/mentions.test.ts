import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRichDocument, documentMentions } from '@space/contracts';
const id='00000000-0000-4000-8000-000000000001';
test('rich documents retain validated mention identity and readable text',()=>{
 const mention={kind:'user' as const,id,label:'Kai'};
 const doc={ops:[{insert:'Hi '},{insert:'@Kai',attributes:{mention}},{insert:'\n'}]};
 assert.deepEqual(parseRichDocument(doc),doc);
 assert.deepEqual(documentMentions(doc),[mention]);
 for(const mention of [{kind:'admin',id,label:'Kai'},{kind:'user',id:'wrong',label:'Kai'},{kind:'broadcast',id:'all',label:'all'},{kind:'user',id,label:'Kai',role:'owner'}]) assert.throws(()=>parseRichDocument({ops:[{insert:'@Kai',attributes:{mention}}]}),{status:400});
 assert.throws(()=>parseRichDocument({ops:[{insert:'@Different',attributes:{mention}}]}),{status:400});
});
test('code, links and quoted lines do not activate mention references',()=>{
 const mention={kind:'agent' as const,id,label:'Agent'};
 for(const attrs of [{code:true},{link:'https://example.test'}]) assert.deepEqual(documentMentions({ops:[{insert:'@Agent',attributes:{mention,...attrs}},{insert:'\n'}]}),[]);
 for(const attrs of [{'code-block':true},{blockquote:true}]) assert.deepEqual(documentMentions({ops:[{insert:'@Agent',attributes:{mention}},{insert:'\n',attributes:attrs}]}),[]);
});
