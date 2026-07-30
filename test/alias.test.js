import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_MASK,
  createMask,
  handleFromPath,
  normalizeHandle,
  personaFor,
} from '../src/alias.js';

test('normalizeHandle strips the decoration a handle arrives wearing', () => {
  assert.equal(normalizeHandle('@Alice_J'), 'alice_j');
  assert.equal(normalizeHandle('alice_j/'), 'alice_j');
  assert.equal(normalizeHandle('  @alice_j  '), 'alice_j');
  assert.equal(normalizeHandle(''), '');
  assert.equal(normalizeHandle(null), '');
  assert.equal(normalizeHandle(undefined), '');
});

// The property the whole feature rests on: the panel and the Instagram tab
// derive personas independently, with no shared state, so a pure function of
// the handle is the only thing keeping one screenshot self-consistent.
test('personaFor is a pure function of the normalized handle', () => {
  const first = personaFor('alice_j');
  const second = personaFor('@Alice_J/');

  assert.deepEqual(first, second);
  assert.deepEqual(personaFor('alice_j'), first);
});

test('personaFor gives a handle and a name describing one person', () => {
  const persona = personaFor('some.real.handle');
  const [given, family] = persona.fullName.split(' ');

  assert.match(persona.username, /^[a-z0-9._]+$/);
  assert.ok(
    persona.username.includes(given.toLowerCase())
      || persona.username.includes(family.toLowerCase()),
    `${persona.username} shares nothing with ${persona.fullName}`
  );
});

test('personaFor returns null rather than a persona for nothing', () => {
  assert.equal(personaFor(''), null);
  assert.equal(personaFor('   '), null);
  assert.equal(personaFor(null), null);
});

// A column of twenty rows that all read "Jordan Reeves" is worse than no mode
// at all. This is not a uniqueness guarantee — it is a check that the pools
// are actually being drawn from independently.
test('personaFor spreads a realistic queue across the pools', () => {
  const handles = Array.from({ length: 200 }, (_, index) => `real_user_${index}`);
  const personas = handles.map(personaFor);

  const names = new Set(personas.map((persona) => persona.fullName));
  const handleStyles = new Set(personas.map((persona) => persona.username.replace(/[a-z0-9]/g, '')));

  assert.ok(names.size >= 190, `only ${names.size} distinct names across 200 handles`);
  assert.ok(handleStyles.size > 1, 'every handle came out in the same style');
});

test('handleFromPath reads the identity out of a profile link', () => {
  assert.equal(handleFromPath('/alice_j/'), 'alice_j');
  assert.equal(handleFromPath('/alice_j'), 'alice_j');
  assert.equal(handleFromPath('/Alice.J/'), 'alice.j');
});

test('handleFromPath refuses the paths that merely look like profiles', () => {
  assert.equal(handleFromPath('/explore/'), null);
  assert.equal(handleFromPath('/direct/'), null);
  assert.equal(handleFromPath('/reels/'), null);
  assert.equal(handleFromPath('/p/Cx1y2z3/'), null);
  assert.equal(handleFromPath('/alice_j/followers/'), null);
  assert.equal(handleFromPath('/'), null);
  assert.equal(handleFromPath('/.../'), null);
  assert.equal(handleFromPath(''), null);
  assert.equal(handleFromPath(null), null);
});

test('the identity mask is a pass-through, so renderers need no branch', () => {
  assert.equal(IDENTITY_MASK.on, false);
  assert.equal(IDENTITY_MASK.username('alice_j'), 'alice_j');
  assert.equal(IDENTITY_MASK.fullName('alice_j', 'Alice Johnson'), 'Alice Johnson');
  assert.equal(IDENTITY_MASK.fullName('alice_j', ''), '');
});

test('a live mask renames both fields off the same handle', () => {
  const mask = createMask();
  const persona = personaFor('alice_j');

  assert.equal(mask.on, true);
  assert.equal(mask.username('alice_j'), persona.username);
  assert.equal(mask.fullName('alice_j', 'Alice Johnson'), persona.fullName);
});

// A row Instagram gave no display name for must not grow one: the mode hides
// what is there, it does not invent UI that is not.
test('a live mask leaves an absent name absent', () => {
  const mask = createMask();
  assert.equal(mask.fullName('alice_j', ''), '');
  assert.equal(mask.fullName('alice_j', undefined), '');
});

test('a live mask passes through what it cannot rename', () => {
  const mask = createMask();
  assert.equal(mask.username(''), '');
});
