import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCrossChannelConflicts } from '../src/core/channel-conflicts';
import type { TVBoxLiveGroup } from '../src/core/types';

const URL = 'http://223.112.114.228:50080/newlive/live/hls/180/live.m3u8';

function group(name: string, urls: string[]): TVBoxLiveGroup {
  return { group: '央视', channels: [{ name, urls }] };
}

test('CCTV5/CCTV5+：按来源票数归给票多的一边', () => {
  const groups = [
    group('CCTV5', [`${URL}$cluntop`]),
    group('CCTV5+', [`${URL}$游魂`, `${URL}$cluntop_test`]),
  ];
  const removed = resolveCrossChannelConflicts(groups);
  assert.equal(groups[0].channels[0].urls.length, 0);
  assert.equal(groups[1].channels[0].urls.length, 2);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].from, 'CCTV5');
  assert.equal(removed[0].to, 'CCTV5+');
});

test('CCTV5/CCTV5+：平票时归 + 变体，避免基础台乱收源', () => {
  const groups = [
    group('CCTV5', [`${URL}$a`]),
    group('CCTV5+', [`${URL}$b`]),
  ];
  resolveCrossChannelConflicts(groups);
  assert.equal(groups[0].channels[0].urls.length, 0);
  assert.equal(groups[1].channels[0].urls.length, 1);
});

test('同一个源把地址同时标给两台：平票仍归 CCTV5+', () => {
  const groups = [
    group('CCTV5', [`${URL}$same`]),
    group('CCTV5+', [`${URL}$same`]),
  ];
  resolveCrossChannelConflicts(groups);
  assert.equal(groups[0].channels[0].urls.length, 0);
  assert.equal(groups[1].channels[0].urls.length, 1);
});

test('互不相关的频道平票：无法判断，保留原样', () => {
  const groups = [
    group('江苏卫视', [`${URL}$a`]),
    group('浙江卫视', [`${URL}$b`]),
  ];
  const removed = resolveCrossChannelConflicts(groups);
  assert.equal(removed.length, 0);
  assert.equal(groups[0].channels[0].urls.length, 1);
  assert.equal(groups[1].channels[0].urls.length, 1);
});

test('只出现在一个频道的地址不动', () => {
  const groups = [
    group('CCTV5', ['http://a/1$src']),
    group('CCTV5+', ['http://b/2$src']),
  ];
  const removed = resolveCrossChannelConflicts(groups);
  assert.equal(removed.length, 0);
  assert.equal(groups[0].channels[0].urls.length, 1);
  assert.equal(groups[1].channels[0].urls.length, 1);
});

test('三个频道抢同一地址：票最多者得，其余清掉', () => {
  const groups = [
    group('CCTV5', [`${URL}$a`, `${URL}$b`]),
    group('CCTV5+', [`${URL}$c`]),
    group('CCTV5+高清', [`${URL}$d`]),
  ];
  const removed = resolveCrossChannelConflicts(groups);
  assert.equal(groups[0].channels[0].urls.length, 2);
  assert.equal(groups[1].channels[0].urls.length, 0);
  assert.equal(groups[2].channels[0].urls.length, 0);
  assert.equal(removed.length, 2);
});
