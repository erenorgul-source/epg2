import fs from 'node:fs'
import path from 'node:path'
import langs from 'langs'

// ---------------------------------------------------------------------------
// M3U playlists
// ---------------------------------------------------------------------------

export interface PlaylistChannel {
  tvgId: string
  channelId: string
  feedId: string | null
  name: string
  logo: string | null
  urls: string[]
  playlists: string[]
}

export function parseM3U(content: string, source: string, into: Map<string, PlaylistChannel>) {
  const lines = content.split(/\r?\n/)
  let current: { tvgId: string; name: string; logo: string | null } | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#EXTINF')) {
      const tvgId = getAttr(line, 'tvg-id')
      const logo = getAttr(line, 'tvg-logo')
      const commaIndex = findTitleComma(line)
      const name = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : ''
      current = tvgId ? { tvgId, name: cleanStreamTitle(name), logo: logo || null } : null
      continue
    }

    if (line.startsWith('#')) continue
    if (!current) continue

    let channel = into.get(current.tvgId)
    if (!channel) {
      const [channelId, feedId] = current.tvgId.split('@')
      channel = {
        tvgId: current.tvgId,
        channelId,
        feedId: feedId || null,
        name: current.name || channelId,
        logo: current.logo,
        urls: [],
        playlists: []
      }
      into.set(current.tvgId, channel)
    }
    if (!channel.logo && current.logo) channel.logo = current.logo
    channel.urls.push(line)
    if (!channel.playlists.includes(source)) channel.playlists.push(source)
    current = null
  }
}

function getAttr(line: string, name: string): string {
  const match = line.match(new RegExp(`${name}="([^"]*)"`))
  return match ? match[1].trim() : ''
}

// the title is everything after the first comma that is not inside a quoted attribute
function findTitleComma(line: string): number {
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ',' && !inQuotes) return i
  }
  return -1
}

// "BBC One (1080p) [Geo-blocked]" -> "BBC One"
export function cleanStreamTitle(title: string): string {
  return title
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\((?:\d{3,4}[pi]|4K|UHD)\)/gi, '')
    .trim()
}

// ---------------------------------------------------------------------------
// iptv-org database (temp/data/*.json)
// ---------------------------------------------------------------------------

export interface DbChannel {
  id: string
  name: string
  alt_names?: string[]
  country: string
  closed?: string | null
}

export interface DbFeed {
  channel: string
  id: string
  name: string
  alt_names?: string[]
  is_main: boolean
  broadcast_area: string[]
  languages: string[]
}

interface DbRegion {
  code: string
  countries: string[]
}

export class Database {
  channels = new Map<string, DbChannel>()
  feeds = new Map<string, DbFeed[]>()
  regions = new Map<string, string[]>()

  static load(dataDir: string): Database {
    const db = new Database()
    const read = <T>(name: string): T[] => {
      const filepath = path.join(dataDir, `${name}.json`)
      if (!fs.existsSync(filepath)) return []
      return JSON.parse(fs.readFileSync(filepath, 'utf8')) as T[]
    }

    for (const channel of read<DbChannel>('channels')) db.channels.set(channel.id, channel)
    for (const feed of read<DbFeed>('feeds')) {
      const list = db.feeds.get(feed.channel) || []
      list.push(feed)
      db.feeds.set(feed.channel, list)
    }
    for (const region of read<DbRegion>('regions')) db.regions.set(region.code, region.countries)

    return db
  }

  getFeed(channelId: string, feedId: string | null): DbFeed | undefined {
    const feeds = this.feeds.get(channelId) || []
    if (feedId) return feeds.find(feed => feed.id === feedId)
    return feeds.find(feed => feed.is_main) || feeds[0]
  }

  // Countries a feed is broadcast in, falling back to the channel's home country
  getCountries(channelId: string, feedId: string | null): Set<string> {
    const countries = new Set<string>()
    const feed = this.getFeed(channelId, feedId)
    if (feed) {
      for (const area of feed.broadcast_area) {
        const [type, code] = area.split('/')
        if (type === 'c') countries.add(code)
        else if (type === 's') countries.add(code.split('-')[0])
        else if (type === 'ct') countries.add(code.slice(0, 2))
        else if (type === 'r') {
          // "INT" and other huge regions say nothing useful about the schedule
          const regionCountries = this.regions.get(code) || []
          if (regionCountries.length <= 10) regionCountries.forEach(c => countries.add(c))
        }
      }
    }
    if (!countries.size) {
      const channel = this.channels.get(channelId)
      if (channel?.country) countries.add(channel.country)
    }
    return countries
  }

  getLanguages(channelId: string, feedId: string | null): Set<string> {
    const result = new Set<string>()
    const feed = this.getFeed(channelId, feedId)
    for (const code of feed?.languages || []) {
      const lang = langs.where('3', code)
      if (lang) result.add(lang['1'])
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Site channel lists (sites/*/*.channels.xml)
// ---------------------------------------------------------------------------

export interface SiteEntry {
  site: string
  site_id: string
  lang: string
  xmltv_id: string
  name: string
  file: string
  group: string
}

export function loadSiteEntries(sitesDir: string, excludeSites: Set<string>): SiteEntry[] {
  const entries: SiteEntry[] = []

  for (const site of fs.readdirSync(sitesDir)) {
    if (excludeSites.has(site)) continue
    const dir = path.join(sitesDir, site)
    if (!fs.statSync(dir).isDirectory()) continue

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.channels.xml')) continue
      const xml = fs.readFileSync(path.join(dir, file), 'utf8')
      for (const entry of parseChannelsXML(xml)) {
        if (!entry.site || !entry.site_id) continue
        const prefix = entry.site_id.includes('#') ? entry.site_id.split('#')[0] : ''
        entries.push({ ...entry, file, group: `${file}|${prefix}` })
      }
    }
  }

  return entries
}

export function parseChannelsXML(xml: string): Omit<SiteEntry, 'file' | 'group'>[] {
  const result: Omit<SiteEntry, 'file' | 'group'>[] = []
  const regex = /<channel\s([^>]*?)\/?>(?:([\s\S]*?)<\/channel>)?/g
  const content = xml.replace(/<!--[\s\S]*?-->/g, '')
  let match: RegExpExecArray | null
  while ((match = regex.exec(content))) {
    const attrs: Record<string, string> = {}
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = unescapeXML(attr[2])
    }
    result.push({
      site: attrs.site || '',
      site_id: attrs.site_id || '',
      lang: attrs.lang || '',
      xmltv_id: attrs.xmltv_id || '',
      name: unescapeXML((match[2] || '').trim())
    })
  }
  return result
}

// Sites marked 🔴 (broken) in SITES.md
export function loadBrokenSites(sitesMdPath: string): string[] {
  if (!fs.existsSync(sitesMdPath)) return []
  const md = fs.readFileSync(sitesMdPath, 'utf8')
  const broken: string[] = []
  for (const row of md.split(/<tr>/)) {
    if (!row.includes('🔴')) continue
    const match = row.match(/href="sites\/([^"]+)"/)
    if (match) broken.push(match[1])
  }
  return broken
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export enum Tier {
  Override = 0,
  StreamId = 1,
  ExactId = 2,
  Callsign = 3,
  NameRegionFeed = 4,
  OtherFeed = 5,
  NameRegion = 6,
  Weak = 7,
  NameLanguage = 8
}

export interface Candidate {
  entry: SiteEntry
  tier: Tier
  hint: number
}

const GENERIC_TLDS = new Set([
  'tv',
  'io',
  'me',
  'fm',
  'co',
  'cc',
  'ai',
  'ws',
  'to',
  'ly',
  'gg',
  'la',
  'nu',
  'am',
  'pw',
  'sh',
  'so',
  'gl',
  'vc',
  'st',
  'ag',
  'gd',
  'sc',
  'tk',
  'ps',
  'eu',
  'xyz',
  'one',
  'app',
  'online'
])

const QUALITY_WORDS =
  /\b(hd|sd|uhd|fhd|4k|8k|1080[pi]|720p|576[pi]|480[pi]|tv|television|channel|the)\b/g

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(QUALITY_WORDS, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

function tokenize(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

// Feed ids such as "SD" or "HD" do not identify a region, so they are not used as hints
const NEUTRAL_FEEDS = new Set(['sd', 'hd', 'uhd', 'fhd', '4k', 'main', 'tv'])

function feedTokens(feed: DbFeed | undefined): string[] {
  if (!feed) return []
  return [feed.id, feed.id.replace(/(HD|SD|UHD)$/, ''), feed.name, ...(feed.alt_names || [])]
    .map(value => tokenize(value).join(' '))
    .filter(value => value && !NEUTRAL_FEEDS.has(value))
}

const CALLSIGN = /^[kwc][a-z]{2,4}$/
const FILLER_WORDS = new Set([
  'hd',
  'hdtv',
  'sd',
  'tv',
  'dt',
  'ld',
  'cd',
  'the',
  'channel',
  'east',
  'west'
])

// "KERO-TV" -> "kero", "CBUFT-DT" -> "cbuft"
function getCallsign(feed: DbFeed | undefined): string | null {
  if (!feed) return null
  const base = feed.name.split(/[-\s]/)[0]
  return /^[KWC][A-Z]{2,4}$/.test(base) ? base.toLowerCase() : null
}

function matchesAny(tokens: string[], haystackTokens: string[], haystackJoined: string): boolean {
  return tokens.some(token =>
    token.includes(' ') ? haystackJoined.includes(token) : haystackTokens.includes(token)
  )
}

function normalizeCountry(code: string): string {
  const upper = code.toUpperCase()
  return upper === 'GB' ? 'UK' : upper
}

export class Matcher {
  private byId = new Map<string, SiteEntry[]>()
  private byChannel = new Map<string, SiteEntry[]>()
  private byName = new Map<string, SiteEntry[]>()
  private byStreamId = new Map<string, SiteEntry[]>()
  private byCallsign = new Map<string, SiteEntry[]>()
  private groupCountries = new Map<string, Set<string>>()

  constructor(
    private db: Database,
    entries: SiteEntry[],
    overrides: SiteEntry[]
  ) {
    this.overrides = new Map()
    for (const entry of overrides) {
      const list = this.overrides.get(entry.xmltv_id) || []
      list.push(entry)
      this.overrides.set(entry.xmltv_id, list)
    }

    const push = (map: Map<string, SiteEntry[]>, key: string, entry: SiteEntry) => {
      if (!key) return
      const list = map.get(key)
      if (list) list.push(entry)
      else map.set(key, [entry])
    }

    const groupStats = new Map<string, Map<string, number>>()
    for (const entry of entries) {
      if (entry.xmltv_id) {
        push(this.byId, entry.xmltv_id, entry)
        const [channelId, feedId] = entry.xmltv_id.split('@')
        push(this.byChannel, channelId, entry)

        const stats = groupStats.get(entry.group) || new Map<string, number>()
        for (const country of db.getCountries(channelId, feedId || null)) {
          stats.set(country, (stats.get(country) || 0) + 1)
        }
        groupStats.set(entry.group, stats)
      }

      const key = normalizeName(entry.name)
      if (key.length >= 2) push(this.byName, key, entry)

      const tail = entry.site_id.split('#').pop() || ''
      if (tail.length >= 12) push(this.byStreamId, tail, entry)

      for (const token of new Set(tokenize(`${entry.name} ${entry.site_id}`))) {
        if (CALLSIGN.test(token)) push(this.byCallsign, token, entry)
      }
    }

    // A group (file + site_id prefix) is assumed to cover the countries that make up
    // a notable share of its already mapped channels. Groups without any mapped
    // channels fall back to the site's country-code TLD.
    const groups = new Set(entries.map(entry => entry.group))
    const siteOfGroup = new Map(entries.map(entry => [entry.group, entry.site]))
    for (const group of groups) {
      const countries = new Set<string>()
      const stats = groupStats.get(group)
      if (stats) {
        const total = [...stats.values()].reduce((a, b) => a + b, 0)
        for (const [country, count] of stats) {
          if (count >= 2 && count / total >= 0.15) countries.add(country)
        }
      }
      if (!countries.size) {
        // tags such as "US1" or "US_LOCALS2" (epgshare01.online)
        const prefix = group.split('|')[1].match(/^([A-Z]{2})(?:\d+|_[A-Z_]+\d*)$/)
        if (prefix) countries.add(normalizeCountry(prefix[1]))
      }
      if (!countries.size) {
        const site = siteOfGroup.get(group) || ''
        const tld = site.split('.').pop() || ''
        if (tld.length === 2 && !GENERIC_TLDS.has(tld)) countries.add(normalizeCountry(tld))
      }
      this.groupCountries.set(group, countries)
    }
  }

  private overrides: Map<string, SiteEntry[]>

  getCandidates(channel: PlaylistChannel): Candidate[] {
    const candidates: Candidate[] = []
    const seen = new Set<string>()
    const add = (entry: SiteEntry, tier: Tier, hint = 0) => {
      const key = `${entry.site}|${entry.site_id}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push({ entry, tier, hint })
    }

    const { channelId, feedId, tvgId } = channel
    const targetCountries = this.db.getCountries(channelId, feedId)
    const targetLangs = this.db.getLanguages(channelId, feedId)
    const ownFeed = this.db.getFeed(channelId, feedId)
    const ownTokens = feedTokens(ownFeed)
    const otherTokens = (this.db.feeds.get(channelId) || [])
      .filter(feed => feed !== ownFeed)
      .flatMap(feed => feedTokens(feed))
      .filter(token => !ownTokens.includes(token))

    const getHint = (entry: SiteEntry): number => {
      const haystack = tokenize(`${entry.site_id} ${entry.name} ${entry.xmltv_id}`)
      const joined = haystack.join(' ')
      if (ownTokens.length && matchesAny(ownTokens, haystack, joined)) return 1
      if (otherTokens.length && matchesAny(otherTokens, haystack, joined)) return -1
      return 0
    }

    // 0. manual overrides
    for (const entry of this.overrides.get(tvgId) || []) add(entry, Tier.Override)

    // 1. stream URLs that embed a provider channel id (e.g. https://jmp2.uk/plu-<pluto id>.m3u8)
    for (const url of channel.urls) {
      const match = url.match(/jmp2\.uk\/[a-z]+-([^/.?]+)/i)
      if (!match) continue
      const entries = this.byStreamId.get(match[1]) || []
      const sorted = [...entries].sort(
        (a, b) =>
          Number(this.inRegion(b, targetCountries)) - Number(this.inRegion(a, targetCountries))
      )
      for (const entry of sorted) add(entry, Tier.StreamId)
    }

    // 2. exact xmltv_id
    for (const entry of this.byId.get(tvgId) || []) add(entry, Tier.ExactId)

    const dbChannel = this.db.channels.get(channelId)
    const baseNames = [channel.name, dbChannel?.name, ...(dbChannel?.alt_names || [])].filter(
      (name): name is string => !!name
    )

    // 3. local stations (feeds such as "KERO-TV" or "CBUFT-DT") by their callsign
    const callsign = getCallsign(ownFeed)
    if (callsign) {
      const nameTokens = new Set(
        baseNames.flatMap(name => tokenize(name)).filter(token => !FILLER_WORDS.has(token))
      )
      for (const entry of this.byCallsign.get(callsign) || []) {
        if (entry.xmltv_id && entry.xmltv_id.split('@')[0] !== channelId) continue
        const rest = tokenize(entry.name).filter(
          token => token !== callsign && !FILLER_WORDS.has(token) && !/^\d+$/.test(token)
        )
        // "KERO HDTV" and "ABC (KERO) Bakersfield" are ours, "Scripps News (KERO-TV6)" is not
        if (rest.length && !rest.some(token => nameTokens.has(token))) continue
        add(entry, Tier.Callsign)
      }
    }

    // 4-8. names and other feeds of the same channel
    const feedNames = ownFeed ? [ownFeed.name, ...(ownFeed.alt_names || [])] : []
    // alternative names are only trusted together with a region match
    const primaryNames = [channel.name, dbChannel?.name].filter((name): name is string => !!name)
    const nameKeys = new Map<string, boolean>()
    for (const name of baseNames) {
      const primary = primaryNames.includes(name)
      const keys = [name, ...feedNames.map(feedName => `${name} ${feedName}`)].map(normalizeName)
      for (const key of keys) nameKeys.set(key, nameKeys.get(key) || primary)
    }

    const nameMatches: { entry: SiteEntry; primary: boolean }[] = []
    for (const [key, primary] of nameKeys) {
      if (key.length < 2) continue
      for (const entry of this.byName.get(key) || []) {
        // an entry that is mapped to a different channel is not ours
        if (entry.xmltv_id && entry.xmltv_id.split('@')[0] !== channelId) continue
        nameMatches.push({ entry, primary: primary && key.length >= 4 })
      }
    }

    const ranked: Candidate[] = []
    for (const { entry, primary } of nameMatches) {
      const hint = getHint(entry)
      if (this.inRegion(entry, targetCountries)) {
        ranked.push({
          entry,
          hint,
          tier: hint > 0 ? Tier.NameRegionFeed : hint < 0 ? Tier.Weak : Tier.NameRegion
        })
      } else if (
        primary &&
        !this.groupCountries.get(entry.group)?.size &&
        targetLangs.has(entry.lang)
      ) {
        ranked.push({ entry, hint, tier: Tier.NameLanguage })
      }
    }
    for (const entry of this.byChannel.get(channelId) || []) {
      const hint = getHint(entry)
      const foreign =
        !!this.groupCountries.get(entry.group)?.size && !this.inRegion(entry, targetCountries)
      ranked.push({ entry, hint, tier: hint < 0 || foreign ? Tier.Weak : Tier.OtherFeed })
    }

    ranked
      .sort((a, b) => a.tier - b.tier || b.hint - a.hint)
      .forEach(candidate => add(candidate.entry, candidate.tier, candidate.hint))

    return candidates
  }

  private inRegion(entry: SiteEntry, countries: Set<string>): boolean {
    const groupCountries = this.groupCountries.get(entry.group)
    if (!groupCountries) return false
    for (const country of countries) if (groupCountries.has(country)) return true
    return false
  }
}

// ---------------------------------------------------------------------------
// XMLTV
// ---------------------------------------------------------------------------

export interface GuideChannelData {
  xml: string
  programmes: string[]
  intervals: [number, number][]
}

export function parseXMLTV(xml: string): Map<string, GuideChannelData> {
  const result = new Map<string, GuideChannelData>()
  const get = (id: string) => {
    let data = result.get(id)
    if (!data) {
      data = { xml: '', programmes: [], intervals: [] }
      result.set(id, data)
    }
    return data
  }

  for (const match of xml.matchAll(/<channel\s+id="([^"]*)"[^>]*>[\s\S]*?<\/channel>/g)) {
    get(unescapeXML(match[1])).xml = match[0]
  }

  for (const match of xml.matchAll(/<programme\s([^>]*)>[\s\S]*?<\/programme>/g)) {
    const attrs = match[1]
    const channel = attrs.match(/channel="([^"]*)"/)
    const start = attrs.match(/start="([^"]*)"/)
    const stop = attrs.match(/stop="([^"]*)"/)
    if (!channel || !start) continue
    const data = get(unescapeXML(channel[1]))
    data.programmes.push(match[0])
    const startTime = parseXMLTVDate(start[1])
    const stopTime = stop ? parseXMLTVDate(stop[1]) : NaN
    if (!isNaN(startTime) && !isNaN(stopTime) && stopTime > startTime) {
      data.intervals.push([startTime, stopTime])
    }
  }

  return result
}

export function parseXMLTVDate(value: string): number {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/)
  if (!match) return NaN
  const [, y, mo, d, h, mi, s, tz] = match
  let time = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0)
  if (tz) {
    const sign = tz[0] === '-' ? -1 : 1
    const offset = (+tz.slice(1, 3) * 60 + +tz.slice(3, 5)) * 60 * 1000
    time -= sign * offset
  }
  return time
}

// Hours of [from, to) that are covered by at least one programme
export function coveredHours(intervals: [number, number][], from: number, to: number): number {
  const clipped = intervals
    .map(([start, stop]) => [Math.max(start, from), Math.min(stop, to)] as [number, number])
    .filter(([start, stop]) => stop > start)
    .sort((a, b) => a[0] - b[0])

  let total = 0
  let currentStart = -1
  let currentStop = -1
  for (const [start, stop] of clipped) {
    if (start > currentStop) {
      if (currentStop > currentStart) total += currentStop - currentStart
      currentStart = start
      currentStop = stop
    } else if (stop > currentStop) {
      currentStop = stop
    }
  }
  if (currentStop > currentStart) total += currentStop - currentStart

  return total / 3600000
}

export function escapeXML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function unescapeXML(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(+code))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}
