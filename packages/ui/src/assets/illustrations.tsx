import React from "react";

// A simple geometric signal-pulse illustration for the Local Exchange brand.
// No emoji, no glyph — a clean SVG in the system's color palette.
export function SignalPulse({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 120" fill="none" className={className} aria-hidden="true">
      {/* Source node */}
      <circle cx="40" cy="60" r="12" className="stroke-zinc-600" strokeWidth="2" fill="none" />
      {/* Topic node (center) */}
      <circle cx="100" cy="60" r="14" className="fill-indigo-600/20 stroke-indigo-500" strokeWidth="2" />
      <circle cx="100" cy="60" r="4" className="fill-indigo-400" />
      {/* Agent nodes */}
      <circle cx="145" cy="30" r="10" className="stroke-emerald-500/60" strokeWidth="2" fill="none" />
      <circle cx="145" cy="60" r="10" className="stroke-amber-500/60" strokeWidth="2" fill="none" />
      <circle cx="145" cy="90" r="10" className="stroke-purple-500/60" strokeWidth="2" fill="none" />
      {/* Connection lines */}
      <line x1="52" y1="60" x2="84" y2="60" className="stroke-zinc-700" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="114" y1="60" x2="134" y2="60" className="stroke-zinc-700" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="114" y1="55" x2="134" y2="32" className="stroke-zinc-700" strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="114" y1="65" x2="134" y2="88" className="stroke-zinc-700" strokeWidth="1.5" strokeDasharray="4 3" />
      {/* Pulse rings */}
      <circle cx="100" cy="60" r="22" className="stroke-indigo-500/20" strokeWidth="1" fill="none">
        <animate attributeName="r" from="14" to="28" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" from="0.5" to="0" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

// Empty state illustration: a quiet exchange diagram
export function EmptyExchange({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 80" fill="none" className={className} aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <React.Fragment key={i}>
          <circle cx={20 + i * 30} cy="25" r="8" className="stroke-zinc-800" strokeWidth="1.5" fill="none" />
          <circle cx={20 + i * 30} cy="55" r="8" className="stroke-zinc-800" strokeWidth="1.5" fill="none" />
          <line x1={20 + i * 30} y1="33" x2={20 + i * 30} y2="47" className="stroke-zinc-800" strokeWidth="1" strokeDasharray="3 3" />
        </React.Fragment>
      ))}
      <circle cx="65" cy="40" r="16" className="fill-zinc-900 stroke-zinc-700" strokeWidth="1.5" />
      <text x="65" y="44" textAnchor="middle" className="fill-zinc-600" fontSize="12" fontFamily="ui-monospace, monospace">?</text>
    </svg>
  );
}