# DocumentViewer

A Source File page shown as paper on a desk, with the regions the AI read; pass `regions` (`id`, `x`, `y`, `w`, `h` in percent, `tag`, `active`), `scanning`, `toolbar`, `label` and the page content as children.

- The page is `paper` in both themes: scans keep their real colours and the dark theme dims rather than inverts them.
- Each extracted value has a region in `ai-mark` at 45 % with an `ai-edge` outline. The active region (the field under the cursor in the review panel) gets a tag with the field name.
- `scanning` runs one scan line down the page while Extraction runs (1.6 s per pass, still under reduced motion).
- Place it left of the review panel (AiValue fields, `review-panel` width). On narrow screens the panel stacks under the page.
- The consumer renders the page itself (PDF canvas or `<img>`) as children; the component positions the overlays.
