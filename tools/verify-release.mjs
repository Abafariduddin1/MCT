// Read-only release integrity check. Node 24+, no dependencies or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST_SHA256.json'), 'utf8'));
const failures = [];
for (const [relative, expected] of Object.entries(manifest.files)) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Invalid manifest path');
  try {
    const bytes = fs.readFileSync(path.join(root, relative));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) failures.push(relative + ': changed');
  } catch { failures.push(relative + ': missing'); }
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log('Verified all ' + Object.keys(manifest.files).length + ' packaged files. No trading command executed.');
}
