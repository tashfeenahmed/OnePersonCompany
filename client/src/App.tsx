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
const Dashboards = lazy(() => import("@/pages/Dashboards").then(m => ({ default: m.Dashboards })));
const PluginDetail = lazy(() => import("@/pages/PluginDetail").then(m => ({ default: m.PluginDetail })));
const Plugins = lazy(() => import("@/pages/Plugins").then(m => ({ default: m.Plugins })));
const Ventures = lazy(() => import("@/pages/Ventures").then(m => ({ default: m.Ventures })));
const Venture = lazy(() => import("@/pages/Venture").then(m => ({ default: m.Venture })));
const VentureForm = lazy(() => import("@/pages/VentureForm").then(m => ({ default: m.VentureForm })));
const VentureMap = lazy(() => import("@/pages/VentureMap").then(m => ({ default: m.VentureMap })));
const Org = lazy(() => import("@/pages/Org").then(m => ({ default: m.Org })));
const Subagent = lazy(() => import("@/pages/Subagent").then(m => ({ default: m.Subagent })));
const Settings = lazy(() => import("@/pages/Settings").then(m => ({ default: m.Settings })));
const SubagentOutputs = lazy(() => import("@/pages/Outputs").then(m => ({ default: m.SubagentOutputs })));
const Ops = lazy(() => import("@/areas/security/Ops").then(m => ({ default: m.Ops })));
const GrowthSection = lazy(() => import("@/pages/SectionPages").then(m => ({ default: m.GrowthSection })));
const Board = lazy(() => import("@/pages/Board").then(m => ({ default: m.Board })));
const MailSection = lazy(() => import("@/pages/SectionPages").then(m => ({ default: m.MailSection })));
const SocialSection = lazy(() => import("@/pages/SectionPages").then(m => ({ default: m.SocialSection })));
const Subagents = lazy(() => import("@/pages/Subagents").then(m => ({ default: m.Subagents })));
const People = lazy(() => import("@/areas/people/People").then(m => ({ default: m.People })));
const Alerts = lazy(() => import("@/areas/proactive/Alerts").then(m => ({ default: m.Alerts })));
const Login = lazy(() => import("@/areas/security/Login").then(m => ({ default: m.Login })));
const Workflows = lazy(() => import("@/areas/chief/Workflows").then(m => ({ default: m.Workflows })));
const Finance = lazy(() => import("@/areas/finance/Finance").then(m => ({ default: m.Finance })));
const ActivityPage = lazy(() => import("@/areas/activity/ActivityPage").then(m => ({ default: m.ActivityPage })));
const Customers = lazy(() => import("@/areas/customers/Customers").then(m => ({ default: m.Customers })));
const JournalPage = lazy(() => import("@/areas/journal/JournalPage").then(m => ({ default: m.JournalPage })));

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
                      the boards follow, arrived at for the same reason. The
                      selection used to be `store.activeSessionId`, which meant
                      pressing a session in the rail from /ventures changed a
                      field and left you on /ventures: the chat you asked for
                      opened on a page you could not see it from. The store
                      field is gone; `/chat/<id>` IS the open conversation, and
                      it is linkable, middle-clickable and reachable with the
                      back button because of it.

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
                    <Route path="/org" element={<Org />} />
                    {/* The old address, kept for links already made. */}
                    <Route path="/ventures/org" element={<Navigate to="/org" replace />} />
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
                    <Route path="/ventures/:slug/journal" element={<Venture />} />
                    {/* A venture's own dashboards. The same board component
                        the global page renders, narrowed to this venture's
                        host — see components/BoardView and lib/scope. */}
                    <Route
                      path="/ventures/:slug/dashboards/:board"
                      element={<Venture />}
                    />
                    <Route
                      path="/ventures/:slug/dashboards"
                      element={<Venture />}
                    />
                    <Route path="/subagents" element={<Subagents />} />
                    {/* PEOPLE'S FOUR TABS ARE FOUR ADDRESSES, the rule every
                        tabbed page here follows: /people/stale is a place
                        somebody sends a link to, not a piece of state. All
                        four render the same element, so moving between them
                        reconciles rather than remounting the page. */}
                    <Route path="/people" element={<People />} />
                    <Route path="/people/:tab" element={<People />} />
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
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/customers/:tab" element={<Customers />} />
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
                    <Route path="/dashboards/reports/email-stats" element={<Dashboards report="email-stats" />} />
                    <Route path="/dashboards/:slug" element={<Dashboards />} />
                    <Route path="/board" element={<Board />} />
                    <Route path="/mail" element={<MailSection />} />
                    <Route path="/mail/:page" element={<MailSection />} />
                    <Route path="/social" element={<SocialSection />} />
                    <Route path="/social/:page" element={<SocialSection />} />
                    <Route path="/social/video/:runId" element={<SocialSection page="video" />} />
                    {/* A campaign run is read on the Publishing page, the way a
                        video run is read on the Video page. */}
                    <Route path="/social/publishing/:runId" element={<SocialSection page="publishing" />} />
                    <Route path="/growth" element={<GrowthSection />} />
                    <Route path="/growth/:page" element={<GrowthSection />} />
                    <Route path="/growth/:page/:runId" element={<GrowthSection />} />
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
                    <Route path="/outputs" element={<SubagentOutputs />} />
                    <Route path="/outputs/:output" element={<SubagentOutputs />} />
                    <Route path="/outputs/:output/:runId" element={<SubagentOutputs />} />
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
                    {/* THE JOURNAL — work the owner did off this box. One
                        address, no tabs: the venture cut of the same list is a
                        tab on the venture page. */}
                    <Route path="/journal" element={<JournalPage />} />
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

/** The old /plugins/:id, carried across to its new address with the id intact. */
function LegacyIntegration() {
  const { id } = useParams();
  return <Navigate to={`/integrations/${id}`} replace />;
}

function LegacyApp() {
  const { app, runId } = useParams();
  const location = useLocation();
  const path = app ? appPage(app, runId) : "/outputs";
  return <Navigate to={`${path}${location.search}${location.hash}`} state={location.state} replace />;
}
