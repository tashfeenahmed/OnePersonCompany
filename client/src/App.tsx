import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/AppSidebar";
import { LiveProvider } from "@/lib/live";
import { StoreProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import { Chat } from "@/pages/Chat";
import { Dashboards } from "@/pages/Dashboards";
import { PluginDetail } from "@/pages/PluginDetail";
import { Plugins } from "@/pages/Plugins";
import { Ventures } from "@/pages/Ventures";
import { Settings } from "@/pages/Settings";
import { Apps } from "@/pages/Apps";
import { Subagents } from "@/pages/Subagents";

export default function App() {
  return (
    <ThemeProvider>
      <StoreProvider>
        <LiveProvider>
          <TooltipProvider>
            {/* Real paths, not a hash. /dashboards/servers is the address a
                board actually has — an address with a #/ in it is not a URL
                anybody wants to paste, and the fragment never reaches a server,
                so nothing upstream can ever route on it. The cost is that
                whatever serves the built files must fall back to index.html for
                unknown paths; Vite's dev server and `vite preview` both do. */}
            <BrowserRouter>
              <div className="flex h-screen overflow-hidden">
                <AppSidebar />
                <main className="flex min-w-0 flex-1 flex-col">
                  <Routes>
                    <Route path="/" element={<Chat />} />
                    <Route path="/ventures" element={<Ventures />} />
                    <Route path="/subagents" element={<Subagents />} />
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
                    <Route path="/dashboards/:slug" element={<Dashboards />} />
                    <Route path="/settings" element={<Settings />} />
                    {/* Same shape as dashboards: the bare path lands on the
                        first app and rewrites itself to that app's own URL. */}
                    <Route path="/apps" element={<Apps />} />
                    <Route path="/apps/:app" element={<Apps />} />
                  </Routes>
                </main>
              </div>
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
