// The contact home (T-588; C-102; S13-19): one reach card, every message the person's way (a text only into the chat the
// mobile opened, else email, never SMS), reply clocks only once they were reached, the handling line on owner and staff
// messages about a private booking, and nothing for a booking the business added with no yes to messages. See
// contact.ts, record.ts and home.ts.
export {
  AUDIENCES,
  MESSAGE_WAYS,
  contactWay,
  replyClockMayStart,
  type Audience,
  type ContactDecision,
  type ContactMessage,
  type Held,
  type HeldWhy,
  type MessageWay,
  type Reached,
  type ReplyClock,
} from "./contact";
export {
  CONTACT_POINTS,
  contactHome,
  contactRule,
  type ContactHomeContext,
  type ContactPoint,
  type ContactReading,
} from "./home";
export {
  ContactHomeError,
  PRIVATE_BOOKING_LINE,
  handlingLineFor,
  readContactRecord,
  type ContactRecord,
  type HandlingLine,
} from "./record";
