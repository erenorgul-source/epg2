# Playlist EPG

Builds a single XMLTV guide (`guide.xml` / `guide.xml.gz`) for every channel in a set of
M3U playlists. It uses as many of the sites in [`/sites`](../sites) as it needs, and
rebuilds the guide automatically on an Ubuntu server.

The playlists are listed in [`playlists.txt`](playlists.txt):

```
https://iptv-org.github.io/iptv/languages/deu.m3u
https://iptv-org.github.io/iptv/countries/uk.m3u
https://iptv-org.github.io/iptv/countries/ie.m3u
https://iptv-org.github.io/iptv/countries/au.m3u
https://iptv-org.github.io/iptv/countries/nz.m3u
https://iptv-org.github.io/iptv/countries/ca.m3u
https://iptv-org.github.io/iptv/countries/us.m3u
```

## How it works

Every run:

1. Downloads the playlists and collects the unique `tvg-id`s. The playlists above hold
   about 2,400 channels.
2. Downloads the iptv-org database (channel names, alternative names, feeds, broadcast
   areas) and reads all `sites/*/*.channels.xml` files. Sites marked 🔴 in
   [SITES.md](../SITES.md) are skipped.
3. Finds candidate sources for every channel, best first:

   | Match            | Example                                                                                |
   | ---------------- | -------------------------------------------------------------------------------------- |
   | `Override`       | your own mapping in `overrides.channels.xml`                                           |
   | `StreamId`       | stream `https://jmp2.uk/plu-<id>.m3u8` → Pluto TV channel `<id>`                       |
   | `ExactId`        | a site lists the same `xmltv_id`                                                       |
   | `Callsign`       | `ABC.us@KEROTV` → "KERO HDTV", "ABC (KERO) Bakersfield, CA"                            |
   | `NameRegionFeed` | `ABCTV.au@NSW` → "ABC TV" in the Sydney listings                                       |
   | `OtherFeed`      | another feed of the same channel (e.g. `@HD` instead of `@SD`)                         |
   | `NameRegion`     | same name in a listing for one of the countries the channel is broadcast in            |
   | `Weak`           | same name, but probably a different regional version (only used if nothing else works) |
   | `NameLanguage`   | same name and language in a listing of unknown country                                 |

   Sites that can serve many of your channels are preferred, so the guide comes from as
   few sites as possible.

4. Grabs the guide in passes. Pass 1 uses each channel's best source. A channel that
   gets less than `--min-hours` (default 12) of programmes for the next 24 hours is
   retried with its next source in pass 2, and so on, up to `--sources` (default 4)
   different sources. Each pass runs one `npm run grab` process per site, several at a
   time.
5. Merges everything into `guide.xml` and `guide.xml.gz`. The channel ids are the
   playlist's `tvg-id`s, and the names and logos come from the playlist. The guide only
   lists channels that have programmes.
6. Writes `report.md` / `report.json` (which site each channel came from, what was tried,
   what is missing) and `mapping.json` (all candidates per channel).

With the current playlists and site lists, about 1,640 of the 2,413 channels have at
least one candidate source. Most of the rest are small public access, community, church
and shopping channels that no EPG site covers. For any of them you can add a manual
mapping (see below).

## Install on Ubuntu

Tested on Ubuntu 22.04 and 24.04. As root:

```sh
git clone -b <branch> https://github.com/<you>/<repo>.git /opt/epg
/opt/epg/playlist-epg/install.sh
```

The installer:

- installs Node.js 22 (NodeSource) if Node.js 20+ is missing, plus `git` and `curl`
- creates the system user `epg` and the folders `/var/lib/epg-playlist` (output) and
  `/etc/epg-playlist` (your settings)
- installs and starts:
  - `epg-playlist.timer`: rebuilds the guide every day at 03:30 and 15:30, plus or minus a
    few minutes. A run that was missed while the server was off runs at the next boot.
  - `epg-playlist.service`: one rebuild. The first one starts right after the install.
  - `epg-playlist-serve.service`: serves the guide on port 3000

The guide is then at:

```
http://<server>:3000/guide.xml
http://<server>:3000/guide.xml.gz
http://<server>:3000/report.md
```

The first run can take an hour or more, depending on how fast the sites respond. The
guide files are replaced in one step, so players never read a half-written file.

### Useful commands

```sh
journalctl -u epg-playlist -f              # follow the current/last run
sudo systemctl start epg-playlist          # rebuild now
systemctl list-timers epg-playlist.timer   # next scheduled run
sudo systemctl edit epg-playlist.timer     # change the schedule (OnCalendar=...)
```

### What a run does

[`run.sh`](run.sh) (started by the timer):

1. `git fetch` + `git reset --hard` to the configured branch, so site fixes reach the
   server. Set `EPG_AUTO_UPDATE=0` to turn this off. Keep your changes in
   `/etc/epg-playlist`, not in the repository, because the reset overwrites changes in
   the repository folder.
2. `npm ci`, only when `package-lock.json` changed
3. `npm run api:load` to refresh the iptv-org database
4. `npm run playlist:epg` with the settings from `/etc/epg-playlist/epg.env`

If you want site fixes from [iptv-org/epg](https://github.com/iptv-org/epg), keep your fork
in sync with it (GitHub's "Sync fork" button). Or clone with `EPG_GIT_BRANCH` pointing to
a branch that you keep merged with upstream.

## Settings

`/etc/epg-playlist/epg.env`:

| Variable          | Default                                    | Description                                   |
| ----------------- | ------------------------------------------ | --------------------------------------------- |
| `EPG_PLAYLISTS`   | `/etc/epg-playlist/playlists.txt`          | one playlist URL or file path per line        |
| `EPG_OVERRIDES`   | `/etc/epg-playlist/overrides.channels.xml` | manual mappings                               |
| `EPG_DATA_DIR`    | `/var/lib/epg-playlist`                    | `public/` = output, `work/` = temporary files |
| `EPG_AUTO_UPDATE` | `1`                                        | update the code before every run              |
| `EPG_GIT_BRANCH`  | branch checked out at install              | branch to update from                         |
| `EPG_PORT`        | `3000`                                     | port of `epg-playlist-serve`                  |
| `EPG_ARGS`        | see below                                  | options for `npm run playlist:epg`            |

Options for `EPG_ARGS` / `npm run playlist:epg`:

```
--days <n>               days to grab (default: each site's own default, usually 2-7)
--sources <n>            max. sources tried per channel (default 4)
--min-hours <h>          hours of the next 24h a channel needs to count as complete (default 12)
--parallel <n>           grab processes at the same time, one site each (default 4)
--maxConnections <n>     concurrent requests per grab process (default 2)
--chunk <n>              max. channels per grab process (default 250)
--job-timeout <min>      kill a grab process after this many minutes (default 120)
--timeout <ms>           timeout per request
--exclude <sites>        comma-separated list of sites to never use
--include-broken         also use sites marked 🔴 in SITES.md
--proxy <url>            proxy for all requests (e.g. socks5://127.0.0.1:1080)
--dry-run                only match channels and write mapping.json / report.md
```

Don't raise `--maxConnections` too much: some sites block clients that send too many
requests.

## Fixing missing or wrong channels

1. Open `report.md` and look under "No source found" and "Matched, but no data".
2. Search the `sites/` folder for the channel, for example
   `grep -ri "channel name" sites/*/*.channels.xml`.
3. Copy the line into `/etc/epg-playlist/overrides.channels.xml` and set `xmltv_id` to
   the playlist's `tvg-id`:

   ```xml
   <channel site="sky.com" site_id="GB#3000" lang="en" xmltv_id="BBCOne.uk@London">BBC One Lon HD</channel>
   ```

Overrides are always tried first. If an automatic match picks the wrong schedule, an
override for that channel fixes it. To stop a site from being used at all, add it to
`--exclude`.

## Running without systemd

```sh
npm install
npm run playlist:epg -- --output=public --days=3
npx serve public
```
