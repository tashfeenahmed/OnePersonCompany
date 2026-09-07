import test from "node:test";
import assert from "node:assert/strict";
import { hrefFor, linkLabel, LINK_SITES } from "./personLinks.ts";

/* THE FOUR READINGS, IN ORDER. Every one of these is a string somebody has
   actually typed into a box labelled with a site's name, and three of the four
   would be a link to a page on this app if the raw value were used as an
   href. */

test("a full url is used exactly as given", () => {
  assert.equal(hrefFor("github", "https://github.com/janedoe"), "https://github.com/janedoe");
  assert.equal(hrefFor("website", "http://example.com/x?y=1"), "http://example.com/x?y=1");
  /* Including one that does not belong to the site the box is labelled with:
     a pasted address is a decision, not a mistake to correct. */
  assert.equal(hrefFor("x", "https://nitter.net/janedoe"), "https://nitter.net/janedoe");
});

test("a scheme this client will not open is not a link", () => {
  assert.equal(hrefFor("website", "javascript:alert(1)"), null);
  assert.equal(hrefFor("website", "data:text/html,<script>"), null);
  assert.equal(hrefFor("rss", "feed://example.com/rss"), null);
});

test("a path is a url with the scheme left off", () => {
  assert.equal(hrefFor("github", "github.com/janedoe"), "https://github.com/janedoe");
  assert.equal(hrefFor("youtube", "youtube.com/@janedoe"), "https://youtube.com/@janedoe");
  assert.equal(hrefFor("rss", "example.com/feed.xml"), "https://example.com/feed.xml");
});

test("the site's own host is an address rather than a handle", () => {
  assert.equal(hrefFor("substack", "janedoe.substack.com"), "https://janedoe.substack.com");
  assert.equal(hrefFor("github", "github.com"), "https://github.com");
});

test("anything else is a handle, put where that site puts handles", () => {
  assert.equal(hrefFor("github", "janedoe"), "https://github.com/janedoe");
  assert.equal(hrefFor("x", "@janedoe"), "https://x.com/janedoe");
  assert.equal(hrefFor("linkedin", "jane-doe"), "https://www.linkedin.com/in/jane-doe");
  assert.equal(hrefFor("substack", "janedoe"), "https://janedoe.substack.com");
  assert.equal(hrefFor("youtube", "@janedoe"), "https://www.youtube.com/@janedoe");
});

test("hacker news puts a user in a query, not a path", () => {
  assert.equal(hrefFor("hn", "janedoe"), "https://news.ycombinator.com/user?id=janedoe");
});

/* THE ONE THAT DECIDES RULE 3'S SHAPE. A Bluesky handle IS a domain, so
   "contains a dot" can never be the test for "is already a URL". */
test("a bluesky handle that is a domain is still a handle", () => {
  assert.equal(hrefFor("bluesky", "tomasberg.se"), "https://bsky.app/profile/tomasberg.se");
  assert.equal(hrefFor("bluesky", "@jane.bsky.social"), "https://bsky.app/profile/jane.bsky.social");
  /* And bsky.app itself is not one. */
  assert.equal(hrefFor("bluesky", "bsky.app"), "https://bsky.app");
});

test("a website or a feed never becomes a relative path", () => {
  assert.equal(hrefFor("website", "example.com"), "https://example.com");
  assert.equal(hrefFor("rss", "example.com"), "https://example.com");
});

test("an empty box is nowhere to go, and so is a box of spaces", () => {
  assert.equal(hrefFor("github", ""), null);
  assert.equal(hrefFor("github", "   "), null);
  assert.equal(hrefFor("github", null), null);
  assert.equal(hrefFor("github", undefined), null);
});

test("a key this client has never heard of still gets a link", () => {
  assert.equal(hrefFor("mastodon", "example.social/@jane"), "https://example.social/@jane");
  assert.equal(linkLabel("mastodon"), "mastodon");
  assert.equal(linkLabel("hn"), "Hacker News");
});

test("the nine keys the server accepts are the nine drawn", () => {
  assert.deepEqual(
    LINK_SITES.map((s) => s.key),
    ["website", "github", "x", "linkedin", "bluesky", "hn", "rss", "substack", "youtube"],
  );
});
