import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRules,
  tierOfChannel,
  isFocusChannel,
  isPriorityLocal,
  curateGroups,
  buildUrlTierMap,
  isExcludedChannel,
  applyChannelExclusions,
  canonicalChannelName,
  DEFAULT_CURATION_RULES,
} from '../src/core/channel-curation';
import { QUALITY_MAX_SOURCES } from '../src/core/channel-tier';
import type { ChannelSpeedEntry, ChannelSpeedMap, TVBoxLiveGroup } from '../src/core/types';

function okEntry(speedMs = 800): ChannelSpeedEntry {
  return {
    speedMs,
    probedAt: new Date().toISOString(),
    kind: 'm3u8',
    stage: 'segment',
    okCount: 3,
    failCount: 0,
    history: '111',
    consecutiveFails: 0,
  };
}

test('normalizeRules：空输入回落到默认值', () => {
  const r = normalizeRules(null);
  assert.deepEqual(r.cctvOrder, DEFAULT_CURATION_RULES.cctvOrder);
  assert.equal(r.focusSources, 20);
  assert.equal(r.quotas.cctv, 8);
});

test('normalizeRules：去重、去空、裁剪越界值', () => {
  const r = normalizeRules({
    satOrder: ['江苏卫视', ' 江苏卫视 ', '', '湖南卫视'],
    focusSources: 99,
    quotas: { cctv: 99, satellite: -3, local: 2 },
  });
  assert.deepEqual(r.satOrder, ['江苏卫视', '湖南卫视']);
  assert.equal(r.focusSources, QUALITY_MAX_SOURCES);   // 99 被夹到 20
  assert.equal(r.quotas.cctv, QUALITY_MAX_SOURCES);    // 先夹到 20，再不超过 focusSources
  assert.equal(r.quotas.satellite, 0);
  assert.equal(r.quotas.local, 2);
});

test('normalizeRules：配额不得超过 focusSources', () => {
  const r = normalizeRules({ focusSources: 5, quotas: { cctv: 20, satellite: 12, local: 4 } });
  assert.equal(r.focusSources, 5);
  assert.equal(r.quotas.cctv, 5);
  assert.equal(r.quotas.satellite, 5);
  assert.equal(r.quotas.local, 4);
});

test('tierOfChannel：分组优先，名字兜底纠错分组', () => {
  assert.equal(tierOfChannel('央视', 'CCTV1'), 'cctv');
  assert.equal(tierOfChannel('卫视', '湖南卫视'), 'satellite');
  assert.equal(tierOfChannel('境内地方', '南京新闻综合'), 'local');
  assert.equal(tierOfChannel('其他', '海峡卫视'), 'satellite');
  assert.equal(tierOfChannel('其他', 'CCTV5+'), 'cctv');
  assert.equal(tierOfChannel('其他', '某县台'), 'other');
});

test('isFocusChannel：央视/卫视/南京/江苏 豁免黑名单，外省地市不豁免', () => {
  assert.equal(isFocusChannel('南京影视'), true);
  assert.equal(isFocusChannel('CCTV3'), true);
  assert.equal(isFocusChannel('东方卫视'), true);
  assert.equal(isFocusChannel('江苏城市'), true);
  assert.equal(isFocusChannel('广东珠江'), false);
});

test('isPriorityLocal：只保南京与江苏，外地县级台不保', () => {
  assert.equal(isPriorityLocal('南京十八频道'), true);
  assert.equal(isPriorityLocal('江苏·苏州新闻'), true);
  assert.equal(isPriorityLocal('浙江杭州综合'), false);
});

test('curateGroups：同名合并、按台序重排、伪 CCTV 清出', () => {
  const entry = okEntry();
  const speedMap: ChannelSpeedMap = {};
  const groups: TVBoxLiveGroup[] = [{
    group: '央视',
    channels: [
      { name: 'CCTV13', urls: ['http://c/13$a'] },
      { name: 'CCTV1', urls: ['http://a/1$a'] },
      { name: 'CCTV1', urls: ['http://b/1$b'] },
      { name: 'CCTV2', urls: ['http://d/2$a'] },
      { name: 'CCTV9576', urls: ['http://e/x$a'] },
    ],
  }];
  for (const u of ['http://c/13', 'http://a/1', 'http://b/1', 'http://d/2', 'http://e/x']) {
    speedMap[u] = { ...entry };
  }

  const res = curateGroups(groups, {}, speedMap);
  const cctv = res.groups.find((g) => g.group === '央视')!;
  assert.deepEqual(cctv.channels.map((c) => c.name), ['CCTV1', 'CCTV2', 'CCTV13']);
  assert.equal(cctv.channels[0].urls.length, 2);
  assert.equal(res.movedOut.includes('CCTV9576'), true);
  const other = res.groups.find((g) => g.group === '其他')!;
  assert.equal(other.channels[0].name, 'CCTV9576');
});

test('curateGroups：重点频道的死链不占输出位置', () => {
  const good = okEntry(700);
  const dead: ChannelSpeedEntry = {
    speedMs: 0,
    probedAt: new Date().toISOString(),
    kind: 'fail',
    fails: 3,
    consecutiveFails: 3,
  };
  const speedMap: ChannelSpeedMap = {
    'http://a/1': good,
    'http://b/2': dead,
    'http://c/3': dead,
  };
  const groups: TVBoxLiveGroup[] = [{
    group: '卫视',
    channels: [{ name: '江苏卫视', urls: ['http://a/1$x', 'http://b/2$x', 'http://c/3$x'] }],
  }];
  const res = curateGroups(groups, {}, speedMap);
  const sat = res.groups.find((g) => g.group === '卫视')!;
  assert.deepEqual(sat.channels[0].urls, ['http://a/1$x']);
});

test('curateGroups：置顶与禁用仍然生效', () => {
  const speedMap: ChannelSpeedMap = {};
  const groups: TVBoxLiveGroup[] = [{
    group: '卫视',
    channels: [
      { name: '江苏卫视', urls: ['http://a/1$x'] },
      { name: '湖南卫视', urls: ['http://b/2$x'] },
      { name: '浙江卫视', urls: ['http://c/3$x'] },
    ],
  }];
  for (const u of ['http://a/1', 'http://b/2', 'http://c/3']) speedMap[u] = okEntry();
  const res = curateGroups(groups, {
    '浙江卫视': { pinned: true },
    '江苏卫视': { disabled: true },
  }, speedMap);
  const sat = res.groups.find((g) => g.group === '卫视')!;
  assert.deepEqual(sat.channels.map((c) => c.name), ['浙江卫视', '湖南卫视']);
});

test('isExcludedChannel：付费台与海外台删除，CCTV5+ 例外保留', () => {
  const r = DEFAULT_CURATION_RULES;
  assert.equal(isExcludedChannel('央视', 'CCTV5+', r), false);
  assert.equal(isExcludedChannel('央视', 'CCTV1', r), false);
  assert.equal(isExcludedChannel('央视', '兵器科技', r), true);
  assert.equal(isExcludedChannel('央视', 'CCTV4美洲', r), true);
  assert.equal(isExcludedChannel('央视', 'CCTV4K', r), true);
  assert.equal(isExcludedChannel('央视', 'CCTV8K', r), true);
  assert.equal(isExcludedChannel('央视', 'CCTV16-4K', r), true);
  assert.equal(isExcludedChannel('纪录科教', 'Love Nature 4K', r), true);
  assert.equal(isExcludedChannel('其他', '4K超清', r), true);
  assert.equal(isExcludedChannel('央视', 'CCTV4 AMERICA', r), true);
  assert.equal(isExcludedChannel('央视', 'CCTV央视文体精品', r), true);
  assert.equal(isExcludedChannel('央视', 'CGTN纪录', r), true);
  assert.equal(isExcludedChannel('港澳台', '翡翠台', r), true);
  assert.equal(isExcludedChannel('其他海外', 'HBO', r), true);
  assert.equal(isExcludedChannel('境内专题', 'CHC动作电影', r), false);
});

test('applyChannelExclusions：整组海外台直接摘掉，付费台按名单删', () => {
  const groups: TVBoxLiveGroup[] = [
    {
      group: '央视',
      channels: [
        { name: 'CCTV1', urls: ['http://a/1$x'] },
        { name: 'CCTV5+', urls: ['http://a/2$x'] },
        { name: '兵器科技', urls: ['http://a/3$x'] },
      ],
    },
    { group: '港澳台', channels: [{ name: '翡翠台', urls: ['http://b/1$x'] }] },
    { group: '其他海外', channels: [{ name: 'HBO', urls: ['http://c/1$x'] }] },
  ];
  const res = applyChannelExclusions(groups, DEFAULT_CURATION_RULES);
  assert.equal(res.groups.length, 1);
  assert.deepEqual(res.groups[0].channels.map((c) => c.name), ['CCTV1', 'CCTV5+']);
  assert.equal(res.removedChannels, 3);
  assert.equal(res.removedGroups, 2);
});

test('curateGroups：排除规则在编排阶段再兜一层（老 KV 树也能清干净）', () => {
  const speedMap: ChannelSpeedMap = {};
  const groups: TVBoxLiveGroup[] = [
    { group: '央视', channels: [
      { name: 'CCTV1', urls: ['http://a/1$x'] },
      { name: '风云剧场', urls: ['http://a/2$x'] },
    ] },
    { group: '国际新闻', channels: [{ name: 'BBC', urls: ['http://b/1$x'] }] },
  ];
  for (const u of ['http://a/1', 'http://a/2', 'http://b/1']) speedMap[u] = okEntry();
  const res = curateGroups(groups, {}, speedMap);
  assert.equal(res.excluded, 2);
  assert.deepEqual(res.groups.map((g) => g.group), ['央视']);
  assert.deepEqual(res.groups[0].channels.map((c) => c.name), ['CCTV1']);
});

test('canonicalChannelName：源侧写法与编排正式名对齐', () => {
  assert.equal(canonicalChannelName('CCTV4 AMERICA'), 'CCTV4美洲');
  assert.equal(canonicalChannelName('CCTV-5+体育'), 'CCTV5+');
  assert.equal(canonicalChannelName('江苏·南京新闻'), '南京新闻综合');
});

test('buildUrlTierMap：同一 URL 取最高档位', () => {
  const groups: TVBoxLiveGroup[] = [
    { group: '央视', channels: [{ name: 'CCTV1', urls: ['http://x/1$a'] }] },
    { group: '其他', channels: [{ name: '某台', urls: ['http://x/1$a', 'http://y/2$a'] }] },
  ];
  const m = buildUrlTierMap(groups);
  assert.equal(m.get('http://x/1'), 'cctv');
  assert.equal(m.get('http://y/2'), 'other');
});

test('curateGroups：非重点分组也遵守每台上限（其他组的源同样压到 focusSources）', () => {
  // 实测「其他」组里有个 `纪录` 频道攒了 38 条源 —— 上限原本只对
  // 央视/卫视/境内地方生效，非重点分组原样透传，用户要求的「最多 20 条」被漏掉。
  const speedMap: ChannelSpeedMap = {};
  const urls: string[] = [];
  for (let i = 0; i < 38; i++) {
    const u = `http://h${i}.example.com/live.m3u8`;
    urls.push(`${u}$源${i}`);
    speedMap[u] = okEntry(500 + i * 10);
  }
  const groups: TVBoxLiveGroup[] = [
    { group: '其他', channels: [{ name: '纪录', urls }] },
  ];

  const res = curateGroups(groups, {}, speedMap);
  const ch = res.groups[0].channels[0];
  assert.equal(ch.name, '纪录');
  assert.equal(ch.urls.length, QUALITY_MAX_SOURCES, '非重点分组的源数必须被压到上限');
});

test('curateGroups：非重点分组剔除确认死链，不把失败源留给客户端', () => {
  const speedMap: ChannelSpeedMap = {};
  const deadUrl = 'http://dead.example.com/x.m3u8';
  speedMap[deadUrl] = {
    ...okEntry(),
    kind: 'fail',
    stage: 'playlist',
    consecutiveFails: 3,
    fails: 3,
  };
  const groups: TVBoxLiveGroup[] = [
    { group: '其他', channels: [{ name: '某台', urls: [`${deadUrl}$死源`, 'http://ok.example.com/y.m3u8$活源'] }] },
  ];
  speedMap['http://ok.example.com/y.m3u8'] = okEntry();

  const res = curateGroups(groups, {}, speedMap);
  const ch = res.groups[0].channels[0];
  assert.equal(ch.urls.length, 1);
  assert.ok(!ch.urls.some((u) => u.startsWith(deadUrl)));
});
