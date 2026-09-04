/**
 * Settings that are not credentials.
 *
 * WHY THIS EXISTS AT ALL. npm needs no key — its downloads API is public — but
 * it cannot be collected without knowing which packages are mine. That is not
 * a secret and must not be treated as one: it is a list the owner maintains by
 * hand, so it has to be readable back to be corrected, and a write-only field
 * you can never check is a field that eventually holds a typo forever. GitHub
 * has a smaller version of the same need: which organisations to walk, which
 * is a decision rather than a credential.
 *
 * A SECOND CLOSED REGISTRY, for the same reason the vault has one. A route
 * that can write any key under any plugin is a route that can invent a setting
 * nothing reads and leave the owner believing they have configured something.
 * Every key is declared below with the plugin it belongs to, what it is for,
 * and what a valid value looks like — and a value is checked before it is
 * stored, so "@my scope/pkg" is refused at the point it was typed rather than
 * becoming a 404 on every run for a week.
 *
 * MOUNTED ALONGSIDE routes/plugins.ts rather than inside it. Both answer under
 * /api/plugins; this half owns `/:id/config` and touches nothing the
 * credential routes own, which keeps the file that can write to the vault as
 * small as it was.
 */
import { Hono } from "hono";
import { configValue, configValues, getPlugin, setConfig, upsertPlugin } from "../db.ts";
import { parsePackages, validName } from "../providers/npm.ts";
import { MAX_KEYWORDS, parseKeywords } from "../providers/bing.ts";
import { MAX_TERMS, parseTerms } from "../providers/demand.ts";
import { DEFAULT_URL, normalise } from "../providers/searxng.ts";
import { pruneOrphanHistory } from "../telegram/bridge.ts";
import { COLLECTORS } from "../collector.ts";

export const pluginConfig = new Hono();

type Key = {
  label: string;
  /** What the owner is being asked for, in one sentence, shown on the page. */
  hint: string;
  /** A placeholder that is a real example rather than a shape. */
  ph?: string;
  /** Null when the value is fine, otherwise the reason it is not. */
  check?: (value: string) => string | null;
};

/**
 * The watch-list field, written once and used by both doors onto it.
 *
 * The label names the source whose page it is on, because a field that said
 * only "Phrases" on two different pages would leave a reader wondering whether
 * they are the same list. They are, and the hint says so.
 */
function termsKey(source: string): Key {
  return {
    label: "Watch phrases",
    hint:
      `Phrases to watch for on ${source}, one per line or separated by commas. ` +
      "This is ONE list shared with the other demand source — editing it here " +
      "changes it there, because a phrase is the same phrase whichever site it " +
      "was said on. Reddit's anonymous feed allows one query a minute, so a " +
      "long list is asked across several collections rather than all at once.",
    ph: "free llm api, video to reel, planning permission ireland",
    check(value) {
      const terms = parseTerms(value);
      const long = terms.filter((t) => t.length > 80);
      if (long.length)
        return `Too long to be a search phrase: “${long[0]!.slice(0, 40)}…”.`;
      const raw = value.split(/[,\n]+/).filter((p) => p.trim()).length;
      if (raw > MAX_TERMS)
        return (
          `That is ${raw} phrases. Each one costs a request per source every ` +
          `collection — and a minute of wall clock on Reddit's anonymous feed — ` +
          `so the list is capped at ${MAX_TERMS}. Trim it rather than have the ` +
          `extras silently dropped.`
        );
      return null;
    },
  };
}

/** The plugins that share the one watch list. */
const DEMAND_PLUGINS = ["reddit", "hackernews"] as const;

/**
 * Write the list onto every door, and set both flags from it.
 *
 * CONNECTED MEANS "THERE IS A LIST", for npm's reason, and for both of these
 * — including Reddit, which CAN hold a credential. Its feed token only lifts a
 * throttle; the Atom feed answers without one. So an account with no phrases
 * would collect nothing while saying "connected", and phrases with no account
 * collect immediately and more slowly, which is the true state of things.
 */
function mirrorTerms(source: string, values: Record<string, string>) {
  const raw = values.terms ?? "";
  const connected = parseTerms(raw).length > 0;
  for (const id of DEMAND_PLUGINS) {
    // The row has to exist before a setting can point at it — the foreign key
    // says so, and the mirror is the one writer that can reach a plugin the
    // owner has never opened.
    if (!getPlugin(id)) upsertPlugin(id, false, null);
    if (id !== source) setConfig(id, "terms", raw);
    upsertPlugin(id, connected, null);
  }
}

const REGISTRY: Record<
  string,
  {
    keys: Record<string, Key>;
    /** What being configured MEANS for this plugin, run after a write. */
    after?: (values: Record<string, string>) => void;
    /**
     * Other plugins this setting also configures, collected alongside it.
     *
     * ONE KEY EXISTS THAT GOVERNS TWO PLUGINS — the demand watch list, mirrored
     * onto both doors — and without this, saving it on the Reddit page would
     * fill Reddit's cards and leave Hacker News's blank until the next tick.
     * A card blank for six hours after a save reads as a setting that did not
     * save, which is the exact reason this route collects at all.
     */
    alsoCollect?: string[];
  }
> = {
  npm: {
    keys: {
      packages: {
        label: "Packages",
        hint:
          "The npm names you publish, separated by commas. Scoped names keep " +
          "their scope — @overbrilliant/ob1 and ob1 are different packages by " +
          "different people, and the scope is the whole identity of yours.",
        ph: "@overbrilliant/ob1, clawsfund-mcp",
        check(value) {
          const raw = value.split(/[\s,]+/).filter(Boolean);
          const bad = raw.filter((n) => !validName(n));
          if (bad.length)
            return `Not npm package names: ${bad.slice(0, 3).join(", ")}.`;
          return null;
        },
      },
    },
    /*
      npm HAS NO ACCOUNTS, so its connected flag cannot be derived from them
      the way every other plugin's is. Here "connected" means "there is a list
      to collect", which is the only true reading available: with no packages
      the collector has nothing to ask about, and with packages it works
      immediately and without a credential.
    */
    after(values) {
      upsertPlugin("npm", parsePackages(values.packages ?? "").length > 0, null);
    },
  },

  /*
    BING'S PHRASE LIST, WHICH IS A SETTING FOR npm's REASON AND NOT A
    DISCOVERY.

    Every other search figure on this dashboard is a rear-view mirror: Search
    Console and Bing's own query report can only ever say what a page of ours
    ALREADY ranks for. `GetKeywordStats` answers the other question — how many
    people typed a phrase, whether or not anything of ours came back — and to
    ask it you have to name the phrase. Nothing on this box knows what those
    phrases are, and the two obvious ways to invent them are both wrong: seeding
    from Search Console's queries would ask "how much demand is there for the
    things we already rank for", which is the question the endpoint exists NOT
    to answer, and a generated matrix of "best X" permutations would put a
    roadmap on the owner's dashboard that the owner never wrote.

    So it is a list, typed by hand, that READS BACK — a write-only field nobody
    can check is a field that eventually holds a typo forever.
  */
  "bing-webmaster": {
    keys: {
      keywords: {
        label: "Keyword phrases",
        hint:
          "Phrases to measure search demand for, one per line or separated by " +
          "commas. These are asked about whether or not you have a page for " +
          "them — that is the whole point of them, and it is the one question " +
          "Search Console cannot answer. Volumes come back as BING impressions " +
          "for one market, not Google's and not a world total.",
        ph: "team chat, ai video generator, planning permission ireland",
        check(value) {
          const phrases = parseKeywords(value);
          /*
            A phrase is checked for being a PHRASE rather than for spelling: a
            keyword can be anything a person types, so the only wrong values
            are the ones that cannot be a search — an empty entry, or something
            long enough to be a paragraph that was pasted by accident.
          */
          const tooLong = phrases.filter((p) => p.length > 80);
          if (tooLong.length)
            return `Too long to be a search phrase: “${tooLong[0]!.slice(0, 40)}…”.`;
          const raw = value.split(/[,\n]+/).filter((p) => p.trim()).length;
          if (raw > MAX_KEYWORDS)
            return (
              `That is ${raw} phrases. Each one costs a request every collection, ` +
              `so the list is capped at ${MAX_KEYWORDS} — trim it rather than have ` +
              `the extras silently dropped.`
            );
          return null;
        },
      },
    },
  },

  /*
    THE WATCH LIST: ONE LIST, TWO DOORS, AND THE MIRROR THAT KEEPS THEM ONE.

    Reddit and Hacker News are asked the same phrases, because a demand signal
    is the same phrase whichever site somebody said it on. Two independent
    lists would be two places for it to drift, and "why is Hacker News missing
    the phrase I added last week" would be a question with no visible answer.

    So `terms` is registered on both plugins and a write to either is mirrored
    onto the other. Both pages show the list, both can edit it, and there is
    only ever one of it. The alternative — a settings page on one plugin that
    silently governs another — was worse: a list you cannot see from the page
    it feeds is a list nobody will believe is set.

    IT IS A SETTING FOR npm's REASON AND BING'S. Nothing on this box knows
    which phrases matter, and the two ways to invent them are both wrong:
    seeding from Search Console's queries asks who is talking about what we
    already rank for, which is the question these sources exist NOT to answer,
    and a matrix generated from product names would put a watch list on the
    owner's dashboard that the owner never wrote.
  */
  reddit: {
    keys: { terms: termsKey("Reddit") },
    after: (values) => mirrorTerms("reddit", values),
    alsoCollect: ["hackernews"],
  },

  hackernews: {
    keys: { terms: termsKey("Hacker News") },
    after: (values) => mirrorTerms("hackernews", values),
    alsoCollect: ["reddit"],
  },

  /*
    SEARXNG'S URL, WHICH IS A SETTING BECAUSE THE NODE IS THE OWNER'S OWN BOX.

    The instance answers on a hostname that carries that box's IP address
    (`178-105-187-189.sslip.io`), so a constant in the source would be a
    dashboard that quietly stops searching the day the box moves — and the fix
    would be an edit and a redeploy rather than a text field. The API KEY is
    still a credential and still goes in the vault; this is the address, which
    is not a secret and has to read back to be corrected.
  */
  searxng: {
    keys: {
      url: {
        label: "Search endpoint",
        hint:
          "Where the SearXNG instance answers. The base URL or the /search " +
          "path — both are accepted, because both are what a person copies. " +
          "The API key is stored separately, in the vault, and travels as a " +
          "header rather than in this URL.",
        ph: DEFAULT_URL,
        check(value) {
          if (!value) return null; // cleared means "use the default"
          return normalise(value)
            ? null
            : "That is not a URL this can call — it needs a scheme and a host, like https://searxng.example.com/search.";
        },
      },
    },
  },

  github: {
    keys: {
      orgs: {
        label: "Organisations to include",
        hint:
          "Organisation logins, separated by commas. Named explicitly rather " +
          "than swept up: “every org I belong to” would drag in every dormant " +
          "repository of an org you merely joined, and they would crowd out " +
          "the repos anybody is actually looking at.",
        ph: "Overbrilliant",
        check(value) {
          const bad = value
            .split(/[\s,]+/)
            .filter(Boolean)
            .filter((o) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o));
          if (bad.length)
            return `Not GitHub organisation names: ${bad.slice(0, 3).join(", ")}.`;
          return null;
        },
      },
    },
  },

  /*
    TELEGRAM'S PAIRED CHAT — A SETTING THAT WRITES ITSELF.

    Every other key in this registry is typed by a human. This one is
    DISCOVERED: the bridge locks onto the first chat that messages the bot and
    writes the id here, which is what the catalog has always promised ("the
    chat id is discovered on the first message the bot receives"). It is in
    plugin_config rather than a table of its own for the reason npm's package
    list is: it is not a credential, the owner is entitled to read it back, and
    a value nobody can see is a value nobody can correct.

    SO THE FIELD IS MOSTLY A WAY TO CLEAR IT. Emptying it un-pairs the bot and
    the next message from any chat pairs it again — which is how the owner
    moves the bot to a different chat, or takes it back after handing it to
    somebody. Typing an id in by hand is allowed and occasionally the fastest
    way to re-pair a chat that is already known, so the check accepts one; it
    refuses anything that is not a Telegram chat id, because a typo here does
    not fail loudly, it just means every message the bot ever receives is
    ignored as coming from the wrong chat.

    WITH SEVERAL BOTS this field is the FIRST one's. The others hold their
    pairing under `chatId#<account id>` — the same suffix rule accounts.ts uses
    for vault entries, and for the same reason — and are cleared through
    `DELETE /api/telegram/lock/<account id>`, which can name one. A settings
    field cannot.
  */
  telegram: {
    keys: {
      chatId: {
        label: "Paired chat",
        hint:
          "The chat this bot answers, discovered from the first message it " +
          "receives. Clear it to un-pair — the next message from any chat, " +
          "from anyone, pairs it again. Every message from any other chat is " +
          "ignored and counted, and nothing from one ever reaches the agent.",
        ph: "discovered on the first message",
        check(value) {
          if (!value) return null; // cleared means "pair with the next chat"
          if (!/^-?\d{1,19}$/.test(value))
            return "A Telegram chat id is a whole number — negative for a group. Leave this empty and message the bot instead; it fills itself in.";
          return null;
        },
      },
    },
    /*
      A pairing that has been cleared or repointed leaves a conversation
      behind that nothing can continue. It is dropped here rather than kept:
      the words of a chat the owner deliberately un-paired have no reader.
    */
    after: () => {
      pruneOrphanHistory();
    },
  },

  /*
    WHICH AGENT ANSWERS THE CHAT — AND WHY IT IS A SETTING RATHER THAN A
    CREDENTIAL, A CONSTANT, OR A FLAG.

    Hermes and OpenClaw both connect by pasting a URL and a key on the
    Integrations page, and both may be connected at once: they are two
    accounts, two vault entries, two things that work. What they cannot both be
    is LIVE. chat/backend.ts sets out why in full — two agents answering the
    same question from two places is not a feature, it is the same message
    arriving twice on a phone — and the mechanism it chose is exactly one
    config value naming exactly one backend, read on every call so a change
    takes effect on the next message and never needs a restart.

    This is that value. It lives here rather than in routes/chat.ts because it
    is not a secret and it must READ BACK: "which agent am I talking to" is a
    question the owner asks of the interface constantly, and a choice you
    cannot see is a choice you will make twice.

    THE PSEUDO-PLUGIN `chat`. There is a plugins row called `chat` and there is
    no such integration — `plugin_config` has a foreign key onto `plugins`, so
    a setting has to hang off something. Hanging it off `hermes` or `openclaw`
    would be worse than a fake row: the value is about the PAIR, and storing it
    under one of them means deleting that integration silently un-chooses the
    other. The row holds no credential, has no account, appears in no catalog
    entry and therefore draws no tile — the Integrations page renders from the
    catalog and ignores server rows it does not recognise.

    AN UNCONNECTED CHOICE IS ALLOWED. Naming a backend that has no credential
    yet is a real thing to want (choose it, then go and paste the key), and
    chat/backend.ts already treats it as a first-class state: activeBackend()
    returns null when the configured backend is not connected, and the Chat
    page says so. Refusing to store it here would make the ordinary order of
    operations impossible for the sake of a check something else already does.
  */
  chat: {
    keys: {
      backend: {
        label: "Live chat backend",
        hint:
          "Which agent answers the Chat page — hermes or openclaw. Exactly " +
          "one: both can be connected, and only the one named here is asked. " +
          "Clearing it leaves no agent live, and the page says so rather than " +
          "guessing.",
        ph: "hermes",
        check(value) {
          if (!value) return null; // cleared means "no agent is live"
          return value === "hermes" || value === "openclaw"
            ? null
            : `“${value}” is not a chat backend. The two are hermes and openclaw.`;
        },
      },
    },
  },

  /*
    THE MODEL HERMES ASKS FOR, WHICH IS NOT A CREDENTIAL AND IS NOT A CONSTANT.

    A single Hermes base URL can front very different things — Nous Portal
    through `hermes proxy`, a local router, any OpenAI-compatible server the
    owner already runs — and each publishes its own model ids. Nothing on this
    box can know which one the owner wants, and both ways of inventing an
    answer are wrong: a hard-coded id breaks the day the endpoint's catalog
    changes, and silently picking one and never saying which leaves the owner
    unable to explain why the answers changed.

    So it is a field, and EMPTY IS A REAL VALUE: it means "whatever this
    endpoint lists first", which providers/hermes.ts discovers once per process
    from /models. That is the right default because it is derived from the
    endpoint rather than assumed about it.
  */
  hermes: {
    keys: {
      model: {
        label: "Model",
        hint:
          "The model id to ask for, exactly as this endpoint lists it at " +
          "/v1/models. Leave it empty to use whichever model the endpoint " +
          "lists first — that is a real answer, read from the endpoint, not a " +
          "guess. The model that actually answered is reported on every reply, " +
          "because a router may route elsewhere.",
        ph: "auto",
        check(value) {
          if (!value) return null;
          if (value.includes("\n")) return "One model id, on one line.";
          if (value.length > 120) return "That is too long to be a model id.";
          return null;
        },
      },
    },
  },

  /*
    THE AGENT OPENCLAW ADDRESSES. Spelled `agent` rather than `model` on
    purpose, and the difference is not cosmetic: OpenClaw's docs are explicit
    that `model` on its OpenAI endpoint is an AGENT TARGET, not a provider
    model, and that `openclaw/default` is "a stable alias; safe to hardcode".
    Calling the field "Model" would invite an owner to paste `gpt-4o` here and
    then wonder why the gateway 404s at them.
  */
  openclaw: {
    keys: {
      agent: {
        label: "Agent",
        hint:
          "Which agent on the gateway answers — openclaw/default is the stable " +
          "alias and is what this uses when the field is empty. This is an " +
          "AGENT name, not a model name: the gateway picks the model. Its " +
          "/v1/models endpoint lists the agents it will answer as.",
        ph: "openclaw/default",
        check(value) {
          if (!value) return null;
          if (value.includes("\n")) return "One agent name, on one line.";
          if (/^https?:\/\//i.test(value))
            return "That is a URL. The gateway URL is a credential field, not this one.";
          return null;
        },
      },
    },
  },
};

/* ------------------------------------------------------- the chat backend */

/**
 * The pseudo-plugin the chat choice hangs off. Named once, here, because the
 * string is a foreign key value and two spellings of it would be two settings.
 */
export const CHAT_PLUGIN = "chat";

/**
 * Which backend is chosen, or null.
 *
 * VALIDATED ON THE WAY OUT AS WELL AS ON THE WAY IN. The registry above checks
 * a written value, but this row can also be reached by a hand-edited database
 * or hold a backend id that was later removed, and `activeBackend()` looking
 * up an adapter for "hermes2" would quietly return null with no explanation.
 * An unrecognised value is read as "nothing is chosen", which is the state the
 * whole chat path already knows how to say out loud.
 *
 * routes/chat.ts hands this to `setChoiceReader` at import, which is what
 * makes `ask()` consult the setting on every call rather than caching it.
 */
export function readChatBackend(): "hermes" | "openclaw" | null {
  const value = configValue(CHAT_PLUGIN, "backend");
  return value === "hermes" || value === "openclaw" ? value : null;
}

/** Set it, or clear it with null. The plugins row is created on demand for the
 *  same reason `mirrorTerms` creates one: the foreign key says the row has to
 *  exist before a setting can point at it. */
export function writeChatBackend(id: "hermes" | "openclaw" | null) {
  if (!getPlugin(CHAT_PLUGIN)) upsertPlugin(CHAT_PLUGIN, false, null);
  setConfig(CHAT_PLUGIN, "backend", id ?? "");
}

/** The keys a plugin accepts, with their current values. Never a secret: no
 *  key in the registry above is one, by construction. */
function shape(id: string) {
  const entry = REGISTRY[id]!;
  const values = configValues(id);
  return {
    id,
    config: values,
    keys: Object.entries(entry.keys).map(([key, k]) => ({
      key,
      label: k.label,
      hint: k.hint,
      ph: k.ph ?? null,
      value: values[key] ?? "",
    })),
  };
}

pluginConfig.get("/:id/config", (c) => {
  const id = c.req.param("id");
  if (!REGISTRY[id])
    return c.json({ error: `${id} has no settings.`, config: {}, keys: [] }, 404);
  return c.json(shape(id));
});

/**
 * Write settings, then collect.
 *
 * Collecting immediately is the same promise the credential routes make: the
 * point of configuring something is to see it, and a list saved at nine that
 * shows nothing until half past is a list the owner will assume did not save.
 *
 * A KEY OUTSIDE THE REGISTRY IS REFUSED rather than ignored, because a
 * silently dropped setting looks exactly like a saved one.
 */
pluginConfig.put("/:id/config", async (c) => {
  const id = c.req.param("id");
  const entry = REGISTRY[id];
  if (!entry) return c.json({ error: `${id} has no settings.` }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    config?: Record<string, string>;
  } | null;
  if (!body?.config || typeof body.config !== "object")
    return c.json({ error: "Expected { config: { … } }." }, 400);

  const unknown = Object.keys(body.config).filter((k) => !(k in entry.keys));
  if (unknown.length)
    return c.json({ error: `Unknown setting(s): ${unknown.join(", ")}` }, 400);

  for (const [key, value] of Object.entries(body.config)) {
    if (typeof value !== "string")
      return c.json({ error: `${key} must be text.` }, 400);
    const problem = entry.keys[key]!.check?.(value.trim());
    if (problem) return c.json({ error: problem }, 400);
  }

  // The plugin row has to exist before a setting can point at it — the foreign
  // key says so, and it is the right order anyway: configuring a plugin is
  // what brings it into being here.
  if (!getPlugin(id)) upsertPlugin(id, false, null);
  for (const [key, value] of Object.entries(body.config))
    setConfig(id, key, value.trim());

  entry.after?.(configValues(id));

  const collector = COLLECTORS[id];
  const plugin = getPlugin(id);
  // Only when there is something to collect FOR: a github row with no
  // account would spend a run to report that it has no account.
  const collected =
    collector && plugin?.connected === 1 ? await collector() : null;

  /* The plugins this same key also configured. Their results are not on the
     wire — the caller asked about one plugin — but the run rows are, and so
     are the cards they fill. */
  const also: string[] = [];
  for (const other of entry.alsoCollect ?? []) {
    const run = COLLECTORS[other];
    if (run && getPlugin(other)?.connected === 1) {
      await run();
      also.push(other);
    }
  }

  return c.json({
    ...shape(id),
    connected: plugin?.connected === 1,
    collected,
    alsoCollected: also,
  });
});
