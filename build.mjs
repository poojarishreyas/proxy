/**
 * Builds a single self-contained shrey.exe.
 *
 *   src/ --esbuild--> dist/shrey.cjs --sea-config--> dist/sea-prep.blob
 *                                       --postject--> dist/shrey.exe
 *
 * The dashboard assets are embedded into the bundle first, so the produced
 * executable has no side files at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { build } from 'esbuild';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const isWindows = process.platform === 'win32';
const exeName = 'shrey' + (isWindows ? '.exe' : '');

const step = (n, text) => console.log('\n[' + n + '] ' + text);

function run(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  step(1, 'embedding dashboard assets');
  run(process.execPath, [path.join(here, 'scripts', 'genassets.mjs')]);

  step(2, 'bundling to CommonJS');
  await build({
    entryPoints: [path.join(here, 'src', 'index.js')],
    outfile: path.join(dist, 'shrey.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    legalComments: 'none',
    // The bundle is CommonJS, so import.meta.url needs a concrete stand-in.
    banner: {
      js: "const __ccproxyMetaUrl = require('node:url').pathToFileURL(__filename).href;"
    },
    define: { 'import.meta.url': '__ccproxyMetaUrl' }
  });
  const bundleSize = fs.statSync(path.join(dist, 'shrey.cjs')).size;
  console.log('    dist/shrey.cjs  ' + (bundleSize / 1024).toFixed(1) + ' KB');

  step(3, 'preparing the SEA blob');
  const seaConfig = {
    main: path.join(dist, 'shrey.cjs'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  const seaConfigPath = path.join(dist, 'sea-config.json');
  fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

  step(4, 'copying the node runtime');
  const exePath = path.join(dist, exeName);
  fs.copyFileSync(process.execPath, exePath);

  if (isWindows) {
    // The official node.exe is Authenticode-signed; injecting into it invalidates
    // that signature. Removing it first avoids a binary that claims a broken one.
    try {
      execFileSync('signtool', ['remove', '/s', exePath], { stdio: 'ignore', windowsHide: true });
      console.log('    removed the inherited code signature');
    } catch {
      console.log('    signtool not available - the inherited signature stays invalid (harmless)');
    }
  }

  step(5, 'injecting the application blob');
  const postject = path.join(here, 'node_modules', 'postject', 'dist', 'cli.js');
  run(process.execPath, [
    postject,
    exePath,
    'NODE_SEA_BLOB',
    path.join(dist, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
  ]);

  const size = fs.statSync(exePath).size;
  console.log('\n  Built ' + path.relative(here, exePath) + '  (' + (size / 1024 / 1024).toFixed(1) + ' MB)');

  step(6, 'verifying the executable');
  await new Promise((resolve, reject) => {
    execFile(exePath, ['--version'], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error('the built executable did not run: ' + err.message));
      console.log('    ' + exeName + ' --version -> ' + String(stdout).trim());
      resolve();
    });
  });

  console.log('\n  Done. Ship dist/' + exeName + ' on its own - it needs no Node install.\n');
}

main().catch((err) => {
  console.error('\nBuild failed: ' + (err?.stack ?? err));
  process.exit(1);
});
