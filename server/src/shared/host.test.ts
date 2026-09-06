/**
 * The host rules, exercised on the cases the six copies disagreed about.
 *
 * Every assertion below was a real disagreement between two areas before this
 * module existed: `example.co.in` was one domain to one collector and two to
 * another, `a.b.gov.br` resolved three ways, and one area's bidirectional
 * match let a subdomain claim its own parent.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { hostOf, registrable, hostMatch, sameSite, ventureForHost } from "./host.ts";

test("a hostname is recovered from every shape a provider stores it in", () => {
  assert.equal(hostOf("Example.com"), "example.com");
  assert.equal(hostOf("www.example.com"), "example.com");
  assert.equal(hostOf("https://www.example.com/pricing?ref=x"), "example.com");
  assert.equal(hostOf("example.com/pricing"), "example.com");
  assert.equal(hostOf("sc-domain:example.com"), "example.com");
  assert.equal(hostOf("example.com."), "example.com");
  assert.equal(hostOf("example.com:8443"), "example.com");
  assert.equal(hostOf("  EXAMPLE.COM  "), "example.com");
});

test("anything that is not host-shaped is null, never the empty string", () => {
  for (const bad of ["", "   ", "localhost", "not a host", "a..b", "-x.com", "https://", null, undefined])
    assert.equal(hostOf(bad), null, `expected null for ${JSON.stringify(bad)}`);
});

test("the multi-label suffix list is the union of the four it replaced", () => {
  /* From the list that had it. The other list did not, and read the same
     domain as two. */
  assert.equal(registrable("shop.example.co.in"), "example.co.in");
  assert.equal(registrable("example.co.in"), "example.co.in");
  /* From the other list. */
  assert.equal(registrable("blog.example.org.uk"), "example.org.uk");
  assert.equal(registrable("a.example.ie.com"), "example.ie.com");
  /* In both. */
  for (const suffix of ["com.pk", "co.uk", "com.au", "co.nz", "com.br", "co.za", "co.jp"])
    assert.equal(registrable(`shop.example.${suffix}`), `example.${suffix}`);
});

test("the generic second-level label rule resolves a.b.gov.br, which only one copy got right", () => {
  assert.equal(registrable("a.b.gov.br"), "b.gov.br");
  assert.equal(registrable("b.gov.br"), "b.gov.br");
  assert.equal(registrable("x.ac.uk"), "x.ac.uk");
  assert.equal(registrable("dept.x.ac.uk"), "x.ac.uk");
});

test("the label rule is confined to country-code TLDs, so net.com does not become a suffix", () => {
  assert.equal(registrable("mail.net.com"), "net.com");
  assert.equal(registrable("blog.example.com"), "example.com");
  assert.equal(registrable("a.b.c.example.com"), "example.com");
});

test("registrable folds www and survives a url, a bare label and nothing", () => {
  assert.equal(registrable("https://www.blog.example.com/x"), "example.com");
  assert.equal(registrable("www.example.com"), "example.com");
  assert.equal(registrable("example"), "example");
  assert.equal(registrable(null), "");
});

test("a host belongs to its parent and never the other way round", () => {
  assert.equal(hostMatch("example.com", "example.com"), "same");
  assert.equal(hostMatch("example.com", "blog.example.com"), "sub");
  /* THE REJECTED BUG. One area matched both directions, so a venture on
     blog.example.com swallowed the venture on example.com. */
  assert.equal(hostMatch("blog.example.com", "example.com"), null);
  assert.equal(hostMatch("example.com", "example.org"), null);
  /* Not a substring match: notexample.com does not end in ".example.com". */
  assert.equal(hostMatch("example.com", "notexample.com"), null);
  assert.equal(hostMatch("example.com", null), null);
  assert.equal(sameSite("example.com", "https://blog.example.com/post"), true);
  assert.equal(sameSite("blog.example.com", "example.com"), false);
});

test("a venture is found by its host, or by its website where it has no host", () => {
  const ventures = [
    { id: "one", host: "example.com", website: "https://example.com" },
    { id: "two", host: null, website: "https://second.example.org/" },
  ];
  assert.equal(ventureForHost("blog.example.com", ventures)?.id, "one");
  assert.equal(ventureForHost("second.example.org", ventures)?.id, "two");
  assert.equal(ventureForHost("sc-domain:example.com", ventures)?.id, "one");
  assert.equal(ventureForHost("nobody.example.net", ventures), null);
  assert.equal(ventureForHost(null, ventures), null);
});

test("an exact match beats a subdomain match whatever order the roster is in", () => {
  const parentFirst = [{ id: "parent", host: "example.com" }, { id: "shop", host: "shop.example.com" }];
  assert.equal(ventureForHost("shop.example.com", parentFirst)?.id, "shop");
  assert.equal(ventureForHost("shop.example.com", [...parentFirst].reverse())?.id, "shop");
  assert.equal(ventureForHost("example.com", parentFirst)?.id, "parent");
  /* And among subdomain matches the most specific parent wins. */
  assert.equal(ventureForHost("eu.shop.example.com", parentFirst)?.id, "shop");
});
