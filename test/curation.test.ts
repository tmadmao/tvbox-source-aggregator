import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRules,
  tierOfChannel,
  isFocusChannel,
  isPriorityLocal,
  curateGroups,
  buildUrlTierMap,
  DEFAULT_CURATION_RULES,
} from '../src/core/channel-curation';
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
  assert.equal(r.focusSources, 8);
  assert.equal(r.quotas.cctv, 6);
});

test('normalizeRules：去重、去空、裁剪越界值', () => {
  const r = normalizeRules({
    satOrder: ['江苏卫视', ' 江苏卫视 ', '', '湖南卫视'],
    focusSources: 99,
    quotas: { cctv: 99, satellite: -3, local: 2 },
  });
  assert.deepEqual(r.satOrder, ['江苏卫视', '湖南卫视']);
  assert.equal(r.focusSources, 20);
  assert.equal(r.quotas.cctv, 20);        // 先夹到 20，再不超过 focusSources
  assert.equal(r.quotas.satellite, 0);
  assert.equal(r.quotas.local, 2);
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

test('buildUrlTierMap：同一 URL 取最高档位', () => {
  const groups: TVBoxLiveGroup[] = [
    { group: '央视', channels: [{ name: 'CCTV1', urls: ['http://x/1$a'] }] },
    { group: '其他', channels: [{ name: '某台', urls: ['http://x/1$a', 'http://y/2$a'] }] },
  ];
  const m = buildUrlTierMap(groups);
  assert.equal(m.get('http://x/1'), 'cctv');
  assert.equal(m.get('http://y/2'), 'other');
});
