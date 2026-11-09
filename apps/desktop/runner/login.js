const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 100, screenReaderMode: true, allowProposedApi: false });
terminal.open(document.getElementById('login'));
window.signIn.output(text => terminal.write(text));
terminal.onData(text => window.signIn.input(text));
terminal.focus();
