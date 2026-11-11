import test from 'node:test';
import assert from 'node:assert/strict';
import { injectCredentials, generateTokenJson } from '../src/core/credential-injector';
import { computeFingerprints, siteFingerprint, siteFingerprintCached } from '../src/core/blacklist';
import type { CloudCredential, CloudPlatform, TVBoxSite } from '../src/core/types';

const policy = { allowedHighRiskKeys: [], deniedKeys: [] };

function creds(entries: Array<[CloudPlatform, Record<string, string>]>): Map<CloudPlatform, CloudCredential> {
  return new Map(entries.map(([platform, credential]) => [platform, { platform, credential } as unknown as CloudCredential]));
}

function site(api: string, ext: unknown): TVBoxSite {
  return { key: 'k1', name: 'x', type: 3, api, ext } as unknown as TVBoxSite;
}

test('injectCredentials：未登录的平台不清空源站原值（P1-8）', () => {
  const sites = [site('csp_Mogg', JSON.stringify({
    cookie: 'OLD_QUARK',
    token: 'SOURCE_OWN_ALI_TOKEN',
    uccookie: 'OLD_UC',
  }))];
  const { sites: out, report } = injectCredentials(
    sites,
    creds([['quark', { cookie: 'NEW_QUARK' }]]),
    policy,
    'http://nas:5678',
  );

  const ext = JSON.parse(String(out[0].ext));
  assert.equal(ext.cookie, 'NEW_QUARK');           // 已登录 → 覆盖
  assert.equal(ext.token, 'SOURCE_OWN_ALI_TOKEN'); // 未登录 → 保持原值，不是 ''
  assert.equal(ext.uccookie, 'OLD_UC');
  assert.equal(report.injected, 1);
});

test('injectCredentials：token.json 派用带路径密钥的地址', () => {
  const ext = 'https://public.example/token.json$$$https://site.example$$$noproxy$$$6$$$cfg';
  const { sites: out } = injectCredentials(
    [site('csp_Wogg', ext)],
    creds([['quark', { cookie: 'Q' }]]),
    policy,
    'http://nas:5678',
    'http://nas:5678/credential/abc123/token.json',
  );
  const text = String(out[0].ext);
  assert.ok(text.startsWith('http://nas:5678/credential/abc123/token.json$$$'), text);
  // 分隔结构不能被破坏
  assert.equal(text.split('$$$').length, 5);
});

test('generateTokenJson：只输出已登录平台的凭证', () => {
  const json = generateTokenJson(creds([
    ['quark', { cookie: 'QUARK_COOKIE' }],
  ]));
  assert.equal(json.quark_cookie, 'QUARK_COOKIE');
  assert.equal(json.uc_cookie, undefined);
  assert.equal(json.refresh_token, undefined);
});

test('注入前后站点指纹一致：黑名单与跳过名单才能对上（P1-9）', async () => {
  const sites = [site('csp_Mogg', JSON.stringify({ cookie: 'SOURCE_OWN', token: 'T' }))];
  // 注入前算一次，全链路复用
  const cache = await computeFingerprints(sites);
  const { sites: injected } = injectCredentials(
    sites,
    creds([['quark', { cookie: 'NEW_QUARK' }]]),
    policy,
    'http://nas:5678',
  );

  // ext 已被改写，现算的指纹必然不同（这正是原来的 bug）
  assert.notEqual(await siteFingerprint(injected[0]), await siteFingerprint(sites[0]));
  // 用注入前那份缓存，则完全一致
  assert.equal(
    await siteFingerprintCached(injected[0], cache),
    await siteFingerprintCached(sites[0], cache),
  );
});
