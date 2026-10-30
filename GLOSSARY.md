# iVAT

iVAT turns financial documents uploaded or entered manually by Czech VAT payers into validated, structured data and produces the Czech VAT return and VAT control statement for a reporting period.

## Tenancy and access

**Organization**:
The tenant: the paying and administrative unit that owns one or more Companies. A self-managing business is an Organization with one Company; an accounting office is an Organization with many.
_Avoid_: Tenant (in user-facing language), account, workspace

**Company**:
A VAT payer whose documents are processed and whose VAT is reported. Belongs to exactly one Organization.
_Avoid_: Client, entity, firm

**IČO**:
The eight-digit identification number of a Czech business in the public registers.
_Avoid_: Company ID, registration number

**VAT ID**:
The number under which a Company is registered as a Czech VAT payer (DIČ): "CZ" followed by eight to ten digits.
_Avoid_: DIČ (in code), tax ID

**Membership**:
A User's access to an Organization or a Company, carrying a Role.
_Avoid_: Assignment, access grant

**Invitation**:
A single-use offer for the holder of a specified email address to join an Organization or Company with a specified Role. It expires and may be delivered by email or shared as a link.
_Avoid_: Registration, public invitation

**Role**:
An access level: SuperAdmin grants platform-wide administration across all Organizations and Companies without a Membership. Administrator and User grant scoped access through Memberships.
_Avoid_: Permission level, profile

**Invitation**:
A single-use, expiring offer of a specified Role in an Organization or Company, bound to a specified email address.
_Avoid_: Access link, registration token

## Documents

**Upload Queue**:
A User's pending selection of files to upload into one Company. It is not yet an Upload Batch.
_Avoid_: Upload Batch (before upload), processing queue

**Upload Batch**:
The set of Source Files a User uploaded together into a Company in one upload.
_Avoid_: Import, job, dávka (in code)

**Source File**:
A single file uploaded or imported into a Company, preserved unchanged. May contain one or more Documents.
_Avoid_: Upload, attachment, document (when meaning the file)

**Document**:
One financial document (invoice, credit note, receipt, simplified tax document…), entered manually or identified within a Source File by a page range or row set. A Document can exist without a Source File.
_Avoid_: Doklad (in code), file, record

**Direction**:
Whether a Document was received by the Company (incoming) or issued by it (outgoing).
_Avoid_: Type, side, AP/AR

**Counterparty**:
The other party of a Document: its supplier when the Document is incoming, its customer when outgoing.
_Avoid_: Partner, contact, vendor

**Split**:
Identifying the boundaries of the Documents contained in a Source File.
_Avoid_: Segmentation, separation

**Extraction**:
Reading structured data out of a Document. Each run produces a new Extraction Version.
_Avoid_: Parsing, OCR (as a synonym), recognition

**Extraction Version**:
An immutable snapshot of a Document's structured data, authored either by an AI provider or by a User's manual entry or corrections.
_Avoid_: Revision, edit

**AI Configuration**:
A platform-owned AI provider credential together with the models used for Split and Extraction, assigned by the SuperAdmin to one or more Companies.
_Avoid_: BYOK, Company key, Organization key

**AI Processing Allowance**:
The total number of successful AI Extractions a Company may consume. It does not reset automatically and only the SuperAdmin may change it.
_Avoid_: Monthly limit, token quota, Organization quota

**Rate Breakdown**:
A Document's net amount and VAT amount per VAT rate.
_Avoid_: VAT summary, tax lines

**Credit Note**:
A corrective tax document that reduces (or increases) a previously reported supply; represented with negative amounts.
_Avoid_: Dobropis (in code), refund, debit note (when meaning reduction)

**Duplicate Warning**:
A flag raised when a Document matches an existing one in the same Company; it never blocks processing.
_Avoid_: Duplicate error, conflict

**Approved Document**:
A Document a human has confirmed; the only kind that counts towards VAT Reports.
_Avoid_: Validated, verified, final

**Return to Review**:
Withdrawing a Document's approval so it can be corrected and approved again; possible only outside a Period Lock.
_Avoid_: Unapprove, reject, reopen

## VAT

**VAT Regime**:
The VAT treatment of a Document (e.g. domestic, domestic reverse charge, EU acquisition of goods, EU received service). Selected or confirmed by a human, with an optional AI proposal.
_Avoid_: Tax code, VAT type, classification

**Rules Engine**:
The deterministic component that maps a Document's VAT Regime, Direction and Rate Breakdown onto VAT Return lines and Control Statement sections.
_Avoid_: Tax calculator, AI classification

**Tax Point Date**:
The date of the taxable supply (DUZP), which determines the default Reporting Period of every Document.
_Avoid_: VAT date, issue date (they differ)

**Import Date**:
The date a Document's Source File was uploaded into iVAT; informational only, it never decides a Reporting Period.
_Avoid_: Receipt Date, received date

**Deferred Claim**:
The choice to claim an incoming Document's input VAT in a Reporting Period later than the one of its Tax Point Date.
_Avoid_: Claim move, period override

**Reporting Year**:
A calendar year generated for a Company with one filing frequency (monthly or quarterly); it may start later than January in the year the Company became a VAT payer.
_Avoid_: Fiscal year, filing frequency history

**Reporting Period**:
A month or quarter of a Reporting Year for which a Company reports VAT.
_Avoid_: Tax period, filing period

**VAT Report**:
The set of outputs for one Company and Reporting Period: the VAT Return and the Control Statement.
_Avoid_: VAT filing, declaration

**VAT Return**:
The Czech VAT return (přiznání k DPH, form DPHDP3).
_Avoid_: VAT declaration

**Control Statement**:
The Czech VAT control statement (kontrolní hlášení, form DPHKH1).
_Avoid_: KH (in code), VAT ledger

**Draft XML**:
An XML representation of a VAT Return or Control Statement prepared for review before Finalization.
_Avoid_: Final XML, submission

**Final XML**:
An XML representation of a finalized VAT Return or Control Statement. Its export does not mean that it has been submitted to the tax authority.
_Avoid_: Filed return, submission confirmation

**Finalization**:
An Administrator's or SuperAdmin's act of confirming a VAT Report, which locks its Reporting Period.
_Avoid_: Submission, filing (iVAT does not submit to the tax authority)

**Period Lock**:
The state of a finalized Reporting Period in which its Documents cannot change until an Administrator unlocks it.
_Avoid_: Closing, freeze

**Manual Classification Required**:
A flag on a Document whose VAT Regime is outside the regimes iVAT supports; such Documents are excluded from VAT Reports.
_Avoid_: Unsupported, error
