import Link from "next/link";
import { useTranslations } from "next-intl";
import styles from "./visual-prototype.module.css";

export type PrototypeScreen =
  | "overview"
  | "upload"
  | "documents"
  | "review"
  | "vat"
  | "vat-output"
  | "settings";

type IconName =
  | "alert"
  | "arrow"
  | "camera"
  | "check"
  | "chevron"
  | "clock"
  | "document"
  | "gear"
  | "home"
  | "refresh"
  | "upload"
  | "vat";

const primaryScreens = [
  "overview",
  "upload",
  "documents",
  "vat",
  "settings",
] as const;

const navIcons: Record<(typeof primaryScreens)[number], IconName> = {
  overview: "home",
  upload: "upload",
  documents: "document",
  vat: "vat",
  settings: "gear",
};

const iconPaths: Record<IconName, string> = {
  alert: "M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3v.1",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  camera:
    "M4 7h3l1.5-2h7L17 7h3v12H4V7Zm8 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  check: "m5 12 4 4L19 6",
  chevron: "m9 6 6 6-6 6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
  document: "M6 3h8l4 4v14H6V3Zm8 0v5h5M9 12h6M9 16h6",
  gear:
    "M9.5 3h5l.6 2.4 2 .8 2.1-1.2 2.5 4.3-1.8 1.6.2 2.2 1.8 1.6-2.5 4.3-2.1-1.2-2 .8-.6 2.4h-5l-.6-2.4-2-.8-2.1 1.2-2.5-4.3 1.8-1.6-.2-2.2-1.8-1.6L4.8 5l2.1 1.2 2-.8L9.5 3Zm2.5 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  home: "M3 11 12 3l9 8v10h-6v-6H9v6H3V11Z",
  refresh: "M19 7V3l-2 2a8 8 0 1 0 2.2 8M19 3h-4",
  upload: "M12 16V4m-5 5 5-5 5 5M4 15v6h16v-6",
  vat: "M5 4h14v16H5V4Zm3 4h8M8 12h3m2 0h3m-8 4h3m2 0h3",
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24">
      <path d={iconPaths[name]} />
    </svg>
  );
}

function BrandMark() {
  return (
    <svg aria-hidden="true" className={styles.mark} viewBox="0 0 32 32">
      <path className={styles.markPaper} d="M4 4h10v15l2 3 3-3V4h9v19l-7 6H11l-7-6z" />
      <path className={styles.markCheck} d="m9 14 7 7 8-11" />
    </svg>
  );
}

function Status({ icon, label, tone }: { icon: IconName; label: string; tone: "active" | "danger" | "neutral" | "success" | "warning" }) {
  return <span className={`${styles.status} ${styles[tone]}`}><Icon name={icon} />{label}</span>;
}

function PageHeader({ action, description, title }: { action?: React.ReactNode; description: string; title: string }) {
  return <header className={styles.pageHeader}><div><h1>{title}</h1><p>{description}</p></div>{action}</header>;
}

function CompanyHeader() {
  const t = useTranslations("prototype");
  return <div className={styles.company}><span className={styles.companyInitial}>{t("company.initial")}</span><span><strong>{t("company.name")}</strong><small>{t("company.meta")}</small></span><Icon name="chevron" /></div>;
}

function LedgerRibbon() {
  const t = useTranslations("prototype.overview.ribbon");
  const stages = ["captured", "reading", "review", "report"] as const;
  return <ol aria-label={t("label")} className={styles.ribbon}>{stages.map((stage, index) => <li className={index === 1 ? styles.ribbonActive : undefined} key={stage}><span className={styles.ribbonMarker}>{index === 0 ? <Icon name="check" /> : index + 1}</span><span><strong>{t(`${stage}.title`)}</strong><small>{t(`${stage}.detail`)}</small></span></li>)}</ol>;
}

function OverviewScreen() {
  const t = useTranslations("prototype.overview");
  return <><PageHeader action={<Link className={styles.primaryButton} href="/prototype?screen=upload"><Icon name="upload" />{t("upload")}</Link>} description={t("description")} title={t("title")} /><LedgerRibbon /><div className={styles.overviewGrid}>
    <section className={styles.workPanel}><div className={styles.sectionHeading}><h2>{t("work.title")}</h2><span>{t("work.count")}</span></div>
      <Link className={styles.task} href="/prototype?screen=documents"><span className={styles.taskIconWarning}><Icon name="document" /></span><span><strong>{t("work.review.title")}</strong><small>{t("work.review.detail")}</small></span><strong className={styles.taskCount}>{t("work.review.count")}</strong><Icon name="chevron" /></Link>
      <Link className={styles.task} href="/prototype?screen=upload"><span className={styles.taskIconDanger}><Icon name="alert" /></span><span><strong>{t("work.failed.title")}</strong><small>{t("work.failed.detail")}</small></span><strong className={styles.taskCount}>{t("work.failed.count")}</strong><Icon name="chevron" /></Link>
      <Link className={styles.task} href="/prototype?screen=vat"><span className={styles.taskIconActive}><Icon name="vat" /></span><span><strong>{t("work.period.title")}</strong><small>{t("work.period.detail")}</small></span><Icon name="chevron" /></Link>
    </section>
    <aside aria-label={t("summaryLabel")} className={styles.sideStack}><section className={styles.processingCard} role="status"><div className={styles.sectionHeading}><h2>{t("processing.title")}</h2><Status icon="clock" label={t("processing.status")} tone="active" /></div><strong>{t("processing.batch")}</strong><p>{t("processing.detail")}</p><div aria-hidden="true" className={styles.activityLine}><span /></div></section><section className={styles.emptyCard}><Icon name="check" /><div><strong>{t("empty.title")}</strong><p>{t("empty.detail")}</p></div></section></aside>
  </div></>;
}

function Pipeline() {
  const t = useTranslations("prototype.upload.pipeline");
  const stages = ["received", "split", "extraction", "review"] as const;
  return <ol aria-label={t("label")} className={styles.pipeline}>{stages.map((stage, index) => <li className={index === 2 ? styles.pipelineActive : undefined} key={stage}><span className={styles.pipelineRail} /><span className={styles.pipelineDot}>{index < 2 ? <Icon name="check" /> : index === 2 ? <span className={styles.pulse} /> : null}</span><span><strong>{t(`${stage}.title`)}</strong><small>{t(`${stage}.detail`)}</small></span></li>)}</ol>;
}

function UploadScreen() {
  const t = useTranslations("prototype.upload");
  return <><PageHeader description={t("description")} title={t("title")} /><section className={styles.capturePanel}><div className={styles.captureCopy}><span className={styles.captureIcon}><Icon name="camera" /></span><div><h2>{t("capture.title")}</h2><p>{t("capture.detail")}</p></div></div><div className={styles.captureActions}><button className={styles.primaryButton} type="button"><Icon name="camera" />{t("capture.camera")}</button><button className={styles.secondaryButton} type="button"><Icon name="upload" />{t("capture.files")}</button></div></section>
    <div className={styles.uploadGrid}><section className={styles.batchCard} role="status"><div className={styles.sectionHeading}><div><h2>{t("batch.title")}</h2><p>{t("batch.meta")}</p></div><Status icon="clock" label={t("batch.active")} tone="active" /></div><Pipeline /><div className={styles.batchFooter}><span>{t("batch.footer")}</span><Link href="/prototype?screen=documents">{t("batch.review")}</Link></div></section>
    <section className={styles.fileList}><h2>{t("files.title")}</h2><article className={styles.fileRow}><span className={styles.filePreview}><Icon name="document" /></span><span><strong>{t("files.success.name")}</strong><small>{t("files.success.detail")}</small></span><Status icon="check" label={t("files.success.status")} tone="success" /></article><article className={styles.fileRow}><span className={styles.filePreview}><Icon name="document" /></span><span><strong>{t("files.error.name")}</strong><small>{t("files.error.detail")}</small></span><Status icon="alert" label={t("files.error.status")} tone="danger" /><button className={styles.textButton} type="button"><Icon name="refresh" />{t("files.error.retry")}</button></article></section></div>
  </>;
}

function QueueTabs() {
  const t = useTranslations("prototype.documents.tabs");
  const tabs = ["review", "incoming", "outgoing", "failed", "approved", "all"] as const;
  return <div aria-label={t("label")} className={styles.tabs} role="navigation">{tabs.map((tab, index) => <button aria-current={index === 0 ? "page" : undefined} key={tab} type="button">{t(tab)}{index === 0 && <span>{t("count")}</span>}</button>)}</div>;
}

function DocumentsScreen() {
  const t = useTranslations("prototype.documents");
  const rows = ["first", "second", "third", "failed"] as const;
  return <><PageHeader action={<span className={styles.queueProgress}>{t("progress")}</span>} description={t("description")} title={t("title")} /><QueueTabs /><section className={styles.tablePanel}><table><caption className="sr-only">{t("table.caption")}</caption><thead><tr><th>{t("table.counterparty")}</th><th>{t("table.number")}</th><th>{t("table.date")}</th><th>{t("table.amount")}</th><th>{t("table.status")}</th><th><span className="sr-only">{t("table.action")}</span></th></tr></thead><tbody>{rows.map((row, index) => <tr key={row}><td data-label={t("table.counterparty")}><strong>{t(`rows.${row}.counterparty`)}</strong><small>{t(`rows.${row}.direction`)}</small></td><td className={styles.mono} data-label={t("table.number")}>{t(`rows.${row}.number`)}</td><td data-label={t("table.date")}>{t(`rows.${row}.date`)}</td><td className={styles.amount} data-label={t("table.amount")}>{t(`rows.${row}.amount`)}</td><td data-label={t("table.status")}><Status icon={index === 3 ? "alert" : "clock"} label={t(`rows.${row}.status`)} tone={index === 3 ? "danger" : "warning"} /></td><td><Link aria-label={t("table.open", { counterparty: t(`rows.${row}.counterparty`) })} href={index === 0 ? "/prototype?screen=review" : "/prototype?screen=documents"}><Icon name="chevron" /></Link></td></tr>)}</tbody></table></section></>;
}

function ReviewScreen() {
  const t = useTranslations("prototype.review");
  const items = ["alpha", "beta", "gamma", "delta"] as const;
  return <div className={styles.reviewScreen}><header className={styles.reviewHeader}><Link className={styles.backLink} href="/prototype?screen=documents"><Icon name="arrow" />{t("back")}</Link><strong>{t("progress")}</strong><div className={styles.reviewNavigation}><button aria-label={t("previous")} className={styles.iconButton} type="button"><Icon name="chevron" /></button><button aria-label={t("next")} className={styles.iconButton} type="button"><Icon name="chevron" /></button></div></header>
    <aside aria-label={t("queue")} className={styles.reviewQueue}><h2>{t("queue")}</h2>{items.map((item, index) => <button aria-current={index === 0 ? "true" : undefined} key={item} type="button"><span><strong>{t(`items.${item}.name`)}</strong><small>{t(`items.${item}.number`)}</small></span><span className={styles.amount}>{t(`items.${item}.amount`)}</span></button>)}</aside>
    <section aria-label={t("preview.label")} className={styles.documentDesk}><div className={styles.documentPage}><span className={styles.invoiceLabel}>{t("preview.invoice")}</span><strong className={styles.invoiceBrand}>{t("preview.supplier")}</strong><div className={styles.invoiceRule} /><dl><div><dt>{t("preview.numberLabel")}</dt><dd>{t("preview.number")}</dd></div><div><dt>{t("preview.dateLabel")}</dt><dd>{t("preview.date")}</dd></div><div><dt>{t("preview.customerLabel")}</dt><dd>{t("preview.customer")}</dd></div></dl><div className={styles.invoiceLines}><span>{t("preview.item")}</span><strong>{t("preview.net")}</strong><span>{t("preview.vat")}</span><strong>{t("preview.vatAmount")}</strong></div><p className={styles.invoiceTotal}>{t("preview.total")}</p></div></section>
    <aside aria-label={t("title")} className={styles.reviewForm}><div className={styles.sectionHeading}><div><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Status icon="clock" label={t("status")} tone="warning" /></div><label><span>{t("fields.direction")}</span><select defaultValue="incoming"><option value="incoming">{t("fields.incoming")}</option></select></label><label><span>{t("fields.counterparty")}</span><input defaultValue={t("fields.counterpartyValue")} /></label><div className={styles.formPair}><label><span>{t("fields.vatId")}</span><input className={styles.mono} defaultValue={t("fields.vatIdValue")} /></label><label><span>{t("fields.date")}</span><input defaultValue={t("fields.dateValue")} /></label></div><label><span>{t("fields.regime")}</span><select defaultValue="domestic"><option value="domestic">{t("fields.regimeValue")}</option></select></label><section className={styles.warningBox}><Icon name="alert" /><div><strong>{t("warning.title")}</strong><p>{t("warning.detail")}</p></div></section><div className={styles.reviewActions}><button className={styles.secondaryButton} type="button">{t("reject")}</button><button className={styles.primaryButton} type="button"><Icon name="check" />{t("approve")}</button></div></aside>
  </div>;
}

function VatSubnav({ active }: { active: "output" | "processing" }) {
  const t = useTranslations("prototype.vat.subnav");
  return <nav aria-label={t("label")} className={styles.subnav}><Link aria-current={active === "processing" ? "page" : undefined} href="/prototype?screen=vat">{t("processing")}</Link><Link aria-current={active === "output" ? "page" : undefined} href="/prototype?screen=vat-output">{t("return")}</Link><Link href="/prototype?screen=vat-output">{t("statement")}</Link></nav>;
}

function VatScreen() {
  const t = useTranslations("prototype.vat");
  return <><PageHeader description={t("description")} title={t("title")} /><VatSubnav active="processing" /><div className={styles.periodControls}><button aria-label={t("previous")} className={styles.iconButton} type="button"><Icon name="chevron" /></button><strong>{t("currentPeriod")}</strong><button aria-label={t("next")} className={styles.iconButton} type="button"><Icon name="chevron" /></button></div><div className={styles.periodGrid}>
    <section className={styles.readinessPanel}><div className={styles.readinessHero}><span className={styles.readinessIcon}><Icon name="alert" /></span><div><h2>{t("readiness.title")}</h2><p>{t("readiness.detail")}</p></div><Status icon="alert" label={t("readiness.blockers")} tone="danger" /></div><ul className={styles.findingList}><li><span className={styles.findingDanger}><Icon name="alert" /></span><span><strong>{t("readiness.unreviewed.title")}</strong><small>{t("readiness.unreviewed.detail")}</small></span><Link href="/prototype?screen=documents">{t("readiness.open")}</Link></li><li><span className={styles.findingDanger}><Icon name="alert" /></span><span><strong>{t("readiness.failed.title")}</strong><small>{t("readiness.failed.detail")}</small></span><Link href="/prototype?screen=upload">{t("readiness.open")}</Link></li><li><span className={styles.findingWarning}><Icon name="clock" /></span><span><strong>{t("readiness.warning.title")}</strong><small>{t("readiness.warning.detail")}</small></span><Status icon="clock" label={t("readiness.warning.label")} tone="warning" /></li></ul></section>
    <aside aria-label={t("snapshot.title")} className={styles.snapshotCard}><span className={styles.snapshotLabel}>{t("snapshot.label")}</span><h2>{t("snapshot.title")}</h2><p>{t("snapshot.detail")}</p><dl><div><dt>{t("snapshot.documents")}</dt><dd>{t("snapshot.documentsValue")}</dd></div><div><dt>{t("snapshot.output")}</dt><dd>{t("snapshot.outputValue")}</dd></div><div><dt>{t("snapshot.status")}</dt><dd><Status icon="clock" label={t("snapshot.statusValue")} tone="neutral" /></dd></div></dl><button className={styles.primaryButton} disabled type="button">{t("snapshot.action")}</button></aside>
    </div><section className={styles.periodHistory}><div className={styles.sectionHeading}><h2>{t("history.title")}</h2><Link href="/prototype?screen=vat-output">{t("history.all")}</Link></div><div><span><strong>{t("history.august")}</strong><small>{t("history.augustDetail")}</small></span><Status icon="check" label={t("history.finalized")} tone="success" /><strong className={styles.amount}>{t("history.augustAmount")}</strong></div><div><span><strong>{t("history.july")}</strong><small>{t("history.julyDetail")}</small></span><Status icon="check" label={t("history.finalized")} tone="success" /><strong className={styles.amount}>{t("history.julyAmount")}</strong></div></section>
  </>;
}

function VatOutputScreen() {
  const t = useTranslations("prototype.vatOutput");
  return <><PageHeader description={t("description")} title={t("title")} /><VatSubnav active="output" /><div className={styles.outputGrid}><section className={styles.returnPanel}><div className={styles.returnSummary}><span><small>{t("summary.output")}</small><strong>{t("summary.outputValue")}</strong></span><span><small>{t("summary.input")}</small><strong>{t("summary.inputValue")}</strong></span><span><small>{t("summary.payable")}</small><strong>{t("summary.payableValue")}</strong></span></div><table><caption className="sr-only">{t("table.caption")}</caption><thead><tr><th>{t("table.line")}</th><th>{t("table.base")}</th><th>{t("table.vat")}</th></tr></thead><tbody><tr><td><strong>{t("table.lineOne")}</strong><small>{t("table.lineOneDetail")}</small></td><td className={styles.amount}>{t("table.lineOneBase")}</td><td className={styles.amount}>{t("table.lineOneVat")}</td></tr><tr><td><strong>{t("table.lineTwo")}</strong><small>{t("table.lineTwoDetail")}</small></td><td className={styles.amount}>{t("table.lineTwoBase")}</td><td className={styles.amount}>{t("table.lineTwoVat")}</td></tr></tbody></table></section><aside aria-label={t("export.title")} className={styles.exportCard}><Status icon="alert" label={t("export.status")} tone="warning" /><h2>{t("export.title")}</h2><p>{t("export.detail")}</p><code>{t("export.filename")}</code><button className={styles.secondaryButton} type="button"><Icon name="document" />{t("export.download")}</button><div className={styles.exportRule} /><strong>{t("export.finalizeTitle")}</strong><p>{t("export.finalizeDetail")}</p><button className={styles.primaryButton} type="button"><Icon name="check" />{t("export.finalize")}</button></aside></div></>;
}

function SettingsScreen() {
  const t = useTranslations("prototype.settings");
  const sections = ["profile", "export", "processing", "users"] as const;
  return <><PageHeader description={t("description")} title={t("title")} /><div className={styles.settingsGrid}>{sections.map((section, index) => <Link href="/prototype?screen=settings" key={section}><span className={styles.settingIcon}><Icon name={index === 2 ? "gear" : index === 3 ? "home" : "document"} /></span><span><strong>{t(`${section}.title`)}</strong><small>{t(`${section}.detail`)}</small></span><Status icon={index < 2 ? "check" : "clock"} label={t(index < 2 ? "complete" : "attention")} tone={index < 2 ? "success" : "warning"} /><Icon name="chevron" /></Link>)}</div></>;
}

function destinationFor(screen: PrototypeScreen) {
  if (screen === "review") return "documents";
  if (screen === "vat-output") return "vat";
  return screen;
}

export function VisualPrototype({ screen }: { screen: PrototypeScreen }) {
  const t = useTranslations("prototype");
  const destination = destinationFor(screen);
  return <div className={`${styles.shell} ${screen === "review" ? styles.reviewShell : ""}`}><a className={styles.skipLink} href="#main-content">{t("skip")}</a><aside aria-label={t("navigation.sidebar")} className={styles.sidebar}><Link aria-label={t("brandLabel")} className={styles.brand} href="/prototype?screen=overview"><BrandMark /><span>{t("brand")}</span></Link><CompanyHeader /><nav aria-label={t("navigation.label")} className={styles.navigation}>{primaryScreens.map((item) => <Link aria-current={destination === item ? "page" : undefined} aria-label={t(`navigation.${item}`)} href={`/prototype?screen=${item}`} key={item}><Icon name={navIcons[item]} /><span>{t(`navigation.${item}`)}</span>{item === "documents" && <small>{t("navigation.documentCount")}</small>}</Link>)}</nav><div className={styles.profile}><span>{t("profile.initials")}</span><span><strong>{t("profile.name")}</strong><small>{t("profile.role")}</small></span></div></aside><header className={styles.mobileHeader}><Link aria-label={t("brandLabel")} className={styles.brand} href="/prototype?screen=overview"><BrandMark /><span>{t("brand")}</span></Link><CompanyHeader /></header><main className={screen === "review" ? styles.mainReview : styles.main} id="main-content">{screen === "overview" && <OverviewScreen />}{screen === "upload" && <UploadScreen />}{screen === "documents" && <DocumentsScreen />}{screen === "review" && <ReviewScreen />}{screen === "vat" && <VatScreen />}{screen === "vat-output" && <VatOutputScreen />}{screen === "settings" && <SettingsScreen />}</main></div>;
}
