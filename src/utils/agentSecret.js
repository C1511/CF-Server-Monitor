/**
 * 探针上报密钥
 * 每台服务器使用由 API_SECRET 派生的独立密钥：HMAC-SHA256(API_SECRET, 'cfsm-agent-v1:' + id)
 * 单台被控机器只能泄露自己的密钥，无法冒充其他服务器，也无法拿到 API_SECRET 登录后台
 */

const AGENT_SECRET_CONTEXT = 'cfsm-agent-v1:';

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualString(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let diff = a.length ^ b.length;
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

export async function deriveAgentSecret(apiSecret, serverId) {
  if (!apiSecret || !serverId) return '';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${AGENT_SECRET_CONTEXT}${serverId}`));
  return bytesToHex(new Uint8Array(signature));
}

// 旧版探针直接使用 API_SECRET 上报；仅在显式设置 ALLOW_LEGACY_AGENT_SECRET=true 时兼容
export function isLegacyAgentSecretAllowed(env) {
  return String(env?.ALLOW_LEGACY_AGENT_SECRET || '').toLowerCase() === 'true';
}

export async function verifyAgentSecret(env, serverId, providedSecret) {
  if (typeof providedSecret !== 'string' || !providedSecret || !env?.API_SECRET) {
    return false;
  }

  const id = typeof serverId === 'string' ? serverId.trim() : String(serverId ?? '').trim();
  if (id) {
    const expected = await deriveAgentSecret(env.API_SECRET, id);
    if (expected && timingSafeEqualString(providedSecret, expected)) {
      return true;
    }
  }

  return isLegacyAgentSecretAllowed(env) && timingSafeEqualString(providedSecret, env.API_SECRET);
}
