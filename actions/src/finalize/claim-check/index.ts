// The claim check, limit 7 (C-091; T-311): each slot's field visible to this recipient (arch 06 line 311; RULES 4.5,
// 4.6; S13-22). The finalize call (C-093, T-313) claims the composer's plan, and the step's fallback text, for the row's
// reader before the message checks (T-312) run; the composer's input takes its facts from claimFacts (K-03 `facts`).

export {
  READERS,
  narrowest,
  readerOf,
  slotAudience,
  tableAudience,
  type FieldAudience,
  type Reach,
  type Reader,
} from "./audience";
export {
  SECURE_PAGE_WORDS,
  claimFacts,
  claimPlan,
  claimSlot,
  claimText,
  type ClaimContext,
  type ClaimWhy,
  type ClaimedPlan,
  type ClaimedText,
  type Refusal,
  type RefusalWhy,
  type SlotClaim,
  type Verdict,
} from "./claim-check";
export {
  FIELD_AUDIENCES,
  QUOTE_SLOT,
  SLOT_AUDIENCES,
  SLOT_FIELDS,
  TABLE_LISTS,
  fieldAudience,
  fieldsOf,
  slotAudienceOf,
  type ListedField,
} from "./fields";
