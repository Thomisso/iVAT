/** Abstract paperwork only: no invented confidence, amounts or extraction evidence. */
export function AuthDocumentArt() {
  return <svg aria-hidden="true" focusable="false" className="auth-document-art" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
    <g transform="translate(-72 170) rotate(-6 180 260)">
      <rect x="15" y="36" width="325" height="545" rx="5" fill="#fff" stroke="#deded7" transform="rotate(15 180 260)" />
      <rect width="360" height="510" rx="5" fill="#fff" stroke="#deded7" />
      <g fill="#d1d1c8">
        <rect x="30" y="34" width="112" height="9" rx="4" /><rect x="238" y="34" width="90" height="9" rx="4" />
        <rect x="30" y="53" width="76" height="5" rx="2" /><rect x="263" y="53" width="65" height="5" rx="2" />
      </g>
      <g stroke="#e4e4de" strokeWidth="1"><path d="M30 86h298M30 258h298M30 280h298M30 372h298" /></g>
      <g fill="#e4e4de">
        {[108, 128, 148, 168].map((y, index) => <g key={y}><rect x="30" y={y} width={90 - index * 8} height="6" rx="3" /><rect x="200" y={y} width={118 - index * 10} height="6" rx="3" /></g>)}
        <rect x="30" y="202" width="298" height="25" rx="2" />
        {[240, 300, 322, 344, 397, 419, 441].map((y, index) => <g key={y}><rect x="30" y={y} width={110 + (index % 3) * 27} height="6" rx="3" /><rect x="240" y={y} width={70 - (index % 3) * 8} height="6" rx="3" /></g>)}
      </g>
      <g fill="#FFE066" fillOpacity=".25" stroke="#A77C00" strokeOpacity=".6"><rect x="195" y="143" width="125" height="17" rx="3" /><rect x="235" y="391" width="80" height="17" rx="3" /></g>
      <path d="M0 270h360" stroke="#FFE066" strokeWidth="12" opacity=".45" /><path d="M0 270h360" stroke="#A77C00" opacity=".55" />
    </g>
    <g transform="translate(1150 210) rotate(7 130 210)">
      <path d="M0 5Q0 0 5 0h250q5 0 5 5v402l-13 10-13-8-13 8-13-8-13 8-13-8-13 8-13-8-13 8-13-8-13 8-13-8-13 8-13-8-13 8-13-8-13 8-13-8-13 8L0 407Z" fill="#fff" stroke="#deded7" />
      <g fill="#d1d1c8"><rect x="78" y="31" width="104" height="9" rx="4" /><rect x="91" y="49" width="78" height="5" rx="2" /><rect x="96" y="62" width="68" height="5" rx="2" /></g>
      <path d="M25 83h210" stroke="#deded7" strokeDasharray="4 5" />
      <g fill="#e1e1da">{[107, 129, 151, 173, 195, 217, 249, 271, 293].map((y, index) => <g key={y}><rect x="27" y={y} width={84 - (index % 3) * 13} height="6" rx="3" /><rect x="188" y={y} width={45 - (index % 3) * 5} height="6" rx="3" /></g>)}</g>
      <g fill="#FFE066" fillOpacity=".25" stroke="#A77C00" strokeOpacity=".6"><rect x="182" y="212" width="55" height="17" rx="3" /><rect x="178" y="286" width="59" height="17" rx="3" /></g>
      <g stroke="#d4d4cc" strokeWidth="2">{Array.from({ length: 45 }, (_, index) => <path key={index} d={`M${34 + index * 4.3} 337v39`} />)}</g>
    </g>
  </svg>;
}
