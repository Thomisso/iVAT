# Document Processing & VAT Reporting Platform
## Software Requirements Specification (SRS)

**Version:** 0.2 – Requirements with MVP decisions  
**Status:** Draft / Work in Progress  
**Changes in 0.2:** Open questions resolved, MVP scope confirmed (section 10), decisions summarized (section 15). Architectural decisions are recorded in `docs/adr/` and domain terms in `GLOSSARY.md`. Where this document conflicts with section 15, section 15 prevails.  
**Application Name:** iVAT  
**Document Type:** High-Level Functional and Technical Requirements

---

## 1. Project Overview

### 1.1 Purpose

The purpose of this project is to develop a multi-user, AI-powered platform for collecting, importing, processing, and managing financial and tax-related documents.

The application will support both **incoming (received)** and **outgoing (issued)** documents, including invoices, receipts, tax documents, credit notes, and other supporting financial records.

The platform will use Optical Character Recognition (OCR), document parsing technologies, and Artificial Intelligence (AI) to extract structured information from uploaded documents.

One of the primary business objectives is to enable users to generate **VAT returns for selected reporting periods** based on processed and validated documents.

### 1.2 Key Objectives

The application should:

- Centralize the storage and management of financial documents.
- Support multiple companies and multiple users.
- Accept documents in various file formats.
- Automate document data extraction using OCR and AI.
- Integrate with external AI service providers.
- Provide structured, validated, and editable document data.
- Generate VAT reporting outputs for selected periods.
- Maintain appropriate security, access control, and auditability.
- Provide a modular architecture supporting future extensions.

### 1.3 Application Architecture

The application is expected to be developed as a web-based, multi-tenant platform.

Each company will operate within a logically isolated environment, with its own documents, extracted data, users, and VAT reporting configuration.

The system architecture should allow future integration with external accounting, ERP, and financial systems.

The final technology stack and deployment architecture are to be defined during the technical design phase.

---

## 2. User Management and Authentication

### 2.1 Multi-User Support

The application must support multiple registered users.

Users will be associated with one or more companies, subject to their assigned access rights.

Company-specific data must be isolated to prevent unauthorized access across companies.

### 2.2 Authentication Methods

The application must support the following authentication mechanisms:

**Social / Identity Provider Login**
- Google Authentication
- Apple Authentication
- Windows Authentication

**Standard Authentication**
- Email address and password

**Multi-Factor Authentication (MFA)**
- Support for authenticator applications using Time-Based One-Time Passwords (TOTP).
- Examples include Google Authenticator, Microsoft Authenticator, and other compatible applications.
- MFA enrollment, recovery, and enforcement policies will be specified later.

Authentication should rely on established security standards and proven identity management technologies.

### 2.3 User Roles and Permissions

The initial release will support three predefined access levels.

#### Role 1: SuperAdmin

**Scope:** Application-wide

The SuperAdmin represents the application owner or platform operator.

Main capabilities:

- Manage the overall application.
- Create, view, and manage companies.
- Manage company administrators.
- Manage global application configuration.
- Configure available AI providers and platform-level integrations.
- Monitor system usage and processing operations.
- Access administrative and diagnostic functionality.

#### Role 2: Administrator

**Scope:** Company-level

The Administrator is responsible for managing a specific company within the platform.

Main capabilities:

- Manage company settings.
- Create, invite, and manage company users.
- Upload and manage documents.
- Configure company-specific document processing settings.
- Review, validate, and correct extracted information.
- Generate and manage VAT reports.
- Access all relevant company-level processing and reporting functionality.

#### Role 3: User

**Scope:** Company-level

The User represents a regular application user.

Initial capabilities:

- Upload financial documents.
- View and manage documents accessible within the company.
- Initiate document processing.
- Review extracted document information.
- Access VAT reporting functionality as permitted by company policies.

**Note:** The exact permission matrix will be refined during detailed design.

### 2.4 Future Role Management

Advanced Role-Based Access Control (RBAC), including custom roles and granular permissions, is explicitly deferred to a later phase.

The initial architecture should nevertheless support future expansion without major restructuring.

---

## 3. Company Management

### 3.1 Multi-Company Support

The application must support multiple independent companies.

Each company should maintain its own:

- Company profile and identification information.
- VAT and tax identification information.
- Registered users and administrators.
- Uploaded financial documents.
- Document processing settings.
- Extracted financial data.
- VAT reporting periods and generated returns.
- Integration configuration, where applicable.

### 3.2 Company Data Isolation

Company-specific data must be logically isolated.

Access to documents, extracted information, and generated VAT returns must be controlled according to the authenticated user's company membership and assigned role.

### 3.3 Company Configuration

The system should support company-specific configuration, including:

- Company name and identification details.
- Country and applicable tax jurisdiction.
- Default currency.
- VAT registration information.
- Reporting configuration.
- Preferred AI processing provider.

The detailed company configuration model will be defined later.

---

## 4. Document Management

### 4.1 Supported Document Types

The system must support the processing of both incoming and outgoing financial documents.

Initial document categories should include:

- Incoming invoices (Accounts Payable).
- Outgoing invoices (Accounts Receivable).
- Credit notes.
- Debit notes.
- Receipts.
- Simplified tax documents.
- Other tax-related or financial supporting documents.

The document type model should be extensible.

### 4.2 Supported Input Formats

The application must support document uploads in multiple formats, including:

| Format | Extension |
|---|---|
| PDF documents | .pdf |
| Microsoft Excel | .xlsx, .xls |
| Images | .png, .jpg, .jpeg |
| Additional structured or unstructured formats | TBD |

The system should support both digitally generated documents and scanned documents or photographs.

Additional formats should be supported through an extensible document ingestion framework.

### 4.3 Document Upload

Users must be able to:

- Upload individual documents.
- Upload multiple documents in a batch.
- Associate documents with the relevant company.
- Identify or select document direction (incoming/outgoing).
- Select or adjust the document type.
- View upload and processing status.
- Access previously uploaded documents.

The system must preserve the original uploaded file for reference, audit, and reprocessing purposes.

### 4.4 Document Integration

In addition to manual uploads, the architecture should support automated document ingestion from external systems.

Potential integration mechanisms include:

- REST APIs.
- System-to-system integrations.
- Other integration methods to be defined later.

Specific integration endpoints, authentication models, and third-party system connectors are outside the scope of this initial specification.

### 4.5 Document Lifecycle

The system should maintain a clear processing lifecycle.

An initial lifecycle may include:

1. Uploaded
2. Queued for Processing
3. Processing
4. Processed
5. Requires Review
6. Validated / Approved
7. Rejected / Failed

Final states and transition rules will be determined during detailed design.

**v0.2:** Simplified to `Uploaded → Processing → NeedsReview → Approved`, plus `Failed` and `Rejected`. See section 15.2.

---

## 5. Document Processing and Data Extraction

### 5.1 Processing Overview

The system must provide automated extraction of structured information from uploaded financial documents.

The platform should support multiple processing technologies, with AI-based extraction being the primary intended approach.

Processing technologies may include:

- Optical Character Recognition (OCR).
- PDF text extraction.
- Spreadsheet and structured file parsing.
- AI-based document understanding.
- Large Language Models (LLMs).
- Multimodal AI models supporting document and image analysis.
- Other relevant document-processing technologies.

The platform should be designed to select or combine technologies according to document format, content, and configured processing strategy.

### 5.2 AI-Based Document Processing

AI-powered extraction is expected to be a core feature of the application.

The system must support integration with external AI providers.

Possible providers may include OpenAI, Anthropic, Google, and others, depending on available capabilities and integration requirements.

Provider integration should support:

- API-based communication.
- Secure management of API credentials.
- Provider-specific configuration.
- Model selection where supported.
- Structured extraction outputs.
- Processing error handling.
- Monitoring of processing status.
- Authentication via OAuth where supported and appropriate for the specific provider.

**Architectural requirement:** AI provider integrations should be implemented through an abstraction layer to reduce dependency on a single provider and facilitate future replacement or extension.

### 5.3 Extracted Document Information

The system should extract structured business information, where available, including:

**Document Identification**
- Document type.
- Document number.
- Issue date.
- Tax point / VAT date.
- Due date.
- Document direction (incoming/outgoing).

**Business Partners**
- Supplier information.
- Customer information.
- Company names.
- Tax identification numbers.
- VAT identification numbers.
- Addresses.

**Financial Information**
- Document currency.
- Net amounts.
- VAT amounts.
- Gross amounts.
- VAT rates.
- VAT breakdown by applicable tax rate.
- Line item information, where available.
- Payment-related details, where relevant.

**Tax Classification**
- Applicable VAT treatment.
- Tax jurisdiction.
- Other VAT reporting attributes required by the relevant country.

The final extraction schema will be specified separately and may vary by document type and tax jurisdiction.

### 5.4 Data Validation and Review

The application must allow users to review and correct extracted information.

Core functionality should include:

- Displaying the original document alongside extracted data.
- Editing extracted fields.
- Identifying missing or inconsistent values.
- Validating numerical relationships between net, VAT, and gross amounts.
- Flagging potential duplicate documents.
- Recording user corrections.
- Confirming document processing results.

Where available, AI confidence indicators or equivalent uncertainty signals may be used to assist user review.

AI-generated values must not automatically be treated as verified financial facts.

### 5.5 Processing History

The application should maintain processing metadata, including:

- Processing timestamp.
- Selected processing technology.
- AI provider and model, where applicable.
- Processing status.
- Errors and warnings.
- User corrections and validation actions.

The architecture should support reprocessing documents without losing the original source files.

---

## 6. VAT Reporting

### 6.1 VAT Return Generation

The system must allow users to generate VAT returns for a selected company and reporting period.

VAT reporting will be based on structured document information extracted and validated within the application.

### 6.2 Reporting Period Selection

Users should be able to select:

- Company.
- Reporting year.
- Reporting period.

Supported reporting frequencies, such as monthly or quarterly reporting, will be defined according to the applicable tax jurisdiction.

### 6.3 VAT Calculation and Aggregation

The VAT reporting module should:

- Identify documents relevant to the selected reporting period.
- Separate incoming and outgoing transactions.
- Aggregate taxable amounts.
- Aggregate input and output VAT amounts.
- Apply relevant VAT classifications.
- Calculate reporting totals.
- Identify incomplete, invalid, or unreviewed documents.
- Provide a traceable connection between reporting values and source documents.

Country-specific tax rules will be defined in dedicated requirements.

### 6.4 VAT Reporting Outputs

The system should support:

- VAT return preview.
- Summary of calculated VAT amounts.
- Breakdown of transactions by applicable VAT treatment.
- Drill-down from reporting figures to individual documents.
- Export of reporting results.

Potential output formats include PDF, Excel, and country-specific electronic filing formats.

The exact formats will depend on jurisdictional requirements.

### 6.5 VAT Return Review

Generated VAT returns should initially be treated as draft reporting outputs requiring user review and approval.

Automated submission to tax authorities is not included in this initial specification.

### 6.6 Country-Specific VAT Logic

The system architecture must support country-specific VAT rules and reporting requirements.

The initial supported country or countries have not yet been determined.

Tax calculation rules, reporting layouts, validation requirements, and statutory formats will be specified separately.

---

## 7. User Interface and User Experience

### 7.1 General Requirements

The application should provide a modern, responsive web interface.

The interface should support:

- Secure login and authentication.
- Company selection and management.
- Document uploading.
- Document lists and filtering.
- Document preview.
- Extracted data review and editing.
- Document processing status monitoring.
- VAT reporting and report generation.
- User administration.
- Company and integration settings.

### 7.2 Document Processing Workspace

The application should provide a dedicated document-processing workspace where users can:

- Select a document.
- View its original content.
- Inspect extracted information.
- Correct recognized values.
- Review processing warnings.
- Confirm or reject extracted data.

The layout should make the comparison between original documents and structured data straightforward.

---

## 8. Security and Data Protection

### 8.1 Security Requirements

The platform must implement appropriate security controls, including:

- Secure user authentication.
- Role-based authorization.
- Company-level data isolation.
- Secure password handling.
- Multi-factor authentication support.
- Encrypted communications.
- Protection of API keys and integration credentials.
- Secure document storage.
- Logging of security-relevant operations.

### 8.2 Sensitive Financial Data

Uploaded documents may contain confidential company information, financial records, and personal data.

The platform should be designed with applicable privacy and data protection regulations in mind, including GDPR where relevant.

Special attention must be given to the transmission of document data to external AI providers.

Data sharing with AI providers should be transparent and governed by appropriate access and configuration controls.

### 8.3 Audit Trail

The application should maintain an audit history of important actions, including:

- Document uploads.
- Document modifications.
- Data validation and approval.
- User management changes.
- Company configuration changes.
- VAT report generation.

---

## 9. Technical and Non-Functional Requirements

### 9.1 Extensibility

The solution should use a modular architecture allowing future extension of:

- Document types.
- Supported file formats.
- AI providers and models.
- Extraction methods.
- Tax jurisdictions.
- VAT reporting rules.
- External integrations.
- User roles and permissions.

### 9.2 Scalability

The system should support growing volumes of:

- Registered users.
- Companies.
- Uploaded documents.
- AI extraction requests.
- Financial transactions.

### 9.3 Background Processing

Document extraction should support asynchronous background processing.

Large documents and bulk uploads must not require users to maintain an active browser session until processing completes.

### 9.4 Reliability

The solution should provide:

- Appropriate error handling.
- Processing retries where applicable.
- Visibility into failed operations.
- Prevention or detection of duplicate processing.
- Reliable preservation of uploaded source documents.
- Monitoring and diagnostic logging.

### 9.5 Configuration

Important integration and processing parameters should be configurable rather than hardcoded.

Examples include:

- AI provider selection.
- AI model selection.
- Extraction processing strategy.
- Company-specific reporting settings.
- Integration credentials.
- Relevant document-processing parameters.

---

## 10. Initial Functional Scope (MVP)

The first implementation phase should focus on establishing the application's core capabilities.

**Confirmed MVP scope (v0.2):**

1. Web application foundation (TypeScript, Next.js + worker, Supabase; local development until MVP).
2. Organizations and Companies with self-service sign-up (Company details prefilled from ARES by IČO).
3. Email/password and Google sign-in.
4. TOTP MFA: optional per User, enforceable by an Organization Administrator, mandatory for SuperAdmin, with recovery codes.
5. Three predefined Roles (SuperAdmin, Administrator, User). Users can be members of multiple Companies.
6. Email invitations (7-day expiry, Role set at invite time).
7. Upload of PDF, images and Excel, single or batch (limits: 20 MB / 50 pages per file, 100 files per batch; configurable).
8. Original Source File storage and viewing.
9. Split → Extract pipeline: one Source File can contain multiple Documents, and users can correct the Split.
10. AI extraction via Anthropic and OpenAI behind a provider abstraction, with the model configurable per step. No dedicated OCR engine.
11. Extraction of header data and Rate Breakdown (no line items).
12. Automatic Direction detection from the Company's VAT ID or IČO.
13. Deterministic validations: arithmetic, valid CZ VAT rates, VAT ID and IČO format, required fields per VAT Regime, VAT payer registry (unreliable payer, published bank accounts).
14. Duplicate Warnings (counterparty VAT ID + document number + Direction, file hash).
15. Review workspace with immutable Extraction Versions and approval.
16. Czech VAT: domestic supplies, domestic reverse charge (§92a), EU acquisitions of goods and services. Other regimes get Manual Classification Required.
17. Foreign currency conversion at the ČNB rate for the Tax Point Date.
18. Credit notes as negative amounts with an optional reference to the original document.
19. VAT Return (DPHDP3) + Control Statement (DPHKH1) generation:
    - EPO XML export validated against XSD,
    - PDF preview of the VAT Return,
    - Excel export of the Reporting Period's Documents for checking before generation (non-approved or invalid Documents on a separate sheet),
    - drill-down from report lines to Documents.
20. Finalization by an Administrator with Period Lock.
21. AI configuration: platform-owned AI Configurations assigned by the SuperAdmin to one or more Companies; no Organization BYOK or Administrator-managed provider settings. New Companies receive enabled AI access through the default configuration and a lifetime allowance of 50 successful Extractions.
22. Metering of AI usage and allowance per Company and AI Configuration (no billing). Company Administrators see only allowance consumption and waiting-Document counts; complete request, token and provider details are SuperAdmin-only.
23. SuperAdmin console: Organizations and Companies, blocking, AI Configurations, usage, allowance, grouped operational problems and failed jobs with remediation. No impersonation.
24. Append-only audit log.
25. UI in Czech and English (i18n from day one).
26. Golden set of anonymized sample documents for automated extraction evaluation.

---

## 11. Future Enhancements

Potential later development phases may include:

- Advanced role and permission management.
- Additional AI providers and processing strategies.
- Secure Company Administrator-managed provider credentials.
- Official-form visual replica of the Control Statement PDF.
- Consistent dark mode.
- Email operational alerts for SuperAdmin.
- Automated document ingestion through email.
- ERP and accounting software integrations.
- Advanced document classification.
- Automated accounting entries.
- Advanced tax determination.
- Multi-country VAT reporting.
- Automated submission to tax authorities.
- Additional statutory tax reports.
- Workflow approvals and configurable approval chains.
- Reporting dashboards and analytics.
- Automated reconciliation and document matching.
- Advanced integration management.

These features are not committed to the initial release.

Concrete post-MVP items are tracked as GitHub Issues labelled `backlog` in Thomisso/iVAT.

---

## 12. Open Questions and Items to Be Defined

The following areas require additional business or technical specifications:

| Area | Open Question | Resolution (v0.2) |
|---|---|---|
| Tax Jurisdiction | Which country or countries will be supported initially? | Czech Republic only, VAT payers only (no identified persons). |
| VAT Reporting | What are the exact VAT return formats and validation rules? | DPHDP3 + DPHKH1; validation rules still to be specified in detail. |
| Technology Stack | Which frontend, backend, database, and hosting technologies will be selected? | TypeScript, Next.js + worker, PostgreSQL, pg-boss, Supabase (ADR-0002). |
| AI Integration | Which AI providers and models should be implemented first? | Anthropic and OpenAI; model configurable per pipeline step. |
| AI Credentials | Will users provide their own API keys or use centrally managed credentials? | Platform-owned AI Configurations assigned to Companies; no Organization BYOK in MVP (ADR-0011). |
| Document Extraction | What is the required structured data schema for each document type? | Header + Rate Breakdown; detailed schema still open. Line items post-MVP. |
| Document Workflow | Which review and approval states are required? | Uploaded → Processing → NeedsReview → Approved, plus Failed and Rejected. |
| Multi-Company Access | Can individual users belong to multiple companies? | Yes, with a Role per Membership. |
| External Integrations | Which ERP, accounting, or document systems are priorities? | None in MVP; public API and email ingestion are in the backlog. |
| Data Retention | What are the document retention and deletion policies? | 10 years; Approved Documents in locked periods cannot be deleted; Company deletion is a soft delete. |
| VAT Export | Which statutory filing and export formats are required? | EPO XML, PDF preview, Excel export. |
| Deployment | Will the platform be cloud-hosted, self-hosted, or both? | Cloud SaaS in the EU; local development until MVP. |
| Commercial Model | Will the application require subscriptions, usage limits, or billing? | No billing in MVP; successful Extractions consume a lifetime Company allowance and usage is metered per Company and AI Configuration. |
| Language Support | Which user interface languages are required? | Czech and English. |

---

## 13. Initial Acceptance Criteria

The initial implementation should be considered functionally successful when the following end-to-end scenario can be demonstrated:

1. A user registers and authenticates using a supported method.
2. A company administrator configures a company and grants user access.
3. An authorized user uploads an incoming or outgoing financial document.
4. The original document is securely stored and made available for viewing.
5. The platform processes the document using a configured extraction provider.
6. Relevant financial and tax data are extracted into structured fields.
7. The user reviews, corrects, and validates the extracted information.
8. The validated document becomes eligible for VAT reporting.
9. The user selects a company and VAT reporting period.
10. The platform generates a draft VAT report using eligible transactions.
11. Reporting amounts can be traced back to the underlying documents.
12. The VAT report can be reviewed and exported in an initially supported format.

The scenario must respect company data isolation and role-based access permissions.

---

## 14. Document Status and Next Steps

This document establishes the initial business and functional requirements for the Document Processing & VAT Reporting Platform.

It is intended to serve as a foundation for:

- Detailed functional specifications.
- Solution architecture design.
- Data model definition.
- User interface design.
- API and integration specifications.
- MVP planning and development.
- Testing and acceptance criteria.

**The specification will be progressively extended as additional business requirements, architectural decisions, and country-specific tax requirements become available.**

---

## 15. Decisions Summary (v0.2)

### 15.1 Product
- Target users: businesses handling their own VAT and accounting offices managing many client Companies.
- Tenancy: Organization → Companies → Memberships (ADR-0001). An Administrator Role exists at both Organization and Company level.
- Self-service sign-up creates an Organization; the registering user becomes its Administrator. The SuperAdmin can manage and block Organizations.

### 15.2 Document lifecycle
- `Uploaded → Processing → NeedsReview → Approved`, plus `Failed` (technical, retryable) and `Rejected` (excluded by a user). Queue states are internal.
- Every AI result requires human review; there is no automatic approval in MVP.
- Both Users and Administrators can approve Documents.

### 15.3 VAT logic
- AI extracts and proposes a VAT Regime. The deterministic Rules Engine assigns VAT Return lines and Control Statement sections (ADR-0003).
- Reporting Period assignment:
  - every Document, incoming or outgoing, by Tax Point Date (ADR-0012),
  - an incoming Document's input VAT can be moved to a later period through a Deferred Claim,
  - the Import Date (Source File upload date) is shown read-only and never decides the period.
- Each Company has a monthly or quarterly filing frequency with an effective-from date.
- Foreign currencies are converted at the ČNB rate for the Tax Point Date. Original amounts, the rate and its source are stored.
- Only an Administrator can finalize a VAT Report. Finalization locks the period (ADR-0007).

### 15.4 Not in MVP (see backlog)
- Single exchange rate (§38).
- Automatic credit note matching.
- EC Sales List (souhrnné hlášení).
- VIES validation.
- Import, export, exempt supplies, deduction coefficient.
- Supplementary returns.
- Public API, email ingestion.
- Apple and Microsoft sign-in.
- Dedicated OCR engine.
- Line items.
- Automatic approval.
- Self-hosting, billing.

**End of Requirements – Version 0.2**
