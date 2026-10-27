# Migration from the current UI

The current app (`src/app/globals.css`) has nine colour variables, a system font stack, 6px and 10px radii and plain element styles. This system keeps its blue, its warm greys, its radii and its danger red, and adds what an AI document ERP needs. Rename the variables as follows when porting.

## Tokens

| Current variable | Light / dark today | New token | Change |
| --- | --- | --- | --- |
| `--background` | `#f7f7f5` / `#141413` | `canvas` | Slightly warmer, dark a touch deeper. |
| `--surface` | `#ffffff` / `#1f1f1d` | `surface` | Dark moved to `#1a1c1b`. |
| `--foreground` | `#1c1c1a` / `#ececea` | `ink` | Unchanged. |
| `--muted` | `#6b6b66` / `#a3a39d` | `ink-muted` | Light darkened to `#62625c` to hold 4.5:1 on `surface-sunken`. |
| `--border` | `#dcdcd6` / `#55554f` | `line` and `line-strong` | Split: `line` for hairlines, `line-strong` (3:1) for control edges. The old value was below 3:1 on white as an input border. |
| `--accent` | `#1f5f8b` / `#6aa9d6` | `accent` | Unchanged. Adds `accent-hover` and `accent-soft`. |
| `--accent-foreground` | `#ffffff` / `#0d1b26` | `on-accent` | Unchanged. |
| `--danger` | `#b42318` / `#f97066` | `danger` | Unchanged. Adds `danger-soft`. |
| — | — | `ai`, `ai-soft`, `ai-mark`, `ai-edge`, `ink-on-mark` | New: the AI's colour. |
| — | — | `success`, `warning` and their `-soft` | New: Document states. |
| — | — | `surface-sunken`, `surface-raised`, `desk`, `paper` | New: table headers, popovers, the document viewer. |

The current dark theme is applied only through `prefers-color-scheme`. Add a `[data-theme="dark"]` block with the same values so a user setting can override the system.

## Classes and components

| Current | New |
| --- | --- |
| `.app-header` with inline Company links and `.language-switcher` | `Sidebar` with the Company switcher; the language switcher moves to the user menu. |
| `button`, `button[type="submit"]` element styles | `Button` (`primary` replaces the submit styling; explicit variants instead of element selectors). |
| `.form label` + `input` + `small` | `TextField` (`label`, `hint`, `error`, `mono`). |
| `.form-error` (`FormError`) | `TextField` `error` for one field; `Notice tone="danger"` for the form. Message keys in `messages/*.json` stay. |
| `.card` (auth pages) | A `surface` panel with `radius-lg` and `line` border; no shadow. |
| `.empty` | `EmptyState`. |
| `.upload-form` (`SourceFileUploadForm`) | `DropZone`. |
| `.source-files` table | `DataTable` with `StatusBadge` and `Money` columns. |
| `.source-file-viewer` (iframe / img) | `DocumentViewer`, with the PDF or image rendered as its child. |
| `.muted` | `ink-muted` / `iv-muted`. |
| `system-ui` font stack | Geist and Geist Mono via `next/font/google`. |
