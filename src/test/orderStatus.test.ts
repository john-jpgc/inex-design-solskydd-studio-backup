import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTransitions, canTransition, holdsReservation, ORDER_STATUSES } from '../domain/orderStatus.ts';

test('huvudflödet är tillåtet steg för steg', () => {
  assert.ok(canTransition('pending', 'paid'));
  assert.ok(canTransition('paid', 'picking'));
  assert.ok(canTransition('picking', 'packed'));
  assert.ok(canTransition('packed', 'shipped'));
  assert.ok(canTransition('shipped', 'delivered'));
});

test('slutstatusar saknar utgångar', () => {
  assert.deepEqual(allowedTransitions('cancelled'), []);
  assert.deepEqual(allowedTransitions('returned'), []);
});

test('man kan inte hoppa över steg', () => {
  assert.equal(canTransition('pending', 'shipped'), false);
  assert.equal(canTransition('paid', 'delivered'), false);
  assert.equal(canTransition('shipped', 'cancelled'), false);
});

test('reservation hålls fram till packning', () => {
  for (const s of ORDER_STATUSES) {
    assert.equal(holdsReservation(s), ['pending', 'paid', 'picking'].includes(s), s);
  }
});
