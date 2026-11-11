// The staging-only guard's whole API (T-522; README.md beside this file). A test tool imports from here.
export {
  STAGING_ENVIRONMENT,
  isGuarded,
  isStagingConfig,
  stagingOnly,
  stagingOnlyRoutes,
  type RouteHandler,
} from "./guard";
export {
  REFUSED_STATUS,
  REFUSED_WORDS,
  STAGING_ONLY_ERROR,
  isStagingOnlyRefusal,
  refusedPage,
} from "./refusal";
