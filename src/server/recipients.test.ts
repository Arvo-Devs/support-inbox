import assert from "node:assert/strict";
import test from "node:test";

import { addressList, isLoopMail, matchInboundAddress, parseAddress } from "./recipients";

test("parseAddress handles the display-name form", () => {
  assert.deepEqual(parseAddress("Jane Doe <jane@Example.com>"), {
    name: "Jane Doe",
    address: "jane@example.com",
  });
});

test("parseAddress strips quotes from a display name containing a comma", () => {
  assert.deepEqual(parseAddress('"Doe, Jane" <jane@example.com>'), {
    name: "Doe, Jane",
    address: "jane@example.com",
  });
});

test("parseAddress handles bare addresses and lowercases them", () => {
  assert.deepEqual(parseAddress("jane@Example.COM"), { name: null, address: "jane@example.com" });
  assert.deepEqual(parseAddress("<jane@example.com>"), { name: null, address: "jane@example.com" });
});

test("parseAddress returns null when no plausible address is present", () => {
  assert.equal(parseAddress(null), null);
  assert.equal(parseAddress(undefined), null);
  assert.equal(parseAddress(""), null);
  assert.equal(parseAddress("not-an-address"), null);
  assert.equal(parseAddress("@example.com"), null);
  assert.equal(parseAddress("jane@"), null);
  assert.equal(parseAddress("Jane Doe <@example.com>"), null);
});

test("addressList accepts arrays", () => {
  assert.deepEqual(addressList(["Jane <jane@Example.com>", "bob@example.com", "junk"]), [
    "jane@example.com",
    "bob@example.com",
  ]);
});

test("addressList splits comma-separated strings, respecting quoted display names", () => {
  assert.deepEqual(addressList('"Doe, Jane" <jane@example.com>, Bob <bob@Example.com>'), [
    "jane@example.com",
    "bob@example.com",
  ]);
});

test("addressList dedupes preserving first occurrence", () => {
  assert.deepEqual(
    addressList(["jane@example.com", "Jane <JANE@example.com>", "bob@example.com"]),
    ["jane@example.com", "bob@example.com"],
  );
  assert.deepEqual(addressList(null), []);
});

test("matchInboundAddress matches via to, cc, and received_for", () => {
  const inboundAddresses = ["support@x.com"];
  assert.deepEqual(
    matchInboundAddress({
      to: ["support@x.com"],
      cc: [],
      receivedFor: [],
      inboundAddresses,
      aliasMap: {},
    }),
    { matched: true, inboundAddress: "support@x.com" },
  );
  assert.deepEqual(
    matchInboundAddress({
      to: ["someone@else.com"],
      cc: ["support@x.com"],
      receivedFor: [],
      inboundAddresses,
      aliasMap: {},
    }),
    { matched: true, inboundAddress: "support@x.com" },
  );
  assert.deepEqual(
    matchInboundAddress({
      to: [],
      cc: [],
      receivedFor: ["support@x.com"],
      inboundAddresses,
      aliasMap: {},
    }),
    { matched: true, inboundAddress: "support@x.com" },
  );
});

test("matchInboundAddress priority received_for > to > cc decides the stored address", () => {
  const result = matchInboundAddress({
    to: ["help@x.com"],
    cc: ["billing@x.com"],
    receivedFor: ["support@x.com"],
    inboundAddresses: ["support@x.com", "help@x.com", "billing@x.com"],
    aliasMap: {},
  });
  assert.deepEqual(result, { matched: true, inboundAddress: "support@x.com" });
});

test("matchInboundAddress translates aliases and counts them as matches", () => {
  // inboundAddresses only lists the public address; the alias key still matches
  // and the stored inbound_address is the translated public form.
  const result = matchInboundAddress({
    to: ["support@abc123.resend.app"],
    cc: [],
    receivedFor: [],
    inboundAddresses: ["support@x.com"],
    aliasMap: { "support@abc123.resend.app": "support@x.com" },
  });
  assert.deepEqual(result, { matched: true, inboundAddress: "support@x.com" });
});

test("matchInboundAddress accepts everything when inboundAddresses is null", () => {
  assert.deepEqual(
    matchInboundAddress({
      to: ["whoever@else.com"],
      cc: [],
      receivedFor: [],
      inboundAddresses: null,
      aliasMap: {},
    }),
    { matched: true, inboundAddress: "whoever@else.com" },
  );
  // Accept-all with zero parseable recipients must still match, not drop.
  assert.deepEqual(
    matchInboundAddress({ to: [], cc: [], receivedFor: [], inboundAddresses: null, aliasMap: {} }),
    { matched: true, inboundAddress: null },
  );
});

test("matchInboundAddress rejects mail addressed elsewhere", () => {
  assert.deepEqual(
    matchInboundAddress({
      to: ["someone@else.com"],
      cc: ["other@else.com"],
      receivedFor: [],
      inboundAddresses: ["support@x.com"],
      aliasMap: {},
    }),
    { matched: false, inboundAddress: null },
  );
});

test("isLoopMail matches the parsed address part of a display-form fromEmail", () => {
  assert.equal(
    isLoopMail({
      fromAddress: "support@x.com",
      fromEmail: "Support <Support@X.com>",
      inboundAddresses: null,
    }),
    true,
  );
});

test("isLoopMail matches configured inbound addresses", () => {
  assert.equal(
    isLoopMail({
      fromAddress: "help@x.com",
      fromEmail: "Support <support@x.com>",
      inboundAddresses: ["help@x.com"],
    }),
    true,
  );
});

test("isLoopMail is false for unrelated or missing senders", () => {
  assert.equal(
    isLoopMail({
      fromAddress: "customer@gmail.com",
      fromEmail: "Support <support@x.com>",
      inboundAddresses: ["support@x.com"],
    }),
    false,
  );
  assert.equal(
    isLoopMail({
      fromAddress: null,
      fromEmail: "Support <support@x.com>",
      inboundAddresses: ["support@x.com"],
    }),
    false,
  );
});
