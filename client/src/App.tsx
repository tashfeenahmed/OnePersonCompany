const ActionInbox = lazy(() => import("@/pages/ActionInbox").then(m => ({ default: m.ActionInbox })));
import { lazy, Suspense } from "react";
import { NavigationShell } from "@/components/NavigationShell";
import { Link, useLocation } from "react-router-dom";
import { appPage } from "../../shared/navigation";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveProvider } from "@/lib/live";
import { StoreProvider } from "@/lib/store";
import { PaletteTokens, ThemeProvider } from "@/lib/theme";
const Chat = lazy(() => import("@/pages/Chat").then(m => ({ default: m.Chat })));
const NewDashboard = lazy(() => import("@/pages/NewDashboard").then(m => ({ default: m.NewDashboard })));
const Dashboards = lazy(() => import("@/pages/Dashboards").then(m => ({ default: m.Dashboards })));
const PluginDetail = lazy(() => import("@/pages/PluginDetail").then(m => ({ default: m.PluginDetail })));
const Plugins = lazy(() => import("@/pages/Plugins").then(m => ({ default: m.Plugins })));
const Ventures = lazy(() => import("@/pages/Ventures").then(m => ({ default: m.Ventures })));
const Venture = lazy(() => import("@/pages/Venture").then(m => ({ default: m.Venture })));
const VentureForm = lazy(() => import("@/pages/VentureForm").then(m => ({ default: m.VentureForm })));
const VentureMap = lazy(() => import("@/pages/VentureMap").then(m => ({ default: m.VentureMap })));
const Subagent = lazy(() => import("@/pages/Subagent").then(m => ({ default: m.Subagent })));
const Person = lazy(() => import("@/pages/Person").then(m => ({ default: m.Person })));
const Settings = lazy(() => import("@/pages/Settings").then(m => ({ default: m.Settings })));
const Ops = lazy(() => import("@/areas/security/Ops").then(m => ({ default: m.Ops })));
const Board = lazy(() => import("@/pages/Board").then(m => ({ default: m.Board })));
const Email = lazy(() => import("@/pages/Email").then(m => ({ default: m.Email })));
const SocialSection = lazy(() => import("@/pages/SectionPages").then(m => ({ default: m.SocialSection })));
const Subagents = lazy(() => import("@/pages/Subagents").then(m => ({ default: m.Subagents })));
const Alerts = lazy(() => import("@/areas/proactive/Alerts").then(m => ({ default: m.Alerts })));
const Login = lazy(() => import("@/areas/security/Login").then(m => ({ default: m.Login })));
const Workflows = lazy(() => import("@/areas/chief/Workflows").then(m => ({ default: m.Workflows })));
const Finance = lazy(() => import("@/areas/finance/Finance").then(m => ({ default: m.Finance })));
const ActivityPage = lazy(() => import("@/areas/activity/ActivityPage").then(m => ({ default: m.ActivityPage })));
const Calendar = lazy(() => import("@/areas/calendar/Calendar").then(m => ({ default: m.Calendar })));
const Studio = lazy(() => import("@/pages/Studio").then(m => ({ default: m.Studio })));

export default function App() {
  return (
    <ThemeProvider>
      <StoreProvider>
        {/* Draws nothing: it applies the workspace's palette over the mode.
            Inside the store because that is where the choice is kept. */}
        <PaletteTokens />
        <LiveProvider>
          <TooltipProvider>
            {/* Real paths, not a hash. /dashboards/servers is the address a
                board actually has — an address with a #/ in it is not a URL
                anybody wants to paste, and the fragment never reaches a server,
                so nothing upstream can ever route on it. The cost is that
                whatever serves the built files must fall back to index.html for
                unknown paths; Vite's dev server and `vite preview` both do. */}
            <BrowserRouter>
              <NavigationShell>
                <Suspense fallback={<p role="status" className="p-6">Loading page…</p>}>
                  <Routes>
                    {/*
                      A CHAT IS A PLACE, SO IT HAS AN ADDRESS — the same rule
                      the boards follow. `/chat/<id>` IS the open conversation,
                      which is what makes it linkable, middle-clickable and
                      reachable with the back button. Nothing in the store
                      names it; see `StoreState` in lib/store.tsx for why.

                      `/` is a NEW chat and stays that way: an empty composer,
                      with the session created by the first message and the URL
                      replaced with its address the moment it exists.

                      BOTH PATHS RENDER THE SAME `<Chat />` ELEMENT, WHICH IS
                      LOAD-BEARING. React Router renders the matched route's
                      element into the same slot with no key, so two routes
                      whose element is the same component type reconcile as one
                      instance: moving between /, /chat/a and /chat/b does not
                      remount the page. That is what keeps the map of turns in
                      flight — a ref on this component — alive across a
                      switch. A `key` here, or two different wrapper
                      components, would silently drop every answer being
                      written the moment somebody changed chats.
                    */}
                    <Route path="/" element={<Chat />} />
                    <Route path="/chat/:sessionId" element={<Chat />} />
                    {/* The bare /chat names no conversation, and the screen
                        for "no conversation" already has an address. */}
                    <Route path="/chat" element={<Navigate to="/" replace />} />
                    <Route path="/ventures" element={<Ventures />} />
                    {/*
                      A VENTURE IS A PLACE, so it has an address — and so does
                      the form that makes one. /ventures/new is a PAGE rather
                      than a dialog because what it asks for (what this is,
                      where it lives, which stage it is at) is a form somebody
                      thinks in, and because a stage nobody read is a stage the
                      agent will give the wrong advice from.

                      `new` is declared BEFORE `:slug` so the literal wins:
                      React Router ranks static segments above dynamic ones, so
                      the order is belt and braces rather than load-bearing —
                      but a venture whose slug really is "new" would otherwise
                      be one routing change away from being unreachable.
                    */}
                    <Route path="/ventures/new" element={<VentureForm />} />
                    {/* The connection map, BEFORE `:slug` for the same reason
                        `new` is: it is a literal segment and a venture could
                        one day be slugged "map". React Router ranks static
                        above dynamic anyway; the order says the intent. */}
                    <Route path="/ventures/map" element={<VentureMap />} />
                    {/* The org chart, before `:slug` for the third time and
                        the third identical reason: a literal segment that a
                        venture could one day be slugged with. */}
                    {/* The org chart is the Sub-agents page's roster now. Both
                        of its old addresses land there, for links already made. */}
                    <Route path="/org" element={<Navigate to="/subagents" replace />} />
                    <Route path="/ventures/org" element={<Navigate to="/subagents" replace />} />
                    <Route path="/ventures/:slug" element={<Venture />} />
                    <Route path="/ventures/:slug/edit" element={<VentureForm />} />
                    {/*
                      ONE OF A VENTURE'S SIX WORKERS. The address is the
                      venture and the ROLE rather than the worker's id —
                      /ventures/acme/team/seo is a sentence and
                      /subagents/sa-v-3f21-seo is a primary key — and the
                      pairing is the thing that is guaranteed: every venture is
                      provisioned with all six on every read.

                      NOT the `<Venture />` element, unlike the tabs below. A
                      worker's page is not a view of the venture; it has its
                      own identity form, its own dispatch box and its own
                      history, and rendering it inside the venture's tab strip
                      would put a Save button under a strip that says
                      "Overview".
                    */}
                    <Route
                      path="/ventures/:slug/team/:role"
                      element={<Subagent />}
                    />
                    {/*
                      THE WORKER WITH NO VENTURE ABOVE IT. Same element, one
                      segment shorter, and the shortness is the whole meaning:
                      the People analyst answers to nobody's business, so
                      there is no venture to put in front of it. The page
                      reads the absence of `:slug` as "this is a portfolio
                      worker" — see pages/Subagent.tsx — rather than as a
                      route that forgot something.

                      Declared after the venture form of the same page so the
                      two sit together; they cannot collide, because
                      /ventures/... is a longer literal prefix.
                    */}
                    <Route path="/team/:role" element={<Subagent />} />
                    {/*
                      ONE WATCHED PERSON'S FILE. A person used to be a query
                      parameter on the line above — `?person=<id>`, a filter
                      over the analyst's transcript — and a page carrying
                      pulled metrics, a timeline of public activity, the
                      mailbox's read on the relationship and every dossier ever
                      written is not a filtered view of a conversation. So it
                      is a page, and pages have addresses.

                      THREE SEGMENTS, so it cannot collide with the two-segment
                      route above it whatever the role is called; the order is
                      for reading rather than for routing.
                    */}
                    <Route path="/team/people/:personId" element={<Person />} />
                    {/*
                      THE VENTURE'S OTHER TABS. Real addresses rather than
                      state, the same rule the boards follow: "what is
                      a venture is connected to" is a place somebody sends a link
                      to. They render the same `<Venture />` element as the
                      overview, so moving between tabs reconciles as one
                      component instead of remounting the page under the
                      header.
                    */}
                    <Route
                      path="/ventures/:slug/connections"
                      element={<Venture />}
                    />
                    <Route path="/ventures/:slug/site" element={<Venture />} />
                    <Route path="/ventures/:slug/audit" element={<Venture />} />
                    <Route path="/ventures/:slug/knowledge" element={<Venture />} />
                    {/* A venture's own dashboards. The same board component
                        the global page renders, narrowed to this venture's
                        host — see components/BoardView and lib/scope. */}
                    {/* Making a board is a page of its own — see pages/NewDashboard. */}
                    <Route path="/ventures/:slug/dashboards/new" element={<NewDashboard />} />
                    <Route
                      path="/ventures/:slug/dashboards/:board"
                      element={<Venture />}
                    />
                    <Route
                      path="/ventures/:slug/dashboards"
                      element={<Venture />}
                    />
                    <Route path="/subagents" element={<Subagents />} />
                    {/* WHERE PEOPLE USED TO BE. Its four tabs — Contacts,
                        Stale, Brief, Commitments — were four questions about
                        mail, so they are four tabs of the Email page now and
                        the page itself is gone. All four addresses have been
                        in links and bookmarks; each one lands on the tab that
                        holds the thing it named, and an unknown tab lands on
                        Contacts. */}
                    <Route path="/people" element={<Navigate to="/mail/contacts" replace />} />
                    <Route path="/people/:tab" element={<LegacyPeople />} />
                    {/* ACTIVITY — one page, three tabs, the URL as the
                        selection: what happened, who arrived, what it cost.
                        The product route under /users is the one deep link,
                        because one product's user table is a place somebody
                        works in rather than a panel they glance at. */}
                    <Route path="/activity" element={<ActivityPage />} />
                    <Route path="/activity/:tab/:product" element={<ActivityPage />} />
                    <Route path="/activity/:tab" element={<ActivityPage />} />
                    {/* CUSTOMERS — the recovery queue, the dispute cases and
                        the event feed. Three tabs on one address for the
                        reason Activity has three: they are the same question
                        at three distances, and the URL is the selection. */}
                    {/* CALENDAR — one week at a time, and the day IS the
                        address: /calendar/2026-09-08 opens the week containing
                        that day and selects it, so one parameter carries both
                        and a link to a particular day is one somebody can keep.
                        /calendar is this week. */}
                    <Route path="/calendar" element={<Calendar />} />
                    <Route path="/calendar/:day" element={<Calendar />} />
                    {/* THE REFERENCE MATERIAL — the brand as measured, the
                        style guide the owner writes and the pictures the
                        generators can be handed — is not a page of its own any
                        more. It is a row in the Studio's rail and draws in the
                        Studio's column, because what it holds is what the
                        thing being made on that screen is made out of. Its own
                        two addresses stay as redirects: they have been in the
                        rail's links, and one of them carries a tab. */}
                    <Route path="/references" element={<Navigate to="/social/studio/references" replace />} />
                    <Route path="/references/:tab" element={<LegacyReference />} />
                    <Route path="/integrations" element={<Plugins />} />
                    <Route path="/integrations/:id" element={<PluginDetail />} />
                    {/* "Plugin" was the wrong word: these are connections to
                        services that already exist, not code loaded into this
                        app. The old paths still resolve — an address that has
                        been in a bookmark bar should not stop working because
                        the thing it points at got a better name. */}
                    <Route
                      path="/plugins"
                      element={<Navigate to="/integrations" replace />}
                    />
                    <Route path="/plugins/:id" element={<LegacyIntegration />} />
                    {/* A dashboard is a place, so it has an address. The
                        bare path is the way in; it lands on the first board
                        and rewrites itself to that board's own URL, so what
                        is in the bar is always something worth bookmarking. */}
                    <Route path="/dashboards" element={<Dashboards />} />
                    <Route path="/dashboards/new" element={<NewDashboard />} />
                    <Route path="/dashboards/reports/:report" element={<Dashboards />} />
                    <Route path="/dashboards/:slug" element={<Dashboards />} />
                    <Route path="/board" element={<Board />} />
                    {/*
                      MAIL IS ONE PAGE AND ENDS IN A SPLAT, for the same two
                      reasons the Studio's route below does.

                      Its own route rather than SectionPages', because the six
                      mail views are tabs of one header now and the slim strip
                      above it would name the section a second time.

                      A splat, because pages/Email.tsx holds the nested
                      `Routes` for the six — /mail/inbox, /mail/sent,
                      /mail/triage, /mail/commitments, /mail/outbox,
                      /mail/nurture — plus the redirect that carries the old
                      /mail/email (and its `?mode=sent`) onto the right one. A
                      parent whose path does not end in `/*` matches nothing
                      below itself.
                    */}
                    <Route path="/mail/*" element={<Email />} />
                    {/*
                      THE STUDIO IS ITS OWN ROUTE, AND IT ENDS IN A SPLAT.

                      Its own, because every other page under /social is drawn
                      by SectionPages inside the slim top bar and the Studio is
                      the one page the owner asked to start at the top of the
                      viewport. Going through SectionPages is what put that
                      strip there, so this route goes around it.

                      A splat, because the Studio holds a nested `Routes` for
                      the three pages that open in its column beside its rail —
                      Autopilot, Publishing and References — and a parent whose
                      path does not end in `/*` matches nothing below itself.
                      React Router ranks these static segments above
                      `/social/:page` whatever the order here, so the order is
                      for reading.
                    */}
                    <Route path="/social/studio/*" element={<Studio />} />
                    <Route path="/social" element={<SocialSection />} />
                    <Route path="/social/:page" element={<SocialSection />} />
                    <Route path="/social/video/:runId" element={<SocialSection page="video" />} />
                    {/* WHERE THE OTHER SOCIAL PAGES USED TO BE. Autopilot and
                        Publishing are rows in the Studio's rail now and draw
                        in its column; the Motion editor is a tab in its
                        composer; the Posts timeline is a tab in Publishing.
                        Their old addresses — in a bookmark, in an old report,
                        in a link somebody sent — land where the thing is now
                        rather than drawing it twice. A campaign run is still
                        read on the Publishing page, the way a video run is
                        read on the Video page. */}
                    <Route path="/social/autopilot" element={<Navigate to="/social/studio/autopilot" replace />} />
                    <Route path="/social/publishing" element={<Navigate to="/social/studio/publishing" replace />} />
                    <Route path="/social/publishing/:runId" element={<LegacyPublishingRun />} />
                    <Route path="/social/motion" element={<Navigate to="/social/studio?make=motion" replace />} />
                    <Route path="/social/posts" element={<Navigate to="/social/studio/publishing?tab=published" replace />} />
                    {/* The SEO & growth section is gone: its three run apps
                        are sub-agents' work at /outputs, and its three
                        readings are reports on the Dashboards page. The old
                        addresses land on the new ones, run id and all. */}
                    <Route path="/growth" element={<Navigate to="/dashboards/reports/growth" replace />} />
                    <Route path="/growth/:page" element={<LegacyGrowth />} />
                    <Route path="/growth/:page/:runId" element={<LegacyGrowth />} />
                    <Route path="/ops" element={<Ops />} />
                    <Route path="/ops/:runId" element={<Ops />} />
                    {/* ALERTS AND THE BRIEFING, one element and two
                        addresses — the same reconciliation trick the venture
                        tabs use, so moving between the rules and the briefing
                        does not remount the page and lose a poll in flight. */}
                    <Route path="/action-inbox" element={<ActionInbox />} />
                    <Route path="/alerts" element={<Alerts />} />
                    <Route path="/alerts/briefing" element={<Alerts />} />
                    <Route path="/settings" element={<Settings />} />
                    {/* THE ONE SCREEN THAT EXISTS BECAUSE SOMETHING WAS
                        REFUSED. lib/api.ts sends the browser here on a 401,
                        with where it was in `?next=`. On a box with no
                        password it says so instead of drawing a form — see
                        areas/security/Login.tsx. */}
                    <Route path="/login" element={<Login />} />
                    {/* The outputs are the Sub-agents page's third tab; the
                        addresses stay, so links to a report keep landing. */}
                    <Route path="/outputs" element={<Subagents />} />
                    <Route path="/outputs/:output" element={<Subagents />} />
                    <Route path="/outputs/:output/:runId" element={<Subagents />} />
                    {/* Existing bookmarks and generated reports retain their destinations. */}
                    <Route path="/apps" element={<LegacyApp />} />
                    <Route path="/apps/:app" element={<LegacyApp />} />
                    <Route path="/apps/:app/:runId" element={<LegacyApp />} />
                    {/* THE CHIEF OF STAFF'S OWN PAGE. Same shape as Apps and
                        Dashboards: the bare path lands on the first tab and
                        rewrites itself to that tab's address, and every tab is
                        a place somebody can link to. One element for both, so
                        moving between tabs reconciles rather than remounting. */}
                    {/* FINANCE — the operating-cost ledger and the profit
                        model. Five tabs, one element, the URL as the selection
                        — the same reconciliation the venture tabs use. Reached
                        from the Dashboards strip rather than from a rail row:
                        the cost cards already live on a dashboard, and this is
                        that subject one level deeper. */}
                    <Route path="/finance" element={<Finance />} />
                    <Route path="/finance/:tab" element={<Finance />} />
                    <Route path="/workflows" element={<Workflows />} />
                    <Route path="/workflows/:tab" element={<Workflows />} />
                    <Route path="*" element={<div className="p-8"><h1 className="text-2xl mb-3">Page not found</h1><p>This address does not match a page.</p><Link className="underline" to="/">Go to your workspace</Link></div>} />
                  </Routes>
                </Suspense>
              </NavigationShell>
            </BrowserRouter>
          </TooltipProvider>
        </LiveProvider>
      </StoreProvider>
    </ThemeProvider>
  );
}

/** The old /references/<tab>, carried into the Studio's column with the tab
 *  intact. The bare /references needs no component: it has no parameter. */
function LegacyReference() {
  const { tab } = useParams();
  const location = useLocation();
  return <Navigate to={`/social/studio/references/${tab}${location.search}${location.hash}`} state={location.state} replace />;
}

/** The old /social/publishing/<runId>, carried to the same page inside the
 *  Studio with the run it was opened for. */
function LegacyPublishingRun() {
  const { runId } = useParams();
  const location = useLocation();
  return <Navigate to={`/social/studio/publishing/${runId}${location.search}${location.hash}`} state={location.state} replace />;
}

/** The old /people/<tab>, carried onto the Email page's tab of the same name.
 *  The four People had are all tabs there; anything else is the Contacts tab,
 *  which is what /people opened on. */
function LegacyPeople() {
  const { tab } = useParams();
  const location = useLocation();
  const known = ["contacts", "stale", "brief", "commitments"];
  const to = tab && known.includes(tab) ? tab : "contacts";
  return <Navigate to={`/mail/${to}${location.search}${location.hash}`} state={location.state} replace />;
}

/** The old /plugins/:id, carried across to its new address with the id intact. */
function LegacyIntegration() {
  const { id } = useParams();
  return <Navigate to={`/integrations/${id}`} replace />;
}

/** The old /growth/<page>, carried to where the page lives now: a run app
 *  to /outputs, a reading to the Dashboards page's reports. */
function LegacyGrowth() {
  const { page, runId } = useParams();
  const location = useLocation();
  const slug = page === "overview" ? "growth" : (page ?? "growth");
  return <Navigate to={`${appPage(slug, runId)}${location.search}${location.hash}`} state={location.state} replace />;
}

function LegacyApp() {
  const { app, runId } = useParams();
  const location = useLocation();
  const path = app ? appPage(app, runId) : "/outputs";
  return <Navigate to={`${path}${location.search}${location.hash}`} state={location.state} replace />;
}
