// 阿里云 RPC 风格 OpenAPI 调用（签名版本 1.0，HMAC-SHA1），只依赖 fetch 和 Web Crypto
// 移植自独立的 aliyun-keepalive-worker

// RFC 3986 编码：encodeURIComponent 不会编码 ! ' ( ) *，需要手动补上
function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function hmacSha1Base64(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function buildSignedQuery(params, accessKeySecret, method = 'GET') {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(String(params[k]))}`)
    .join('&');
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(accessKeySecret + '&', stringToSign);
  return `${canonical}&Signature=${percentEncode(signature)}`;
}

export async function callApi({ endpoint, version, action, params = {}, accessKeyId, accessKeySecret }) {
  const allParams = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Action: action,
    ...params,
  };
  const query = await buildSignedQuery(allParams, accessKeySecret);
  const resp = await fetch(`https://${endpoint}/?${query}`);
  const text = await resp.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${action} 返回了非 JSON 内容 (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`${action} 调用失败 (HTTP ${resp.status}): ${data.Code} - ${data.Message}`);
  }
  return data;
}
