import assert from "node:assert/strict";
import test from "node:test";

import { httpsProxyUrlFor, isNoProxyHost, parseMacProxyConfig } from "../../../lib/https-proxy.mjs";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

function withProxyEnv(env, fn) {
  const previous = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("httpsProxyUrlFor uses HTTPS_PROXY env for https targets", () => {
  withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7897" }, () => {
    assert.equal(httpsProxyUrlFor("https://api.openai.com/v1/responses"), "http://127.0.0.1:7897/");
  });
});

test("httpsProxyUrlFor never proxies loopback or http targets", () => {
  withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7897" }, () => {
    assert.equal(httpsProxyUrlFor("https://127.0.0.1:8443/v1"), "");
    assert.equal(httpsProxyUrlFor("https://localhost/v1"), "");
    assert.equal(httpsProxyUrlFor("http://api.openai.com/v1"), "");
  });
});

test("httpsProxyUrlFor honors NO_PROXY and rejects non-http proxy schemes", () => {
  withProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "api.openai.com" }, () => {
    assert.equal(httpsProxyUrlFor("https://api.openai.com/v1"), "");
  });
  withProxyEnv({ HTTPS_PROXY: "socks5://127.0.0.1:7897" }, () => {
    assert.equal(httpsProxyUrlFor("https://api.openai.com/v1"), "");
  });
});

test("isNoProxyHost matches wildcard, suffix, and exact patterns", () => {
  assert.equal(isNoProxyHost("api.openai.com", "*"), true);
  assert.equal(isNoProxyHost("api.openai.com", "openai.com"), true);
  assert.equal(isNoProxyHost("api.openai.com", ".openai.com"), true);
  assert.equal(isNoProxyHost("api.openai.com", "*.openai.com"), true);
  assert.equal(isNoProxyHost("api.openai.com", "example.com,other.net"), false);
  assert.equal(isNoProxyHost("api.openai.com", ""), false);
});

test("parseMacProxyConfig reads scutil output with exceptions list", () => {
  const parsed = parseMacProxyConfig([
    "<dictionary> {",
    "  ExceptionsList <array> {",
    "    0 : *.local",
    "    1 : 169.254/16",
    "  }",
    "  HTTPSEnable : 1",
    "  HTTPSPort : 7897",
    "  HTTPSProxy : 127.0.0.1",
    "}",
  ].join("\n"));
  assert.equal(parsed.HTTPSEnable, "1");
  assert.equal(parsed.HTTPSPort, "7897");
  assert.equal(parsed.HTTPSProxy, "127.0.0.1");
  assert.deepEqual(parsed.ExceptionsList, ["*.local", "169.254/16"]);
});
