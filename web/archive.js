/* global zip */
(() => {
  'use strict';
  const MiB = 1024 * 1024;
  const limits = { archive: 64 * MiB, expanded: 256 * MiB, entries: 4000, text: 4 * MiB, allText: 32 * MiB };
  const isConversation = path => /(^|\/)conversations?\//i.test(path);
  const isText = path => /\.(tex|ltx|cls|sty|bib|json)$/i.test(path) && !isConversation(path);
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
    let total = 0, retainedText = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        const name = entry.filename.replace(/^(?:\.\/)+/, '');
        const options = { directory: entry.directory, comment: entry.comment, lastModDate: entry.lastModDate,
          externalFileAttributes: entry.externalFileAttributes, versionMadeBy: entry.versionMadeBy };
        let size = entry.uncompressedSize;
        if (entry.directory) {
          await writer.add(entry.filename, undefined, options);
        } else if (changes.has(name)) {
          if (!/\.(?:tex|ltx)$/i.test(name)) throw new Error('Only LaTeX source files can be edited.');
          const bytes = new TextEncoder().encode(changes.get(name));
          if (bytes.length > limits.text) throw new Error('An edited source exceeds the 4 MiB text limit.');
          size = bytes.length;
          await writer.add(entry.filename, new zip.Uint8ArrayReader(bytes), options);
          written.add(name);
        } else {
          const compressed = await entry.getData(new zip.BlobWriter(), { passThrough: true });
          await writer.add(entry.filename, new zip.BlobReader(compressed), { ...options, passThrough: true,
            compressionMethod: entry.compressionMethod, uncompressedSize: entry.uncompressedSize, signature: entry.signature });
        }
        total += size;
        if (!entry.directory && isText(name) && size <= limits.text) retainedText += size;
        if (retainedText > limits.allText) throw new Error('Edited project exceeds the 32 MiB source and metadata limit.');
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
  // Preview only bounded raster assets from the already verified archive.
  // SVG, PDF and remote URLs are intentionally not loaded into the editor.
  const rasterTypes = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'};
  function rasterCandidates(files, root, source, target) {
    if (typeof target !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(target) || !validPath(target)) return [];
    const folder = path => path.includes('/') ? path.slice(0,path.lastIndexOf('/')+1) : '';
    const suffixes = /\.[A-Za-z0-9]+$/.test(target) ? [''] : ['.png','.jpg','.jpeg','.gif','.webp'];
    return [...new Set([folder(root),folder(source)].flatMap(dir=>suffixes.map(ext=>dir+target+ext)))].filter(name=>
      files.has(name) && Object.hasOwn(rasterTypes,name.split('.').at(-1).toLowerCase()));
  }
  async function readRaster(blob, path) {
    if (!validPath(path)) throw new Error('Unsupported image path.');
    const mime = rasterTypes[path.split('.').at(-1).toLowerCase()];
    if (!mime) throw new Error('Only PNG, JPEG, GIF and WebP previews are supported.');
    const reader=new zip.ZipReader(new zip.BlobReader(blob),{useWebWorkers:false});
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (entry.directory || entry.filename.replace(/^(?:\.\/)+/,'')!==path) continue;
        if (entry.uncompressedSize>5*MiB) throw new Error('Image exceeds the 5 MiB preview limit.');
        let size=0;
        const chunks=[];
        await entry.getData(new WritableStream({write(chunk){
          size+=chunk.length;
          if(size>5*MiB || size>entry.uncompressedSize) throw new Error('Image exceeds its declared size.');
          chunks.push(chunk.slice());
        }}),{checkSignature:true,checkOverlappingEntry:true});
        if(size!==entry.uncompressedSize) throw new Error('Incomplete image.');
        return new Blob(chunks,{type:mime});
      }
      throw new Error('Image not found in the imported ZIP.');
    } finally {await reader.close();}
  }
  globalThis.PaperColabArchive = { readArchive, exportArchive, isConversation, rasterCandidates, readRaster };
})();
