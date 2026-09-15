/** Carry the entry point in the link, so refresh, Back and a new tab preserve
 * the focused chat view without changing the worker's normal history view. */
export function runLinkFromChat(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const url = new URL(href, "https://opc.invalid");
  if (!/^\/(?:ventures\/[^/]+\/team\/[^/]+|team\/[^/]+)\/runs\/[^/]+$/.test(url.pathname)) return href;
  url.searchParams.set("view", "chat");
  return url.pathname + url.search + url.hash;
}

export function isChatRunView(params: URLSearchParams): boolean {
  return params.get("view") === "chat";
}
