'use strict';
/* ============================================================
   The starting point, and a piece of insurance.

   Uploading a folder through a browser is easy to get half-right:
   files can land deeper than intended, and the only symptom is a
   host reporting

       Cannot find module '.../server/index.js'
       Exited with status 1

   which says nothing about what to do next. So this looks for the
   server wherever it actually is, says where it found it, and if it
   truly cannot find it, prints the folder tree it DID find — so the
   deploy log answers the question by itself instead of starting
   another round of guessing.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const TARGET = path.join('server', 'index.js');
const SKIP = new Set(['node_modules', '.git', '.github', 'public', 'shared', 'test']);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function dirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory() && e.name.charAt(0) !== '.' && !SKIP.has(e.name); })
      .map(function (e) { return e.name; });
  } catch (e) { return []; }
}

/* Breadth-first, a few levels down. Deeper than any plausible upload
   mistake, and it stops at the first server it finds. */
function find() {
  if (isFile(path.join(HERE, TARGET))) return { file: path.join(HERE, TARGET), where: null };

  /* No folders at all: a browser file-picker upload drops every file into one
     pile, so the server's index.js is sitting right here beside this one. Its
     companions identify it — a bare index.js could be anything. */
  if (isFile(path.join(HERE, 'index.js')) &&
      isFile(path.join(HERE, 'ws.js')) &&
      isFile(path.join(HERE, 'rooms.js'))) {
    return { file: path.join(HERE, 'index.js'), where: null, flat: true };
  }

  let frontier = dirs(HERE).map(function (n) { return n; });
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next = [];
    for (const rel of frontier) {
      const candidate = path.join(HERE, rel, TARGET);
      if (isFile(candidate)) return { file: candidate, where: rel };
      for (const child of dirs(path.join(HERE, rel))) next.push(path.join(rel, child));
    }
    frontier = next;
  }
  return null;
}

/* A small picture of what is actually on disk, for the log. */
function tree(root, prefix, depth, out) {
  if (depth > 2 || out.length > 40) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  entries = entries.filter(function (e) { return e.name.charAt(0) !== '.' && e.name !== 'node_modules'; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  for (const e of entries) {
    out.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
    if (e.isDirectory() && out.length <= 40) tree(path.join(root, e.name), prefix + '  ', depth + 1, out);
  }
  return out;
}

const found = find();

if (!found) {
  const lines = tree(HERE, '  ', 0, []);
  console.error('');
  console.error('  ============================================================');
  console.error('  Gin & Corners cannot start: no "server/index.js" anywhere.');
  console.error('  ============================================================');
  console.error('');
  console.error('  Looked under: ' + HERE);
  console.error('  What is actually there:');
  console.error('');
  console.error(lines.length ? lines.join('\n') : '  (the folder is empty)');
  console.error('');
  console.error('  What it should look like at the top level:');
  console.error('');
  console.error('    package.json');
  console.error('    render.yaml');
  console.error('    start.js');
  console.error('    public/');
  console.error('    server/');
  console.error('    shared/');
  console.error('    test/');
  console.error('');
  console.error('  If the list above is missing the folders, the upload did not');
  console.error('  include them — re-upload from INSIDE the unzipped folder,');
  console.error('  selecting the folders as well as the loose files.');
  console.error('');
  process.exit(1);
}

if (found.flat) {
  console.warn('');
  console.warn('  Note: the files are all in one folder with no sub-folders — the');
  console.warn('  upload flattened them. The game runs perfectly well like this,');
  console.warn('  so there is nothing you need to do about it.');
  console.warn('');
}

if (found.where) {
  console.warn('');
  console.warn('  Note: found the app inside "' + found.where + '/" rather than at the top');
  console.warn('  level. Running it from there — it works perfectly well — but the');
  console.warn('  tidier arrangement is everything together at the top of the repo.');
  console.warn('');
}

require(found.file);
