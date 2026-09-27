#!/usr/bin/env node
// Packs every card under card_sources/ into addon_files/Resources and zips the
// result. Two differences from NordvikManager-DND's scripts/pack-cards.mjs (the
// dnd5e addon's packer, which this was forked from):
//   1. Cards are discovered by globbing card_sources/* instead of a hardcoded
//      list — adding a new ported sheet needs no changes here.
//   2. Each card's CSS output is auto-collected into Resources alongside its JS,
//      instead of relying on a hand-merged shared.css that doesn't scale past a
//      handful of independently-styled sheets.
// Every card's vite.config.js must keep single-chunk output (no manualChunks /
// dynamic imports) — this script takes only the first .js and first .css file
// it finds in each card's dist/assets/.
import archiver from 'archiver';
import { execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packedDir = path.join(repoRoot, 'packed');
const resourcesDir = path.join(packedDir, 'Resources');
const addonFilesDir = path.join(repoRoot, 'addon_files');
const cardSourcesRoot = path.join(repoRoot, 'card_sources');
const zipPath = path.join(repoRoot, 'packed.zip');

const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });

// Every directory directly under card_sources/ that has its own package.json is
// treated as a card to build. roll20compat-shared (the shared runtime library,
// relative-imported by the other cards rather than built standalone) is excluded.
const cards = existsSync(cardSourcesRoot)
    ? readdirSync(cardSourcesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name !== 'roll20compat-shared')
        .filter((name) => existsSync(path.join(cardSourcesRoot, name, 'package.json')))
    : [];

if (cards.length === 0) {
    console.warn('No cards found under card_sources/ — nothing to build yet.');
}

// 1. wipe any previous packed/ output and reseed it with addon_files.
//    Without this, cpSync only ever ADDS/overwrites — a file that existed in
//    an earlier packed/ but was since removed from addon_files/ (e.g. a
//    .gitkeep deleted after real content landed) silently survives into the
//    next zip, undoing the fix at the source.
rmSync(packedDir, { recursive: true, force: true });
mkdirSync(packedDir, { recursive: true });
cpSync(addonFilesDir, packedDir, { recursive: true });

// 2. build every card
for (const card of cards) {
    console.log(`Building ${card}...`);
    const dir = path.join(cardSourcesRoot, card);
    run('pnpm install', dir);
    run('pnpm run build', dir);
}

// 3. extract each card's JS bundle (and CSS, if it produced one) into packed/Resources
mkdirSync(resourcesDir, { recursive: true });
for (const card of cards) {
    console.log(`Packing ${card}...`);
    const assetsDir = path.join(cardSourcesRoot, card, 'dist', 'assets');
    const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];

    const jsFile = assetFiles.find((name) => name.endsWith('.js'));
    const cssFile = assetFiles.find((name) => name.endsWith('.css'));

    if (jsFile) {
        cpSync(path.join(assetsDir, jsFile), path.join(resourcesDir, `${card}.js`));
    } else {
        console.warn(`No JS file found for ${card}`);
    }

    if (cssFile) {
        cpSync(path.join(assetsDir, cssFile), path.join(resourcesDir, `${card}.css`));
    }
}

// 4. zip the packed folder into packed.zip
rmSync(zipPath, { force: true });
await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(packedDir, false);
    archive.finalize();
});

console.log('Cards packed successfully.');
