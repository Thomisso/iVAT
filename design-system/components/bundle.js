/* @ds-bundle: {"format":4,"namespace":"iVAT","components":[{"name":"Icon"},{"name":"Button"},{"name":"TextField"},{"name":"StatusBadge"},{"name":"Confidence"},{"name":"Money"},{"name":"AiValue"},{"name":"AiSuggestion"},{"name":"AskBar"},{"name":"DataTable"},{"name":"DropZone"},{"name":"DocumentViewer"},{"name":"Sidebar"},{"name":"Notice"},{"name":"EmptyState"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }

  // 16px stroke icons drawn for iVAT: 1.5 stroke, round joins, currentColor.
  var ICONS = {
    check: ["M3.5 8.5l3 3 6-7"],
    alert: ["M8 2.5l6 11H2z", "M8 6.5v3", "M8 11.6v.01"],
    info: ["M8 14a6 6 0 100-12 6 6 0 000 12z", "M8 7.5V11", "M8 5v.01"],
    error: ["M8 14a6 6 0 100-12 6 6 0 000 12z", "M6 6l4 4", "M10 6l-4 4"],
    marker: ["M10.5 2.5l3 3-6 6h-3v-3z", "M8.5 4.5l3 3", "M2 14h7"],
    upload: ["M8 10.5V2.5", "M5 5.5l3-3 3 3", "M2.5 10.5v3h11v-3"],
    file: ["M4 1.5h5l3 3v10H4z", "M9 1.5v3h3"],
    search: ["M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z", "M10.5 10.5l3 3"],
    lock: ["M4.5 7h7a1 1 0 011 1v5a1 1 0 01-1 1h-7a1 1 0 01-1-1V8a1 1 0 011-1z", "M5.5 7V5a2.5 2.5 0 015 0v2"],
    chevron: ["M4 6l4 4 4-4"],
    duplicate: ["M6 5h7a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H6a.5.5 0 01-.5-.5v-8A.5.5 0 016 5z", "M3.5 11V2.5h7"],
    inbox: ["M2 9.5h3.5l1 2h3l1-2H14", "M2 9.5L4 3h8l2 6.5V13H2z"],
    send: ["M2 8l12-5.5-4.5 12-2-5z", "M7.5 9.5L14 2.5"],
    report: ["M3.5 1.5h9v13h-9z", "M6 5h4", "M6 8h4", "M6 11h2"],
    building: ["M3 14V2.5h7V14", "M10 6h3v8", "M1.5 14h13", "M5.5 5h2", "M5.5 8h2", "M5.5 11h2"],
    split: ["M2.5 8h11", "M4 2.5h8v3H4z", "M4 10.5h8v3H4z"],
    arrow: ["M8 13V3", "M4 7l4-4 4 4"],
    clock: ["M8 14a6 6 0 100-12 6 6 0 000 12z", "M8 4.5V8l2.5 1.5"]
  };

  function Icon(props) {
    var size = props.size || 16;
    var paths = ICONS[props.name] || ICONS.file;
    return h("svg", { className: cx("iv-icon", props.className), width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": props.label ? undefined : true, role: props.label ? "img" : undefined, "aria-label": props.label },
      paths.map(function (d, i) { return h("path", { key: i, d: d }); }));
  }

  function Button(props) {
    var variant = props.variant || "secondary", size = props.size || "md";
    var rest = Object.assign({}, props);
    delete rest.variant; delete rest.size; delete rest.icon; delete rest.children; delete rest.className;
    return h("button", Object.assign({ type: "button" }, rest, { className: cx("iv-btn", variant !== "secondary" && "iv-btn-" + variant, size === "sm" && "iv-btn-sm", props.className) }),
      props.icon ? h(Icon, { name: props.icon }) : null, props.children);
  }

  var fieldSeq = 0;
  function TextField(props) {
    var idRef = React.useRef(null);
    if (!idRef.current) idRef.current = props.id || "iv-field-" + (++fieldSeq);
    var id = idRef.current;
    var rest = Object.assign({}, props);
    ["label", "hint", "error", "mono", "id", "className"].forEach(function (k) { delete rest[k]; });
    var describedBy = props.error ? id + "-err" : props.hint ? id + "-hint" : undefined;
    return h("div", { className: cx("iv-field", props.error && "is-invalid", props.className) },
      h("label", { className: "iv-field-label", htmlFor: id }, props.label),
      h("input", Object.assign({ id: id, className: cx("iv-input", props.mono && "iv-mono"), "aria-invalid": props.error ? true : undefined, "aria-describedby": describedBy }, rest)),
      props.error ? h("span", { id: id + "-err", className: "iv-field-error", role: "alert" }, h(Icon, { name: "error", size: 14 }), props.error)
        : props.hint ? h("span", { id: id + "-hint", className: "iv-field-hint" }, props.hint) : null);
  }

  // The Document lifecycle, in the glossary's words.
  var STATUSES = {
    uploaded: { tone: "", icon: "file", label: "Uploaded" },
    splitting: { tone: "ai", icon: "split", label: "Splitting" },
    extracting: { tone: "ai", icon: "marker", label: "Extracting" },
    proposed: { tone: "ai", icon: "marker", label: "AI proposed" },
    "needs-review": { tone: "warning", icon: "alert", label: "Needs review" },
    duplicate: { tone: "warning", icon: "duplicate", label: "Duplicate warning" },
    manual: { tone: "danger", icon: "alert", label: "Manual classification required" },
    failed: { tone: "danger", icon: "error", label: "Extraction failed" },
    approved: { tone: "success", icon: "check", label: "Approved" },
    locked: { tone: "ink", icon: "lock", label: "Period locked" }
  };
  function StatusBadge(props) {
    var s = STATUSES[props.status] || STATUSES.uploaded;
    return h("span", { className: cx("iv-badge", s.tone && "iv-badge-" + s.tone) }, h(Icon, { name: s.icon, size: 14 }), props.children || s.label);
  }

  function confidenceLevel(v) { return v >= 0.95 ? "high" : v >= 0.8 ? "medium" : "low"; }
  function Confidence(props) {
    var v = Math.max(0, Math.min(1, props.value)), level = confidenceLevel(v);
    var on = level === "high" ? 3 : level === "medium" ? 2 : 1;
    var label = { high: "High", medium: "Medium", low: "Low" }[level];
    return h("span", { className: cx("iv-conf", "is-" + level), title: "AI confidence " + Math.round(v * 100) + " %" },
      h("span", { className: "iv-conf-pips", "aria-hidden": true }, [0, 1, 2].map(function (i) { return h("span", { key: i, className: cx("iv-conf-pip", i < on && "on") }); })),
      props.compact ? null : label + " · " + Math.round(v * 100) + " %");
  }

  // Czech money: narrow no-break space groups, decimal comma, true minus sign.
  function formatAmount(amount, locale) {
    var s = new Intl.NumberFormat(locale || "cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
    return (amount < 0 ? "−" : "") + s;
  }
  function Money(props) {
    var cur = props.currency === undefined ? "Kč" : props.currency;
    return h("span", { className: cx("iv-money", props.amount < 0 && "is-negative", props.className) },
      formatAmount(props.amount, props.locale), cur ? h("span", { className: "iv-money-cur" }, cur) : null);
  }

  function AiValue(props) {
    var state = props.state || "proposed";
    var low = state === "proposed" && props.confidence !== undefined && confidenceLevel(props.confidence) === "low";
    var labelIcon = state === "approved" ? h(Icon, { name: "check", size: 14, label: "Approved" })
      : state === "edited" ? h("span", { className: "iv-badge", style: { height: 18 } }, "Edited")
      : h(Icon, { name: low ? "alert" : "marker", size: 14, label: low ? "Check this value" : "Proposed by AI" });
    return h("div", { className: cx("iv-aival", "is-" + (low ? "low" : state), props.active && "is-active") },
      h("div", { className: "iv-aival-label", style: { color: state === "proposed" ? (low ? "var(--warning)" : "var(--ai)") : undefined } }, labelIcon, props.label),
      h("div", { className: cx("iv-aival-value", props.mono && "iv-mono") }, props.children || props.value),
      h("div", { className: "iv-aival-meta" },
        state === "proposed" && props.confidence !== undefined ? h(Confidence, { value: props.confidence, compact: true }) : null,
        props.source ? h("span", { className: "iv-aival-src" }, props.source) : null));
  }

  function AiSuggestion(props) {
    return h("section", { className: "iv-sugg", "aria-label": "AI suggestion" },
      h("div", { className: "iv-sugg-head" }, h(Icon, { name: "marker", size: 14 }), props.eyebrow || "AI proposal"),
      h("h3", { className: "iv-sugg-title" }, props.title),
      props.reasons && props.reasons.length ? h("ul", { className: "iv-sugg-why" }, props.reasons.map(function (r, i) { return h("li", { key: i }, r); })) : null,
      props.children,
      h("div", { className: "iv-sugg-foot" },
        h(Button, { variant: "primary", size: "sm", icon: "check", onClick: props.onAccept }, props.acceptLabel || "Accept"),
        h(Button, { size: "sm", onClick: props.onChange }, props.changeLabel || "Change"),
        props.confidence !== undefined ? h(Confidence, { value: props.confidence }) : null));
  }

  function AskBar(props) {
    var id = props.id || "iv-ask";
    return h("div", { className: "iv-ask" },
      h("div", { className: "iv-ask-box" },
        h(Icon, { name: "marker" }),
        h("input", { id: id, type: "text", "aria-label": props.label || "Ask about this document", placeholder: props.placeholder || "Ask about this document", defaultValue: props.defaultValue }),
        h("span", { className: "iv-ask-kbd", "aria-hidden": true }, "⌘K"),
        h(Button, { variant: "primary", size: "sm", "aria-label": "Ask", icon: "arrow", style: { width: 28, padding: 0, borderRadius: 9999 } })),
      props.answer ? h("div", { className: "iv-ask-answer", "aria-live": "polite" },
        h("p", null, props.answer),
        props.citations ? h("div", { className: "iv-row" }, props.citations.map(function (c, i) { return h("span", { key: i, className: "iv-ask-cite" }, h(Icon, { name: "file", size: 12 }), c); })) : null) : null);
  }

  // columns: [{ key, header, align: "right", mono, render(row) }]
  function DataTable(props) {
    return h("div", { className: "iv-table-wrap" },
      h("table", { className: "iv-table" },
        props.caption ? h("caption", { style: { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } }, props.caption) : null,
        h("thead", null, h("tr", null, props.columns.map(function (c) { return h("th", { key: c.key, scope: "col", className: c.align === "right" ? "is-num" : undefined }, c.header); }))),
        h("tbody", null, props.rows.map(function (row) {
          return h("tr", { key: row.id, className: row.id === props.selectedId ? "is-selected" : undefined, "aria-selected": row.id === props.selectedId ? true : undefined },
            props.columns.map(function (c) {
              return h("td", { key: c.key, className: cx(c.align === "right" && "is-num", c.mono && "iv-mono", c.muted && "iv-muted") }, c.render ? c.render(row) : row[c.key]);
            }));
        }))));
  }

  function DropZone(props) {
    return h("label", { className: cx("iv-drop", props.over && "is-over"), tabIndex: 0 },
      h("span", { className: "iv-drop-icon" }, h(Icon, { name: "upload", size: 20 })),
      h("span", { className: "iv-drop-text" },
        h("span", { className: "iv-drop-title" }, props.title || "Drop invoices and receipts here"),
        h("span", { className: "iv-drop-hint" }, props.hint || "PDF, PNG or JPEG. The original is kept unchanged.")),
      h("input", { type: "file", accept: props.accept || ".pdf,.png,.jpg,.jpeg", multiple: true, hidden: true, onChange: props.onFiles }),
      h("span", { className: "iv-btn iv-btn-sm", "aria-hidden": true }, h(Icon, { name: "upload", size: 14 }), "Choose files"));
  }

  // regions: [{ id, x, y, w, h, tag, active }] in percent of the page.
  function DocumentViewer(props) {
    return h("div", { className: "iv-viewer" },
      props.toolbar ? h("div", { className: "iv-viewer-bar" }, props.toolbar) : null,
      h("div", { className: "iv-page", role: "img", "aria-label": props.label || "Source File page" },
        h("div", { className: "iv-page-content" }, props.children),
        (props.regions || []).map(function (r) {
          return h("div", { key: r.id, className: cx("iv-region", r.active && "is-active"), style: { left: r.x + "%", top: r.y + "%", width: r.w + "%", height: r.h + "%" } },
            r.tag && r.active ? h("span", { className: "iv-region-tag" }, r.tag) : null);
        }),
        props.scanning ? h("div", { className: "iv-scan", "aria-hidden": true }) : null));
  }

  // companies: [{ id, name, ico }]; items: [{ group?, label, icon, count, ai, current }]
  function Sidebar(props) {
    var c = props.company;
    return h("nav", { className: "iv-side", "aria-label": "Main" },
      h("div", { className: "iv-brand" }, h("b", { "aria-hidden": true }), "iVAT"),
      c ? h("button", { type: "button", className: "iv-company iv-btn", style: { height: "auto", justifyContent: "flex-start", textAlign: "left", fontWeight: 400 } },
        h(Icon, { name: "building" }),
        h("span", { className: "iv-company-text" }, h("span", { className: "iv-company-name" }, c.name), h("span", { className: "iv-company-id" }, "IČO " + c.ico)),
        h(Icon, { name: "chevron" })) : null,
      h("div", { className: "iv-nav" }, props.items.map(function (it, i) {
        if (it.group) return h("div", { key: i, className: "iv-nav-group" }, it.group);
        return h("a", { key: i, href: it.href || "#", className: "iv-nav-item", "aria-current": it.current ? "page" : undefined },
          h(Icon, { name: it.icon }), it.label,
          it.count !== undefined ? h("span", { className: cx("iv-nav-count", it.ai && "is-ai") }, it.count) : null);
      })));
  }

  var NOTICE_ICON = { info: "info", warning: "alert", danger: "error", success: "check" };
  function Notice(props) {
    var tone = props.tone || "info";
    return h("div", { className: cx("iv-notice", "iv-notice-" + tone), role: tone === "danger" ? "alert" : "status" },
      h(Icon, { name: NOTICE_ICON[tone] }), h("div", null, props.title ? h("strong", null, props.title, " ") : null, props.children));
  }

  function EmptyState(props) {
    return h("div", { className: "iv-empty" },
      props.icon ? h(Icon, { name: props.icon, size: 24 }) : null,
      h("p", { className: "iv-empty-title" }, props.title),
      props.children ? h("p", null, props.children) : null,
      props.action || null);
  }

  window.iVAT = Object.assign(window.iVAT || {}, {
    Icon: Icon, Button: Button, TextField: TextField, StatusBadge: StatusBadge, Confidence: Confidence, Money: Money,
    AiValue: AiValue, AiSuggestion: AiSuggestion, AskBar: AskBar, DataTable: DataTable, DropZone: DropZone,
    DocumentViewer: DocumentViewer, Sidebar: Sidebar, Notice: Notice, EmptyState: EmptyState,
    formatAmount: formatAmount, confidenceLevel: confidenceLevel
  });
})();
