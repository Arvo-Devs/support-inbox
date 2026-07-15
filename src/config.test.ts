import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig, type SupportInboxConfig } from "./config";
import { createSupportInbox } from "./index";

function baseConfig(partial: Partial<SupportInboxConfig> = {}): SupportInboxConfig {
  return {
    db: {} as never,
    resendApiKey: "re_test",
    fromEmail: "Infra Agent Support <support@infraagent.app>",
    webhookSecret: "whsec_test",
    authorize: async () => null,
    ...partial,
  };
}

test("normalizeConfig parses fromEmail into address, name, and domain", () => {
  const resolved = normalizeConfig(baseConfig());
  assert.equal(resolved.fromAddress, "support@infraagent.app");
  assert.equal(resolved.fromName, "Infra Agent Support");
  assert.equal(resolved.fromDomain, "infraagent.app");
});

test("normalizeConfig accepts a bare fromEmail address", () => {
  const resolved = normalizeConfig(baseConfig({ fromEmail: "support@x.com" }));
  assert.equal(resolved.fromAddress, "support@x.com");
  assert.equal(resolved.fromName, null);
  assert.equal(resolved.fromDomain, "x.com");
});

test("normalizeConfig throws at creation on an unparseable or empty fromEmail", () => {
  assert.throws(() => normalizeConfig(baseConfig({ fromEmail: "" })), /fromEmail/);
  assert.throws(() => normalizeConfig(baseConfig({ fromEmail: "not-an-address" })), /fromEmail/);
});

test("createSupportInbox with an empty API key constructs without throwing", () => {
  // The Resend SDK constructor throws on an empty key; construction must stay
  // lazy so an unconfigured inbox still serves its 503/401 paths per-request
  // instead of taking down the whole surface at boot.
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => createSupportInbox(baseConfig({ resendApiKey: "" })));
  } finally {
    console.warn = original;
  }
});

test("normalizeConfig tolerates an empty key/secret (webhook 503s by design)", () => {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    assert.doesNotThrow(() => normalizeConfig(baseConfig({ resendApiKey: "", webhookSecret: "" })));
  } finally {
    console.warn = original;
  }
  // Missing config is one loud creation-time signal, not per-request noise.
  assert.equal(warnings.length, 2);
});
