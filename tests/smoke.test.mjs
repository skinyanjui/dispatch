import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('demo has explicit demo identity and core app landmarks', () => {
  assert.match(html, /Freight Dispatch Workspace \(Demo\)/);
  for (const id of ['main','loadTable','detail','resetDemo']) {
    assert.ok(html.includes(`id="${id}"`),`Missing ${id}`);
  }
});

test('prototype includes core load, driver, exception and separate billing workflows', () => {
  for (const term of ['newCarrier','driverSelect','exceptionForm','carrierBilling','dispatchBilling','dateTime']) {
    assert.ok(html.includes(term),`Missing ${term}`);
  }
});

test('repository documentation distinguishes demo from production', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Not.*production|production multi-tenant/i);
  assert.match(readme, /carrier/i);
  const instructions = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(instructions, /authorization/i);
});
