/* global PaperColabEngines, PaperColabBlocks */
(() => {
  'use strict';
  const E = PaperColabEngines;
  const documentNode = E.TiptapNode.create({ name: 'doc', topNode: true, content: 'paragraph' });
  const paragraph = E.TiptapNode.create({ name: 'paragraph', group: 'block', content: 'inline*',
    parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0] });
  const text = E.TiptapNode.create({ name: 'text', group: 'inline' });
  const token = E.TiptapNode.create({ name: 'texToken', inline: true, group: 'inline', atom: true, selectable: false,
    addAttributes: () => ({ latex: { default: '', rendered: false } }),
    renderHTML({ node }) {
      const latex = node.attrs.latex;
      return ['span', { class: 'tex-token', contenteditable: 'false', title: latex, 'aria-label': latex }, latex];
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
          if (!tr.docChanged) return true;
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
    return new E.Editor({
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
  // Shared scientific field controls: host applications supply persistence and authority.
  function scientificFields(host, model) {
    const panel=document.createElement('div');
    panel.className='scientific-panel';
    const title=document.createElement('strong');
    title.textContent={equation:'Equation',table:'Table',figure:'Figure',list:'List'}[model.type];
    panel.append(title);
    const inputs=[];
    function field(index) {
      const data=model.fields[index], label=document.createElement('label');
      const input=document.createElement(model.type==='equation'?'textarea':'input');
      input.value=data.value; input.setAttribute('aria-label',data.name);
      input.spellcheck=false;
      if (model.type==='equation') input.rows=3;
      label.append(input);
      inputs[index]=input;
      return label;
    }
    if (model.type==='table') {
      const wrap=document.createElement('div'); wrap.className='scientific-table-scroll';
      const table=document.createElement('table'), body=document.createElement('tbody');
      for (const row of model.rows) {
        const tr=document.createElement('tr');
        for (const i of row) { const td=document.createElement('td'); td.append(field(i)); tr.append(td); }
        body.append(tr);
      }
      table.append(body); wrap.append(table); panel.append(wrap);
    } else {
      for (let i=0;i<model.fields.length;i++) {
        const row=document.createElement('div'); row.className='scientific-field';
        const name=document.createElement('span'); name.textContent=model.fields[i].name;
        row.append(name,field(i)); panel.append(row);
      }
    }
    if (model.type==='equation') {
      const preview=document.createElement('div'); preview.className='math-linear-preview';
      const symbols={alpha:'α',beta:'β',gamma:'γ',delta:'δ',theta:'θ',lambda:'λ',mu:'μ',pi:'π',sigma:'σ',omega:'ω',sum:'∑',int:'∫',times:'×',cdot:'·',pm:'±',leq:'≤',geq:'≥',neq:'≠',infty:'∞'};
      const render=()=>{preview.textContent='Linear preview: '+inputs[0].value.trim().replace(/\\([A-Za-z]+)/g,(m,k)=>symbols[k]??m);};
      inputs[0].addEventListener('input',render); render(); panel.append(preview);
    }
    host.append(panel);
    return {panel, inputs};
  }
  globalThis.PaperColabEditors = { visual, source, scientificFields, undo: editor => runHistory(editor, E.undo), redo: editor => runHistory(editor, E.redo),
    canUndo: editor => E.undo(editor.state), canRedo: editor => E.redo(editor.state) };
})();
