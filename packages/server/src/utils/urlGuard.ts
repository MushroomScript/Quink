// SSRF 防御 helper (安全审计 H4 + H5)
// 用于校验用户提供的 webhook URL / AI baseUrl 等"由用户输入而后端去 fetch"的场景.
// 防御策略: 协议白名单 (仅 https, dev 允许 http localhost 调试) + DNS 解析后 IP 黑名单 (私有 / loopback / 元数据)

import { lookup } from 'dns/promises';
import { isIP } from 'net';

// IPv4 私有段 / loopback / link-local / metadata
const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ['10.0.0.0', 8],          // RFC 1918
  ['172.16.0.0', 12],       // RFC 1918
  ['192.168.0.0', 16],      // RFC 1918
  ['127.0.0.0', 8],         // loopback
  ['169.254.0.0', 16],      // link-local (含 AWS/GCP/Azure 169.254.169.254 元数据)
  ['100.64.0.0', 10],       // CGNAT
  ['192.0.0.0', 24],        // IANA
  ['192.0.2.0', 24],        // TEST-NET-1
  ['198.18.0.0', 15],       // benchmark
  ['198.51.100.0', 24],     // TEST-NET-2
  ['203.0.113.0', 24],      // TEST-NET-3
  ['224.0.0.0', 4],         // multicast
  ['240.0.0.0', 4],         // reserved
  ['0.0.0.0', 8],           // current network
];

// IPv6 私有 / loopback / link-local
const BLOCKED_IPV6_PREFIXES = [
  '::1',          // loopback
  '::',           // unspecified
  'fc00:',        // ULA fc00::/7
  'fd00:',        // ULA fd00::/8
  'fe80:',        // link-local fe80::/10
  'ff00:',        // multicast
  '64:ff9b:',     // NAT64
  '2001:db8:',    // documentation
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + parseInt(p, 10), 0) >>> 0;
}

function ipv4InRange(ip: string, base: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIPv4(ip: string): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => ipv4InRange(ip, base, prefix));
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // 也屏蔽 IPv6 包装 IPv4 (::ffff:10.0.0.1 等)
  const v4InV6 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4InV6) return isBlockedIPv4(v4InV6[1]);
  return BLOCKED_IPV6_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export interface UrlGuardOptions {
  // 是否允许 http (默认 false). 仅在白名单 host (如本机调试 OpenAI proxy localhost:8080) 时考虑开启
  allowHttp?: boolean;
  // host 白名单 (可选, 允许的 hostname 列表如 ['api.openai.com', 'api.anthropic.com']).
  // 不传则不限制 hostname 但仍走 IP 黑名单
  hostAllowList?: string[];
}

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * 校验用户输入的 URL 是否可被后端安全 fetch.
 * 失败返回 { ok: false, reason }. reason 是用户友好提示, 不暴露内部细节.
 *
 * 注意: 仅校验, 不替换 URL. 调用方拿到 ok=true 后用原 URL fetch.
 * 局限: 不防 TOCTOU (DNS 解析时间 → fetch 时间之间 IP 可能变化, 但 Node fetch 不允许重新 lookup).
 * 防 99% 攻击足够, 真正 paranoid 场景考虑用代理网络隔离.
 */
export async function validateOutboundUrl(input: string, opts: UrlGuardOptions = {}): Promise<UrlGuardResult> {
  if (!input || typeof input !== 'string') return { ok: false, reason: 'URL 不能为空' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'URL 格式不合法' };
  }
  // 协议白名单
  const protocol = url.protocol.toLowerCase();
  const allowHttp = !!opts.allowHttp;
  if (protocol !== 'https:' && !(allowHttp && protocol === 'http:')) {
    return { ok: false, reason: `不支持的协议 (仅 https${allowHttp ? ' / http' : ''})` };
  }
  // 端口黑名单 (常见敏感端口)
  const port = url.port ? parseInt(url.port, 10) : (protocol === 'https:' ? 443 : 80);
  const BLOCKED_PORTS = [22, 23, 25, 3306, 5432, 6379, 9200, 27017, 11211]; // SSH/Telnet/SMTP/MySQL/Postgres/Redis/ES/Mongo/Memcache
  if (BLOCKED_PORTS.includes(port)) return { ok: false, reason: '禁止访问该端口' };
  // hostname 白名单 (可选)
  const hostname = url.hostname.toLowerCase();
  if (opts.hostAllowList && opts.hostAllowList.length > 0) {
    const inWhite = opts.hostAllowList.some(h => hostname === h.toLowerCase() || hostname.endsWith('.' + h.toLowerCase()));
    if (!inWhite) return { ok: false, reason: '不在允许的服务列表' };
  }
  // 防 hostname 本身就是 IP 字面量直接绕 DNS
  const literalIp = isIP(hostname);
  if (literalIp === 4) {
    if (isBlockedIPv4(hostname)) return { ok: false, reason: '禁止访问该网段' };
  } else if (literalIp === 6) {
    if (isBlockedIPv6(hostname)) return { ok: false, reason: '禁止访问该网段' };
  } else {
    // 是 hostname, DNS 解析 (all 拿全部 records 防只过滤 v4 不过滤 v6 绕)
    try {
      const addrs = await lookup(hostname, { all: true });
      for (const a of addrs) {
        if (a.family === 4 && isBlockedIPv4(a.address)) {
          return { ok: false, reason: '该域名解析到禁止访问的网段' };
        }
        if (a.family === 6 && isBlockedIPv6(a.address)) {
          return { ok: false, reason: '该域名解析到禁止访问的网段' };
        }
      }
    } catch {
      return { ok: false, reason: '域名无法解析' };
    }
  }
  return { ok: true };
}

/**
 * 用户友好错误脱敏: 把详细 fetch error message 换成通用提示, 防内网探测.
 * fetch error 通常含 ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH 让攻击者推断目标存活
 */
export function sanitizeFetchError(_err: unknown): string {
  return '请求失败 (网络异常 / 目标不可达 / 服务无响应)';
}
