// The frontier's 60-choice cap (T-295; C-075; arch 03 line 167): over 60, each booking other than the target collapses
// to one 'which booking?' choice. See cap.ts.

export {
  MAX_CHOICES,
  WHICH_BOOKING_DEFINITION,
  capChoices,
  targetBookingOf,
  visitWords,
  whichBookingChoice,
  whichBookingLabel,
  type CapAnswer,
} from "./cap";
