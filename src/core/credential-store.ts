// 网盘凭证加密存储

import type { Storage } from '../storage/interface';
import type { CloudPlatform, CloudCredential, CredentialPolicyConfig } from './types';
import { KV_CLOUD_CREDENTIALS, KV_CREDENTIAL_POLICY, KV_CREDENTIAL_ENCRYPTION_KEY, KV_CREDENTIAL_TOKEN_SECRET } from './config';

// ─── base64（分块）──────────────────────────────────────

/**
 * `btoa(String.fromCharCode(...arr))` 的展开有上限：
 * 实测 13 万字节就 RangeError: Maximum call stack size exceeded。
 * 凭证 JSON 现在只有几 KB，但一旦超限，saveCredential 直接抛错且看不出根因
 * （用户会以为「保存不了」），所以按 8KB 一块拼。
 */
function bytesToBase64(arr: Uint8Array): string {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─── AES-GCM 加密层 ─────────────────────────────────────

async function getOrCreateEncryptionKey(storage: Storage): Promise<CryptoKey> {
  const raw = await storage.get(KV_CREDENTIAL_ENCRYPTION_KEY);

  if (raw) {
    const keyData = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // 首次使用：生成随机 256-bit key
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as CryptoKey;
  const exported = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
  const b64 = bytesToBase64(new Uint8Array(exported));
  await storage.put(KV_CREDENTIAL_ENCRYPTION_KEY, b64);

  // 返回不可导出的版本
  return crypto.subtle.importKey('raw', exported, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // iv (12 bytes) + ciphertext → base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

async function decrypt(key: CryptoKey, encrypted: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuffer);
}

// ─── 凭证 CRUD ──────────────────────────────────────────

export async function loadCredentials(storage: Storage): Promise<Map<CloudPlatform, CloudCredential>> {
  const map = new Map<CloudPlatform, CloudCredential>();
  const raw = await storage.get(KV_CLOUD_CREDENTIALS);
  if (!raw) return map;

  try {
    const key = await getOrCreateEncryptionKey(storage);
    const json = await decrypt(key, raw);
    const arr: CloudCredential[] = JSON.parse(json);
    for (const cred of arr) {
      map.set(cred.platform, cred);
    }
  } catch (err) {
    console.error('[credential-store] Failed to decrypt credentials:', err instanceof Error ? err.message : err);
  }

  return map;
}

export async function saveCredential(storage: Storage, credential: CloudCredential): Promise<void> {
  const existing = await loadCredentials(storage);
  existing.set(credential.platform, credential);

  const key = await getOrCreateEncryptionKey(storage);
  const json = JSON.stringify([...existing.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(KV_CLOUD_CREDENTIALS, encrypted);
}

export async function deleteCredential(storage: Storage, platform: CloudPlatform): Promise<void> {
  const existing = await loadCredentials(storage);
  if (!existing.has(platform)) return;

  existing.delete(platform);
  const key = await getOrCreateEncryptionKey(storage);

  if (existing.size === 0) {
    await storage.put(KV_CLOUD_CREDENTIALS, '');
    return;
  }

  const json = JSON.stringify([...existing.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(KV_CLOUD_CREDENTIALS, encrypted);
}

// ─── 凭证策略 CRUD ──────────────────────────────────────

const DEFAULT_POLICY: CredentialPolicyConfig = {
  allowedHighRiskKeys: [],
  deniedKeys: [],
};

export async function loadCredentialPolicy(storage: Storage): Promise<CredentialPolicyConfig> {
  const raw = await storage.get(KV_CREDENTIAL_POLICY);
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function saveCredentialPolicy(storage: Storage, policy: CredentialPolicyConfig): Promise<void> {
  await storage.put(KV_CREDENTIAL_POLICY, JSON.stringify(policy));
}

// ─── token.json 路径密钥 ─────────────────────────────────

/**
 * 自托管 token.json 的路径密钥（32 位 hex，首次使用时生成并持久化）。
 *
 * TVBox/FongMi 客户端拉 token.json 时带不了 Bearer，所以这个端点必须匿名可读；
 * 但一条公开路径 + 明文网盘 Cookie 等于把账号交出去（任意网页 fetch 一下就有）。
 * 折中方案：用不可猜的路径段当凭证，注入时自动写进源的 ext。
 * 手动配置的老用户仍可走 /credential/token.json（需要管理 token）。
 */
export async function ensureCredentialTokenSecret(storage: Storage): Promise<string> {
  const raw = ((await storage.get(KV_CREDENTIAL_TOKEN_SECRET)) || '').trim();
  if (/^[0-9a-f]{32}$/i.test(raw)) return raw.toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  await storage.put(KV_CREDENTIAL_TOKEN_SECRET, hex);
  return hex;
}
