import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import './check.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await rm(join(root,'dist'), { recursive: true, force: true });
await mkdir(join(root,'dist','assets'), { recursive: true });
for (const path of ['index.html','assets/desktop-preview.png','assets/mobile-preview.png']) {
  await copyFile(join(root,path),join(root,'dist',path));
}
console.log('Built dist/ static demo (no server-side capabilities).');
