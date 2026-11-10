// The email double (T-418; C-213; K-12 v1): test code only, for the tests and the staging test-phone page (C-205,
// through T-565); never production.
export * from "./double";
export * from "./types";
export { sendEmailProblems } from "./validate";
export { ADDRESS_TAKEN_OUT, STALE_BY_SECONDS, UNREADABLE_EVENT_TYPE, type SignOptions } from "./webhooks";
