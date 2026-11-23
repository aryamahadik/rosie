// Staff status and admins' powers (T-321; C-094; K-22 v1 staff and team_powers). A Tool API handler makes one per call:
// createStaffAccess({ businessId: context.businessId, reader }), and gives the identity-and-access base its admins'
// powers with createIdentityAccess({ ..., adminPowers: teamAdminPowers(reader) }).

export {
  STAFF_STATUSES,
  StaffReadError,
  TEAM_POWERS,
  createStaffAccess,
  teamAdminPowers,
  type HeldPower,
  type StaffAccess,
  type StaffAccessOptions,
  type StaffOnFile,
  type StaffReader,
  type StaffStatus,
  type TeamMember,
  type TeamPower,
  type TeamPowerOnFile,
} from "./staff";
