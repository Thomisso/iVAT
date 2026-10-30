# Brand and authentication frame

The original six-page [logo and login reference](../design-system/design_v2/iVAT%20%E2%80%93%20logo%20a%20p%C5%99ihla%C5%A1ovac%C3%AD%20obrazovka.pdf)
is carried from the published `docs/qa-v5-requirements` branch. Pages 1/2/4 govern
the mark, light desktop login and light mobile login. Page 6 is the workspace
reference for the separate shared-workspace styling ticket.

The PDF contains raster artwork. `src/lib/brand-art.ts` reconstructs its rounded
blue iV tile, yellow slanted mark and outlined wordmark as small, font-independent
SVG paths. The palette is #1F5F8B/#FFE066/#A77C00/#1C1C1A/#F6F6F3. Existing Geist
and Geist Mono text roles and semantic success/warning/error colours remain.

Run `npm run brand:assets` to regenerate the shared public SVGs and Next metadata
assets from that one source. The ICO embeds actual 16/32/48px PNG frames; the
Apple icon is 180px and the additional app icon 512px. Keep these exact static
paths in the proxy's public-asset bypass so anonymous and pending-MFA sessions
can render them without authentication redirects.

`FocusedShell` retains its actions/children interface and main-content/card hooks
for login, invitations, MFA, personal security and Company setup. It puts the
shared brand inside the centered white card, language/actions at the top right,
and abstract document sheets beyond the card on desktop. Those sheets are
aria-hidden, contain no invented values or confidence labels, and disappear
below 1024px. Smaller screens use the simple light frame with normal scrolling.
Recovery pages using the existing auth layout inherit this frame when integrated.

The reference's registration and Google examples do not authorize new workflows:
public signup stays closed, Google remains conditional on usable configuration,
and the deployed release label remains the same compiled identity. No dark theme
is introduced. `e2e/brand-auth.spec.ts` checks actual assets, accessibility, keyboard
focus, CS/EN, dark-system light rendering and 360/720/1024/1440px layouts; visual
reference comparison and actual-size icon inspection complement those assertions.
