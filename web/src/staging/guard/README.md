# web/src/staging/guard (T-522)

The one staging-only guard staging's test tools use (build prompt 9.4: "Never in production"), beside the shell's own check. Import from `web/src/staging/guard` (its `index.ts`).

- `stagingOnlyRoutes(routes)`: wrap a tool's whole list, `export const ROUTES = stagingOnlyRoutes([...])`. Unless ENVIRONMENT is exactly `staging`, every route answers the shell's 404 page and its handler is never called.
- `stagingOnly(handle)`: the same for one handler. `isGuarded(route)`: true for a route either of them made.
- `isStagingConfig(context.config)`: true only on staging. A page outside the tool folders uses it to show no link to a tool, and no control of one, anywhere else.
- `isStagingOnlyRefusal(outcome)`: true for K-21 v1's `{ "error": "stagingOnly" }`, and it narrows the outcome's type. `refusedPage(context)`: the page that shows that refusal as refused (403, inside the frame, with the trace id). In a handler: `if (isStagingOnlyRefusal(outcome)) return refusedPage(context);`

Rules:

- The guard reads only the config the shell hands a handler, never the request, and it fails closed.
- Keep the tool's folder marked `stagingOnly: true` in `web/src/routes.ts`. `guard.test.ts` fails when a staging-only folder lists a route that is not guarded, or when a guarded route sits in a folder without the mark.
- A method a route does not take gets the shell's 405 before any handler runs; only the mark in `routes.ts` makes that a 404.
