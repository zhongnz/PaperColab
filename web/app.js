/* global PaperColabArchive, PaperColabInspect, PaperColabExample */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const sampleName = 'estuary-example.zip';
  let active, session, selection;

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function notices(container, rows) {
    const children = rows.slice(0, 100).map(item => {
      const itemEl = node('div', undefined, 'notice ' + item.level);
      itemEl.append(node('p', item.message));
      if (item.path) itemEl.append(node('code', item.path));
      return itemEl;
    });
    if (rows.length > children.length) children.push(node('p', 'Save the report for all ' + rows.length + ' findings.', 'muted'));
    container.replaceChildren(...children);
  }

  function list(rows) {
    const items = node('ul', undefined, 'record-list');
    for (const [title, description] of rows.slice(0, 100)) {
      const item = node('li');
      item.append(node('code', title));
      if (description) item.append(node('small', description));
      items.append(item);
    }
    if (rows.length > 100) items.append(node('li', 'Showing 100 of ' + rows.length + '. Save the report for the full list.'));
    return items;
  }

  function details(title, content) {
    const el = node('details');
    el.append(node('summary', title), content);
    return el;
  }

  function showRoot() {
    if (!session) return;
    const root = $('root').value;
    selection = root ? PaperColabInspect.inspectRoot(session.data, root) : null;
    $('root-panel').hidden = !selection;
    $('build-panel').hidden = !selection;
    if (!selection) return;
    const refs = selection.references;
    const problems = refs.filter(item => item.status === 'missing' || item.status === 'review');
    const warnings = [...selection.notes, ...problems.map(item => ({
      level: item.status, path: item.source + ', line ' + item.line,
      message: (item.target || '\\' + item.command) + ' — ' + item.reason
    }))];
    $('root-status').textContent = warnings.length ? warnings.length + ' item' + (warnings.length === 1 ? '' : 's') + ' to check for this root' :
      'No missing literal references found for this root';
    notices($('root-notes'), warnings);
    const found = refs.filter(item => item.status === 'found');
    const toolchain = refs.filter(item => item.status === 'toolchain');
    $('references').replaceChildren();
    if (found.length) $('references').append(details('Located references (' + found.length + ')',
      list(found.map(item => [item.resolved, item.source + ', line ' + item.line]))));
    if (toolchain.length) $('references').append(details('TeX distribution lookups (' + toolchain.length + ')',
      list(toolchain.map(item => [item.target, '\\' + item.command + ' · ' + item.source + ', line ' + item.line]))));
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    $('build-command').textContent = 'docker pull texlive/texlive:TL2025-historic\npython3 scripts/check_build.py --root ' +
      quote(root) + ' --pdf checked.pdf -- ' + quote(session.name);
  }

  function showReport() {
    const { data, name, sample } = session;
    $('report-heading').textContent = name;
    const metrics = [[data.files.size, 'files'], [data.roots.length, data.roots.length === 1 ? 'manuscript root' : 'manuscript roots']];
    const metricNodes = metrics.map(([value, label]) => {
      const el = node('span');
      el.append(node('strong', value), document.createTextNode(label));
      return el;
    });
    metricNodes.push(node('span', 'PDF build pending'));
    $('metrics').replaceChildren(...metricNodes);
    notices($('archive-notes'), data.notes);
    $('root').replaceChildren(...data.roots.map(root => new Option(root, root)));
    const json = data.metadata.map(item => [item.path, item.kind + ' · ' + item.detail]);
    const meta = $('metadata');
    meta.replaceChildren();
    if (json.length) meta.append(list(json));
    if (data.conversations) meta.append(node('p', 'Archived conversation files: ' + data.conversations + '. Contents are excluded from the report.', 'muted'));
    meta.append(details('All files (' + data.files.size + ')', list([...data.files].map(([path, entry]) => [path, entry.size + ' bytes']))));
    $('sample-download').hidden = !sample;
    showRoot();
    $('start').hidden = true;
    $('report').hidden = false;
    $('report-heading').focus({ preventScroll: true });
  }

  async function openFile(file, sample = false) {
    if (!file) return;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    session = null;
    selection = null;
    $('error').hidden = true;
    $('start').hidden = false;
    $('report').hidden = true;
    for (const el of $('report').querySelectorAll('details[open]')) el.open = false;
    const progress = $('progress');
    progress.hidden = false;
    progress.textContent = 'Opening ' + file.name + '…';
    try {
      const files = await PaperColabArchive.readArchive(file, { signal: controller.signal });
      if (controller.signal.aborted) return;
      session = { data: PaperColabInspect.inventory(files), name: file.name, sample };
      showReport();
    } catch (error) {
      if (controller.signal.aborted) return;
      session = null;
      $('error').textContent = 'Could not inspect this ZIP. ' + error.message;
      $('error').hidden = false;
    } finally {
      if (!controller.signal.aborted) progress.hidden = true;
    }
  }

  $('choose').onclick = $('again').onclick = () => $('file').click();
  $('file').onchange = event => {
    const file = event.target.files[0];
    event.target.value = '';
    openFile(file);
  };
  const demo = () => new File([Uint8Array.from(atob(PaperColabExample), char => char.charCodeAt(0))], sampleName, { type: 'application/zip' });
  $('example').onclick = () => openFile(demo(), true);
  $('sample-download').onclick = () => download(demo(), sampleName);
  $('root').onchange = showRoot;
  $('download').onclick = () => {
    if (!session) return;
    const { data, name } = session;
    const report = {
      schemaVersion: 1, archive: name, build: 'not-run', roots: data.roots, selectedManuscript: selection,
      archiveFindings: data.notes, metadata: data.metadata, conversationFiles: data.conversations,
      files: [...data.files].map(([path, entry]) => ({ path, bytes: entry.size }))
    };
    download(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }), name.replace(/\.zip$/i, '') + '-report.json');
  };
  const drop = $('drop');
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => {
    event.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', event => {
    if (!drop.contains(event.relatedTarget)) drop.classList.remove('drag');
  });
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('drag');
    openFile(event.dataTransfer.files[0]);
  });
})();
