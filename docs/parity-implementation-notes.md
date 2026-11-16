# Parity implementation notes: documents, conditions, loan registration/submission

Status: research only — not yet built. These notes record how each LOS/API would need
to be shaped so brokers and other LOS systems can read/write documents, read conditions,
submit conditions, and register/submit loan files through the passthrough middleware.

jXchange is intentionally excluded from loan-file parity: it is account/transaction-focused
and has no mortgage loan capabilities. Its parity item is a decision-first todo, not a
loan document/condition/submission plan.

## Shared design goals across the mortgage repos

- Loan identity is the spine: every document, condition, and submission operation is scoped
  to a loan id.
- Tenant + persona scoping is enforced at the gateway layer before any vendor call.
- Reads are cached briefly where the vendor supports it; writes go through the queue worker
  except for direct-sync document uploads where the vendor already accepts them.
- Condition and document attachments are treated as separate concerns: conditions carry
  status/description; documents carry file content and metadata; some systems also tie
  documents to conditions.
- Loan registration/submission is a first-class operation in Encompass and is partially
  present in MeridianLink and BytePro through their condition/fee/document mutation paths.
  The exact “submit loan file” semantics are LOS-specific and still need a concrete contract.

## Encompass

Source shape: `src/gateway.js`, `dev/fake-encompass.js`.

### Loan registration / submission
- Loan creation goes through `POST /v1/loans` with a `loanFolder` and a `LoanContract`-shaped
  body; the gateway returns `201` with the created `loanId`.
- Application data is updated with `PATCH /v1/loans/{id}/application`, which is how an
  externally originated loan file would be written into Encompass after registration.
- Milestone progression is separate: `GET/PATCH /v1/loans/{id}/milestones/{milestoneId}` with
  `action=finish|unfinish`. That is the natural place to model “loan file readiness” states
  like underwriting start/finish.

### Documents
- List: `GET /v1/loans/{id}/documents` with query flags such as `requireActiveAttachments`,
  `includeRemoved`, `view`, `start`, `limit`.
- Create document records: `PATCH /v1/loans/{id}/documents` with `action=add`. The gateway
  validates a title and batches up to the document-update cap.
- Attachments are uploaded separately: `POST /v1/loans/{id}/attachmentUploadUrl` initiates an
  upload and returns an attachment id/url; `POST /v1/loans/{id}/attachmentDownloadUrl` creates
  download urls for a batch of attachment ids.
- Condition-scoped documents exist: `GET/POST/PATCH .../conditions/{conditionId}/documents` for
  listing and attaching/removing documents on a specific condition.

### Conditions
- List: `GET /v1/loans/{id}/conditions`.
- Create: `PATCH /v1/loans/{id}/conditions` with `action=add`.
- Update: `PATCH /v1/loans/{id}/conditions` with `action=update`.
- Standard conditions are a distinct route family: `GET/POST/PATCH /v1/loans/{id}/conditions/{type}`
  where `type` is one of `underwriting`, `preliminary`, `postclosing`.
- Condition documents are managed under the condition routes, not only under the loan document
  route, so condition-to-document linking already exists in the Encompass shape.

### What “parity” would mean here
- Document read/download already exists.
- Document create + attachment upload/download already exists.
- Condition read/create/update already exists.
- Condition-to-document linkage already exists.
- Loan registration/submission is the main open piece beyond existing field/application writes:
  this repo already has the loan create + application update + milestone shape needed to model it,
  but the exact “submit loan file” contract still needs to be defined in this repo's todos/notes
  before building.

## MeridianLink Mortgage

Source shape: `src/app.js`, `src/edocs.js`, `src/mismo.js`, `mock/meridian.js`.

### Loan registration / submission
- Loan reads currently go through a MISMO-shaped loan read path; the gateway parses MISMO XML
  into a normalized loan object.
- Write mutation is currently exposed as fee writes and condition submission rather than a single
  “submit loan file” endpoint. That means loan submission would most naturally be modeled as a
  sequence of MISMO updates: fees, conditions, and possibly document references, posted against
  the loan.
- If a dedicated “submit loan” operation is wanted later, it would probably be a new gateway route
  that assembles a MISMO `<MESSAGE>` update for the loan and queues it through the same write path.

### Documents
- Document operations are through the EDocs SOAP service, not a REST document endpoint.
- List documents: `EDocsService.asmx` `ListEdocsByLoanNumber`.
- Upload PDF: `EDocsService.asmx` `UploadPDFDocument`.
- Download PDF: `EDocsService.asmx` `DownloadEdocsPdfById`.
- Auth is a separate SOAP ticket from `AuthService.asmx` `GetUserAuthTicket`, and the mock
  shows ticket caching is part of the expected flow.
- The current gateway exposes documents to the `TPO_BROKER` persona and accepts base64 PDF content
  with a `documentType` and optional notes.

### Conditions
- Conditions are submitted as MISMO `<CONDITIONS>` blocks matched by description.
- The gateway validates description + status and translates them into MISMO XML through
  `conditionsToXml()`.
- This is a submitonditions style flow rather than a full condition lifecycle read/write model
  like Encompass has. For parity, the repo would need to decide whether conditions are only
  submitted or also readable/manageable through the gateway.

### What “parity” would mean here
- Document upload/download exists in the EDocs shape.
- Document listing exists in the EDocs shape.
- Condition submission exists through MISMO.
- Missing relative to Encompass parity:
  - A richer condition read/manage surface, if that is wanted.
  - A clearer loan registration/submit contract beyond fee/condition/document updates.
  - Explicit condition-to-document linkage, if the LOS supports it; otherwise documents and
    conditions remain separate concerns.

## BytePro Enterprise Cloud

Source shape: `src/app.js`, `src/byte.js`, `src/writes.js`, `mock/bytepro.js`.

### Loan registration / submission
- Loan data is read from `GET /loans/{id}` with path roots such as `Property,Loan,Borrower,
  Milestones,Conditions,Fees,CustomFields`.
- Loan mutation is through `PATCH /loans/{id}` with a `{ data: { ... } }` body. The mock shows
  `Fees` and `Conditions` being accepted there, and `updateLoan()` in `src/byte.js` is the client
  method used for that.
- That means a loan file submission path can be built on top of the existing loan PATCH contract:
  submit fees and conditions together, or in sequence, through queued writes.
- A dedicated “submit loan file” operation would be a gateway-level concept that maps to one or
  more BytePro loan PATCH calls, not necessarily a new BytePro endpoint.

### Documents
- List: `GET /loans/{id}/documents`.
- Download: `GET /loans/{id}/documents/{documentId}`.
- Upload: `POST /loans/{id}/documents` with `documentType`, optional `notes`, and base64 PDF content.
- The gateway currently supports both a queued upload path and a direct synchronous upload path for
  larger documents, with a documented size threshold between them.
- Documents are exposed to `TITLE_VENDOR` and `TPO_BROKER` personas.

### Conditions
- Conditions are submitted through the same loan PATCH contract as a `Conditions` array inside
  `{ data: { Conditions: [...] } }`.
- The gateway normalizes incoming conditions into `Description`, `Status`, optional `Category`,
  and optional `BorrowerVisible`.
- Conditions can be matched/upserted by description in the mock, which suggests a practical
  “submit or update condition by description” pattern.
- Reading conditions is available through the loan read path when `Conditions` is included in the
  requested roots.

### What “parity” would mean here
- Document read/list/upload already exists.
- Conditions can be read through loan data and submitted through loan PATCH.
- Loan submission can be modeled as a queued loan PATCH containing fees and/or conditions.
- Missing relative to Encompass parity:
  - Dedicated standard-condition types like Encompass’s underwriting/preliminary/postclosing are not
    present in the current BytePro shape; they would need to be modeled at the gateway level if
    desired.
  - Condition-to-document linkage is not yet a first-class BytePro pattern in this repo; if needed,
    it would likely be modeled as metadata on the document or condition rather than a separate LOS
    endpoint.

## Cross-repo comparison for later build work

- Encompass has the richest first-class condition and document model, including condition-scoped
  documents and standard condition types.
- MeridianLink relies on SOAP EDocs for documents and MISMO for conditions/fees, so parity there
  is more about translation and ticket/auth handling than REST document/condition endpoints.
- BytePro is the most REST-like of the three for documents and conditions, but its condition model
  is simpler and currently lives inside the loan PATCH contract.
- Across all three, loan registration/submission is the least standardized concept. Encompass has
  explicit loan create/application/milestone routes; MeridianLink and BytePro currently model loan
  mutation as field/condition/fee/document updates. If the team wants a uniform “submit loan file”
  API across repos, that contract should be defined once and then mapped into each LOS's native
  mutation paths.

## Open questions for later

- Do MeridianLink and BytePro need a full condition read/manage surface, or is condition submission
  enough for parity?
- Should condition-to-document linkage be implemented in MeridianLink and BytePro, or only in
  Encompass where the LOS already supports it?
- What exactly does “submit loan file” mean for each LOS: mark a milestone complete, post a final
  condition/fee set, upload remaining documents, or all three?
- Which personas should be able to read vs write documents and conditions in each repo?
