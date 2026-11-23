/* global zip */
(() => {
  'use strict';
  const MiB = 1024 * 1024;
  const limits = { archive: 64 * MiB, expanded: 256 * MiB, entries: 4000, text: 4 * MiB, allText: 32 * MiB };
  const isConversation = path => /(^|\/)conversations?\//i.test(path);
  const isText = path => /\.(tex|ltx|cls|sty|json)$/i.test(path) && !isConversation(path);
  const validPath = path => path.length <= 1024 && !/[\\:\u0000-\u001f\u007f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');

  async function readArchive(blob, { signal, onFile } = {}) {
    if (!blob.size) throw new Error('This file is empty. Choose the original ZIP export.');
    if (blob.size > limits.archive) throw new Error('This ZIP exceeds 64 MiB. Check individual project exports instead.');
    const reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false, signal });
    const files = new Map();
    const declaredPaths = new Set();
    const directories = new Set();
    let declaredBytes = 0, retainedBytes = 0, count = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        signal?.throwIfAborted();
        if (++count > limits.entries) throw new Error('This ZIP contains more than 4,000 entries. Check one project at a time.');
        const name = entry.filename.replace(/^(?:\.\/)+/, '');
        if (!name && entry.directory && entry.filename.startsWith('./')) continue;
        const path = entry.directory ? name.replace(/\/$/, '') : name;
        if (!validPath(path)) throw new Error('This ZIP contains an unsafe or unsupported file path.');
        const unixType = (entry.externalFileAttributes >>> 28) & 15;
        if (entry.encrypted || (unixType && unixType !== 8 && unixType !== 4)) {
          throw new Error('Encrypted files, links and special files cannot be inspected. Export a ZIP of regular files.');
        }
        if (declaredPaths.has(path) || (!entry.directory && directories.has(path))) {
          throw new Error('Conflicting ZIP entries share the path ' + path);
        }
        declaredPaths.add(path);
        let parent = path;
        while (parent.includes('/')) {
          parent = parent.slice(0, parent.lastIndexOf('/'));
          if (files.has(parent)) throw new Error('A file is also used as a directory: ' + parent);
          directories.add(parent);
        }
        if (entry.directory) { directories.add(path); continue; }
        declaredBytes += entry.uncompressedSize;
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.expanded) {
          throw new Error('The expanded archive exceeds 256 MiB. Check one project at a time.');
        }
        const retain = isText(path) && entry.uncompressedSize <= limits.text;
        if (retain && (retainedBytes += entry.uncompressedSize) > limits.allText) {
          throw new Error('The archive contains more than 32 MiB of source and metadata. Check one project at a time.');
        }
        onFile?.(path);
        let size = 0;
        const chunks = [];
        const writer = new WritableStream({
          write(chunk) {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > limits.expanded) throw new Error('Expanded data exceeds the declared size.');
            if (retain) chunks.push(chunk.slice());
          }
        });
        try {
          await entry.getData(writer, { checkSignature: true, checkOverlappingEntry: true, signal });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new Error('Could not verify ' + path + '. Re-export the original ZIP. (' + error.message + ')');
        }
        if (size !== entry.uncompressedSize) throw new Error('Incomplete file in ZIP: ' + path);
        let text, skipped;
        if (retain) {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          // Keep a UTF-8 BOM inside the string so patching another span preserves its bytes.
          try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { skipped = 'Text is not UTF-8.'; }
        } else if (isText(path)) { skipped = 'Text exceeds the 4 MiB per-file inspection limit.'; }
        files.set(path, { size, text, skipped });
      }
      return files;
    } finally {
      await reader.close();
    }
  }
  // Only called on the original Blob already verified by readArchive. Unedited ZIP
  // members retain their compressed payload. An untouched archive is returned verbatim.
  async function exportArchive(blob, changes) {
    if (!changes.size) return blob;
    const reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false });
    const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
    const written = new Set();
    let total = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        const name = entry.filename.replace(/^(?:\.\/)+/, '');
        const options = { directory: entry.directory, comment: entry.comment, lastModDate: entry.lastModDate,
          externalFileAttributes: entry.externalFileAttributes, versionMadeBy: entry.versionMadeBy };
        if (entry.directory) {
          await writer.add(entry.filename, undefined, options);
        } else if (changes.has(name)) {
          if (!/\.(?:tex|ltx)$/i.test(name)) throw new Error('Only LaTeX source files can be edited.');
          const bytes = new TextEncoder().encode(changes.get(name));
          if (bytes.length > limits.text) throw new Error('An edited source exceeds the 4 MiB text limit.');
          total += bytes.length;
          await writer.add(entry.filename, new zip.Uint8ArrayReader(bytes), options);
          written.add(name);
        } else {
          total += entry.uncompressedSize;
          const compressed = await entry.getData(new zip.BlobWriter(), { passThrough: true });
          await writer.add(entry.filename, new zip.BlobReader(compressed), { ...options, passThrough: true,
            compressionMethod: entry.compressionMethod, uncompressedSize: entry.uncompressedSize, signature: entry.signature });
        }
        if (total > limits.expanded) throw new Error('Edited project exceeds the expanded archive limit.');
      }
      if (written.size !== changes.size) throw new Error('An edited source was not present in the original archive.');
      const output = await writer.close(reader.comment);
      if (output.size > limits.archive) throw new Error('Edited project exceeds the 64 MiB ZIP limit.');
      return output;
    } finally {
      await reader.close();
    }
  }
  globalThis.PaperColabArchive = { readArchive, exportArchive, isConversation };
})();
