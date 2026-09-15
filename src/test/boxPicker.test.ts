import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMysteryBox, totalQuantity, type PickCandidate } from '../domain/boxPicker.ts';

const catalog: PickCandidate[] = [
  { id: 1, brand: 'Velo', flavor: 'mint', strength: 'strong', available: 10 },
  { id: 2, brand: 'Velo', flavor: 'citrus', strength: 'medium', available: 10 },
  { id: 3, brand: 'Zyn', flavor: 'mint', strength: 'extra_strong', available: 10 },
  { id: 4, brand: 'Zyn', flavor: 'kaffe', strength: 'mild', available: 10 },
  { id: 5, brand: 'Loop', flavor: 'lakrits', strength: 'strong', available: 10 },
  { id: 6, brand: 'Loop', flavor: 'bär', strength: 'strong', available: 0 },
];

test('fyller boxen med rätt antal', () => {
  const picks = pickMysteryBox(catalog, { boxSize: 5 });
  assert.equal(totalQuantity(picks), 5);
});

test('hoppar över uteslutna smaker och slutsålda produkter', () => {
  const picks = pickMysteryBox(catalog, { boxSize: 5, excludedFlavors: ['Mint'] });
  const ids = picks.map((p) => p.productId);
  assert.ok(!ids.includes(1) && !ids.includes(3), 'mint ska inte plockas');
  assert.ok(!ids.includes(6), 'slutsåld produkt ska inte plockas');
});

test('föredrar kundens styrka och smak', () => {
  const picks = pickMysteryBox(catalog, { boxSize: 2, strength: 'strong', preferredFlavors: ['mint'] });
  assert.equal(picks[0]?.productId, 1, 'Velo mint strong ska rankas högst');
});

test('undviker produkter kunden redan fått när det finns alternativ', () => {
  const picks = pickMysteryBox(catalog, { boxSize: 3, strength: 'strong', previouslySent: [1, 5] });
  const ids = picks.map((p) => p.productId);
  assert.ok(ids.includes(3) || ids.includes(2), 'ska variera mot vad som skickats tidigare');
});

test('returnerar färre om lagret inte räcker', () => {
  const small: PickCandidate[] = [{ id: 1, brand: 'Velo', flavor: 'mint', strength: 'strong', available: 2 }];
  const picks = pickMysteryBox(small, { boxSize: 5 });
  assert.equal(totalQuantity(picks), 2);
});

test('samma seed ger samma resultat, olika seed kan ge annat', () => {
  const a = pickMysteryBox(catalog, { boxSize: 4, seed: 42 });
  const b = pickMysteryBox(catalog, { boxSize: 4, seed: 42 });
  assert.deepEqual(a, b);
});
