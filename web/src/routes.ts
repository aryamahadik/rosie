// web's pages, each at its path under BASE_PATH (T-1171). servePage (shell/serve.ts) answers these paths and no other.
// Every page renders through the page frame (shell/frame.ts), so every page's footer links to the privacy notice
// (RULES 4.3; Q-30). T-511 (the web app shell) adds each feature folder's routes here.
import { renderPrivacyPage } from "./pages/privacy/page";
import { PRIVACY_PATH } from "./shell/frame";

/** One page: its path under BASE_PATH, and the whole HTML document it shows for a base path. */
export interface PageRoute {
  path: string;
  render: (basePath: string) => string;
}

export const PAGE_ROUTES: readonly PageRoute[] = [{ path: PRIVACY_PATH, render: renderPrivacyPage }];
