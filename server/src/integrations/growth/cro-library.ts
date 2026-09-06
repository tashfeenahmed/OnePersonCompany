/**
 * THE CONVERSION-EXPERIMENT LIBRARY — hand-written, static, and the reason a
 * CRO answer on this box never needs a model.
 *
 * WHY A FILE AND NOT A TABLE. Nothing here is per-owner: these are hypotheses
 * about pages in general, they are the same for everybody who installs this,
 * and a copy in the database would be a copy that drifts from the one the code
 * reads. What IS per-owner is which of them a venture is running, and that is
 * `growth_cro`.
 *
 * WHY A FILE AND NOT A MODEL. A model asked "what should I test on my pricing
 * page" answers plausibly and differently every time, and a different answer
 * every time is not a library — it is a slot machine. The point of this is that
 * the owner never has to invent a hypothesis from a blank page, and that the
 * same leaking stage produces the same shortlist twice.
 *
 * NOTHING HERE IS A PROMISE THAT A TEST WILL WIN. Every entry is a hypothesis
 * and the change that would settle it; most tests lose, and a library that
 * pretended otherwise would be selling something.
 *
 * `rank` IS THE ORDER TO TRY THINGS IN, and it is the dimension's rank rather
 * than the entry's: what the page SAYS beats how the page ASKS beats how much
 * work the page makes somebody do. Friction is always last on purpose —
 * removing friction from a page nobody wants is faster failure.
 *
 * THE REFUSALS ARE PART OF THE LIBRARY. A conversion library with no floor
 * under it eventually suggests a countdown timer on an offer that does not
 * expire. The list below is what this will not suggest, in any stage, ever.
 */

export type Experiment = {
  id: string;
  /** The funnel stage this is for. One of STAGES. */
  stage: string;
  /** Which of the seven dimensions it moves. */
  dimension: string;
  /** The dimension's rank, 1 (biggest lever) to 7. */
  rank: number;
  hypothesis: string;
  /** What to change. One change, specific enough to start today. */
  change: string;
  /** How to know whether it worked, in the units the owner already has. */
  measure: string;
  /** Roughly what it costs: "an hour", "an afternoon", "a day", "a week". */
  effort: string;
};

export const STAGES: { id: string; what: string }[] = [
  { id: "landing", what: "A stranger arrives and decides in seconds whether this is for them." },
  { id: "pricing", what: "Somebody interested is working out what it costs and which plan is theirs." },
  { id: "signup", what: "Somebody has decided and is now doing the work of becoming a user." },
  { id: "onboarding", what: "A new account is being set up and has not yet done the thing it came for." },
  { id: "activation", what: "The account exists and has to reach the moment the product actually works." },
  { id: "paywall", what: "A user who gets value is being asked to pay for it." },
  { id: "retention", what: "A paying or active user decides whether to come back, and whether to stay." },
];

export const DIMENSIONS: { id: string; rank: number; what: string }[] = [
  { id: "value-prop", rank: 1, what: "Whether the page says what the thing is and who it is for, before anything else." },
  { id: "headline", rank: 2, what: "The sentence carrying the value proposition — its specificity, and whose words it is in." },
  { id: "cta", rank: 3, what: "What is asked for, how large the ask is, and how many times it is asked." },
  { id: "hierarchy", rank: 4, what: "The order things are read in, and whether the most important thing is the most prominent." },
  { id: "trust", rank: 5, what: "Whether a stranger has any reason to believe the page." },
  { id: "objections", rank: 6, what: "The reasons not to act, answered on the page rather than left to be guessed at." },
  { id: "friction", rank: 7, what: "The work between wanting the thing and having it. Always last." },
];

export const REFUSALS: string[] = [
  "Countdown timers on an offer that does not expire, and fake scarcity of any kind.",
  "Invented social proof — testimonials, logos, user counts or ratings that are not real and checkable.",
  "Confirmshaming: a decline button worded to make somebody feel foolish for pressing it.",
  "Hiding the price, or revealing the total only after an account has been created.",
  "Pre-ticked consent, opt-ins or add-ons.",
  "Making cancellation harder than signing up, in steps, clicks or channels.",
  "A flow that is easy to enter and needs an email to leave.",
  "A button styled as the primary action that goes somewhere the person did not ask for.",
  "Testing on a page whose traffic cannot reach a decision inside a quarter. A test that cannot conclude is a coin flip with a report attached.",
];

/**
 * The entries. Forty-four of them, seven stages, ordered inside each stage by
 * the dimension's rank so a shortlist is always offered biggest-lever first.
 */
export const EXPERIMENTS: Experiment[] = [
  /* ---------------------------------------------------------- landing */
  {
    id: "land-vp-01", stage: "landing", dimension: "value-prop", rank: 1,
    hypothesis: "A first-time visitor cannot tell in five seconds what this is, so they leave before reading anything else.",
    change: "Rewrite the first line as a plain sentence of the form “<product> is a <category> for <who> that <outcome>”. Nothing clever above it.",
    measure: "Bounce rate on the landing page and sessions that reach a second page, over two weeks either side.",
    effort: "an hour",
  },
  {
    id: "land-vp-02", stage: "landing", dimension: "value-prop", rank: 1,
    hypothesis: "The page describes the mechanism rather than the outcome, so it reads as interesting rather than as useful.",
    change: "Replace the “how it works” hero with the result the visitor gets, and move the mechanism below the fold.",
    measure: "Clicks on the primary call to action per session.",
    effort: "an afternoon",
  },
  {
    id: "land-vp-03", stage: "landing", dimension: "value-prop", rank: 1,
    hypothesis: "The page speaks to everyone, so it lands with nobody in particular.",
    change: "Name one audience in the first line, even if it is narrower than the real one.",
    measure: "Signup rate from the landing page, and the share of signups that reach activation.",
    effort: "an hour",
  },
  {
    id: "land-hd-01", stage: "landing", dimension: "headline", rank: 2,
    hypothesis: "The headline is a category name rather than a claim, so there is nothing in it to agree or disagree with.",
    change: "Swap it for a specific claim with a real number in it that the product can stand behind.",
    measure: "Scroll depth past the hero, and calls-to-action clicked.",
    effort: "an hour",
  },
  {
    id: "land-hd-02", stage: "landing", dimension: "headline", rank: 2,
    hypothesis: "The headline is in the company's vocabulary rather than the visitor's.",
    change: "Rewrite it using the exact phrasing of the top Search Console queries, or of a support message, verbatim.",
    measure: "Click-through rate from search on the landing page, in Search Console, four weeks after.",
    effort: "an hour",
  },
  {
    id: "land-cta-01", stage: "landing", dimension: "cta", rank: 3,
    hypothesis: "The first ask is too large for somebody who arrived ninety seconds ago.",
    change: "Offer a smaller first step beside the main one — see it working, read the docs, try one input — with the large ask unchanged.",
    measure: "Total actions taken per session, counting both asks separately.",
    effort: "an afternoon",
  },
  {
    id: "land-cta-02", stage: "landing", dimension: "cta", rank: 3,
    hypothesis: "The button says what the site does rather than what the visitor gets.",
    change: "Change the label from the site's verb (“Sign up”, “Submit”) to the person's outcome (“Get my first report”).",
    measure: "Click rate on that button.",
    effort: "an hour",
  },
  {
    id: "land-cta-03", stage: "landing", dimension: "cta", rank: 3,
    hypothesis: "There is one call to action and it is above the fold, so a reader convinced by section four has nothing to press.",
    change: "Repeat the same call to action after each major section, in the same words each time.",
    measure: "Clicks per session on the call to action, and which position they came from.",
    effort: "an afternoon",
  },
  {
    id: "land-hi-01", stage: "landing", dimension: "hierarchy", rank: 4,
    hypothesis: "The navigation bar competes with the one thing the page is for.",
    change: "Cut the header to the logo and the primary action, on this page only.",
    measure: "Primary action clicks per session against navigation clicks per session.",
    effort: "an hour",
  },
  {
    id: "land-hi-02", stage: "landing", dimension: "hierarchy", rank: 4,
    hypothesis: "A decorative hero image is taking the space the claim needs and says nothing.",
    change: "Replace it with a real screenshot of the product doing the job, or with nothing.",
    measure: "Scroll depth and time to first interaction.",
    effort: "an afternoon",
  },
  {
    id: "land-tr-01", stage: "landing", dimension: "trust", rank: 5,
    hypothesis: "A stranger has no reason to believe any claim on the page.",
    change: "Put one piece of real, checkable evidence in the first screen: a named customer, a real figure, a public repository, a live demo.",
    measure: "Signup rate from the landing page.",
    effort: "a day",
  },
  {
    id: "land-tr-02", stage: "landing", dimension: "trust", rank: 5,
    hypothesis: "The site looks unattended, so the visitor assumes the product is too.",
    change: "Add a visible last-updated date, a changelog link or a recent post — only if they are real and will stay current.",
    measure: "Bounce rate, and returning visitors over four weeks.",
    effort: "a day",
  },
  {
    id: "land-ob-01", stage: "landing", dimension: "objections", rank: 6,
    hypothesis: "The commonest reason people do not start is never mentioned on the page.",
    change: "Take the objection that appears most in support mail and answer it in one line under the call to action.",
    measure: "Call-to-action clicks, and the volume of that question in support mail.",
    effort: "an hour",
  },
  {
    id: "land-fr-01", stage: "landing", dimension: "friction", rank: 7,
    hypothesis: "The page is slow enough on a phone that a share of visitors never see it.",
    change: "Cut the largest render-blocking asset and re-measure on a throttled connection.",
    measure: "Bounce rate on mobile sessions specifically.",
    effort: "a day",
  },
  {
    id: "land-fr-02", stage: "landing", dimension: "friction", rank: 7,
    hypothesis: "Search traffic lands on articles with no path to the product.",
    change: "Add one contextual, relevant product link to the end of the ten highest-traffic posts.",
    measure: "Sessions that go from a post to the product page, in the analytics that is connected.",
    effort: "an afternoon",
  },

  /* ---------------------------------------------------------- pricing */
  {
    id: "pri-vp-01", stage: "pricing", dimension: "value-prop", rank: 1,
    hypothesis: "The plans are named after internal tiers, so nobody can tell which one is theirs.",
    change: "Rename the plans after the person who buys them and add one line saying who each is for.",
    measure: "Checkouts started per pricing-page session.",
    effort: "an afternoon",
  },
  {
    id: "pri-vp-02", stage: "pricing", dimension: "value-prop", rank: 1,
    hypothesis: "The page lists what the plans contain rather than what they let somebody do.",
    change: "Lead each plan with the outcome it unlocks and keep the feature list underneath as detail.",
    measure: "Checkouts started per pricing-page session.",
    effort: "an afternoon",
  },
  {
    id: "pri-vp-03", stage: "pricing", dimension: "value-prop", rank: 1,
    hypothesis: "The unit the price is charged in is not the unit the customer thinks in.",
    change: "Restate the price in the customer's unit beside the billing unit — per report, per seat, per month of use.",
    measure: "Checkouts started, and support questions about pricing.",
    effort: "an hour",
  },
  {
    id: "pri-cta-01", stage: "pricing", dimension: "cta", rank: 3,
    hypothesis: "Every plan's button says the same thing, so the page gives no guidance.",
    change: "Make the recommended plan's button the primary style and word the others as alternatives.",
    measure: "Share of checkouts on the recommended plan, and total checkouts.",
    effort: "an hour",
  },
  {
    id: "pri-cta-02", stage: "pricing", dimension: "cta", rank: 3,
    hypothesis: "The only path forward is paying, and the visitor is not ready.",
    change: "Add a genuinely free path beside the paid buttons — a free tier, a trial that needs no card, or a demo.",
    measure: "Total accounts created, and the share of them that later pay.",
    effort: "a week",
  },
  {
    id: "pri-hi-01", stage: "pricing", dimension: "hierarchy", rank: 4,
    hypothesis: "Four plans is a decision the visitor postpones rather than makes.",
    change: "Cut to three, or to two with a contact line for the largest.",
    measure: "Checkouts started per pricing-page session.",
    effort: "an afternoon",
  },
  {
    id: "pri-hi-02", stage: "pricing", dimension: "hierarchy", rank: 4,
    hypothesis: "No plan is recommended, so the page asks the visitor to do the work of choosing.",
    change: "Mark one plan as the usual choice and say in one line why it is.",
    measure: "Checkouts started, and the spread across plans.",
    effort: "an hour",
  },
  {
    id: "pri-tr-01", stage: "pricing", dimension: "trust", rank: 5,
    hypothesis: "Nobody can tell whether the price will change once they are in.",
    change: "State the billing terms plainly beside the price: what is charged, when, and what happens at the limit.",
    measure: "Checkouts completed over checkouts started.",
    effort: "an hour",
  },
  {
    id: "pri-ob-01", stage: "pricing", dimension: "objections", rank: 6,
    hypothesis: "The unasked question is what happens if it does not work out.",
    change: "Add a short, real refund or cancellation line directly under the buttons.",
    measure: "Checkouts completed over checkouts started.",
    effort: "an hour",
  },
  {
    id: "pri-ob-02", stage: "pricing", dimension: "objections", rank: 6,
    hypothesis: "The three questions that always come up are answered nowhere on the page.",
    change: "Add a four-question FAQ under the plans, in the actual wording people use.",
    measure: "Checkouts started, and the volume of those questions in support mail.",
    effort: "an afternoon",
  },
  {
    id: "pri-fr-01", stage: "pricing", dimension: "friction", rank: 7,
    hypothesis: "The checkout asks for more than a card before it will take money.",
    change: "Remove every field the first payment does not need — company name, phone, address where tax does not require it.",
    measure: "Checkouts completed over checkouts started.",
    effort: "a day",
  },

  /* ----------------------------------------------------------- signup */
  {
    id: "sig-vp-01", stage: "signup", dimension: "value-prop", rank: 1,
    hypothesis: "The signup page repeats nothing about why somebody is signing up, so a moment of doubt ends the session.",
    change: "Put one line of the value proposition beside the form, and the specific thing that happens next.",
    measure: "Form completions over form views.",
    effort: "an hour",
  },
  {
    id: "sig-cta-01", stage: "signup", dimension: "cta", rank: 3,
    hypothesis: "The submit button describes the form rather than the outcome.",
    change: "Label it with what the person gets on the other side.",
    measure: "Form completions over form views.",
    effort: "an hour",
  },
  {
    id: "sig-hi-01", stage: "signup", dimension: "hierarchy", rank: 4,
    hypothesis: "The form asks for everything at once, so the first screen looks like work.",
    change: "Ask for the minimum that creates an account and collect the rest after the first success.",
    measure: "Form completions over form views, and how many later fill in the rest.",
    effort: "a day",
  },
  {
    id: "sig-tr-01", stage: "signup", dimension: "trust", rank: 5,
    hypothesis: "Handing over an email feels like an unbounded commitment.",
    change: "Say in one line what will and will not be sent, next to the email field.",
    measure: "Form completions over form views.",
    effort: "an hour",
  },
  {
    id: "sig-ob-01", stage: "signup", dimension: "objections", rank: 6,
    hypothesis: "Somebody who is not ready to commit has no smaller option, so they leave rather than choose.",
    change: "Offer a way to see the product working without an account, linked from the form.",
    measure: "Accounts created, and sessions that use the no-account path then create one.",
    effort: "a week",
  },
  {
    id: "sig-fr-01", stage: "signup", dimension: "friction", rank: 7,
    hypothesis: "Email verification stands between signing up and doing anything.",
    change: "Let the account work immediately and verify in the background, gating only what genuinely needs it.",
    measure: "Share of new accounts that take their first real action the same day.",
    effort: "a week",
  },
  {
    id: "sig-fr-02", stage: "signup", dimension: "friction", rank: 7,
    hypothesis: "The password rules are refused after submission rather than explained beside the field.",
    change: "State the rules next to the field and validate as it is typed.",
    measure: "Failed submissions per completed signup.",
    effort: "an afternoon",
  },

  /* ------------------------------------------------------- onboarding */
  {
    id: "onb-vp-01", stage: "onboarding", dimension: "value-prop", rank: 1,
    hypothesis: "A new account lands on an empty screen and has to invent something to do.",
    change: "Ship a worked example already in the account, with real-looking data, that can be edited rather than started from nothing.",
    measure: "Share of new accounts that complete one real action in their first session.",
    effort: "a week",
  },
  {
    id: "onb-cta-01", stage: "onboarding", dimension: "cta", rank: 3,
    hypothesis: "The first screen offers five things and no order to do them in.",
    change: "Name one next step and hide the rest until it is done.",
    measure: "Share of new accounts that complete that step.",
    effort: "a day",
  },
  {
    id: "onb-hi-01", stage: "onboarding", dimension: "hierarchy", rank: 4,
    hypothesis: "Setup is ordered by how the system is built rather than by what the user came for.",
    change: "Reorder it so the thing they signed up for happens first and configuration comes after.",
    measure: "Time from account creation to the first real action.",
    effort: "a week",
  },
  {
    id: "onb-fr-01", stage: "onboarding", dimension: "friction", rank: 7,
    hypothesis: "The first useful action requires connecting something that takes an afternoon.",
    change: "Let the product do something worthwhile before the integration, with the integration offered afterwards.",
    measure: "Share of new accounts reaching a first result within a day.",
    effort: "a week",
  },

  /* ------------------------------------------------------- activation */
  {
    id: "act-vp-01", stage: "activation", dimension: "value-prop", rank: 1,
    hypothesis: "Accounts reach the moment the product works and do not notice it happening.",
    change: "Mark the moment explicitly — show the result, name what just happened, and say what it is worth.",
    measure: "Share of activated accounts that return within seven days.",
    effort: "a day",
  },
  {
    id: "act-cta-01", stage: "activation", dimension: "cta", rank: 3,
    hypothesis: "There is no second thing to do after the first success, so the session ends there.",
    change: "Offer exactly one next action on the success screen, related to what just worked.",
    measure: "Actions per account in the first week.",
    effort: "a day",
  },
  {
    id: "act-ob-01", stage: "activation", dimension: "objections", rank: 6,
    hypothesis: "The first result is not obviously right, so it is not trusted or used.",
    change: "Show what the result was computed from, beside it.",
    measure: "Share of first results that are acted on rather than abandoned.",
    effort: "a week",
  },
  {
    id: "act-fr-01", stage: "activation", dimension: "friction", rank: 7,
    hypothesis: "The step that produces value takes long enough that people leave before it finishes.",
    change: "Make the wait visible and useful, or produce a partial result immediately.",
    measure: "Abandonment during that step.",
    effort: "a week",
  },

  /* ---------------------------------------------------------- paywall */
  {
    id: "pay-vp-01", stage: "paywall", dimension: "value-prop", rank: 1,
    hypothesis: "The paywall appears before the user has had anything worth paying for.",
    change: "Move it to after the first real result, and say what was just delivered when it appears.",
    measure: "Paid conversions per active account, over a full month.",
    effort: "a week",
  },
  {
    id: "pay-hd-01", stage: "paywall", dimension: "headline", rank: 2,
    hypothesis: "The paywall talks about the plan rather than about what the user was trying to do.",
    change: "Word it around the specific action being blocked, in the user's own context.",
    measure: "Checkouts started from the paywall per time it is shown.",
    effort: "an afternoon",
  },
  {
    id: "pay-cta-01", stage: "paywall", dimension: "cta", rank: 3,
    hypothesis: "The only option is to pay now, so somebody who would pay later leaves instead.",
    change: "Offer a smaller commitment beside it — a lower tier, a monthly option, or a way to be reminded.",
    measure: "Total paid conversions over the following month, not the same day.",
    effort: "a week",
  },
  {
    id: "pay-tr-01", stage: "paywall", dimension: "trust", rank: 5,
    hypothesis: "It is not clear what happens to the work already done if they do not pay.",
    change: "Say plainly what is kept, what is locked, and for how long.",
    measure: "Checkouts started from the paywall, and returning accounts after seeing it.",
    effort: "an hour",
  },

  /* -------------------------------------------------------- retention */
  {
    id: "ret-vp-01", stage: "retention", dimension: "value-prop", rank: 1,
    hypothesis: "Customers cannot see what they have got out of it, so renewal is a cost with no counterweight.",
    change: "Show a periodic summary of what the account actually did and what it produced.",
    measure: "Cancellation rate over the following quarter.",
    effort: "a week",
  },
  {
    id: "ret-cta-01", stage: "retention", dimension: "cta", rank: 3,
    hypothesis: "There is no reason to come back between the moments of need.",
    change: "Add one recurring, genuinely useful reason to return.",
    measure: "Repeat sessions per account per month — sessions, not email opens.",
    effort: "a week",
  },
  {
    id: "ret-tr-01", stage: "retention", dimension: "trust", rank: 5,
    hypothesis: "Customers cannot tell whether the product is still being worked on.",
    change: "Publish an honest changelog and link it from inside the product.",
    measure: "Cancellations citing abandonment, and returning accounts.",
    effort: "a day",
  },
  {
    id: "ret-ob-01", stage: "retention", dimension: "objections", rank: 6,
    hypothesis: "People cancel over one specific missing thing that is never asked about.",
    change: "Ask one open question at cancellation and read the answers for a fortnight before changing anything.",
    measure: "The answers themselves. This one buys a finding, not a rate.",
    effort: "a day",
  },
  {
    id: "ret-fr-01", stage: "retention", dimension: "friction", rank: 7,
    hypothesis: "A failed card silently ends the subscription.",
    change: "Retry, and tell the customer in plain words with a one-click way to fix it.",
    measure: "Involuntary cancellations per month, from the payment processor's own figures.",
    effort: "a day",
  },
  {
    id: "ret-fr-02", stage: "retention", dimension: "friction", rank: 7,
    hypothesis: "Returning after a break means starting over.",
    change: "Keep state across a lapse so a returning account finds its work where it left it.",
    measure: "Share of lapsed accounts that take an action when they return.",
    effort: "a week",
  },
];

/** The experiments for one stage, biggest lever first. */
export function forStage(stage: string): Experiment[] {
  return EXPERIMENTS.filter((e) => e.stage === stage).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export function experiment(id: string): Experiment | null {
  return EXPERIMENTS.find((e) => e.id === id) ?? null;
}
