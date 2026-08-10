#!/usr/bin/env node
// build.js — produce the Chrome Web Store package.
//
// The store build ships without the follow-back harvest. The harvest is the
// only thing that needs the `downloads` permission, and a permission increase
// disables the extension for every existing user until they re-consent — so
// while the harvest is still being trialled, it stays out of the published
// package and the store build asks for nothing new.
//
// Nothing here is clever. The harvest already lives behind one seam (see
// src/harvest/mount.js), so the build deletes files and two marked regions.
// What makes that safe is verify() at the bottom: it re-derives from the built
// output that no harvest code survived, and refuses to write a zip otherwise.
// A build that half-works must not produce something submittable.
//
//   npm run build   ->  dist/store/                     (load unpacked to test)
//                       dist/request-blaster-<version>.zip

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'store');

// Everything the unpacked extension needs at runtime. An allow-list, not an
// ignore-list: a new dev-only file at the root is then left out by default,
// which is the safe direction to get this wrong. `test/`, `docs/`, `.claude/`,
// `package.json`, `README.md` and this file are all excluded by omission.
const INCLUDE = ['manifest.json', 'background.js', 'content.js', 'banner.js',
                 'anon-content.js', 'sidepanel.html', 'sidepanel.css', 'images', 'src'];

// The harvest feature, as files. Copied by INCLUDE above, then removed.
const HARVEST_PATHS = ['src/harvest', 'harvest-content.js'];

// Manifest entries the harvest is the only user of.
const HARVEST_PERMISSIONS = ['downloads', 'downloads.ui'];
const HARVEST_CONTENT_SCRIPTS = ['harvest-content.js'];

// Paired marker comments in src/panel.js. Both the import and the mountHarvest
// call are wrapped in one, and there are exactly this many — a file that grows
// a third is a seam nobody told this script about, so the count is asserted
// rather than assumed.
const REGION = /^[ \t]*\/\/ #region harvest\b[\s\S]*?^[ \t]*\/\/ #endregion harvest\b.*$\n?/gm;
const REGION_FILE = 'src/panel.js';
const REGION_COUNT = 2;

const say = (...args) => console.log('   ', ...args);

// Skips the junk that macOS and iCloud leave in a source tree. An unpacked
// extension folder ships as-is, so a stray ._file really would be submitted.
const JUNK = /(^|\/)(\.DS_Store|\._.*|\.Trashes|node_modules)$/;

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

/** The next minor version, without writing anything. */
function nextVersion() {
  const current = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
  const parts = current.split('.');
  if (parts.length < 2) parts.push('0');
  parts[1] = String(Number(parts[1]) + 1);
  return { current, next: parts.join('.') };
}

/**
 * Record the bump in the source manifest — only once a zip exists.
 *
 * It has to reach source, not just dist/: the store rejects any version that is
 * not strictly greater than the published one, so a bump that lived only in the
 * output would hand out the same number on every build. Doing it last means a
 * build that fails verification leaves the version alone rather than silently
 * burning one.
 *
 * (Chrome zero-pads missing components, so a source "1.0" does not beat the
 * published "1.0.0". That is why the first build here has to reach 1.1.)
 */
function commitVersion(next) {
  const path = join(ROOT, 'manifest.json');
  const raw = readFileSync(path, 'utf8');
  // Rewritten as text, not as JSON.stringify(parse(raw)), so the manifest keeps
  // its hand-written grouping and blank lines.
  writeFileSync(path, raw.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${next}"`));
}

/** Copy the allow-list into a clean dist/store. */
function copyTree() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const entry of INCLUDE) {
    cpSync(join(ROOT, entry), join(OUT, entry), {
      recursive: true,
      filter: (src) => !JUNK.test(src),
    });
  }
}

/** Delete the harvest's files and its two regions in panel.js. */
function stripHarvest() {
  for (const path of HARVEST_PATHS) {
    rmSync(join(OUT, path), { recursive: true, force: true });
    say(`removed ${path}`);
  }

  const path = join(OUT, REGION_FILE);
  const source = readFileSync(path, 'utf8');
  const found = source.match(REGION)?.length ?? 0;
  if (found !== REGION_COUNT) {
    throw new Error(
      `${REGION_FILE}: expected ${REGION_COUNT} "#region harvest" blocks, found ${found}. ` +
      `Either a marker was edited away or a new seam needs one.`
    );
  }
  writeFileSync(path, source.replace(REGION, ''));
  say(`stripped ${found} harvest regions from ${REGION_FILE}`);
}

/** Drop the harvest's permissions and content script; set the version. */
function transformManifest(version) {
  const path = join(OUT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));

  manifest.version = version;

  // The `key` pins the extension ID for the unpacked copy, so moving this
  // folder stops looking to Chrome like a different extension and taking the
  // storage with it. It is development-only: the Web Store issues the
  // published extension its own identity, and a package arriving with a key of
  // its own is a package claiming an ID that is not the one being updated.
  delete manifest.key;
  manifest.permissions = manifest.permissions.filter((p) => !HARVEST_PERMISSIONS.includes(p));
  for (const script of manifest.content_scripts ?? []) {
    script.js = script.js.filter((file) => !HARVEST_CONTENT_SCRIPTS.includes(file));
  }

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  say(`permissions: ${manifest.permissions.join(', ')}`);
}

/**
 * Re-derive from the built output that the strip actually worked.
 *
 * Deliberately checks the output rather than trusting the steps above, and
 * checks executable references rather than the word "harvest" — content.js and
 * src/api.js both mention harvest-content.js in comments that describe a real
 * capability (an optional content script that may be absent), and those
 * comments are still true here.
 */
function verify() {
  const problems = [];
  const files = walk(OUT);
  const read = (file) => readFileSync(join(OUT, file), 'utf8');

  // 1. The permission this whole build exists to avoid.
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    if (read(file).includes('chrome.downloads')) problems.push(`${file} still calls chrome.downloads`);
  }

  // 2. The manifest agrees.
  const manifest = JSON.parse(read('manifest.json'));
  // The dev key must not ship — see transformManifest. Checked here rather
  // than trusted there because the failure is silent until upload, where it
  // reads as an ID mismatch rather than as anything to do with this file.
  if ('key' in manifest) problems.push('manifest still carries the development "key"');
  for (const permission of HARVEST_PERMISSIONS) {
    if (manifest.permissions.includes(permission)) problems.push(`manifest still requests "${permission}"`);
  }
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js) {
      if (HARVEST_CONTENT_SCRIPTS.includes(file)) problems.push(`manifest still loads ${file}`);
    }
  }

  // 3. No import survived the region strip, and no caller either.
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const source = read(file);
    if (/from\s+['"][^'"]*harvest/.test(source)) problems.push(`${file} still imports from harvest/`);
    if (/\bmountHarvest\s*\(/.test(source)) problems.push(`${file} still calls mountHarvest()`);
  }

  // 4. Nothing dev-only rode along.
  for (const file of files) {
    if (/^(test|docs|\.claude)\//.test(file) || ['package.json', 'README.md', 'build.js'].includes(file)) {
      problems.push(`${file} should not be in the package`);
    }
    if (JUNK.test(file)) problems.push(`${file} is junk and should not be in the package`);
  }

  // 5. Every file the manifest names exists. Catches an over-eager strip or a
  //    file INCLUDE forgot — the failure that makes Chrome reject the load.
  const named = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap((s) => [...(s.js ?? []), ...(s.css ?? [])]),
    // A missing web-accessible resource fails at runtime rather than at load,
    // so Chrome accepts the package and the feature that dynamic-imports it
    // simply never works. Nothing here is a glob today; if one is added, this
    // needs to resolve it rather than test it as a literal path.
    ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
  ].filter(Boolean);
  for (const file of named) {
    if (!existsSync(join(OUT, file))) problems.push(`manifest names ${file}, which is not in the package`);
  }

  // 6. Every relative import resolves. This is the real test that deleting the
  //    import line left a loadable module graph rather than a broken one.
  for (const file of files.filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
    const source = read(file);
    for (const [, spec] of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = join(dirname(file), spec);
      if (!existsSync(join(OUT, target))) problems.push(`${file} imports ${spec}, which does not exist`);
    }
  }

  if (problems.length) {
    console.error('\n  Build FAILED verification:');
    for (const problem of problems) console.error(`    - ${problem}`);
    console.error('\n  No zip was written.\n');
    process.exit(1);
  }
  say(`verified ${files.length} files`);
}

function zip(version) {
  const name = `request-blaster-${version}.zip`;
  // -r recurse, -X drop macOS extended attributes, -q quiet.
  execFileSync('zip', ['-r', '-X', '-q', join(DIST, name), '.'], { cwd: OUT });
  return name;
}

console.log('\n  Building the store package (harvest excluded)\n');
const { current, next } = nextVersion();
copyTree();
stripHarvest();
transformManifest(next);
verify();
const name = zip(next);
commitVersion(next);
say(`version ${current} -> ${next}`);
console.log(`\n  dist/${name}\n  dist/store/  (load unpacked to check it before submitting)\n`);
