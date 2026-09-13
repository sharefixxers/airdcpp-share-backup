'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Worker } = require('worker_threads');
const SettingsManager = require('airdcpp-extension-settings');

const EXTENSION_VERSION = require('../package.json').version;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const SETTINGS = [
  {
    key: 'backup_folder',
    title: 'Folder to save backups in',
    help: 'If empty, backups go to the extension\'s own log folder.',
    default_value: '',
    type: 'string',
    optional: true,
  },
  {
    key: 'compress_backup',
    title: 'Compress backups to bz2 (much slower, but smaller file)',
    help:
      'Off by default: backups are saved as a .xml file -- faster (no compression step). Turn this on to ' +
      'compress to .xml.bz2 instead, it\'s noticeably slower.',
    default_value: false,
    type: 'boolean',
  },
  {
    key: 'nick',
    title: 'Your AirDC++ nickname (used in the backup filename)',
    help: 'Leave empty to auto-detect. Fill in to force a specific name instead.',
    default_value: '',
    type: 'string',
    optional: true,
  },
  {
    key: 'exclude_virtual_folders',
    title: 'Skip these virtual folders (comma-separated)',
    help: 'Leave empty to back up everything.',
    default_value: '',
    type: 'string',
    optional: true,
  },
  {
    key: 'schedule_days',
    title: 'Automatically back up on these days (comma-separated)',
    help: 'English day names, e.g. "monday" or "monday,thursday".',
    default_value: '',
    type: 'string',
    optional: true,
  },
  {
    key: 'retention_days',
    title: 'Delete backups older than this many days (0 = never)',
    help: 'Checked after every backup (manual or automatic).',
    default_value: 60,
    type: 'number',
    min: 0,
  },
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateTimeForFilename(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function todayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs the (slow, CPU-bound, synchronous) bzip2 compression in a
// worker_thread instead of the main thread, so it doesn't freeze the
// WebSocket connection to AirDC++ while a large share is being compressed
// (multiple minutes for a large share is normal for this pure-JS
// implementation -- there's no native bzip2 module available here).
function compressBufferToBz2(buffer, blockSizeMultiplier) {
  return new Promise((resolve, reject) => {
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    let worker;
    try {
      worker = new Worker(__filename, { workerData: { buffer: arrayBuffer, blockSizeMultiplier }, transferList: [arrayBuffer] });
    } catch (e) {
      reject(e);
      return;
    }
    worker.once('message', (msg) => {
      worker.terminate().catch(() => {});
      if (msg && msg.ok) {
        resolve(Buffer.from(msg.buffer));
      } else {
        const err = new Error((msg && msg.error) || 'bz2 compression failed for an unknown reason');
        if (msg && msg.verifyFailed) err.verifyFailed = true;
        reject(err);
      }
    });
    worker.once('error', (err) => {
      worker.terminate().catch(() => {});
      reject(err);
    });
  });
}

// Tries to bzip2-compress with self-verification (see bz2-worker.js), and
// if that fails, retries once with a different block size -- shifting
// every block boundary is usually enough to dodge the same data-dependent
// encoder bug. Returns { compressed } on success, or { fallbackToXml: true }
// if verification failed on both attempts, so the caller can save an
// uncompressed .xml instead of ever writing an unverified/corrupt .bz2.
async function compressWithVerification(xmlBuffer, logFn) {
  try {
    return { compressed: await compressBufferToBz2(xmlBuffer, 9) };
  } catch (e) {
    if (!e.verifyFailed) throw e;
    await logFn(
      `bz2 self-verification failed on the first attempt (${e.message}) -- retrying with a different block size...`,
      'warning'
    );
  }
  try {
    return { compressed: await compressBufferToBz2(xmlBuffer, 3) };
  } catch (e) {
    if (!e.verifyFailed) throw e;
    await logFn(
      `bz2 self-verification failed again (${e.message}) -- saving this backup as an uncompressed .xml instead, so it's never silently corrupt. ` +
        'This is a known rare bug in the pure-JS bzip2 compressor on some large shares.',
      'warning'
    );
    return { fallbackToXml: true };
  }
}

module.exports = function (socket, extension) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: 1,
    definitions: SETTINGS,
  });

  let running = false;
  let ownCid = '';
  let schedulerTimer = null;

  async function log(text, severity) {
    try {
      await socket.post('events', { text: `[Share-backup] ${text}`, severity: severity || 'info' });
    } catch (e) {
      console.error(`Could not send system log message: ${e.message}`);
    }
  }

  function getExcludedFolderNames() {
    const raw = (settings.getValue('exclude_virtual_folders') || '').trim();
    if (!raw) return new Set();
    return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  }

  // Best-effort nick lookup: tries a currently connected hub first (AirDC++
  // already falls back to the global nick there if nothing is set per-hub),
  // then any hub at all (even disconnected), and finally the raw settings
  // API as a last resort. Never throws -- this must never be able to block
  // or skip the actual backup content, only affect what the output file is
  // named. Returns '' if nothing usable was found anywhere.
  async function getAutoNick() {
    try {
      const hubs = await socket.get('hubs');
      if (Array.isArray(hubs) && hubs.length) {
        const connected = hubs.find(
          (h) => h && h.connect_state && h.connect_state.id === 'connected' && h.settings && h.settings.nick
        );
        if (connected) return connected.settings.nick;
        const any = hubs.find((h) => h && h.settings && h.settings.nick);
        if (any) return any.settings.nick;
      }
    } catch (e) {
      // Fall through -- a failed hub lookup should never stop the backup.
    }
    try {
      const globalSettings = await socket.get('settings');
      if (globalSettings && globalSettings.nick) return globalSettings.nick;
    } catch (e) {
      // Same -- ignore and let the caller fall back to a placeholder.
    }
    return '';
  }

  // Resolves the nick to use for this backup's filename: manual setting
  // (if filled in) always wins, since that's an explicit choice (useful if
  // you use different nicks on different hubs). Otherwise auto-detect, and
  // if that also comes up empty, fall back to a safe placeholder -- the
  // backup itself (every file and folder) always runs either way, only the
  // filename/openability in AirDC++ is affected by this choice.
  async function resolveNick() {
    const manual = (settings.getValue('nick') || '').trim();
    if (manual) return { nick: manual, source: 'manual' };

    const auto = (await getAutoNick()).trim();
    if (auto) return { nick: auto, source: 'auto-detected' };

    return { nick: 'Unknown', source: 'fallback' };
  }

  function getBackupFolder() {
    const backupFolderSetting = (settings.getValue('backup_folder') || '').trim();
    return backupFolderSetting || path.join(extension.logPath, 'backups');
  }

  function stateFilePath() {
    return path.join(extension.configPath, 'share-backup-state.json');
  }

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    } catch (e) {
      return {};
    }
  }

  function writeState(state) {
    try {
      fs.writeFileSync(stateFilePath(), JSON.stringify(state));
    } catch (e) {
      console.error(`Could not save share-backup state: ${e.message}`);
    }
  }

  function parseScheduleDays() {
    const raw = (settings.getValue('schedule_days') || '').trim();
    if (!raw) return new Set();
    const days = new Set();
    for (const part of raw.split(',')) {
      const name = part.trim().toLowerCase();
      const idx = DAY_NAMES.indexOf(name);
      if (idx >= 0) days.add(idx);
    }
    return days;
  }

  // Sanitizes a value for safe use as a single filesystem path segment
  // (AirDC++'s own filelist naming convention can't tolerate characters that
  // aren't valid in a path segment on Windows/Linux/macOS).
  function sanitizePathSegment(value) {
    return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  }

  function backupPathForDate(backupFolder, date, nick) {
    const dayFolder = path.join(backupFolder, todayKey(date));
    const fileName = `${sanitizePathSegment(nick)}.${sanitizePathSegment(ownCid)}.xml.bz2`;
    return { dayFolder, filePath: path.join(dayFolder, fileName) };
  }

  async function cleanupOldBackups(backupFolder, retentionDays) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let entries;
    try {
      entries = await fsp.readdir(backupFolder, { withFileTypes: true });
    } catch (e) {
      return 0;
    }
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.name);
      if (!match) continue;
      const folderDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (Number.isNaN(folderDate.getTime()) || folderDate.getTime() >= cutoff) continue;
      const full = path.join(backupFolder, entry.name);
      try {
        await fsp.rm(full, { recursive: true, force: true });
        deleted += 1;
      } catch (e) {

      }
    }
    return deleted;
  }

  async function getShareRoots() {
    const roots = await socket.get('share_roots');
    return roots || [];
  }

  function groupRootsByVirtualName(roots) {
    const groups = [];
    const byName = new Map();
    for (const r of roots) {
      const key = (r.virtual_name || '').toLowerCase();
      let group = byName.get(key);
      if (!group) {
        group = { virtual_name: r.virtual_name, roots: [] };
        byName.set(key, group);
        groups.push(group);
      }
      group.roots.push(r);
    }
    return groups;
  }

  // Lists the content (files + subdirectories) of one real directory path,
  // via AirDC++'s stateless Share API -- no browsing session involved, so

  async function getDirectoryContent(realPath) {
    const pageSize = 1000;
    let start = 0;
    const all = [];
    for (;;) {
      let items;
      let lastErr;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          items = await socket.post(`share/directories/by_real/content/${start}/${pageSize}`, { path: realPath });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await sleep(300);
        }
      }
      if (lastErr) throw lastErr;
      all.push(...(items || []));
      if (!items || items.length < pageSize) break;
      start += pageSize;
    }
    return all;
  }

  const MAX_DEPTH = 60;

  async function writeDirectoryContents(realPath, stream, indent, counters, progressCb, visitedRealPaths, depth, excludedNames) {
    if (depth > MAX_DEPTH) {
      await log(`Stopped descending at "${realPath}" -- reached the maximum folder depth (${MAX_DEPTH}). This can happen with a symlink loop on disk. Skipping the rest of this branch; the rest of the backup continues normally.`, 'warning');
      return;
    }
    const normalized = realPath.toLowerCase();
    if (visitedRealPaths.has(normalized)) {
      await log(`Stopped descending at "${realPath}" -- this exact real path was already visited during this backup. This can happen with a symlink loop on disk. Skipping the rest of this branch; the rest of the backup continues normally.`, 'warning');
      return;
    }
    visitedRealPaths.add(normalized);

    let items;
    try {
      items = await getDirectoryContent(realPath);
    } catch (e) {
      await log(`Could not read "${realPath}", skipping it: ${e && e.message ? e.message : e}`, 'warning');
      return;
    }

    const dirs = items.filter((i) => i.type && i.type.id === 'directory');
    const files = items.filter((i) => !i.type || i.type.id !== 'directory');

    for (const f of files) {
      stream.write(`${indent}<File Name="${escapeXml(f.name)}" Size="${f.size || 0}" TTH="${f.tth || ''}"/>\n`);
      counters.files += 1;
      counters.bytes += f.size || 0;
      progressCb();
    }
    for (const d of dirs) {
      if (excludedNames.has((d.name || '').toLowerCase())) {
        counters.excluded += 1;
        continue;
      }
      const dateAttr = d.time ? ` Date="${d.time}"` : '';
      stream.write(`${indent}<Directory Name="${escapeXml(d.name)}"${dateAttr}>\n`);
      counters.dirs += 1;
      await writeDirectoryContents(d.path, stream, indent + '\t', counters, progressCb, visitedRealPaths, depth + 1, excludedNames);
      stream.write(`${indent}</Directory>\n`);
    }
  }

  async function resolveVirtualPath(trimmedPath, groups) {
    const segments = trimmedPath.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    const rootName = segments[0].toLowerCase();
    const group = groups.find((g) => (g.virtual_name || '').toLowerCase() === rootName);
    if (!group) {
      throw new Error(`Could not find a share root named "${segments[0]}"`);
    }

    if (segments.length === 1) {
      return { displayName: group.virtual_name, realPaths: group.roots.map((r) => r.path) };
    }

    // Deeper subpath: only one real starting point makes sense here, so if
    // this virtual name happens to be merged from multiple real roots, just
    // use the first one.
    let currentRealPath = group.roots[0].path;
    let currentDisplayName = group.roots[0].virtual_name;
    for (let i = 1; i < segments.length; i++) {
      const items = await getDirectoryContent(currentRealPath);
      const match = items.find(
        (it) => it.type && it.type.id === 'directory' && (it.name || '').toLowerCase() === segments[i].toLowerCase()
      );
      if (!match) {
        throw new Error(`Could not find subfolder "${segments[i]}" inside "${segments.slice(0, i).join('/')}"`);
      }
      currentRealPath = match.path;
      currentDisplayName = match.name;
    }
    return { displayName: currentDisplayName, realPaths: [currentRealPath] };
  }

  async function runBackup(startPath, trigger) {
    if (running) {
      await log('A backup is already in progress, please wait for it to finish.', 'warning');
      return;
    }
    running = true;

    let tempXmlPath = null;

    try {
      const triggerText = trigger === 'scheduled' ? ' (scheduled backup)' : '';
      await log(`Backup started${startPath && startPath !== '/' ? ` for "${startPath}"` : ''}${triggerText}...`, 'info');

      const { nick, source: nickSource } = await resolveNick();
      if (nickSource === 'auto-detected') {
        await log(`Using auto-detected nick "${nick}" for the backup filename (set "Your AirDC++ nickname" to override).`, 'info');
      } else if (nickSource === 'fallback') {
        await log(
          `Could not auto-detect a nick (no connected hub found) and none is set manually -- using placeholder name ` +
            `"${nick}" instead. The backup still includes every file and folder; only the filename may not be recognized ` +
            `by AirDC++'s "Open filelist" until you set "Your AirDC++ nickname" or connect to a hub.`,
          'warning'
        );
      }

      const roots = await getShareRoots();
      if (!roots.length) {
        throw new Error('No shared folders found -- nothing to back up.');
      }
      const groups = groupRootsByVirtualName(roots);

      const trimmedStart = (startPath || '/').trim().replace(/^\/+|\/+$/g, '');
      const resolved = trimmedStart ? await resolveVirtualPath(trimmedStart, groups) : null;

      const backupFolder = getBackupFolder();
      await fsp.mkdir(backupFolder, { recursive: true });

      const now = new Date();
      tempXmlPath = path.join(backupFolder, `.share-backup-${Date.now()}.tmp.xml`);

      const stream = fs.createWriteStream(tempXmlPath, { encoding: 'utf8' });

      stream.write('<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n');
      stream.write(
        `<FileListing Version="1" CID="${escapeXml(ownCid)}" Base="${escapeXml(startPath || '/')}" BaseDate="${Math.floor(
          now.getTime() / 1000
        )}" Generator="ShareFixxers Share-Backup ${EXTENSION_VERSION}">\n`
      );

      const excludedNames = getExcludedFolderNames();
      const counters = { files: 0, dirs: 0, bytes: 0, excluded: 0 };
      let lastProgressLog = Date.now();
      const progressCb = () => {
        const nowMs = Date.now();
        if (nowMs - lastProgressLog >= 5000) {
          lastProgressLog = nowMs;
          log(`Still working... ${counters.files} files, ${counters.dirs} folders so far.`, 'info').catch(() => {});
        }
      };

      const visitedRealPaths = new Set();

      if (resolved) {
        stream.write(`\t<Directory Name="${escapeXml(resolved.displayName)}">\n`);
        counters.dirs += 1;
        for (const realPath of resolved.realPaths) {
          await writeDirectoryContents(realPath, stream, '\t\t', counters, progressCb, visitedRealPaths, 1, excludedNames);
        }
        stream.write('\t</Directory>\n');
      } else {
        for (const group of groups) {
          if (excludedNames.has((group.virtual_name || '').toLowerCase())) {
            counters.excluded += group.roots.length;
            continue;
          }
          stream.write(`\t<Directory Name="${escapeXml(group.virtual_name)}">\n`);
          counters.dirs += 1;
          for (const root of group.roots) {
            await writeDirectoryContents(root.path, stream, '\t\t', counters, progressCb, visitedRealPaths, 1, excludedNames);
          }
          stream.write('\t</Directory>\n');
        }
      }

      stream.write('</FileListing>\n');
      await new Promise((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()));
      });

      const xmlBuffer = await fsp.readFile(tempXmlPath);

      const compressionEnabled = !!settings.getValue('compress_backup');
      let compressed;
      let fallbackToXml;
      let verificationFailed = false;
      if (compressionEnabled) {
        await log('Compressing the backup to bz2 (this can take a few minutes for a large share, running in the background)...', 'info');
        const result = await compressWithVerification(xmlBuffer, log);
        compressed = result.compressed;
        fallbackToXml = result.fallbackToXml;
        verificationFailed = !!result.fallbackToXml;
      } else {
        fallbackToXml = true;
      }

      const { dayFolder, filePath: bz2Path } = backupPathForDate(backupFolder, now, nick);
      await fsp.mkdir(dayFolder, { recursive: true });

      const outputPath = fallbackToXml ? bz2Path.replace(/\.xml\.bz2$/, '.xml') : bz2Path;

      // A same-day backup (manual or scheduled) always overwrites that
      // day's file rather than creating a second one -- the filename can't
      // carry a time/counter suffix without breaking AirDC++'s "Open
      // filelist" name recognition (see the README). Detect that here so
      // it's a visible, logged event instead of a silent overwrite.
      let previousBackupOverwritten = false;
      try {
        await fsp.access(outputPath);
        previousBackupOverwritten = true;
      } catch (e) {
        // Didn't exist yet -- nothing being overwritten.
      }

      let writtenSize;
      if (fallbackToXml) {
        await fsp.writeFile(outputPath, xmlBuffer);
        writtenSize = xmlBuffer.length;
      } else {
        await fsp.writeFile(outputPath, compressed);
        writtenSize = compressed.length;
      }
      await fsp.unlink(tempXmlPath).catch(() => {});
      tempXmlPath = null;

      const deletedCount = await cleanupOldBackups(backupFolder, settings.getValue('retention_days'));

      const sizeMb = (writtenSize / 1024 / 1024).toFixed(2);
      const excludedText = counters.excluded > 0 ? `, ${counters.excluded} folder(s) skipped by name` : '';
      const cleanupText = deletedCount > 0 ? `, ${deletedCount} old backup(s) deleted` : '';
      const overwriteText = previousBackupOverwritten ? ', overwrote the previous backup already saved today' : '';
      const formatText = !compressionEnabled
        ? ' (uncompressed .xml)'
        : verificationFailed
        ? ' (uncompressed .xml -- bz2 verification failed, see warning above)'
        : ' (bz2)';
      await log(
        `Backup complete: ${counters.files} files, ${counters.dirs} folders, ${sizeMb} MB${formatText}${excludedText}${cleanupText}${overwriteText}. Saved to: ${outputPath}`,
        'info'
      );
    } catch (e) {
      await log(`Backup failed: ${e && e.message ? e.message : e}`, 'error');
    } finally {
      if (tempXmlPath) {
        await fsp.unlink(tempXmlPath).catch(() => {});
      }
      running = false;
    }
  }

  async function isHashingBusy() {
    try {
      const stats = await socket.get('hash/stats');
      if (!stats) return false;
      const filesLeft = typeof stats.hash_files_left === 'number' ? stats.hash_files_left : 0;
      const hashers = typeof stats.hashers === 'number' ? stats.hashers : 0;
      return filesLeft > 0 || hashers > 0;
    } catch (e) {
      return false;
    }
  }

  async function waitForHashingIdle(maxWaitMs) {

    const pollMs = typeof extension.__hashWaitPollMsOverride === 'number' ? extension.__hashWaitPollMsOverride : 15000;
    const start = Date.now();
    let waited = false;
    while (Date.now() - start < maxWaitMs) {
      if (!(await isHashingBusy())) return;
      if (!waited) {
        await log(
          'AirDC++ appears to still be hashing/refreshing the share (e.g. "Refresh share at startup") -- waiting for it to finish ' +
            'before starting the scheduled backup, so the snapshot is not taken mid-refresh...',
          'info'
        );
        waited = true;
      }
      await sleep(pollMs);
    }
    if (waited) {
      await log(
        'Still hashing after waiting -- starting the scheduled backup anyway rather than skipping it. It may include some ' +
          'entries that were not yet refreshed.',
        'warning'
      );
    }
  }

  function checkSchedule() {
    // Everything in here runs directly from a setTimeout/setInterval
    // callback, which Node.js does NOT wrap in a try/catch of its own --
    // an uncaught exception at this level crashes the entire extension
    // process, not just this one scheduled check. wrap the whole body
    // defensively so a problem here (e.g. settings not being available
    // for some unexpected reason) is logged instead of taking the
    // extension down.
    try {
      const days = parseScheduleDays();
      if (days.size === 0) return;
      const now = new Date();
      if (!days.has(now.getDay())) return;
      const state = readState();
      const today = todayKey(now);
      if (state.lastAutoBackup === today) return;
      writeState({ ...state, lastAutoBackup: today });
      const maxHashWaitMs =
        typeof extension.__hashWaitMaxMsOverride === 'number' ? extension.__hashWaitMaxMsOverride : 20 * 60 * 1000;
      (async () => {
        await waitForHashingIdle(maxHashWaitMs);
        await runBackup('/', 'scheduled');
      })().catch((e) => console.error(`Scheduled backup error: ${e.message}`));
    } catch (e) {
      console.error(`checkSchedule failed unexpectedly: ${e && e.message ? e.message : e}`);
    }
  }

  const SHAREBACKUP_HELP_TEXT = `
Share-backup commands

/sharebackup - Back up the whole share
/sharebackup <path> - Back up only that share-relative folder (e.g. /Music/)

Saves an XML snapshot (names, sizes, TTH) named <nick>.<CID>.xml, in a
YYYY-MM-DD subfolder, openable directly with "Open filelist" in AirDC++ or most other DC++ clients.
Schedule, retention, bz2 compression and excluded folders are all set in
this extension's Settings tab.`;

  const sendStatus = async (type, entityId, text) => {
    if (!type || !entityId) {
      await log(text, 'info');
      return;
    }
    try {
      await socket.post(`${type}/${entityId}/status_message`, { text, severity: 'info' });
    } catch (e) {
      console.error(`Could not send status message: ${e.message}`);
    }
  };

  const handleChatCommand = async (type, data, entityId) => {
    const command = (data.command || '').toLowerCase();
    const args = data.args || [];

    if (command === 'sharebackup') {
      const startPath = args.join(' ').trim();

      if (startPath.toLowerCase() === 'help') {
        await sendStatus(type, entityId, SHAREBACKUP_HELP_TEXT);
        return;
      }

      runBackup(startPath || '/', 'manual').catch((e) => console.error(`Unexpected backup error: ${e.message}`));
    } else if (command === 'sharebackuphelp') {
      await sendStatus(type, entityId, SHAREBACKUP_HELP_TEXT);
    }
  };

  extension.onStart = async (sessionInfo) => {
    ownCid = (sessionInfo && sessionInfo.system_info && sessionInfo.system_info.cid) || '';

    await settings.load();

    // airdcpp-extension-settings silently swallows a failed settings
    // registration (e.g. AirDC++'s API rejecting one of the definitions) --
    // load() still resolves normally in that case, but no settings would ever
    // show up in AirDC++'s Settings tab, with no error visible anywhere but
    // this extension's own error.log. Surface that loudly instead.
    const loadedValues = settings.getValues();
    if (!loadedValues || typeof loadedValues.retention_days === 'undefined') {
      await log(
        'Warning: settings registration with AirDC++ appears to have failed -- no options will be visible ' +
          'or changeable in this extension\'s Settings tab, and default values will be used for everything. ' +
          'Check this extension\'s error.log for details, then restart AirDC++ to retry.',
        'error'
      );
    }

    try {
      await socket.addListener('hubs', 'hub_text_command', (data, entityId) => handleChatCommand('hubs', data, entityId));
      await socket.addListener('private_chat', 'private_chat_text_command', (data, entityId) =>
        handleChatCommand('private_chat', data, entityId)
      );
    } catch (e) {
      console.error(`Could not register command listener: ${e.message}`);
    }

    const STARTUP_GRACE_MS =
      typeof extension.__startupGraceMsOverride === 'number' ? extension.__startupGraceMsOverride : 2 * 60 * 1000;
    const startupTimer = setTimeout(checkSchedule, STARTUP_GRACE_MS);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();
    schedulerTimer = setInterval(checkSchedule, 60 * 60 * 1000);
    if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();

    await log(`Extension started (v${EXTENSION_VERSION}), command /sharebackup <path> is active. Type /sharebackuphelp for help.`, 'info');
  };

  extension.onStop = () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  };
};
