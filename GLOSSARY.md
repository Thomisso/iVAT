# iVAT

iVAT turns financial documents uploaded by Czech VAT payers into validated, structured data and produces the Czech VAT return and VAT control statement for a reporting period.

## Tenancy and access

**Organization**:
The tenant: the paying and administrative unit that owns one or more Companies. A self-managing business is an Organization with one Company; an accounting office is an Organization with many.
_Avoid_: Tenant (in user-facing language), account, workspace

**Company**:
A VAT payer whose documents are processed and whose VAT is reported. Belongs to exactly one Organization.
_Avoid_: Client, entity, firm

**Membership**:
A User's access to an Organization or a Company, carrying a Role.
_Avoid_: Assignment, access grant

**Role**:
The access level a Membership grants: SuperAdmin (platform-wide), Administrator (Organization or Company), or User (Company).
_Avoid_: Permission level, profile

## Documents

**Source File**:
A single file uploaded or imported into a Company, preserved unchanged. May contain one or more Documents.
_Avoid_: Upload, attachment, document (when meaning the file)

**Document**:
One financial document (invoice, credit note, receipt, simplified tax document…) identified within a Source File by a page range or row set.
_Avoid_: Doklad (in code), file, record

**Direction**:
Whether a Document was received by the Company (incoming) or issued by it (outgoing).
_Avoid_: Type, side, AP/AR

**Split**:
Identifying the boundaries of the Documents contained in a Source File.
_Avoid_: Segmentation, separation

**Extraction**:
Reading structured data out of a Document. Each run produces a new Extraction Version.
_Avoid_: Parsing, OCR (as a synonym), recognition

**Extraction Version**:
An immutable snapshot of a Document's structured data, authored either by an AI provider or by a User's corrections.
_Avoid_: Revision, edit

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

## VAT

**VAT Regime**:
The VAT treatment of a Document (e.g. domestic, domestic reverse charge, EU acquisition of goods, EU received service). Proposed by AI, confirmed by a human.
_Avoid_: Tax code, VAT type, classification

**Rules Engine**:
The deterministic component that maps a Document's VAT Regime, Direction and Rate Breakdown onto VAT Return lines and Control Statement sections.
_Avoid_: Tax calculator, AI classification

**Tax Point Date**:
The date of the taxable supply (DUZP), which determines the Reporting Period of an outgoing Document.
_Avoid_: VAT date, issue date (they differ)

**Receipt Date**:
The date the Company received an incoming Document; the earliest default Reporting Period for claiming input VAT.
_Avoid_: Upload date (it only defaults to it)

**Reporting Period**:
A month or quarter for which a Company reports VAT, per the Company's filing frequency in force at that time.
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

**Finalization**:
An Administrator's act of confirming a VAT Report, which locks its Reporting Period.
_Avoid_: Submission, filing (iVAT does not submit to the tax authority)

**Period Lock**:
The state of a finalized Reporting Period in which its Documents cannot change until an Administrator unlocks it.
_Avoid_: Closing, freeze

**Manual Classification Required**:
A flag on a Document whose VAT Regime is outside the regimes iVAT supports; such Documents are excluded from VAT Reports.
_Avoid_: Unsupported, error
