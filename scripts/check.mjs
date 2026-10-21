import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (script.length !== 1) throw new Error(`Expected one inline demo script, got ${script.length}`);
new Script(script[0][1], { filename: 'index.html inline script' });
for (const match of ['id="loadTable"', 'id="detail"', 'id="addLoad"', 'id="resetDemo"', 'id="carrierFilter"']) {
  if (!html.includes(match)) throw new Error(`Missing required UI landmark: ${match}`);
}
console.log('Static HTML and inline JavaScript syntax check passed.');
