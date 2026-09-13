## Notes (1.0.1 / 1.0.2 / 1.0.3 / 1.0.4)

Some issues with publishing it!

## Notes (1.0.0)

First final release!

## Notes (0.1.18-beta)

Wording fix only: the help text and docs said the backup file is
"openable directly with 'Open filelist' in AirDC++", which read as if
only AirDC++ could open it -- it is the standard DC++ filelist XML
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

Produces `dist/main.js`. Copy this project's folder (with `dist/main.js`
and `package.json`) into your AirDC++ extensions folder, or zip it up the
way the packaged release is structured.

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

## Notes (b0.1.9)

Removed the "Share profile Token to back up" setting entirely. It never
supported more than one profile at a time (a comma-separated list of
Tokens was compared as one literal string, matching nothing), and backing
up everything is the simpler, expected default -- so the setting is gone
and every backup now always includes every shared folder, regardless of
share profile.

## Notes (b0.1.4 / b0.1.7)

b0.1.4 briefly switched "Folder to save backups in" to AirDC++'s
`directory_path` setting type, which adds a native Browse button next to
the field. b0.1.7 reverted this back to plain `string` (no Browse button)
-- AirDC++ itself has a bug in that Browse dialog (clicking Browse, then
Cancel, requires clicking Browse twice to open it again), confirmed to
also affect the same button on airdcpp-sfv-folder-checker's "Default
folder to scan" setting, so it is not specific to this extension. No
behavior change otherwise -- leaving the field empty still uses the
extension's own log folder.

## Notes (b0.1.2 / b0.1.3)

b0.1.0 introduced a bug that made **every setting disappear from the
Settings tab, and eventually crashed the whole extension**: the new
"Compress backups to bz2" definition had an `optional: true` field that
only makes sense on string-type settings, not booleans. AirDC++'s API
rejected the whole settings-definitions request with `Field of type
boolean cannot be optional` because of that one bad field, and the
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
