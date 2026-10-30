/** Vector reconstruction of page 1 of the published design_v2 PDF.
 * Keep all generated browser/app assets on this same silhouette and palette. */
const mark = `<rect width="128" height="128" rx="30" fill="#1F5F8B"/>
<path d="M29 28h17q4 0 3 4l-4 11q-.6 2-3 2H26q-4 0-3-4l4-11q.6-2 2-2Z" fill="#FFE066"/>
<path d="M35 62v31M58 73l15 20 24-51" fill="none" stroke="#fff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>`;

const wordmark = `<g fill="#1C1C1A">
<path d="M156 44h18v60h-18zM182 24h21l21 59 21-59h21l-31 80h-23z"/>
<path fill-rule="evenodd" d="M251 104l30-80h24l30 80h-21l-6-18h-30l-6 18Zm33-34h18l-9-27Z"/>
<path d="M340 24h70v18h-25v62h-20V42h-25Z"/>
</g>
<path d="M158 23h18q3 0 2 3l-4 12q-.5 2-3 2h-18q-3 0-2-3l4-12q.5-2 3-2Z" fill="#FFE066" stroke="#A77C00" stroke-width="1.5"/>`;

export const brandMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${mark}</svg>`;
export const brandLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 410 128">${mark}${wordmark}</svg>`;
