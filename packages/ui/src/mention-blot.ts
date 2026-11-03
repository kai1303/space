import type Quill from 'quill';
import type InlineBlot from 'quill/blots/inline.js';
import { parseMention } from '@space/contracts';
// Keep readable string operations while the editor treats each identity as one token.
export function registerMention(Editor: typeof Quill) {
  if(Editor.imports['formats/mention'])return;
  const Inline=Editor.import('blots/inline') as typeof InlineBlot;
  class Mention extends Inline {
    static blotName='mention';static tagName='SPAN';static className='sp-mention-token';
    static create(value:unknown){const node=super.create();node.setAttribute('data-mention',JSON.stringify(parseMention(value)));node.setAttribute('contenteditable','false');return node;}
    static formats(node:HTMLElement){try{return parseMention(JSON.parse(node.getAttribute('data-mention')??'null'));}catch{return undefined;}}
  }
  Editor.register(Mention,true);
}
