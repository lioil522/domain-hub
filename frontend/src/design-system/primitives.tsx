import type React from "react";

export function Section(props: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold text-content-primary mb-1">{props.title}</h2>
      {props.desc && <p className="text-xs text-content-muted mb-4">{props.desc}</p>}
      {!props.desc && <div className="mb-4" />}
      {props.children}
    </section>
  );
}

export function Swatch(props: { name: string; varName: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`h-10 rounded-md border border-border-base ${props.className}`} />
      <span className="text-[11px] text-content-secondary font-medium">{props.name}</span>
      <code className="text-[10px] text-content-muted font-mono">{props.varName}</code>
    </div>
  );
}
