import { Logger, Timer } from '@freearhey/core'
import { Option, program } from 'commander'
import { spawn } from 'node:child_process'
import { DATA_DIR, SITES_DIR } from '../../constants'
import { parseList, parseNumber } from '../../core'
import {
  Candidate,
  Database,
  GuideChannelData,
  Matcher,
  PlaylistChannel,
  SiteEntry,
  Tier,
  coveredHours,
  escapeXML,
  loadBrokenSites,
  loadSiteEntries,
  parseChannelsXML,
  parseM3U,
  parseXMLTV
} from '../../core/playlist'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

program
  .addOption(
    new Option(
      '-p, --playlists <path>',
      'File with one playlist URL (or local path) per line'
    ).default('playlist-epg/playlists.txt')
  )
  .addOption(
    new Option(
      '-o, --output <dir>',
      'Directory for guide.xml, guide.xml.gz and the report'
    ).default('playlist-epg/public')
  )
  .addOption(
    new Option(
      '--overrides <path>',
      'Channels file with manual mappings (xmltv_id = tvg-id)'
    ).default('playlist-epg/overrides.channels.xml')
  )
  .addOption(
    new Option('--workdir <dir>', 'Directory for temporary files').default('temp/playlist-epg')
  )
  .addOption(
    new Option('--exclude <sites>', 'Comma-separated list of sites to never use').argParser(
      parseList
    )
  )
  .addOption(
    new Option('--include-broken', 'Also use sites marked as broken in SITES.md').default(false)
  )
  .addOption(
    new Option('--sources <number>', 'Max. number of sites tried for each channel')
      .argParser(parseNumber)
      .default(4)
  )
  .addOption(
    new Option('--parallel <number>', 'Number of grab processes running at the same time')
      .argParser(parseNumber)
      .default(4)
  )
  .addOption(
    new Option('--maxConnections <number>', 'Concurrent requests inside each grab process')
      .argParser(parseNumber)
      .default(2)
  )
  .addOption(
    new Option('--chunk <number>', 'Max. number of channels per grab process')
      .argParser(parseNumber)
      .default(250)
  )
  .addOption(
    new Option('--job-timeout <minutes>', 'Kill a grab process after this many minutes')
      .argParser(parseNumber)
      .default(120)
  )
  .addOption(
    new Option('--min-hours <hours>', 'Hours of the next 24h a channel must cover to be complete')
      .argParser(parseNumber)
      .default(12)
  )
  .addOption(new Option('--days <days>', 'Number of days to grab').argParser(parseNumber))
  .addOption(
    new Option('-t, --timeout <milliseconds>', 'Timeout for each request').argParser(parseNumber)
  )
  .addOption(new Option('-x, --proxy <url>', 'Use the specified proxy'))
  .addOption(
    new Option('--dry-run', 'Only resolve the channel mapping, do not grab').default(false)
  )
  .parse()

interface Options {
  playlists: string
  output: string
  overrides: string
  workdir: string
  exclude?: string[]
  includeBroken: boolean
  sources: number
  parallel: number
  maxConnections: number
  chunk: number
  jobTimeout: number
  minHours: number
  days?: number
  timeout?: number
  proxy?: string
  dryRun: boolean
}

interface ChannelState {
  channel: PlaylistChannel
  candidates: Candidate[]
  next: number
  best: { candidate: Candidate; hours: number; data: GuideChannelData } | null
  tried: { site: string; site_id: string; hours: number }[]
}

interface Job {
  name: string
  channelsFile: string
  outputFile: string
  logFile: string
  states: ChannelState[]
}

const options: Options = program.opts()
const logger = new Logger({ level: 3 })

async function main() {
  const timer = new Timer()
  timer.start()

  const workdir = path.resolve(options.workdir)
  const outputDir = path.resolve(options.output)
  fs.mkdirSync(workdir, { recursive: true })
  fs.mkdirSync(outputDir, { recursive: true })

  logger.info('loading playlists...')
  const channels = await loadPlaylists(path.resolve(options.playlists), workdir)
  logger.info(`  found ${channels.size} unique channel(s)`)

  logger.info('loading database...')
  if (!fs.existsSync(path.join(DATA_DIR, 'channels.json')))
    throw new Error(`"${DATA_DIR}/channels.json" not found, run "npm run api:load" first`)
  const db = Database.load(DATA_DIR)

  logger.info('loading site channel lists...')
  const excluded = new Set(options.exclude || [])
  if (!options.includeBroken) {
    const broken = loadBrokenSites('SITES.md')
    broken.forEach(site => excluded.add(site))
    if (broken.length) logger.info(`  skipping broken sites: ${broken.join(', ')}`)
  }
  const entries = loadSiteEntries(SITES_DIR, excluded)
  const overrides = loadOverrides(options.overrides)
  logger.info(`  loaded ${entries.length} site channel(s) and ${overrides.length} override(s)`)

  logger.info('matching channels...')
  const matcher = new Matcher(db, entries, overrides)
  const states = resolveCandidates(matcher, [...channels.values()])
  const matched = states.filter(state => state.candidates.length)
  logger.info(`  matched ${matched.length} of ${states.length} channel(s)`)
  writeMapping(states, path.join(outputDir, 'mapping.json'))

  if (!options.dryRun) {
    const now = Date.now()
    const until = now + 24 * 60 * 60 * 1000

    for (let pass = 1; pass <= options.sources; pass++) {
      const pending = matched.filter(
        state =>
          (!state.best || state.best.hours < options.minHours) &&
          state.next < state.candidates.length
      )
      if (!pending.length) break

      logger.info(`pass ${pass}: grabbing ${pending.length} channel(s)...`)
      const jobs = createJobs(pending, path.join(workdir, `pass${pass}`))
      await runJobs(jobs)

      for (const job of jobs) {
        const guide = fs.existsSync(job.outputFile)
          ? parseXMLTV(fs.readFileSync(job.outputFile, 'utf8'))
          : new Map<string, GuideChannelData>()

        for (const state of job.states) {
          const candidate = state.candidates[state.next]
          state.next++
          const data = guide.get(state.channel.tvgId)
          const hours = data ? coveredHours(data.intervals, now, until) : 0
          state.tried.push({
            site: candidate.entry.site,
            site_id: candidate.entry.site_id,
            hours: Math.round(hours * 10) / 10
          })
          if (data && data.programmes.length && (!state.best || hours > state.best.hours)) {
            state.best = { candidate, hours, data }
          }
        }
      }

      const complete = matched.filter(state => state.best && state.best.hours >= options.minHours)
      logger.info(`  ${complete.length} of ${matched.length} matched channel(s) complete`)
    }

    logger.info('saving guide...')
    writeGuide(states, outputDir)
  }

  writeReport(states, outputDir, !options.dryRun)

  logger.success(`  done in ${timer.format('HH[h] mm[m] ss[s]')}`)
}

main().catch(error => {
  logger.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function loadPlaylists(
  listPath: string,
  workdir: string
): Promise<Map<string, PlaylistChannel>> {
  const sources = fs
    .readFileSync(listPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  const cacheDir = path.join(workdir, 'playlists')
  fs.mkdirSync(cacheDir, { recursive: true })

  const channels = new Map<string, PlaylistChannel>()
  for (const source of sources) {
    const cacheFile = path.join(cacheDir, source.replace(/[^a-z0-9.]+/gi, '_'))
    let content: string
    try {
      if (/^https?:\/\//.test(source)) {
        const response = await fetch(source, { signal: AbortSignal.timeout(60000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        content = await response.text()
        fs.writeFileSync(cacheFile, content)
      } else {
        content = fs.readFileSync(path.resolve(path.dirname(listPath), source), 'utf8')
      }
    } catch (error) {
      if (!fs.existsSync(cacheFile))
        throw new Error(`could not load "${source}": ${error}`, { cause: error })
      logger.warn(`  could not load "${source}" (${error}), using cached copy`)
      content = fs.readFileSync(cacheFile, 'utf8')
    }
    const before = channels.size
    parseM3U(content, source, channels)
    logger.info(`  ${source}: ${channels.size - before} new channel(s)`)
  }

  return channels
}

function loadOverrides(filepath: string): SiteEntry[] {
  if (!fs.existsSync(filepath)) return []
  return parseChannelsXML(fs.readFileSync(filepath, 'utf8'))
    .filter(entry => entry.site && entry.site_id && entry.xmltv_id)
    .map(entry => ({ ...entry, file: path.basename(filepath), group: 'overrides' }))
}

function resolveCandidates(matcher: Matcher, channels: PlaylistChannel[]): ChannelState[] {
  const all = channels.map(channel => ({ channel, candidates: matcher.getCandidates(channel) }))

  // Sites that can serve many of the channels well are preferred within a tier,
  // which keeps the number of sites (and requests) down.
  const popularity = new Map<string, number>()
  for (const { candidates } of all) {
    const sites = new Set(
      candidates.filter(c => c.tier <= Tier.NameRegionFeed).map(c => c.entry.site)
    )
    sites.forEach(site => popularity.set(site, (popularity.get(site) || 0) + 1))
  }

  return all.map(({ channel, candidates }) => {
    const sorted = candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort(
        (a, b) =>
          a.candidate.tier - b.candidate.tier ||
          b.candidate.hint - a.candidate.hint ||
          (a.candidate.tier === Tier.StreamId ? a.index - b.index : 0) ||
          (popularity.get(b.candidate.entry.site) || 0) -
            (popularity.get(a.candidate.entry.site) || 0) ||
          a.index - b.index
      )
      .map(item => item.candidate)

    // try different sites before trying the same site again
    const perSite = new Map<string, number>()
    const selected: Candidate[] = []
    for (const candidate of sorted) {
      const count = perSite.get(candidate.entry.site) || 0
      if (count >= 2) continue
      perSite.set(candidate.entry.site, count + 1)
      selected.push(candidate)
      if (selected.length >= options.sources) break
    }

    return { channel, candidates: selected, next: 0, best: null, tried: [] }
  })
}

function createJobs(states: ChannelState[], dir: string): Job[] {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const bySite = new Map<string, ChannelState[]>()
  for (const state of states) {
    const site = state.candidates[state.next].entry.site
    const list = bySite.get(site) || []
    list.push(state)
    bySite.set(site, list)
  }

  const jobs: Job[] = []
  for (const [site, siteStates] of bySite) {
    for (let i = 0; i < siteStates.length; i += options.chunk) {
      const chunk = siteStates.slice(i, i + options.chunk)
      const name = `${site}-${i / options.chunk + 1}`
      const job: Job = {
        name,
        channelsFile: path.join(dir, `${name}.channels.xml`),
        outputFile: path.join(dir, `${name}.xml`),
        logFile: path.join(dir, `${name}.log`),
        states: chunk
      }

      let xml = '<?xml version="1.0" encoding="UTF-8"?>\r\n<channels>\r\n'
      for (const state of chunk) {
        const { entry } = state.candidates[state.next]
        xml += `  <channel site="${escapeXML(entry.site)}" site_id="${escapeXML(entry.site_id)}" lang="${escapeXML(entry.lang)}" xmltv_id="${escapeXML(state.channel.tvgId)}">${escapeXML(entry.name || state.channel.name)}</channel>\r\n`
      }
      xml += '</channels>\r\n'
      fs.writeFileSync(job.channelsFile, xml)

      jobs.push(job)
    }
  }

  // biggest jobs first so they do not end up running alone at the end
  return jobs.sort((a, b) => b.states.length - a.states.length)
}

async function runJobs(jobs: Job[]) {
  let index = 0
  const worker = async () => {
    while (index < jobs.length) {
      const job = jobs[index++]
      const started = Date.now()
      const code = await runGrab(job)
      const seconds = Math.round((Date.now() - started) / 1000)
      logger.info(`  ${job.name}: ${job.states.length} channel(s), exit ${code}, ${seconds}s`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.parallel) }, worker))
}

function runGrab(job: Job): Promise<number | null> {
  const tsx = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  const args = [
    'scripts/commands/epg/grab.ts',
    `--channels=${job.channelsFile}`,
    `--output=${job.outputFile}`,
    `--maxConnections=${options.maxConnections}`
  ]
  if (options.days) args.push(`--days=${options.days}`)
  if (options.timeout) args.push(`--timeout=${options.timeout}`)
  if (options.proxy) args.push(`--proxy=${options.proxy}`)

  return new Promise(resolve => {
    const log = fs.openSync(job.logFile, 'w')
    const child = spawn(tsx, args, { stdio: ['ignore', log, log] })
    const timeout = setTimeout(
      () => {
        fs.appendFileSync(job.logFile, `\nkilled after ${options.jobTimeout} minutes\n`)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 10000).unref()
      },
      options.jobTimeout * 60 * 1000
    )
    child.on('close', code => {
      clearTimeout(timeout)
      fs.closeSync(log)
      resolve(code)
    })
    child.on('error', error => {
      clearTimeout(timeout)
      fs.appendFileSync(job.logFile, `\n${error.message}\n`)
    })
  })
}

function writeGuide(states: ChannelState[], outputDir: string) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const withData = states
    .filter(state => state.best)
    .sort((a, b) => a.channel.tvgId.localeCompare(b.channel.tvgId))

  const parts: string[] = [`<?xml version="1.0" encoding="UTF-8" ?><tv date="${date}">\n`]
  for (const state of withData) {
    const { channel } = state
    const icon = channel.logo || state.best?.data.xml.match(/<icon src="([^"]*)"/)?.[1]
    const url = state.best?.data.xml.match(/<url>([^<]*)<\/url>/)?.[1]
    parts.push(
      `<channel id="${escapeXML(channel.tvgId)}"><display-name>${escapeXML(channel.name)}</display-name>` +
        (icon ? `<icon src="${channel.logo ? escapeXML(icon) : icon}"/>` : '') +
        (url ? `<url>${url}</url>` : '') +
        '</channel>\n'
    )
  }
  for (const state of withData) {
    for (const programme of state.best?.data.programmes || []) parts.push(programme, '\n')
  }
  parts.push('</tv>\n')

  const xml = parts.join('')
  writeAtomic(path.join(outputDir, 'guide.xml'), xml)
  writeAtomic(path.join(outputDir, 'guide.xml.gz'), zlib.gzipSync(xml))
  logger.info(`  saved ${withData.length} channel(s) to "${path.join(outputDir, 'guide.xml')}"`)
}

function writeAtomic(filepath: string, content: string | Buffer) {
  const tmp = `${filepath}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filepath)
}

function writeMapping(states: ChannelState[], filepath: string) {
  const mapping = states.map(state => ({
    tvg_id: state.channel.tvgId,
    name: state.channel.name,
    candidates: state.candidates.map(c => ({
      site: c.entry.site,
      site_id: c.entry.site_id,
      name: c.entry.name,
      match: Tier[c.tier]
    }))
  }))
  writeAtomic(filepath, JSON.stringify(mapping, null, 2))
}

function writeReport(states: ChannelState[], outputDir: string, grabbed: boolean) {
  const unmatched = states.filter(state => !state.candidates.length)
  const failed = states.filter(state => state.candidates.length && !state.best)
  const partial = states.filter(state => state.best && state.best.hours < options.minHours)
  const complete = states.filter(state => state.best && state.best.hours >= options.minHours)

  const sites = new Map<string, number>()
  for (const state of states) {
    if (!state.best) continue
    const site = state.best.candidate.entry.site
    sites.set(site, (sites.get(site) || 0) + 1)
  }

  const report = {
    generated: new Date().toISOString(),
    total: states.length,
    matched: states.length - unmatched.length,
    complete: complete.length,
    partial: partial.length,
    failed: failed.length,
    unmatched: unmatched.length,
    sites: Object.fromEntries([...sites].sort((a, b) => b[1] - a[1])),
    channels: states.map(state => ({
      tvg_id: state.channel.tvgId,
      name: state.channel.name,
      playlists: state.channel.playlists,
      source: state.best
        ? {
            site: state.best.candidate.entry.site,
            site_id: state.best.candidate.entry.site_id,
            match: Tier[state.best.candidate.tier],
            hours: Math.round(state.best.hours * 10) / 10,
            programmes: state.best.data.programmes.length
          }
        : null,
      tried: state.tried
    }))
  }
  writeAtomic(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2))

  const lines: string[] = [
    '# Playlist EPG report',
    '',
    `Generated: ${report.generated}`,
    '',
    '| | Channels |',
    '| --- | ---: |',
    `| In playlists | ${report.total} |`,
    `| Matched to at least one site | ${report.matched} |`
  ]
  if (grabbed) {
    lines.push(
      `| Complete (>= ${options.minHours}h of the next 24h) | ${report.complete} |`,
      `| Partial | ${report.partial} |`,
      `| Matched, but no site returned data | ${report.failed} |`
    )
  }
  lines.push(`| No source found | ${report.unmatched} |`, '')

  if (grabbed) {
    lines.push('## Sites used', '', '| Site | Channels |', '| --- | ---: |')
    for (const [site, count] of Object.entries(report.sites)) lines.push(`| ${site} | ${count} |`)
    lines.push('')

    lines.push('## Matched, but no data', '')
    for (const state of failed) {
      const tried = state.tried.map(t => `${t.site} (${t.site_id})`).join(', ')
      lines.push(`- \`${state.channel.tvgId}\` ${state.channel.name} — tried: ${tried}`)
    }
    lines.push('')
  }

  lines.push('## No source found', '')
  for (const state of unmatched) lines.push(`- \`${state.channel.tvgId}\` ${state.channel.name}`)
  lines.push('')

  writeAtomic(path.join(outputDir, 'report.md'), lines.join('\n'))
  if (grabbed) {
    logger.info(
      `  complete: ${report.complete}, partial: ${report.partial}, no data: ${report.failed}, no source: ${report.unmatched}`
    )
  }
}
