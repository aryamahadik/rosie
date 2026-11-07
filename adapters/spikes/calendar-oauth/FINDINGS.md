# T-1123 findings: calendar app review and consent (Google, Microsoft)

Spike T-1123, Nov 7 2026, for the CTO: J-13's lead time and K-16's scopes. An integrations research agent with web access read the documents (DL-064); the lead wrote this file from its text report (DL-063). Research only: no app was made and nothing changed. Time: about 10 minutes of agent run time (limit 2 hours).

Local inputs: K-16 in `ops/plan/02-contracts.md` section 5, Q-10, Q-11 (iCloud stays out), Q-56, J-13 in `ops/plan/08-needs-from-jay.md` and Master Corrections section 8 "Calendars". Sources [G1] to [M10] are listed at the end; all were read on Nov 7 2026.

## Launch on Dec 3

**In one line:** Dec 3 leaves time for Google's review only if the app is made now and submitted, demo video included, by about Nov 20, because J-13's current date (Nov 23) plus the stated 10 days lands on Dec 3 with no slack; the fallback is to launch unverified, with the warning screen and a cap of 100 new users [G3][G7].

## What K-16 needs

Four things: busy times by push plus incremental reads (Google's watch and sync tokens; Graph's subscription and delta), a fresh free/busy read when a booking is written, and one event per visit that is written, moved and deleted. A free/busy-only scope cannot do all of that.

## Google

| Scope                         | Of the methods K-16 needs, it allows                                                              | Fit                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `calendar.freebusy`           | `freebusy.query` only [G2]                                                                        | Too narrow: no watch, no sync-token list, no writes                                             |
| `calendar.events.freebusy`    | `freebusy.query`, `events.list`, `events.watch`; no writes [G2]                                   | The read half of option B; which event fields it returns is unknown [G2]                        |
| **`calendar.events.owned`**   | `events.list`, `.watch`, `.insert`, `.update`, `.delete`; not `freebusy.query` [G2]               | **Recommended:** the narrowest single scope that covers K-16, on calendars the person owns [G1] |
| `calendar.app.created`        | `events.list`, `.watch`, `.insert`, `.update`, `.delete`, only on calendars the app made [G1][G2] | The write half of option B                                                                      |
| `calendar.events`, `calendar` | The same and more, on every calendar the person can reach [G1]                                    | Broader than needed                                                                             |

- Option B (`calendar.events.freebusy` with `calendar.app.created`) reads less, but visits go on a calendar Rosie creates, not on the person's own calendar. That is a CTO call (open).
- With `calendar.events.owned`, K-16's fresh free/busy read becomes an `events.list` over the slot, because `freebusy.query` refuses that scope [G2]. The alternative is to add `calendar.freebusy` (its tier is unknown).
- **Review tier.** Google's example of a sensitive scope is "reading events stored in Google Calendar" [G3]. No Calendar scope is restricted: the restricted list is Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient and Health [G4], so no security assessment is needed; that applies to restricted scopes only [G5]. The Calendar scope page shows no tier per scope [G1], so each granular scope's tier is unknown until the Cloud console's Data Access page shows it. Plan for sensitive-scope verification.
- **Review steps** [G3][G5]:
  1. A consent screen with the app name, a support email, a public homepage that describes the app (not a sign-in page) and a privacy policy on the same domain (rosfield.com). The policy must say how Google user data is accessed, used, stored and shared.
  2. The authorized domains verified in Search Console.
  3. Every scope declared, each sensitive one with a detailed justification of why a narrower one will not do.
  4. A demo video of the end-to-end flow, unlisted on YouTube and in English, showing the OAuth grant and the consent screen with the scopes.
  5. Data used only for user-facing features.
- **Stated review time:** sensitive-scope verification "can take up to 10 days to complete"; brand verification's automated review "usually completes in a few minutes" [G3].
- **Limits before review:**
  - In Testing status the app allows at most 100 test users, and their authorizations and refresh tokens expire 7 days after consent [G6].
  - In production but unverified, users see the "unverified app" screen, and the cap is 100 new users in total [G7].
  - Apps in development or test builds, and internal apps, need no verification [G7].
- **Workspace accounts:** an admin can restrict Calendar to trusted apps, block one app, or block every unconfigured app; the default allows any third-party app [G8].

## Microsoft (Graph, delegated permissions)

| Permission                | Least privileged for                                                                               | Admin consent required, delegated [M1]  |
| ------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **`Calendars.ReadWrite`** | Create event, work and personal accounts [M2]; also accepted for delta [M3] and `getSchedule` [M4] | No (application permission: yes)        |
| `Calendars.Read`          | Event change notifications [M5]; event delta [M3]                                                  | No (application permission: yes)        |
| `Calendars.ReadBasic`     | `getSchedule`, work accounts only; personal accounts "Not supported" [M4]                          | No                                      |
| `offline_access`          | Refresh tokens: must be requested; typically valid 90 days [M6]                                    | Unknown: not in the reference rows read |

- **Recommended:** `Calendars.ReadWrite` with `offline_access`. Add `Calendars.Read` only if the event subscription refuses ReadWrite (unknown; check in the K-16 spike): the subscription table names only `Calendars.Read`, and says subscriptions "don't support write access permissions when only read access permissions are needed" [M5]. The `.Shared` permissions are not needed and cannot subscribe to shared folders [M5]. Use no application permissions: they all need admin consent [M1].
- **Consent:**
  - None of the pages read names an app review for these permissions. Personal accounts (Outlook.com, Hotmail) never need an admin.
  - In a work tenant, users may by default consent to permissions that do not need admin consent [M7]. A tenant can limit user consent to verified publishers' apps and low-impact permissions, or turn it off; the user then gets an error or the admin-consent request form, and an admin must consent [M6][M7].
  - If risk-based step-up consent is on, users cannot consent to multitenant apps registered after Nov 8 2020 that are not publisher verified [M8].
- **Publisher verification** is free. It needs a verified Microsoft AI Cloud Partner Program account, an app registered from an Entra work or school account (not a personal Microsoft account), and a publisher domain that is not `*.onmicrosoft.com`. With those in place, an app "can be verified in minutes" [M8]. The partner account's own verification "in most cases ... takes three to five business days" and asks for business and domain documents [M9]. Register the app as "Any Entra ID Tenant + Personal Microsoft accounts" [M10].
- **For K-16:** `getSchedule` does not serve personal accounts [M4], so their fresh read uses `calendarView`. Delta cannot `$select` [M3], so the adapter drops titles, as with Google.

## For J-13

- Google's review applies, so ask J-13 now rather than by Nov 16.
  - Make the Google project in Testing. Staging and T-433 can run on test users, but their links drop every 7 days [G6].
  - The demo video needs the real connect flow working, so a minimal connect, busy read and event write must run on staging before T-433 (Nov 23).
- Microsoft needs no review, but it needs an Entra work tenant with rosfield.com, and Partner Center verification if owners on work accounts must connect without their admin.

## Unknowns

- The tier of each granular Google scope (shown only in the console), and which fields `events.list` returns under `calendar.events.freebusy`.
- How long Google's review really takes beyond the stated 10 days, and how many rounds a first submission needs.
- Whether Graph accepts `Calendars.ReadWrite` alone for an event subscription.
- How many owners' Microsoft tenants or Workspace domains restrict consent or Calendar access.
- Whether Rosfield has an Entra work tenant and a partner account; whether rosfield.com has a public homepage and a privacy policy that covers Google user data (that wording may need Jay).

## Sources

All read on Nov 7 2026, with the page's own date where it shows one.

- [G1] Choose Google Calendar API scopes (no date shown): https://developers.google.com/workspace/calendar/api/auth
- [G2] Calendar API v3 reference, the Authorization sections of freebusy/query, events/list, events/watch, events/insert, events/update and events/delete (no date shown): https://developers.google.com/workspace/calendar/api/v3/reference/
- [G3] Sensitive scope verification (no date shown): https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- [G4] Restricted Scopes, Cloud Console Help (no date shown): https://support.google.com/cloud/answer/13464325
- [G5] Verification requirements, Cloud Console Help (no date shown): https://support.google.com/cloud/answer/13464321
- [G6] Manage App Audience, Cloud Console Help (no date shown): https://support.google.com/cloud/answer/15549945
- [G7] Unverified apps, Cloud Console Help (no date shown): https://support.google.com/cloud/answer/7454865
- [G8] Control which apps access Google Workspace data (updated Oct 26 2026): https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data
- [M1] Microsoft Graph permissions reference (updated Nov 7 2026): https://learn.microsoft.com/en-us/graph/permissions-reference
- [M2] Create event (updated Aug 3 2026): https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0
- [M3] event: delta (updated May 14 2026): https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0
- [M4] calendar: getSchedule (updated May 19 2026): https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0
- [M5] Create subscription (updated Apr 7 2026): https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0
- [M6] Scopes and permissions in the Microsoft identity platform (updated Sep 30 2026): https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc
- [M7] Configure how users consent to applications (updated Aug 4 2026): https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent
- [M8] Publisher verification overview (updated Jun 15 2026): https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
- [M9] Understand the verification process in Partner Center (updated Jul 28 2026): https://learn.microsoft.com/en-us/partner-center/enroll/understand-the-verification-process
- [M10] How to register an app in Microsoft Entra ID (updated Jun 15 2026): https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
