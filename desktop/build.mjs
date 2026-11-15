import { packager } from '@electron/packager';
import { readFile, mkdir, mkdtemp, cp, rm, rename, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const destination = path.join(dist, 'Latte Loop.app');
const previousDestination = path.join(dist, 'Practice Timer.app');
if (process.platform !== 'darwin') throw new Error('Build this personal Mac app on macOS.');
// Refuse to replace a running copy. Saving and quitting are handled by the app itself.
function isRunning(bundle, executable) {
  try {
    return Boolean(execFileSync('pgrep', ['-f', path.join(bundle, 'Contents/MacOS', executable)], { encoding: 'utf8' }).trim());
  } catch (error) { if (error.status !== 1) throw error; return false; }
}
if (isRunning(destination, 'Latte Loop')) throw new Error('Quit Latte Loop before rebuilding it.');
await mkdir(dist, { recursive: true });
const work = await mkdtemp(path.join(os.tmpdir(), 'practice-timer-build-'));
try {
  const source = path.join(work, 'source');
  await mkdir(path.join(source, 'desktop'), { recursive: true });
  const assets = ['index.html', 'styles.css', 'app.js', 'timer-core.js', 'practice-data.js', 'backup-files.js', 'sound-engine.js',
    'manifest.json', 'favicon-32.png', 'apple-touch-icon.png', 'stopwatch-dock-icon-192.png', 'stopwatch-dock-icon-512.png', 'package.json'];
  for (const filename of assets) await cp(path.join(root, filename), path.join(source, filename));
  for (const filename of ['main.cjs', 'preload.cjs', 'storage.cjs', 'server.cjs', 'native-sounds.cjs', 'trayTemplate.png', 'trayTemplate@2x.png', 'breakTrayTemplate.png', 'breakTrayTemplate@2x.png']) {
    await cp(path.join(root, 'desktop', filename), path.join(source, 'desktop', filename));
  }
  const iconset = path.join(work, 'Timer.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), path.join(root, 'stopwatch-dock-icon-512.png'), '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    if (size <= 256) execFileSync('sips', ['-z', String(size * 2), String(size * 2), path.join(root, 'stopwatch-dock-icon-512.png'), '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  const icon = path.join(work, 'Timer.icns');
  execFileSync('iconutil', ['-c', 'icns', '-o', icon, iconset]);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const [output] = await packager({ dir: source, out: path.join(work, 'output'), name: 'Latte Loop',
    platform: 'darwin', arch: process.arch, electronVersion: manifest.devDependencies.electron,
    appBundleId: 'io.github.ichilolule.practice-timer', appVersion: manifest.version, icon,
    asar: true, prune: false, overwrite: true,
    extendInfo: { NSHumanReadableCopyright: 'Latte Loop',
      NSQuitAlwaysKeepsWindows: false },
  });
  const next = path.join(output, 'Latte Loop.app');
  await flipFuses(next, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  // Keep the previous bundle recoverable until the new one has been copied successfully.
  const staged = path.join(dist, '.Latte Loop.pending.app');
  await rm(staged, { recursive: true, force: true });
  await cp(next, staged, { recursive: true, verbatimSymlinks: true });
  await access(path.join(staged, 'Contents/MacOS/Latte Loop'));
  await access(path.join(staged, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  await rm(destination, { recursive: true, force: true });
  await rename(staged, destination);
  // The old name may still be in use during the first build after renaming.
  if (!isRunning(previousDestination, 'Practice Timer')) await rm(previousDestination, { recursive: true, force: true });
  else console.log('Practice Timer is running and was kept. Quit it before opening Latte Loop.');
  console.log(`Ready: ${destination}`);
} finally { await rm(work, { recursive: true, force: true }); }
