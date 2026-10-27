# AiValue

One extracted field in the review panel, showing who authored it; pass `label`, `value` (or children), `state`, `confidence`, `source`, `mono` and `active`.

- `proposed`: the AI read it and no one has checked it. Marker-tinted background, ochre underline, confidence pips, and the page it came from (`p. 1`).
- A proposed value with Low confidence turns `warning` and must be looked at.
- `edited`: a human changed the AI's value; this becomes a new Extraction Version authored by the User.
- `approved`: confirmed by a human; plain ink with a green check. Approval is what removes the marker.
- `active` outlines the field while its region is highlighted on the page in the DocumentViewer. Hovering a field activates its region and vice versa.
