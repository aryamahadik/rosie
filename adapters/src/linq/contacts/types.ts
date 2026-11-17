// The contact add's types (T-415; C-208; K-11 v1 contactAdd). They mirror the contactAdd definitions of
// contracts/port-linq/port-linq.v1.schema.json by hand, field for field as the Linq double's types do
// (adapters/src/linq/double/types.ts), because the generated contract types are git-ignored (ADR-005). This folder's
// tests check every outcome against the schema itself.

/** K-11 `contactAdd.request`: add a saved mobile as a Linq contact (arch 11 line 572; MC C9). */
export interface ContactAddRequest {
  phone: string;
}

/** K-11 `contactAdd.response`: added, so the chat link and its QR code may be shown (Q-03's default). */
export interface ContactAddAdded {
  result: "added";
  phone: string;
  alreadyContact: boolean;
  providerContactId: string | null;
}

/** K-11 `contactAdd.errors`: not added, so no chat link is shown (Q-03's default; MC 8 'Texting'). */
export interface ContactAddFailed {
  result: "failed";
  phone: string;
  retryable: boolean;
  code: string | null;
  reason: string;
}

export type ContactAddOutcome = ContactAddAdded | ContactAddFailed;
