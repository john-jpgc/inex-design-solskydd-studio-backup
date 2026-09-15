import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSek, vatFromGross } from '../domain/money.ts';

test('moms beräknas från bruttobelopp', () => {
  assert.equal(vatFromGross(12_500, 25), 2_500);
  assert.equal(vatFromGross(0, 25), 0);
  assert.equal(vatFromGross(4_900, 25), 980);
});

test('belopp formateras på svenska', () => {
  assert.equal(formatSek(0), '0 kr');
  assert.equal(formatSek(4_900), '49 kr');
  assert.equal(formatSek(123_456), '1 234,56 kr');
  assert.equal(formatSek(-1_050), '-10,50 kr');
});
