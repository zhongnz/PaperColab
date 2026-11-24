/* global PaperColabEngines, PaperColabBlocks */
(() => {
  'use strict';
  const E = PaperColabEngines;

  function renderMath(host, latex) {
    if (latex.length > 4096) return false;
    const tex = latex.trim();
    const delimited = /^(?:\$\$([\s\S]+)\$\$|\\\[([\s\S]+)\\\]|\$([\s\S]+)\$|\\\(([\s\S]+)\\\))$/.exec(tex);
    const environment = /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]+\\end\{\1\}$/.test(tex);
    if (!delimited && !environment) return false;
    const expression = environment ? tex : delimited.slice(1).find(value => value !== undefined);
    try {
      E.KaTeX.render(expression, host, { output: 'mathml', displayMode: Boolean(environment || delimited[1] || delimited[2]),
        trust: false, throwOnError: true, strict: 'ignore', maxExpand: 300, maxSize: 12 });
      return true;
    } catch {
      return false;
    }
  }

  const documentNode = E.TiptapNode.create({ name: 'doc', topNode: true, content: 'paragraph' });
  const paragraph = E.TiptapNode.create({ name: 'paragraph', group: 'block', content: 'inline*',
    parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0] });
  const text = E.TiptapNode.create({ name: 'text', group: 'inline' });
  const token = E.TiptapNode.create({ name: 'texToken', inline: true, group: 'inline', atom: true, selectable: false,
    addAttributes: () => ({ latex: { default: '', rendered: false } }),
    renderHTML({ node }) {
      const latex = node.attrs.latex;
      return ['span', { class: 'tex-token', contenteditable: 'false', title: latex, 'aria-label': latex }, latex];
    },
    addNodeView() {
      return ({ node }) => {
        const latex = node.attrs.latex;
        const dom = document.createElement('span');
        dom.className = 'tex-token';
        dom.contentEditable = 'false';
        dom.title = latex;
        if (renderMath(dom, latex)) dom.classList.add('tex-math');
        else dom.textContent = latex;
        return { dom };
      };
    } });
  const bold = E.TiptapMark.create({ name: 'bold', parseHTML: () => [{ tag: 'strong' }, { tag: 'b' }], renderHTML: () => ['strong', 0] });
  const italic = E.TiptapMark.create({ name: 'italic',
    addAttributes: () => ({ command: { default: null, rendered: false } }), parseHTML: () => [{ tag: 'em' }, { tag: 'i' }], renderHTML: () => ['em', 0] });
  const runHistory = (editor, command) => command(editor.state, editor.view.dispatch);

  function visual(host, content, { onChange, onState, onProtected }) {
    const editing = E.Extension.create({
      name: 'blockEditing',
      addProseMirrorPlugins() {
        return [E.history(), new E.Plugin({ filterTransaction(tr, state) {
          if (!tr.docChanged || tr.getMeta('papercolab-source-update')) return true;
          const old = PaperColabBlocks.tokens(state.doc.toJSON());
          const next = PaperColabBlocks.tokens(tr.doc.toJSON());
          if (old.length === next.length && old.every((value, i) => value === next[i])) return true;
          onProtected();
          return false;
        } })];
      },
      addKeyboardShortcuts() {
        return { 'Mod-z': () => runHistory(this.editor, E.undo), 'Mod-Shift-z': () => runHistory(this.editor, E.redo),
          'Mod-y': () => runHistory(this.editor, E.redo), 'Mod-b': () => this.editor.commands.toggleMark('bold'),
          'Mod-i': () => this.editor.commands.toggleMark('italic'), Enter: () => true, 'Shift-Enter': () => true };
      }
    });
    const editor = new E.Editor({
      element: host, extensions: [documentNode, paragraph, text, bold, italic, token, editing], content,
      injectCSS: false, enableInputRules: false, enablePasteRules: false,
      editorProps: { attributes: { class: 'visual-prose', 'aria-label': 'Visual block text', role: 'textbox',
        spellcheck: 'true' }, handlePaste(view, event) {
        if (!event.clipboardData) return false;
        event.preventDefault();
        const pasted = event.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' ');
        if (pasted) view.dispatch(view.state.tr.insertText(pasted));
        return true;
      } },
      onUpdate: ({ editor }) => onChange(editor.getJSON()),
      onTransaction: onState, onSelectionUpdate: onState
    });
    editor.setFromSource = nextContent => {
      const { state, view } = editor;
      const next = editor.schema.nodeFromJSON(nextContent);
      if (state.doc.eq(next)) return;
      view.dispatch(state.tr.replaceWith(0, state.doc.content.size, next.content)
        .setMeta('papercolab-source-update', true).setMeta('preventUpdate', true).setMeta('addToHistory', false));
    };
    return editor;
  }

  function source(host, initial, readOnly, onChange) {
    let quiet = false;
    const view = new E.CodeView({ parent: host, doc: initial, extensions: [
      E.lineNumbers(), E.CodeView.lineWrapping, E.StreamLanguage.define(E.stex),
      E.syntaxHighlighting(E.defaultHighlightStyle), E.codeHistory(), E.codeKeymap.of([...E.historyKeymap, ...E.defaultKeymap]),
      E.CodeState.readOnly.of(readOnly), E.CodeView.editable.of(!readOnly),
      E.CodeView.contentAttributes.of({ 'aria-label': 'Block LaTeX source', 'aria-readonly': String(readOnly), spellcheck: 'false' }),
      E.CodeView.updateListener.of(update => { if (!quiet && update.docChanged) onChange(update.state.doc.toString()); })
    ] });
    return { destroy: () => view.destroy(), value: () => view.state.doc.toString(), set(value) {
      const next = value.replace(/\r\n?/g, '\n');
      if (next === view.state.doc.toString()) return;
      quiet = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } }); }
      finally { quiet = false; }
    } };
  }
  globalThis.PaperColabEditors = { visual, source, renderMath, undo: editor => runHistory(editor, E.undo), redo: editor => runHistory(editor, E.redo),
    canUndo: editor => E.undo(editor.state), canRedo: editor => E.redo(editor.state) };
})();
