/**
 * THE ANALYTICS AREA: Umami, Google Calendar, PyPI and Bluesky.
 *
 * Four integrations that have nothing to do with one another and one thing in
 * common — each measures ATTENTION rather than money or machines. Traffic on
 * the owner's own sites, the hours other people have booked of his week,
 * downloads of what he published, and what a social account is doing. They
 * share a directory rather than a document: no figure here spans two of them,
 * and there is no `/api/analytics` for the same reason there is no `/api/seo`
 * over Google and Bing.
 *
 * TWO CREDENTIALED PLUGINS AND TWO LISTS, which is the whole design in a line:
 *
 *   `umami` and `calendar` are MULTI-ACCOUNT, because both are per instance
 *   and per grant. One Umami account is one server carrying every website on
 *   it; one Calendar account is one Google login. Both verify at the door, and
 *   both verifications exist to catch the SAME shape of failure — a credential
 *   that connects happily and reports nothing forever.
 *
 *   `pypi` and `bluesky` are CONFIG-ONLY, because their sources are public.
 *   There is no key to seal, so "connected" means "there is a list to
 *   collect" — npm's reading, twice. The `after` hooks below are what keep
 *   that flag honest, and they are the only place it is written.
 *
 * MANUAL CONFIGURATION IS THE RULE. Every URL, credential, package name and
 * handle below is typed by the owner on the plugin page. Nothing here reads an
 * environment variable, a file, or a list it discovered — a list that grows
 * itself is a chart whose baseline moves without anybody deciding it should.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { trafficSeries } from "../insights/providers.ts";
import * as umami from "./umami.ts";
import * as calendar from "./calendar.ts";
import * as pypi from "./pypi.ts";
import * as bluesky from "./bluesky.ts";
import {
  collectBluesky,
  collectCalendar,
  collectPypi,
  collectUmami,
  syncListPlugin,
} from "./collect.ts";
import { forgetBlueskyHandles, forgetPypiPackages } from "./store.ts";
import { umamiRoutes } from "./umami-route.ts";
import { calendarRoutes } from "./calendar-route.ts";
import { pypiRoutes } from "./pypi-route.ts";
import { blueskyRoutes } from "./bluesky-route.ts";
import { PACKS, SKILLS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  insightSources: trafficSeries,
  id: "analytics",

  plugins: {
    /*
      UMAMI — FOUR FIELDS, THREE OF THEM OPTIONAL, AND EXACTLY TWO LEGAL
      COMBINATIONS.

      The URL is required and is the only field that always is: an Umami runs
      wherever the owner put it and there is no endpoint to hard-code, so the
      address is half the credential and is stored beside the other half for
      the reason `accounts.writeCredentials` is transactional — a base URL
      stored apart from the key that matches it is an account that reads
      nothing while looking configured.

      The other three are a CHOICE, not a set: a self-hosted instance signs in
      with a username and password at /api/auth/login; Umami Cloud and any
      instance with an issued key answer `x-umami-api-key` and have no login
      endpoint at all. Both are supported because both exist in the wild, and
      neither is guessed at — `verify` refuses a set that is neither, at the
      door, rather than storing it to fail hourly.
    */
    umami: {
      secret: "umami",
      fields: ["url", "username", "password", "token"],
      optional: ["username", "password", "token"],
      async verify(values) {
        const url = umami.normaliseUrl(values.url ?? "");
        if (!url)
          return "Paste the address you open your Umami dashboard at, including https://.";

        const token = (values.token ?? "").trim();
        const username = (values.username ?? "").trim();
        const password = values.password ?? "";
        if (!token && !(username && password))
          return (
            "Umami needs one of two things and this is neither: the username " +
            "and password you sign in with, or an API key from Settings → API " +
            "(Umami Cloud, and self-hosted instances that have issued one). " +
            "Paste one pair or the key, not half of each."
          );
        if (token && username)
          return (
            "That is both an API key and a login. Use one: a key is sent as " +
            "x-umami-api-key and never signs in, and a login mints its own " +
            "bearer — storing both would leave the unused half to rot."
          );

        const res = await umami.verify({ url, username, password, token });
        return res.ok ? null : res.error;
      },
    },

    /*
      CALENDAR — THE GMAIL CLIENT, A DIFFERENT SCOPE, AND THAT IS THE WHOLE
      REASON IT IS A SECOND PLUGIN.

      The three fields are gmail's three, in the same shape and for the same
      argument its entry makes: this vault stores FIELDS, and a JSON blob in a
      secret is a document that must be parsed before anything can be checked,
      so a typo inside it would fail as "the grant was refused" rather than as
      "the client secret is missing".

      What cannot be shared is the TOKEN. Google grants scopes at the consent
      screen, per grant, and no call from this box can widen one — so the
      refresh token in the `gmail` plugin was minted for gmail.modify and can
      no more read a calendar than a Hetzner token can read Stripe. The most
      likely thing to be pasted here is that exact token, which refreshes
      perfectly and then 403s on every calendar call, so `verify` checks the
      scope BEFORE the call and says which one to tick. Stored unchecked it
      would be a calendar page that is empty forever for a reason nobody can
      see.

      THE SAME CLIENT ID AND SECRET ARE EXPECTED, though, and that is not a
      contradiction: one OAuth client can mint many grants. The owner reruns
      the consent flow with the calendar scope and pastes the client pair
      again beside the new refresh token.
    */
    calendar: {
      secret: "calendar",
      fields: ["client-id", "client-secret", "refresh-token"],
      async verify(values) {
        const clientId = (values["client-id"] ?? "").trim();
        const clientSecret = (values["client-secret"] ?? "").trim();
        const refreshToken = (values["refresh-token"] ?? "").trim();
        if (!clientId)
          return "Paste the OAuth client ID — the same Desktop app client the Gmail plugin uses is fine, from Google Cloud → Credentials.";
        if (!clientSecret)
          return "The client secret is issued with the client ID and Google refuses a refresh grant without it.";
        if (!refreshToken)
          return (
            "Paste a refresh token minted with access_type=offline AND the " +
            "https://www.googleapis.com/auth/calendar.readonly scope. The Gmail " +
            "token already in this vault will not do: Google grants scopes at " +
            "the consent screen and nothing here can widen one."
          );
        const res = await calendar.verify({ clientId, clientSecret, refreshToken });
        return res.ok ? null : res.error;
      },
    },
  },

  config: {
    /*
      PyPI'S PACKAGE LIST, which is a setting for npm's reason: the downloads
      API is public, so there is nothing to seal, but it cannot be collected
      without knowing which packages are the owner's. That is a decision rather
      than a credential — public by design, shown in full, and readable back so
      a typo can be corrected rather than becoming a 404 on every run for a
      week.
    */
    pypi: {
      keys: {
        packages: {
          label: "Packages",
          hint:
            "The PyPI names you publish, separated by commas or newlines. " +
            "Names are normalised the way PyPI normalises them — Foo.Bar_baz " +
            "and foo-bar-baz are the same package and are stored once — so " +
            "whichever spelling you paste will work. Downloads exclude mirrors.",
          ph: "my-package, my-other-package",
          check(value) {
            const raw = value.split(/[\s,]+/).filter(Boolean);
            const bad = raw.filter((n) => !pypi.validName(n));
            if (bad.length)
              return `Not PyPI package names: ${bad.slice(0, 3).join(", ")}.`;
            if (raw.length > 40)
              return (
                `That is ${raw.length} packages. Each one costs up to three ` +
                "requests to two public services that nobody is paying for, so " +
                "trim the list rather than have it rate-limited."
              );
            return null;
          },
        },
      },
      /*
        npm's rule: with no packages the collector has nothing to ask about,
        and with packages it works immediately and without a credential.

        AND THE ROWS FOLLOW THE LIST, here rather than only in the collector.
        A name removed takes its downloads with it — otherwise it goes on
        counting inside every total while appearing nowhere on the page — and
        the collector cannot be the only place that happens, because clearing
        the list to EMPTY disconnects the plugin and the collector never runs
        again. A list emptied on the settings page must empty the page too.
      */
      after(values) {
        const packages = pypi.parsePackages(values.packages ?? "");
        forgetPypiPackages(packages);
        syncListPlugin("pypi", packages.length);
      },
    },

    /*
      BLUESKY'S HANDLE LIST. The public AppView has no notion of "mine" — it
      answers for any handle on the network — so the list is exactly what the
      owner typed, and every figure downstream is captioned with the handle it
      belongs to rather than implied to be his.
    */
    bluesky: {
      keys: {
        handles: {
          label: "Handles",
          hint:
            "The Bluesky handles to watch, separated by commas or newlines. A " +
            "handle is a domain — alice.bsky.social, or a custom one you " +
            "verified — and a leading @ is fine. These are read from Bluesky's " +
            "public API with no key, so any handle on the network works; the " +
            "list is what you want on the page, not what you own.",
          ph: "@bsky.app, alice.bsky.social",
          check(value) {
            const raw = value
              .split(/[\s,]+/)
              .map((h) => h.trim().replace(/^@/, "").toLowerCase())
              .filter(Boolean);
            const bad = raw.filter((h) => !bluesky.validHandle(h));
            if (bad.length)
              return (
                `Not Bluesky handles: ${bad.slice(0, 3).join(", ")}. A handle is ` +
                "a domain — alice.bsky.social — not a display name."
              );
            if (raw.length > 40)
              return (
                `That is ${raw.length} handles, and each costs two requests to a ` +
                "public API every six hours. Trim the list."
              );
            return null;
          },
        },
      },
      /* The rows follow the list — see the pypi entry above for why this is
         here as well as in the collector. */
      after(values) {
        const handles = bluesky.parseHandles(values.handles ?? "");
        forgetBlueskyHandles(handles);
        syncListPlugin("bluesky", handles.length);
      },
    },
  },

  collectors: {
    umami: collectUmami,
    calendar: collectCalendar,
    pypi: collectPypi,
    bluesky: collectBluesky,
  },

  routes: [
    { path: "/api/umami", app: umamiRoutes },
    { path: "/api/calendar", app: calendarRoutes },
    { path: "/api/pypi", app: pypiRoutes },
    { path: "/api/bluesky", app: blueskyRoutes },
  ],

  skills: SKILLS,
  packs: PACKS,
};
