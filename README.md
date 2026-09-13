# airdcpp-share-backup

Adds a hub/private-chat command, `/sharebackup [path]`, that saves an XML
snapshot of your own share (folder names, file names, sizes, TTH) to a
local backup file. Optionally run automatically on configurable days of
the week, with automatic cleanup of old backups.

This is a backup of the file *listing* only, not the files themselves --
but it is the exact same XML format AirDC++ itself uses for filelists, so
the output is a real, valid filelist you could load in or "Open filelist"
in AirDC++ or most other DC++ clients, if you ever needed to.

By default the backup is saved as a plain, uncompressed `.xml` file --
that is already a fully valid, directly-openable filelist, and writing it
is fast regardless of share size. Turning on the **Compress backups to
bz2** setting instead produces a smaller `.xml.bz2`, matching what AirDC++
itself writes for filelists, at the cost of extra time (see "Self-verified
compression" below for why, and "Automatic backup timing" for how this
also affects scheduled backups).

## Commands

- `/sharebackup` -- back up your whole share right now.
- `/sharebackup <path>` -- back up just one virtual folder (and everything
  under it), e.g. `/sharebackup /Music/`.
- `/sharebackuphelp` -- show a short in-hub reminder of these commands and
  the current settings.

## Settings

- **Folder to save backups in** -- leave empty to use the extension's own
  log folder, under a `backups` subfolder. Each backup is saved as
  `<this folder>/YYYY-MM-DD/<nick>.<CID>.xml` (or `.xml.bz2` if compression
  is turned on).
- **Compress backups to bz2** -- off by default, which saves each backup as
  a plain `.xml` file: already directly openable, and fast to write no
  matter how large your share is. Turn this on to instead compress to
  `.xml.bz2` (smaller file, matches AirDC++'s own filelist format exactly),
  which takes noticeably longer -- see [Self-verified compression](#Self-verified-compression) below.
- **Your AirDC++ nickname** -- leave empty to auto-detect from a currently
  connected hub (falls back to your global nick there). Fill this in only
  if you want to force a specific name instead, e.g. if you use different
  nicks on different hubs. The backup always runs and saves every file and
  folder regardless of whether a nick could be found -- if none is
  available at all (no hub connected and nothing set here), a placeholder
  name (`Unknown`) is used instead so nothing is ever skipped, with a
  warning logged.
- **Skip these virtual folders** -- comma-separated folder names to leave
  out of the backup (matched anywhere in the tree).
- **Automatically back up on these days** -- comma-separated English day
  names, e.g. `monday` or `monday,thursday`. Empty by default, which
  disables automatic backups entirely (`/sharebackup` still always works
  manually). Checked once at startup and then hourly, so a missed day
  (AirDC++ was off) still runs once it's back on, but never more than once
  per calendar day.
- **Delete backups older than this many days** -- 0 disables cleanup.
  Checked after every backup, manual or automatic; removes whole dated
  folders, not individual files.

## Backup filenames

`<nick>.<CID>.xml` by default, or `<nick>.<CID>.xml.bz2` if compression is
turned on -- e.g. `YourNick.D4I7FFUWQLQGGMUVSZJQG47AS3FNW7WD4SZD4VI.xml`.
This is the exact naming convention AirDC++ itself uses for filelists,
saved inside a `YYYY-MM-DD` subfolder of the backup folder (e.g.
`2026-08-24/YourNick.D4I7FF....xml`). This is what makes the file openable
directly with "Open filelist" in AirDC++ or most other DC++ clients; a
differently-named file is
rejected with "invalid filelist name". AirDC++ looks for a compressed
version first and only falls back to an uncompressed one if no `.bz2`
exists, so a plain `.xml` opens exactly the same way -- compression is
purely about file size, never about whether it can be opened.

Since the filename cannot carry a time/counter suffix without breaking that
recognition, a second backup (manual or scheduled) on the same day
overwrites that day's file rather than creating a second one. This is now
called out explicitly in the system log ("...overwrote the previous backup
already saved today") instead of happening silently.

## Self-verified compression

This only applies when the **Compress backups to bz2** setting is turned
on (off by default -- see [Settings](#Settings) above).

There is no native bzip2 module available to a Node.js extension, so
compression uses a pure-JavaScript bzip2 encoder. This is a large part of
why it is slower than AirDC++'s own filelist compression, which uses a
native C++ implementation instead. Real-world testing on large shares
(tens of millions of files) also found that the pure-JS encoder can,
rarely, write one corrupt block in an otherwise-fine file -- invisible
until something tries to open it, at which point AirDC++ reports "invalid
filelist name"/"error while unpacking", or an archive tool like WinRAR
reports a checksum error.

To make sure this never ships a silently-broken backup, every compressed
backup is decompressed and compared byte-for-byte against the original
data immediately after compressing, before the file is ever written:

- If it matches, the `.bz2` is written normally.
- If not, one retry is made with a different block size (this reliably
  dodges the bug, since it shifts where every block boundary falls).
- If that also fails, the backup is saved as a plain, uncompressed `.xml`
  file instead (same name, `.xml` instead of `.xml.bz2`) -- still a fully
  valid, readable FileListing, just not bzip2-compressed. A warning is
  logged explaining why. This is rare in practice, but guarantees a
  usable backup either way rather than a corrupt one.

## Automatic backup timing

An automatic (scheduled) backup is never started the instant the extension
connects. Two protections avoid it racing AirDC++'s own "Refresh share at
startup" (which can be running at the exact same moment, since both are
triggered by AirDC++ starting up):

- The very first schedule check after startup is delayed by a couple of
  minutes, giving AirDC++'s own directory scan a head start.
- Before an automatic backup actually begins, the extension checks
  AirDC++'s hashing status and waits (polling periodically, up to 20
  minutes) for it to go idle, logging a clear message while it waits. If
  it is still busy after that cap, the backup starts anyway rather than
  being skipped -- it may just include a few not-yet-refreshed entries.

Manual `/sharebackup` is never delayed or gated by any of this -- typing
the command always starts the backup immediately, since that is an explicit
request.

None of this timing is affected by the **Compress backups to bz2**
setting -- that only changes what happens after the share walk finishes
(compress or do not compress), not when the backup starts.

## How it works

This walks your share using AirDC++'s own stateless Share API (real disk
paths: `GET /share_roots` + `POST /share/directories/by_real/content`),
builds the filelist XML itself, and -- only if compression is turned on --
bzip2-compresses it in a worker thread so the compression (which can take
a few minutes on a large share, since there is no native bzip2 module
available to an extension) does not freeze the connection to AirDC++.

Multiple real share roots added under the same virtual name are merged
into one folder, the same way AirDC++ merges them in its own filelist --
this is handled explicitly during the walk rather than relying on a
browsing session to do it.

## Why not AirDC++'s own `/generatelist`?

AirDC++ has a real, hidden hub command, `/generatelist`, that does this
same job natively and produces a genuine filelist in its own Settings
folder. It is confirmed by an AirDC++ developer and works when typed
directly into a hub's chat window.

Two earlier versions of this extension tried to use it instead of the
Share API, and both were tested against a real AirDC++ install:

- Using AirDC++'s "own filelist" browsing session API (the same thing
  "Open own filelist" uses) could get stuck retrying a directory that
  never became available, and corrupt the browsing session so every
  remaining folder failed too.
- Triggering `/generatelist` through the Web API's chat-message endpoint
  (both the per-hub and "all hubs" variants) is silently accepted --
  no error -- but never actually regenerates the file. Whatever maps the
  text `/generatelist` to the actual action appears to live only in the
  web UI's own client-side code, not anywhere an extension can reach over
  the WebSocket/REST API.

The Share API approach in this version has no session to corrupt and no
dependency on an undocumented, API-unreachable command -- every call is a
plain, independent request keyed by a real disk path, and it is fully
public, documented API surface.

## What is new in each version
[Changelog](https://github.com/sharefixxers/airdcpp-share-backup/blob/master/CHANGELOG.md)

## Troubleshooting
Enable extension debug mode from application settings and check the extension error logs
`(Settings\Extensions\airdcpp-share-backup\logs)` for additional information.

