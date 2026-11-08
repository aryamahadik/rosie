// The geo double (T-439; C-220; K-17 v1): the geo port's stand-in until a provider is picked (Q-25).
export * from "./double";
export * from "./types";
export {
  checkGeocodeRequest,
  GEOCODE_ERRORS,
  GEOCODE_KINDS,
  isGeocodeError,
  type CheckedRequest,
} from "./validate";
export * from "./world";
