import { spawnSync } from "node:child_process";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function httpsProxyUrlFor(url) {
  let target;
  try {
    target = url instanceof URL ? url : new URL(String(url ?? ""));
  } catch {
    return "";
  }
  if (target.protocol !== "https:") return "";
  if (LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) return "";
  if (isNoProxyHost(target.hostname, process.env.NO_PROXY || process.env.no_proxy || "")) return "";
  const raw = process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || systemHttpsProxyUrl(target.hostname);
  if (!raw) return "";
  try {
    const proxy = new URL(raw);
    return proxy.protocol === "http:" ? proxy.href : "";
  } catch {
    return "";
  }
}

export function isNoProxyHost(hostname, noProxy) {
  const host = String(hostname || "").toLowerCase();
  return String(noProxy || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((item) => {
      if (item === "*") return true;
      const pattern = item.split(":")[0];
      if (!pattern) return false;
      if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
      if (pattern.startsWith(".")) return host.endsWith(pattern);
      return host === pattern || host.endsWith(`.${pattern}`);
    });
}

function systemHttpsProxyUrl(hostname) {
  if (process.platform !== "darwin") return "";
  const result = spawnSync("scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) return "";
  const proxyConfig = parseMacProxyConfig(result.stdout);
  const exceptions = proxyConfig.ExceptionsList || [];
  if (Array.isArray(exceptions) && exceptions.some((item) => isNoProxyHost(hostname, item))) return "";
  if (proxyConfig.HTTPSEnable !== "1") return "";
  const host = proxyConfig.HTTPSProxy;
  const port = proxyConfig.HTTPSPort;
  if (!host || !port) return "";
  return `http://${host}:${port}`;
}

export function parseMacProxyConfig(output) {
  const config = {};
  let inExceptions = false;
  const exceptions = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ExceptionsList")) {
      inExceptions = true;
      continue;
    }
    if (inExceptions && trimmed === "}") {
      inExceptions = false;
      continue;
    }
    if (inExceptions) {
      const match = trimmed.match(/^\d+\s*:\s*(.+)$/);
      if (match) exceptions.push(match[1].trim());
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9]+)\s*:\s*(.+)$/);
    if (match) config[match[1]] = match[2].trim();
  }
  if (exceptions.length > 0) config.ExceptionsList = exceptions;
  return config;
}
