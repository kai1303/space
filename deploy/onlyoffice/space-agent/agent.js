// This function runs as a single editor command. The comparison and replacement
// must stay together so another edit or a moved selection cannot slip between them.
function workOnSelection() {
  const doc = Api.GetDocument();
  const range = doc.GetRangeBySelect();
  if (!range) return { status: 'empty' };
  const text = range.GetText();
  if (!text || !text.trim() || text.length > 16000) return { status: 'empty' };
  const start = range.GetStartPos();
  const end = range.GetEndPos();
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return { status: 'empty' };
  const paragraphs = range.GetAllParagraphs();
  const first = paragraphs[0]?.GetInternalId();
  const last = paragraphs[paragraphs.length - 1]?.GetInternalId();
  if (!first || !last) return { status: 'empty' };
  const expected = Asc.scope.expected;
  if (!expected) return { status: 'selected', text, start, end, first, last };
  if (text !== expected.text || start !== expected.start || end !== expected.end ||
      first !== expected.first || last !== expected.last) return { status: 'changed' };
  if (!Asc.scope.write) return { status: 'matched' };
  return { status: doc.EnterText(Asc.scope.replacement) ? 'applied' : 'error' };
}

window.Asc.plugin.init = function () {
  if (window.top === window || this.spaceConnected) return;
  this.spaceConnected = true;
  const plugin = window.Asc.plugin;
  const channel = new MessageChannel();
  const port = channel.port1;
  let selection;
  let busy = false;
  let markTimer;
  const label = document.getElementById('cursor-label');
  const hide = () => {
    label.hidden = true;
    plugin.executeMethod('UnShowInputHelper', [plugin.guid, true]);
  };
  port.onmessage = ({ data }) => {
    if (!data || typeof data.id !== 'string' || busy) return;
    const reply = (status, text) => port.postMessage({ id: data.id, status, text });
    if (data.action !== 'read' && data.action !== 'apply') return;
    const apply = data.action === 'apply';
    if (apply && (!selection || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 16000)) {
      reply('changed'); return;
    }
    busy = true;
    Asc.scope.expected = apply ? selection : null;
    Asc.scope.replacement = apply ? data.text : '';
    selection = undefined;
    const finish = result => {
      busy = false;
      if (result?.status === 'selected') selection = result;
      reply(result?.status || 'error', selection?.text);
    };
    Asc.scope.write = false;
    plugin.callCommand(workOnSelection, false, false, result => {
      if (!apply || result?.status !== 'matched') return finish(result);
      clearTimeout(markTimer);
      label.hidden = false;
      plugin.executeMethod('ShowInputHelper', [plugin.guid, 74, 24, false], () => {
        Asc.scope.write = true;
        plugin.callCommand(workOnSelection, false, true, written => {
          markTimer = setTimeout(hide, 650);
          finish(written);
        });
      });
    });
  };
  window.top.postMessage({ type: 'space-office-selection-ready' }, '*', [channel.port2]);
};
