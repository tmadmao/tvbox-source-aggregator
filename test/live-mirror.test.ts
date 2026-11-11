// 直播源下载路径：GitHub raw 直连不通时的镜像回退
//
// 背景：NAS / 家宽直连 raw.githubusercontent.com 的 443 普遍被阻断（DNS 能解析，
// TCP 直接不通，curl 返回 000）。配置里 10 条 GitHub 源因此全部下载失败，
// 聚合只体现在 failedSources 里，输出侧看不出「少了一大半源」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorCandidates } from '../src/core/live-merger';
import { LIVE_MIRROR_PREFIXES } from '../src/core/config';

test('mirrorCandidates：GitHub raw 生成镜像地址', () => {
  const url = 'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u';
  const out = mirrorCandidates(url);
  assert.equal(out.length, LIVE_MIRROR_PREFIXES.length);
  assert.ok(out.every((m) => m.endsWith(url)), '镜像前缀后必须原样保留原地址');
  assert.ok(out.every((m) => m.startsWith('https://')), '镜像必须是 https');
});

test('mirrorCandidates：gist 同样走镜像', () => {
  const out = mirrorCandidates('https://gist.githubusercontent.com/u/1/raw/a.m3u');
  assert.ok(out.length > 0);
});

test('mirrorCandidates：正常源不做镜像回退', () => {
  // 这些源直连正常，套镜像只会多一次失败等待
  for (const u of [
    'https://guovin.github.io/iptv-api/result.m3u',
    'https://live.hacks.tools/tv/ipv4/categories/央视频道.m3u',
    'https://raw.giteeusercontent.com/joeyfff/live-config/raw/master/live-config.txt',
    'https://iptv-org.github.io/iptv/countries/cn.m3u',
  ]) {
    assert.deepEqual(mirrorCandidates(u), [], `不应镜像：${u}`);
  }
});

test('mirrorCandidates：非法 URL 返回空，不抛异常', () => {
  assert.deepEqual(mirrorCandidates('not a url'), []);
  assert.deepEqual(mirrorCandidates(''), []);
});

test('mirrorCandidates：host 精确匹配，不做后缀包含', () => {
  // evil-raw.githubusercontent.com.attacker.tld 这类不能命中
  assert.deepEqual(mirrorCandidates('https://raw.githubusercontent.com.attacker.tld/x.m3u'), []);
});