/**
 * Public TikTok: the parsers (fixtures shaped like the answers tiktok.com gave
 * on 2026-09-29) and the route's joins — which venture a handle belongs to,
 * and what "new" means for a search suggestion. No network.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db, setConfig, upsertPlugin } from "../../db.ts";
import {
  bioHost,
  buildProbes,
  parseDiscover,
  parseHandles,
  parseItemList,
  parseProfileHtml,
  parseSeeds,
  parseSuggestions,
  rankTerms,
} from "./tiktok.ts";
import { tiktokRoutes } from "./tiktok-route.ts";
import {
  today,
  writeTiktokDay,
  writeTiktokDiscover,
  writeTiktokProfile,
  writeTiktokSearches,
  writeTiktokVideos,
} from "./tiktok-store.ts";

const page = (scope: unknown) =>
  `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: scope,
  })}</script></html>`;

test("handles are read from @names, bare names and profile links", () => {
  assert.deepEqual(
    parseHandles("@ExampleApp, cedarstudio\nhttps://www.tiktok.com/@some.one?lang=en  bad!name"),
    ["exampleapp", "cedarstudio", "some.one"],
  );
  assert.deepEqual(parseSeeds("Invoice App\n invoice app, team  chat"), ["invoice app", "team chat"]);
});

test("a profile page gives exact counts from statsV2 and the bio's own site", () => {
  const p = parseProfileHtml(
    page({
      "webapp.user-detail": {
        statusCode: 0,
        userInfo: {
          user: {
            id: "1",
            uniqueId: "exampleapp",
            secUid: "SEC",
            nickname: "exampleapp",
            avatarMedium: "https://cdn/a.jpg",
            signature: "Simple invoicing. More: ExampleApp.com",
          },
          stats: { followerCount: 500, heartCount: 12300, videoCount: 50 },
          statsV2: { followerCount: "500", heartCount: "12345", videoCount: "50", followingCount: "2" },
        },
      },
    }),
    "exampleapp",
  );
  assert.equal(p.likes, 12345, "statsV2 is exact where stats rounds");
  assert.equal(p.followers, 500);
  assert.equal(p.bioHost, "exampleapp.com");
  assert.equal(bioHost("Start a call here: www.cedarstudio.app"), "cedarstudio.app");
  assert.throws(
    () => parseProfileHtml(page({ "webapp.user-detail": { statusCode: 10221 } }), "nobody"),
    /no TikTok account has that handle/,
  );
  assert.throws(() => parseProfileHtml("<html></html>", "x"), /no profile data/);
});

test("the video grid parses counts, photo posts and missing figures as null", () => {
  const v = parseItemList(
    {
      itemList: [
        {
          id: "76",
          createTime: 1790631105,
          desc: " #ExampleApp ",
          imagePost: { cover: { imageURL: { urlList: ["https://cdn/p.jpg"] } } },
          video: { duration: 0 },
          stats: { playCount: 402, diggCount: 4, commentCount: 1, shareCount: 0, collectCount: 2 },
        },
        { id: "77", createTime: 1790629314, video: { cover: "https://cdn/v.jpg", duration: 31 }, stats: {} },
        { desc: "no id" },
      ],
    },
    "exampleapp",
  );
  assert.equal(v.length, 2);
  assert.equal(v[0]!.isPhoto, true);
  assert.equal(v[0]!.url, "https://www.tiktok.com/@exampleapp/photo/76");
  assert.equal(v[0]!.duration, null);
  assert.equal(v[0]!.shares, 0, "a reported zero stays zero");
  assert.equal(v[1]!.views, null, "an unreported count is null, not zero");
  assert.equal(v[1]!.duration, 31);
});

test("search suggestions rank by reciprocal rank and drop echoes", () => {
  assert.deepEqual(parseSuggestions('{"sug_list":[{"content":"Invoice App "},{"content":""}]}'), ["invoice app"]);
  assert.deepEqual(parseSuggestions("not json"), []);
  assert.ok(buildProbes("x").includes("x app"));
  const ranked = rankTerms([
    { probe: "seed", terms: ["seed for claude", "seed repo", "only once"] },
    { probe: "seed a", terms: ["seed repo", "seed for claude"] },
    { probe: "seed for claude", terms: ["seed for claude"] },
  ]);
  assert.deepEqual(
    ranked.map((t) => t.term),
    ["seed for claude", "seed repo"],
    "a term one probe surfaced is dropped",
  );
  assert.equal(ranked[0]!.score, 1.5, "its own probe does not add to its score");
});

test("discover splits creators and hashtags and keeps the region", () => {
  const d = parseDiscover({
    body: [
      {
        pageState: { region: "IE" },
        exploreList: [
          { cardItem: { id: "1", type: 2, title: "Ryanair", subTitle: "@ryanair", link: "/@ryanair", extraInfo: { fans: 2500000, likes: 9, verified: true } } },
        ],
      },
      { exploreList: [{ cardItem: { id: "9", type: 3, title: "#glowseason", link: "/tag/glowseason", extraInfo: { views: 130500000 } } }] },
    ],
  });
  assert.equal(d.region, "IE");
  assert.deepEqual(d.items.map((i) => [i.kind, i.rank]), [["creator", 1], ["hashtag", 1]]);
  assert.equal(d.items[0]!.followers, 2500000);
  assert.equal(d.items[1]!.views, 130500000);
  assert.equal(d.items[1]!.link, "https://www.tiktok.com/tag/glowseason");
});

test("the route joins a handle to the venture its bio names, and marks new search terms", async () => {
  const at = new Date().toISOString();
  upsertPlugin("tiktok-public", true, null);
  setConfig("tiktok-public", "handles", "exampleapp, ghost");
  setConfig("tiktok-public", "searches", "invoice app");
  db.prepare(
    `INSERT OR REPLACE INTO ventures (id, slug, name, website, host, stage, color, color_source, position, created_at, updated_at)
     VALUES ('v-tt', 'tt', 'ExampleApp', 'https://exampleapp.com', 'exampleapp.com', 'launched', '#000', 'auto', 99, ?, ?)`,
  ).run(at, at);
  const profile = {
    handle: "exampleapp", userId: "1", secUid: "S", nickname: "exampleapp", avatar: null,
    bio: "More: ExampleApp.com", bioHost: "exampleapp.com", followers: 500, following: 2, likes: 12345, videos: 1,
  };
  writeTiktokProfile(profile);
  writeTiktokVideos(
    "exampleapp",
    [{ id: "76", createdAt: at, caption: "hi", cover: null, url: "u", duration: 9, isPhoto: false, pinned: false, views: 402, likes: 4, comments: 1, shares: 0, saves: 2 }],
    true,
  );
  writeTiktokDay("exampleapp", profile, { views: 402, complete: true, count: 1 });
  writeTiktokSearches("invoice app", [{ term: "invoice app for freelancers", score: 3.3, hits: 4, rank: 1 }]);
  writeTiktokDiscover("IE", [
    { kind: "hashtag", id: "9", rank: 1, title: "#glow", subtitle: null, description: null, link: null, cover: null, views: 5, followers: null, likes: null, videos: null, verified: null },
  ]);

  const doc = (await (await tiktokRoutes.request("/")).json()) as {
    handles: { handle: string; ventureId: string | null; ventureVia: string | null; profile: { followers: number | null }; videos: unknown[]; days: { viewsComplete: boolean }[] }[];
    searches: { seed: string; terms: { term: string; firstSeen: string; daysSeen: number }[] }[];
    discover: { region: string | null; hashtags: { title: string }[] };
  };
  const [ours, ghost] = doc.handles;
  assert.equal(ours!.ventureId, "v-tt");
  assert.equal(ours!.ventureVia, "bio");
  assert.equal(ours!.videos.length, 1);
  assert.equal(ours!.days[0]!.viewsComplete, true);
  assert.equal(ghost!.profile.followers, null, "a handle never read has no figures, not zeroes");
  assert.equal(doc.searches[0]!.terms[0]!.firstSeen, today());
  assert.equal(doc.discover.region, "IE");
  assert.equal(doc.discover.hashtags[0]!.title, "#glow");
});
