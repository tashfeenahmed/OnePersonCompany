/**
 * THE IDEA CALL AREA — see ./call.ts for what it is and why it is not the chat.
 *
 * No `plugins`, no `collectors`: it borrows whichever model is connected and
 * the search, domain and voice connections other areas already hold, and it
 * goes stale on no cadence. No `skills` either — the Chief of Staff does not
 * place this call, the owner does, from the idea page.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { ideaCallRoutes } from "./routes.ts";

export const manifest: IntegrationManifest = {
  id: "ideacall",
  routes: [{ path: "/api/idea-call", app: ideaCallRoutes }],
};
