import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { readPdfPages } from './dist/pdf-text.js';
const pdf = await readFile(new URL('../../tests/fixtures/preview/two-pages.pdf', import.meta.url));
const read = (bytes, page = 1, count = 8) => {
  return readPdfPages({ read: async (key, maxBytes) => {
    assert.equal(key, 'files/source');
    assert.equal(maxBytes, bytes.length);
    return bytes;
  } }, 'files/source', bytes.length, page, count);
};

test('reads text by physical page and reports the original page count', async () => {
  const result = await read(pdf, 2, 1);
  assert.equal(result.status, 'readable');
  assert.equal(result.page_count, 2);
  assert.deepEqual(result.pages.map(p => p.page), [2]);
  assert.match(result.pages[0].text, /Page 2 of 2/);
  assert.doesNotMatch(result.pages[0].text, /Page 1/);
  assert.equal(result.pages[0].truncated, false);
  const both = await read(pdf);
  assert.deepEqual(both.pages.map(p => p.page), [1, 2]);
});

test('distinguishes pages without text, missing pages and malformed PDFs', async () => {
  // Preserve fixture offsets and drawing operators, including the page's colored rectangle.
  const noText = Buffer.from(pdf.toString('ascii').replace(/BT .*? ET/g, operators => ' '.repeat(operators.length)));
  assert.deepEqual(await read(noText, 2, 1), {kind:'pdf',page_count:2,status:'no_text',pages:[{page:2,text:'',truncated:false}]});
  assert.deepEqual(await read(pdf, 7, 1), {kind:'pdf',page_count:2,status:'out_of_range',pages:[]});
  assert.deepEqual(await read(Buffer.from('%PDF-1.4\ninvalid')), {kind:'pdf',page_count:null,status:'unavailable',pages:[]});
});

test('rejects invalid windows before touching object storage', async () => {
  const storage = { read: () => assert.fail('object read') };
  for (const [first, count] of [[0, 1], [1, 0], [1, 9], [1.5, 1]]) {
    await assert.rejects(() => readPdfPages(storage, 'key', pdf.length, first, count), {code:'invalid_pdf_page'});
  }
});

test('limits concurrent reads and releases capacity after storage errors', async () => {
  const gates = [];
  const storage = { read: () => new Promise((_resolve, reject) => gates.push(reject)) };
  const first = readPdfPages(storage, 'key', 5), second = readPdfPages(storage, 'key', 5);
  const settled = Promise.allSettled([first, second]);
  try { await assert.rejects(readPdfPages(storage, 'key', 5), {code:'pdf_reader_busy'}); }
  finally { gates.forEach(reject => reject(new Error('storage unavailable'))); }
  assert.ok((await settled).every(item => item.status === 'rejected' && item.reason.message === 'storage unavailable'));
  assert.equal((await read(pdf)).status, 'readable');
});

function singlePagePdf(operators) {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300000 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${operators.length} >> stream
${operators}
endstream endobj
trailer << /Root 1 0 R >>
%%EOF`);
}

test('a large page returns a bounded excerpt marked as truncated', async () => {
  const operators = 'BT /F1 10 Tf 40 700 Td (' + 'Evidence '.repeat(3000) + ') Tj ET';
  const result = await read(singlePagePdf(operators), 1, 1);
  assert.equal(result.status, 'readable');
  assert.equal(result.pages[0].text.length, 16000);
  assert.equal(result.pages[0].truncated, true);
});

test('clipping PDF text preserves complete Unicode characters', async () => {
  const unicode = Buffer.from('a'+'😀'.repeat(9000), 'utf16le').swap16().toString('hex');
  const operators = `/Span << /ActualText <FEFF${unicode}> >> BDC BT /F1 10 Tf 40 700 Td (Actual text) Tj ET EMC`;
  const result = await read(singlePagePdf(operators), 1, 1);
  assert.equal(result.status, 'readable');
  assert.equal(result.pages[0].truncated, true);
  assert.equal(result.pages[0].text.length, 15999);
  assert.equal(result.pages[0].text.isWellFormed(), true);
});

test('the extraction budget includes object storage and returns an explicit unavailable result on timeout', async () => {
  const storage = { read: async (_key, _max, _range, _etag, signal) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    signal.throwIfAborted();
    assert.fail('expired input must not reach the PDF decoder');
  } };
  assert.deepEqual(await readPdfPages(storage, 'key', 30, 1, 1, 10),
    {kind:'pdf',page_count:null,pages:[],status:'unavailable'});
});
