import {
  Database,
  Matcher,
  PlaylistChannel,
  SiteEntry,
  Tier,
  coveredHours,
  parseM3U,
  parseXMLTV,
  parseXMLTVDate
} from '../../../scripts/core/playlist'

function entry(data: Partial<SiteEntry>): SiteEntry {
  return {
    site: 'example.com',
    site_id: '1',
    lang: 'en',
    xmltv_id: '',
    name: '',
    file: 'example.com.channels.xml',
    group: 'example.com.channels.xml|',
    ...data
  }
}

function createDatabase(): Database {
  const db = new Database()
  db.channels.set('ABCTV.au', { id: 'ABCTV.au', name: 'ABC TV', country: 'AU' })
  db.channels.set('ABC.us', { id: 'ABC.us', name: 'ABC', country: 'US' })
  db.channels.set('Other.au', { id: 'Other.au', name: 'Other', country: 'AU' })
  db.feeds.set('ABCTV.au', [
    {
      channel: 'ABCTV.au',
      id: 'NSW',
      name: 'NSW',
      alt_names: ['New South Wales', 'Sydney'],
      is_main: true,
      broadcast_area: ['s/AU-NSW'],
      languages: ['eng']
    },
    {
      channel: 'ABCTV.au',
      id: 'SA',
      name: 'SA',
      alt_names: ['South Australia', 'Adelaide'],
      is_main: false,
      broadcast_area: ['s/AU-SA'],
      languages: ['eng']
    }
  ])
  db.feeds.set('ABC.us', [
    {
      channel: 'ABC.us',
      id: 'KEROTV',
      name: 'KERO-TV',
      is_main: false,
      broadcast_area: ['c/US'],
      languages: ['eng']
    }
  ])
  db.feeds.set('Other.au', [
    {
      channel: 'Other.au',
      id: 'SD',
      name: 'SD',
      is_main: true,
      broadcast_area: ['c/AU'],
      languages: ['eng']
    }
  ])
  return db
}

function playlistChannel(tvgId: string, name: string, urls: string[] = []): PlaylistChannel {
  const [channelId, feedId] = tvgId.split('@')
  return { tvgId, channelId, feedId, name, logo: null, urls, playlists: [] }
}

describe('playlist', () => {
  it('parses m3u playlists', () => {
    const channels = new Map<string, PlaylistChannel>()
    parseM3U(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="BBCOne.uk@HD" tvg-logo="https://example.com/logo.png" group-title="General,UK",BBC One (1080p) [Geo-blocked]',
        'https://example.com/1.m3u8',
        '#EXTINF:-1 tvg-id="BBCOne.uk@HD",BBC One',
        'https://example.com/2.m3u8',
        '#EXTINF:-1 tvg-id="",No ID',
        'https://example.com/3.m3u8'
      ].join('\n'),
      'uk.m3u',
      channels
    )

    expect([...channels.keys()]).toEqual(['BBCOne.uk@HD'])
    expect(channels.get('BBCOne.uk@HD')).toMatchObject({
      channelId: 'BBCOne.uk',
      feedId: 'HD',
      name: 'BBC One',
      logo: 'https://example.com/logo.png',
      urls: ['https://example.com/1.m3u8', 'https://example.com/2.m3u8']
    })
  })

  it('ranks candidates', () => {
    const db = createDatabase()
    const entries = [
      // mapped entries tell the matcher that the "au" group is Australian
      entry({
        site: 'a.com',
        site_id: 'au/x#1',
        xmltv_id: 'Other.au@SD',
        name: 'Other',
        group: 'a|au/x'
      }),
      entry({
        site: 'a.com',
        site_id: 'au/x#2',
        xmltv_id: 'Other.au@SD',
        name: 'Other 2',
        group: 'a|au/x'
      }),
      entry({ site: 'a.com', site_id: 'au/Adelaide#abc', name: 'ABC TV', group: 'a|au/x' }),
      entry({ site: 'a.com', site_id: 'au/Sydney#abc', name: 'ABC TV', group: 'a|au/x' }),
      entry({ site: 'b.com', site_id: 'abc-nsw', xmltv_id: 'ABCTV.au@NSW', name: 'ABC' }),
      entry({ site: 'c.com', site_id: 'kero-hdtv', name: 'KERO HDTV' }),
      entry({ site: 'c.com', site_id: 'kero-scripps', name: 'Scripps News (KERO-TV6)' }),
      entry({ site: 'pluto.tv', site_id: '5e7cf6c7b156d500078c5f44', name: 'Something' })
    ]
    const matcher = new Matcher(db, entries, [])

    const abc = matcher.getCandidates(playlistChannel('ABCTV.au@NSW', 'ABC TV NSW'))
    expect(abc.map(c => [c.entry.site_id, c.tier])).toEqual([
      ['abc-nsw', Tier.ExactId],
      ['au/Sydney#abc', Tier.NameRegionFeed],
      ['au/Adelaide#abc', Tier.Weak]
    ])

    const kero = matcher.getCandidates(playlistChannel('ABC.us@KEROTV', 'ABC KERO-TV'))
    expect(kero.map(c => c.entry.site_id)).toEqual(['kero-hdtv'])
    expect(kero[0].tier).toBe(Tier.Callsign)

    const pluto = matcher.getCandidates(
      playlistChannel('Unknown.us@SD', 'Unknown', [
        'https://jmp2.uk/plu-5e7cf6c7b156d500078c5f44.m3u8'
      ])
    )
    expect(pluto.map(c => [c.entry.site, c.tier])).toEqual([['pluto.tv', Tier.StreamId]])
  })

  it('measures guide coverage', () => {
    const guide = parseXMLTV(
      '<tv><channel id="A&amp;B"><display-name>A</display-name></channel>' +
        '<programme start="20250101000000 +0100" stop="20250101020000 +0100" channel="A&amp;B"><title>1</title></programme>' +
        '<programme start="20250101010000 +0000" stop="20250101030000 +0000" channel="A&amp;B"><title>2</title></programme>' +
        '</tv>'
    )
    const data = guide.get('A&B')
    expect(data?.programmes.length).toBe(2)

    const from = parseXMLTVDate('20241231230000 +0000')
    expect(from).toBe(Date.UTC(2024, 11, 31, 23))
    // 23:00-01:00 and 01:00-03:00 UTC
    expect(coveredHours(data?.intervals || [], from, from + 24 * 3600000)).toBe(4)
    expect(coveredHours(data?.intervals || [], from + 3600000, from + 2 * 3600000)).toBe(1)
  })
})
