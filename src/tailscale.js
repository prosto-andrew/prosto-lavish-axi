import { isIP } from "node:net";

// LAVISH-HARDENED: tailnet detection is removed. The stock module shelled out to the
// `tailscale` binary to find this machine's tailnet IPv4 so the review server could
// bind to it as well. The candidate list, the subprocess call and the incomplete-status
// handling are DELETED from this source, so no probe can run and the server has no
// address to bind beyond loopback. parseTailscaleStatus is kept because it is a pure
// parser with no I/O, and its tests document the shape that is no longer consumed.

/**
 * @typedef {{ ipv4: string, magicDnsName: string }} TailscaleNet
 * @typedef {{ ipv4: null, magicDnsName: null, warning: string }} IncompleteTailscaleNet
 */

/**
 * Parse a `tailscale status --json` document into this machine's Tailscale IPv4 and MagicDNS
 * name, or null when Tailscale is not up. Never throws.
 * @param {string} raw
 * @returns {TailscaleNet | null}
 */
export function parseTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const state = String(data.BackendState || "");
  if (state !== "Running") return null;

  const ips = [];
  const selfIps = data.Self && Array.isArray(data.Self.TailscaleIPs) ? data.Self.TailscaleIPs : [];
  const topIps = Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : [];
  for (const ip of [...selfIps, ...topIps]) {
    if (typeof ip === "string") ips.push(ip.trim());
  }
  const ipv4 = ips.find((ip) => isIP(ip) === 4);
  if (!ipv4) return null;

  const dnsRaw = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.trim() : "";
  const magicDnsName = dnsRaw.replace(/\.$/, "").toLowerCase();
  const labels = magicDnsName.split(".");
  if (
    magicDnsName.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  return { ipv4, magicDnsName };
}

/**
 * Always null in this build. Callers still pass the stock options object; every
 * argument is ignored and no subprocess is started.
 * @param {...unknown} _ignored
 * @returns {Promise<TailscaleNet | IncompleteTailscaleNet | null>}
 */
export async function detectTailscale(..._ignored) {
  return null;
}
