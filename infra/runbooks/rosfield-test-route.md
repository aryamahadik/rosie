# Way back: staging off rosfield.com/test

Staging has served https://rosfield.com/test since D-000 check 1 (DL-023, DL-036, DL-044), on the routes `rosfield.com/test` and `rosfield.com/test/*` in `wrangler.jsonc` (staging section). The old page is saved in `infra/rosfield-test-backup/` (`index.html`, 13 asset files, `SHA256SUMS`, saved Nov 6). Going back never waits for a person (build prompt 5.4); the build never changes the website itself (RK-51).

When: the user says so, or a check on rosfield.com/test fails and cannot be fixed at once.

1. Remove the two routes (`rosfield.com/test` and `rosfield.com/test/*`) from the staging section of `wrangler.jsonc`, in a reviewed change merged to `main`. (The CI test `infra/ci/rosfield-test-route.test.mjs` pins them; the change updates that test in the same review.)
2. Deploy staging from `main` on the build Mac: `npm run deploy:staging` (skill deploy-staging, DL-024; never `wrangler deploy` directly). Staging then holds no rosfield.com route.
3. Check that https://rosfield.com/test shows the old page again (compare with `infra/rosfield-test-backup/index.html` and its asset files), and that https://rosfield.com, /privacy and /terms answer 200 as before. The one expected difference is `assets/_assets_chat.js` line 9: the saved copy holds the placeholder `ROSFIELD_TEST_IMESSAGE_NUMBER` where the live page's chat script holds the page's iMessage number (T-1327). The workers.dev address of staging keeps answering throughout: run `npm run check:staging <workers.dev url>`.
4. If the old page does not come back (the route is gone but the site does not serve it), the user restores it from the saved copy in `infra/rosfield-test-backup/`, since the build never changes the website (RK-51). First verify the files with `SHA256SUMS` (`shasum -a 256 -c SHA256SUMS` inside that folder). Then, in a copy outside the repository, fill the placeholder `ROSFIELD_TEST_IMESSAGE_NUMBER` (its one place: `assets/_assets_chat.js` line 9) with the page's iMessage number, which is the user's own and kept outside the repository, and restore the page from that copy.
5. Report the steps and their log lines to the lead for `ops/releases/D-xxx.md`.
