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
A User's access to an Organization or a Company, carrying a Role in that scope. A User may hold several Memberships with different Roles.
_Avoid_: Assignment, access grant

**Effective Access**:
A User's resulting access to a Company through Company or Organization Memberships, or the SuperAdmin Role. Removing one Membership does not remove access supplied by another Membership or by that platform Role.
_Avoid_: Global membership, global Company role

**Invitation**:
A single-use offer for the holder of a specified email address to join an Organization or Company with a specified Role. It expires and may be delivered by email or shared as a link.
_Avoid_: Registration, public invitation

**Role**:
An access level: SuperAdmin grants platform-wide administration across all Organizations and Companies without a Membership. Administrator and User grant scoped access through Memberships.
_Avoid_: Permission level, profile

**MFA recovery**:
A User restores access after losing an authenticator by proving email ownership and a prepared backup MFA code, then establishing a replacement authenticator.
_Avoid_: MFA bypass, backup-code login

## Platform operations

**Operational Alert**:
An optional email to a SuperAdmin about a continuing critical blockage of active platform work, grouped by its root cause.
_Avoid_: Company notification, delivery confirmation

**Incident Episode**:
One continuous period in which the same operational root cause critically blocks active work. Changes in affected Companies or work counts belong to the same episode while any blockage remains.
_Avoid_: Error occurrence, incident history

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

**Upload Transfer**:
The private, incomplete bytes and server-confirmed progress for one immutable Upload Batch item. It becomes a Source File only after validated publication.
_Avoid_: Source File (before publication), Document

**Upload Attempt**:
One generation of an Upload Transfer. A full restart creates a new attempt for the same immutable item; retired attempts cannot continue a replacement's progress.
_Avoid_: Session (when meaning a transport generation), access token

**Photo Group**:
A User-confirmed ordered set of original photographs of one Document, fixed when its Upload Batch starts. Its processed basis is separate from the unchanged Source Files.
_Avoid_: Automatic group, merged original

**Processed Basis**:
The preserved representation actually supplied for Extraction, with its identity and page order traceable to the original source evidence.
_Avoid_: Original, Source File (when meaning a derived representation)

**Document**:
One financial document (invoice, credit note, receipt, simplified tax document…), entered manually, identified within a Source File by a page range or row set, or explicitly bounded by a Photo Group. A Document can exist without a Source File.
_Avoid_: Doklad (in code), file, record

**Direction**:
Whether a Document was received by the Company (incoming) or issued by it (outgoing).
_Avoid_: Type, side, AP/AR

**Counterparty**:
The other party of a Document: its supplier when the Document is incoming, its customer when outgoing.
_Avoid_: Partner, contact, vendor

**Counterparty Directory**:
A Company's own collection of Counterparties; one entry can be both a supplier and a customer. Linking a Document to an entry does not replace the Document's recorded party details.
_Avoid_: Shared Organization address book, supplier-only register

**Payment Account**:
The bank account designated for payment on a Document. A Czech domestic account number and its equivalent Czech IBAN are two representations of the same Payment Account.
_Avoid_: IBAN account, separate domestic account

**Bank Account Check**:
A dated observation of whether a Document's Payment Account is published for its supplier in the VAT payer register. It describes the registry at the time of the check, independently of the Document's approval and historical checks.
_Avoid_: Account approval, historical publication proof

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
A Document confirmed by a human or under the Company's explicitly enabled automatic approval policy; the only kind that counts towards VAT Reports.
_Avoid_: Validated, verified, final

**Rejected Document**:
A Document deliberately excluded from further processing and VAT Reports with a recorded reason, while retaining its data and history. Restoring it returns it to human review.
_Avoid_: Deleted Document, failed Extraction

**Partial Claim**:
A User's explicit selection of amounts for eligible separate supplies on an incoming Document, by VAT rate, while preserving the Document's full amounts. It is independent of data discrepancies and distinct from statutory proportional or reduced deduction.
_Avoid_: Rounding correction, corrected total

**Proportional Deduction**:
A User's explicitly confirmed input-VAT deduction under § 75 based on already known actual economic use, using one whole percentage for the entire Document. It is distinct from selecting separate supplies through a Partial Claim and from reduced deduction under § 76.
_Avoid_: Partial Claim, estimated coefficient, reduced deduction

**Unclaimed Portion**:
The difference between a Document's full amounts and its explicitly selected Partial Claim or Proportional Deduction, by VAT rate. It does not classify expenses for income tax or absorb discrepancies in extracted data.
_Avoid_: Non-tax expense, balancing amount

**Return to Review**:
Withdrawing a Document's approval so it can be corrected and approved again; possible only outside a Period Lock.
_Avoid_: Unapprove, reject, reopen

## VAT

**VAT Regime**:
The VAT treatment of a Document (e.g. domestic, domestic reverse charge, EU acquisition of goods, EU received service). Selected or confirmed by a human, or accepted under the Company's explicitly enabled automatic approval policy, with an optional AI proposal.
_Avoid_: Tax code, VAT type, classification

**Rules Engine**:
The deterministic component that maps a Document's VAT Regime, Direction and Rate Breakdown onto VAT Return lines and Control Statement sections.
_Avoid_: Tax calculator, AI classification

**Tax Point Date**:
The date of the taxable supply (DUZP), which determines the default Reporting Period of every Document.
_Avoid_: VAT date, issue date (they differ)

**Import Date**:
The date a Document's Source File was uploaded into iVAT, not the date the Company originally received the financial document. It does not replace the Tax Point Date or establish earlier possession of the Document.
_Avoid_: Receipt Date, received date

**Earliest Claim Period**:
The first Reporting Period in which the conditions for claiming an incoming Document's input VAT were satisfied. It is distinct from the period in which the entitlement arose and the period the User ultimately chooses to claim it.
_Avoid_: Receipt Date, Import Period, entitlement period

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

**PDF Preview**:
A Czech form representation of a VAT Return or Control Statement whose filing data agrees with the corresponding XML export. It can be reviewed with incomplete filing details.
_Avoid_: Submission confirmation, separate calculation

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

**Representative**:
A person identified as acting for the Company in the filing details of a VAT Report export. The Representative is distinct from the Company taxpayer, the export's author and any Authorized Signatory; entering these details does not establish or verify power of attorney.
_Avoid_: Company User, export author, verified proxy

**Representation Profile**:
A Company's saved default Representative details, which a User can replace or explicitly disable for one export without changing the default.
_Avoid_: Membership, Role, power of attorney record

**Authorized Signatory**:
The natural person identified as authorized to sign for a legal person in a VAT Report export, with their relationship to that legal person. This identity is separate from the Representative and the export's author.
_Avoid_: Representative (when meaning the signatory), export author
