# airdcpp-share-backup

Adds a hub/private-chat command, `/sharebackup [path]`, that saves an XML
snapshot of your own share (folder names, file names, sizes, TTH) to a
local backup file. Optionally run automatically on configurable days of
the week, with automatic cleanup of old backups.

This is a backup of the file *listing* only, not the files themselves --
but it's the exact same XML format AirDC++ itself uses for filelists, so
the output is a real, valid filelist you could load in "Open own filelist"
or "Open filelist" in AirDC++ or most other DC++ clients, if you ever
needed to.

By default the backup is saved as a plain, uncompressed `.xml` file --
that's already a fully valid, directly-openable filelist, and writing it
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
  which takes noticeably longer -- see "Self-verified compression" below.
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

Since the filename can't carry a time/counter suffix without breaking that
recognition, a second backup (manual or scheduled) on the same day
overwrites that day's file rather than creating a second one. This is now
called out explicitly in the system log ("...overwrote the previous backup
already saved today") instead of happening silently.

## Self-verified compression

This only applies when the **Compress backups to bz2** setting is turned
on (off by default -- see "Settings" above).

There's no native bzip2 module available to a Node.js extension, so
compression uses a pure-JavaScript bzip2 encoder. This is a large part of
why it's slower than AirDC++'s own filelist compression, which uses a
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
  it's still busy after that cap, the backup starts anyway rather than
  being skipped -- it may just include a few not-yet-refreshed entries.

Manual `/sharebackup` is never delayed or gated by any of this -- typing
the command always starts the backup immediately, since that's an explicit
request.

None of this timing is affected by the **Compress backups to bz2**
setting -- that only changes what happens after the share walk finishes
(compress or don't), not when the backup starts.

## How it works

This walks your share using AirDC++'s own stateless Share API (real disk
paths: `GET /share_roots` + `POST /share/directories/by_real/content`),
builds the filelist XML itself, and -- only if compression is turned on --
bzip2-compresses it in a worker thread so the compression (which can take
a few minutes on a large share, since there's no native bzip2 module
available to an extension) doesn't freeze the connection to AirDC++.

Multiple real share roots added under the same virtual name are merged
into one folder, the same way AirDC++ merges them in its own filelist --
this is handled explicitly during the walk rather than relying on a
browsing session to do it.

### Why not AirDC++'s own `/generatelist`?

AirDC++ has a real, hidden hub command, `/generatelist`, that does this
same job natively and produces a genuine filelist in its own Settings
folder. It's confirmed by an AirDC++ developer and works when typed
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
plain, independent request keyed by a real disk path, and it's fully
public, documented API surface.

## Notes (1.0.4)

Forgot to build it :)

## Notes (1.0.0)

First release!

## Notes (b0.1.2 / b0.1.3)

b0.1.0 introduced a bug that made **every setting disappear from the
Settings tab, and eventually crashed the whole extension**: the new
"Compress backups to bz2" definition had an `optional: true` field that
only makes sense on string-type settings, not booleans. AirDC++'s API
rejected the whole settings-definitions request with `Field of type
boolean can't be optional` because of that one bad field, and the
extension's settings library silently swallows a rejection like that (it
only writes to this extension's own `error.log`, not the visible system
log) -- so nothing in the UI hinted at what went wrong. With settings
never actually loaded, the very next scheduled-backup timer tick then
crashed the entire extension process with `Cannot read properties of
undefined (reading 'schedule_days')`, since that check ran directly in a
setInterval/setTimeout callback -- which Node.js does not wrap in any
try/catch of its own. Fixed in b0.1.2 (removed the bad field) and b0.1.3
(that scheduled-backup check is now wrapped so a problem there is logged
instead of ever taking the whole extension down again).

As a safety net for the future, if settings registration with AirDC++ ever
fails again for any reason, this now posts a clear warning to the system
log on startup ("settings registration...appears to have failed") instead
of failing silently.

Also new in b0.1.2: overwriting a same-day backup (see "Backup filenames"
above) is now called out explicitly in the system log, instead of
happening silently.

## Notes (b0.1.4 / b0.1.7)

b0.1.4 briefly switched "Folder to save backups in" to AirDC++'s
`directory_path` setting type, which adds a native Browse button next to
the field. b0.1.7 reverted this back to plain `string` (no Browse button)
-- AirDC++ itself has a bug in that Browse dialog (clicking Browse, then
Cancel, requires clicking Browse twice to open it again), confirmed to
also affect the same button on airdcpp-sfv-folder-checker's "Default
folder to scan" setting, so it's not specific to this extension. No
behavior change otherwise -- leaving the field empty still uses the
extension's own log folder.

## Notes (b0.1.9)

Removed the "Share profile Token to back up" setting entirely. It never
supported more than one profile at a time (a comma-separated list of
Tokens was compared as one literal string, matching nothing), and backing
up everything is the simpler, expected default -- so the setting is gone
and every backup now always includes every shared folder, regardless of
share profile.

## Notes (0.1.10-beta)

Added `repository` and `bugs` fields to `package.json` (placeholder
GitHub URL -- replace `YOUR-USERNAME-HERE` with the real account/repo
before actually running `npm publish`), and flipped `private` from
`true` back to `false` in preparation for an eventual real npm publish.
Until that publish actually happens, this brings back the npmjs.org
update-check 404 that `private: true` had deliberately silenced --
harmless, just a log line, and easy to re-suppress by setting `private`
back to `true` for anyone installing from source/zip rather than a real
npm publish.

## Notes (0.1.11-beta)

Renamed the package from `airdcpp-share-backup` to `airdcpp-share-backup`.
AirDC++'s official extension spec says a package name "must start with
airdcpp-", but that turned out to only apply to extensions published
through npm's own registry and picked up via AirDC++'s in-app update
checker -- a locally-installed or FulDC++-catalogue extension with a
non-`airdcpp-`-prefixed name loads and runs identically (confirmed with
a small purpose-built test extension, installed manually and via
`dce-tiny-fileserver`'s auto-install, in real AirDC++ 4.30). Since this
whole family is only ever installed that way, `dce-` (Direct Connect
Extension) reads better than a name implying it only works with one
specific client. No functional change otherwise.

## Notes (0.1.12-beta)

Reverted the 0.1.11-beta rename: back to airdcpp-share-backup. Turns
out the official "name must start with airdcpp-" requirement is real
after all, just narrower than a quick test had suggested -- a minimal
test extension with no settings (dce-hello-fixxer) loaded, ran, and
handled chat commands fine under a non-airdcpp--prefixed name, which
looked like proof the whole requirement was obsolete. But every real
extension in this family uses settings, and AirDC++ rejects the
settings-registration API call (POST extensions/<name>/settings/
definitions) for a non-airdcpp--prefixed name -- confirmed with an
isolated one-line diff (only name/version changed, nothing else) that
reproduced a clean crash: a 400 on that endpoint, silently swallowed by
the settings library, followed by a hard crash the moment any setting
was read. Confirmed consistent even after a full AirDC++ restart, so
not a one-time registration race either. Back to airdcpp- for good. No
functional change otherwise.

## Notes (0.1.18-beta)

Wording fix only: the help text and docs said the backup file is
"openable directly with 'Open filelist' in AirDC++", which read as if
only AirDC++ could open it -- it's the standard DC++ filelist XML
format, so most other DC++ clients can open it too. Wording generalized
in the `/sharebackup help` text and in this README. No functional
change.

## Notes (0.1.17-beta)

Two changes, both purely to how help text is shown -- no backup logic
changed:

- `/sharebackup help` and `/sharebackuphelp` now reply in the same hub
  or private-chat window the command was typed in, instead of the
  general system log -- matching how `/rvalidator help` already
  behaved in airdcpp-release-fixxer.
- The help text itself is now a short list of commands, one per line,
  instead of a single long paragraph.

## Notes (0.1.16-beta)

Fixed a bug where `/sharebackup help` was silently treated as a literal
share-relative path (`help`), instead of showing usage -- resulted in a
confusing "Could not find a share root named help" failure. The
separate `/sharebackuphelp` command already worked correctly and is
unchanged; this just also catches the more natural `<command> help`
typing pattern (only when "help" is the entire argument -- a real path
is still free to contain the word). Same class of bug found and fixed
at the same time in airdcpp-sample-proof-checker and
airdcpp-sfv-folder-checker.

Also fixed, while in there: the internal `EXTENSION_VERSION` constant
(used only in the startup log line and in the XML "Generator" attribute
of each backup file) had drifted to "0.1.14-beta" -- two releases behind
package.json -- because the 0.1.15-beta repository/bugs/private change
didn't update it. Same desync bug as the one already fixed once for this
extension (see "Notes (0.1.14-beta)" below) and, separately, for
tiny-fileserver; back in sync now. No other functional change.

## Notes (0.1.14-beta)

Fixed the same version-desync bug found in tiny-fileserver: this
extension's startup log line said "v0.1.9-beta" for the last five
releases (0.1.10 through 0.1.13-beta) because a separate internal
EXTENSION_VERSION constant had fallen out of sync with package.json --
confirmed live via a user-reported system log showing "Extension
started (v0.1.9-beta)" right after auto-installing 0.1.13-beta. Back in
sync now (0.1.14-beta). No other functional change.

## Notes (0.1.13-beta)

Added a "files": ["dist"] field to package.json. Without it, `npm pack`
(or an eventual `npm publish`) would include the entire source tree
(src/, everything) since this extension has no .npmignore at all --
none of which is needed at runtime, since `dist/main.js` is a
self-contained webpack bundle. Packaging is smaller and cleaner now; no
functional change.

## Building from source

```
npm install
npm run build
```

Produces `dist/main.js`. Copy this project's folder (with `dist/main.js`
and `package.json`) into your AirDC++ extensions folder, or zip it up the
way the packaged release is structured.
