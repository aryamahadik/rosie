// The frontier's hubs-and-doors source (T-293): the hub for the target booking's stage, the hubs of the writer's role
// and the door entries, from the routing tables of the bundle the turn pins. See hubs-doors.ts.

export { firstSentence } from "./first-sentence";
export {
  DOOR_NAMES,
  HUBS_AND_DOORS,
  createHubsAndDoorsSource,
  offerHubsAndDoors,
  passedCodeCheck,
  targetBookingOf,
  type DoorKey,
  type HubKey,
} from "./hubs-doors";
