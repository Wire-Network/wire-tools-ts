import {
  ClusterReadinessCheckStatus,
  ClusterReadinessEndpointKind,
  type ClusterReadinessReport
} from "@wireio/cluster-tool-shared"

import {
  presentReadiness,
  ReadinessCheckLabels,
  readinessProofBoundary,
  type ReadinessAssetState,
  type ReadinessMissingItem
} from "./ReadinessPresentation.js"

const EndpointLabels: Record<ClusterReadinessEndpointKind, string> = {
  [ClusterReadinessEndpointKind.wire]: "WIRE",
  [ClusterReadinessEndpointKind.hyperion]: "HYPERION",
  [ClusterReadinessEndpointKind.ethereum]: "ETHEREUM",
  [ClusterReadinessEndpointKind.solana]: "SOLANA"
}

/** Render the stable readiness projection as a self-contained operator report. */
export class ReadinessHtmlRenderer {
  /** Create one HTML renderer for a completed readiness report. */
  constructor(private readonly report: ClusterReadinessReport) {}

  /** Return one offline-readable HTML document with inline styles and controls. */
  render(): string {
    const { report } = this,
      view = presentReadiness(report),
      ready = report.summary.featurePreflightReady,
      title = `WIRE ${report.feature.toUpperCase()} readiness`,
      collateralReady = view.collateral.filter(state => state.ready).length,
      custodyReady = view.custody.filter(state => state.ready).length,
      chainId =
        report.observedWireChainId ?? report.requestedWireChainId ?? "unknown"

    return [
      "<!doctype html>",
      `<html lang="en"><head><meta charset="utf-8">`,
      `<meta name="viewport" content="width=device-width,initial-scale=1">`,
      `<title>${esc(title)}</title>`,
      `<style>${Css}</style></head>`,
      `<body><header class="report-header ${ready ? "ready" : "blocked"}">`,
      `<p class="eyebrow">WIRE · ${esc(report.feature.toUpperCase())} READINESS</p>`,
      `<div class="headline"><h1>${ready ? "Read-only ready" : "Still blocked"}</h1>`,
      `<p>${report.summary.clusterLive ? "Cluster healthy" : "Cluster unhealthy"} · ` +
        `${view.readyRoutes.length}/${report.routes.length} routes preflight-ready · ` +
        `${view.transactionallyVerifiedRoutes.length} transactionally verified</p></div>`,
      `<p class="run-meta">${esc(report.generatedAt)} · ${(report.durationMs / 1_000).toFixed(1)}s · chain ${esc(chainId)}</p>`,
      `<nav><a href="#missing">Still missing</a><a href="#healthy">Healthy now</a>` +
        `<a href="#routes">Routes</a><a href="#checks">Granular checks</a></nav>`,
      `</header><main>`,
      `<section id="missing" class="missing"><div class="section-heading">`,
      `<p class="section-index">01</p><div><h2>Still missing on this cluster</h2>`,
      `<p>Verified configuration gaps only. Fix these before expecting every advertised route to pass preflight.</p></div></div>`,
      renderMissing(view.missing),
      `</section>`,
      `<section class="unproven"><div class="section-heading"><p class="section-index">02</p>`,
      `<div><h2>Not yet proven by this command</h2><p>These are explicit test boundaries, not inferred configuration failures.</p></div></div>`,
      `<ul class="plain-list"><li>Funded test-wallet balances, ERC-20 allowances, and required Solana token accounts are not inspected.</li>`,
      `<li>OPP circulation, terminal settlement, destination delivery, and SWAP_REVERT refunds require funded canaries.</li></ul>`,
      `</section>`,
      `<section id="healthy"><div class="section-heading"><p class="section-index">03</p>`,
      `<div><h2>Healthy now</h2><p>The current state that does not need to be rebuilt.</p></div></div>`,
      `<dl class="metrics">`,
      metric("Cluster", report.summary.clusterLive ? "Healthy" : "Unhealthy"),
      metric("Checks", `${view.passed.length}/${report.checks.length} passing`),
      metric(
        "Collateral",
        `${collateralReady}/${view.collateral.length} ready`
      ),
      metric("Custody", `${custodyReady}/${view.custody.length} ready`),
      metric(
        "Routes",
        `${view.readyRoutes.length}/${report.routes.length} ready`
      ),
      metric(
        "Settlement",
        `${view.transactionallyVerifiedRoutes.length} verified`
      ),
      `</dl>`,
      renderEndpoints(report),
      renderAssetTable("Collateral buckets", view.collateral),
      renderAssetTable("External custody reserves", view.custody),
      `</section>`,
      `<section id="routes"><div class="section-heading"><p class="section-index">04</p>`,
      `<div><h2>Route detail</h2><p>Live Hub-aligned quotes plus the exact infrastructure reason for each route verdict.</p></div></div>`,
      renderRoutes("Preflight-ready routes", view.readyRoutes, true),
      renderRoutes("Blocked routes", view.blockedRoutes, false),
      `</section>`,
      `<section id="checks"><div class="section-heading"><p class="section-index">05</p>`,
      `<div><h2>Granular checks</h2><p>Every assertion and its machine evidence. Failed checks open by default.</p></div></div>`,
      `<div class="check-controls"><button data-fold="expand">Expand all</button>` +
        `<button data-fold="collapse">Collapse all</button><button data-fold="failures">Failures only</button></div>`,
      report.checks.map(renderCheck).join(""),
      `</section>`,
      `<footer><strong>Proof boundary</strong><p>${esc(readinessProofBoundary(report))}</p>`,
      `<p class="final-verdict">${ready ? `${report.feature} read-only infrastructure preflight passed.` : `${report.feature} readiness is blocked; resolve the verified gaps above.`}</p></footer>`,
      `</main><script>${Script}</script></body></html>`
    ].join("\n")
  }
}

function renderMissing(items: ReadinessMissingItem[]): string {
  if (items.length === 0) {
    return `<p class="empty good">No verified configuration gaps.</p>`
  }
  return `<ol class="missing-list">${items
    .map(
      item =>
        `<li><span class="category">${esc(item.category)}</span>` +
        `<div><strong>${esc(item.label)}</strong><p>${esc(item.issues.join("; "))}</p>` +
        `${item.facts.length > 0 ? `<small>${esc(item.facts.join(" · "))}</small>` : ""}</div></li>`
    )
    .join("")}</ol>`
}

function metric(label: string, value: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
}

function renderEndpoints(report: ClusterReadinessReport): string {
  const rows = report.endpoints
    .map(
      endpoint =>
        `<tr><th>${esc(EndpointLabels[endpoint.kind])}</th><td>${esc(endpoint.url)}</td>` +
        `<td>${esc(endpoint.expectedChainId ?? "not declared")}</td><td>${esc(endpoint.source)}</td></tr>`
    )
    .join("")
  return (
    `<details class="data-section"><summary>Network group <span>${report.endpoints.length} endpoints</span></summary>` +
    `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Endpoint</th><th>Identity</th><th>Source</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div></details>`
  )
}

function renderAssetTable(
  title: string,
  states: ReadinessAssetState[]
): string {
  if (states.length === 0) return ""
  const ready = states.filter(state => state.ready).length,
    rows = states
      .map(
        state =>
          `<tr><td><span class="status ${state.ready ? "pass" : "fail"}">${state.ready ? "READY" : "MISSING"}</span></td>` +
          `<th>${esc(state.label)}</th><td>${esc(state.issues.join("; ") || "No issues")}</td>` +
          `<td>${esc(state.facts.join(" · "))}</td></tr>`
      )
      .join("")
  return (
    `<details class="data-section" open><summary>${esc(title)} <span>${ready}/${states.length} ready</span></summary>` +
    `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Asset</th><th>Issues</th><th>Evidence</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div></details>`
  )
}

function renderRoutes(
  title: string,
  routes: ClusterReadinessReport["routes"],
  open: boolean
): string {
  const rows = routes
    .map(
      route =>
        `<tr><th>${esc(route.source)} → ${esc(route.destination)}</th>` +
        `<td>${esc(route.quotedSourceAmount)}</td><td>${esc(route.quotedDestinationAmount)}</td>` +
        `<td>${esc(route.detail)}</td></tr>`
    )
    .join("")
  return (
    `<details class="data-section routes ${open ? "pass" : "fail"}"${open ? " open" : ""}>` +
    `<summary>${esc(title)} <span>${routes.length}</span></summary>` +
    (routes.length === 0
      ? `<p class="empty">None</p>`
      : `<div class="table-wrap"><table><thead><tr><th>Route</th><th>Source probe</th><th>Live quote</th><th>Verdict detail</th></tr></thead><tbody>${rows}</tbody></table></div>`) +
    `</details>`
  )
}

function renderCheck(check: ClusterReadinessReport["checks"][number]): string {
  const cls = check.status,
    evidence = check.evidence
      ? `<details class="evidence"><summary>Evidence</summary><pre>${esc(JSON.stringify(check.evidence, null, 2))}</pre></details>`
      : ""
  return (
    `<details class="check ${cls}"${check.status === ClusterReadinessCheckStatus.fail ? " open" : ""}>` +
    `<summary><span class="status ${cls}">${esc(check.status.toUpperCase())}</span>` +
    `<strong>${esc(ReadinessCheckLabels[check.id])}</strong>` +
    `<small>${check.blocking ? "blocking" : "advisory"}${check.reason ? ` · ${esc(check.reason)}` : ""}</small></summary>` +
    `<div class="check-body"><p>${esc(check.detail)}</p>${evidence}</div></details>`
  )
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const Css = `
  :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b0e11;color:#e8edf2;--line:#29313a;--muted:#91a0ae;--red:#ff655f;--green:#44d17a;--amber:#f2bd4b;--cyan:#58c7e8}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#0b0e11}a{color:inherit}
  .report-header{padding:3rem clamp(1.25rem,5vw,5rem) 2rem;border-bottom:1px solid var(--line)}
  .report-header.blocked{border-top:5px solid var(--red)}.report-header.ready{border-top:5px solid var(--green)}
  .eyebrow,.section-index,.category{font:700 .72rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .headline{display:flex;gap:2rem;align-items:end;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:1.4rem}
  h1{font-size:clamp(2.6rem,7vw,6rem);line-height:.92;letter-spacing:-.055em;margin:.5rem 0}.blocked h1{color:var(--red)}.ready h1{color:var(--green)}
  .headline p{max-width:34rem;margin:0 0 .4rem;color:#c5ced6;font-size:1.05rem}.run-meta{color:var(--muted);font:500 .78rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
  nav{display:flex;flex-wrap:wrap;gap:1.25rem;margin-top:1.4rem}nav a{text-decoration:none;color:#c5ced6;border-bottom:1px solid transparent;padding:.2rem 0}nav a:hover,nav a:focus{color:white;border-color:var(--cyan)}
  main{max-width:1440px;margin:auto;padding:0 clamp(1.25rem,5vw,5rem)}section{padding:3.5rem 0;border-bottom:1px solid var(--line)}
  .section-heading{display:grid;grid-template-columns:3rem minmax(0,1fr);gap:1rem;margin-bottom:1.75rem}.section-heading h2{font-size:clamp(1.7rem,3vw,2.8rem);letter-spacing:-.035em;margin:0}.section-heading p{margin:.5rem 0 0;color:var(--muted);max-width:52rem}
  .missing-list{list-style:none;padding:0;margin:0}.missing-list li{display:grid;grid-template-columns:8rem minmax(0,1fr);gap:1rem;padding:1rem 0;border-top:1px solid var(--line)}.missing-list li:last-child{border-bottom:1px solid var(--line)}
  .missing-list strong{font-size:1.02rem}.missing-list p{margin:.3rem 0;color:#ffd0ce}.missing-list small{color:var(--muted)}.missing .category{color:var(--red)}
  .unproven{border-left:3px solid var(--amber);padding-left:1.25rem}.plain-list{margin:0;padding-left:1.25rem}.plain-list li{margin:.55rem 0;color:#d8d0b8}
  .metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));margin:0 0 2rem;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.metrics div{padding:1rem;border-right:1px solid var(--line)}.metrics div:last-child{border-right:0}.metrics dt{color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}.metrics dd{margin:.35rem 0 0;font-weight:700}
  details.data-section,details.check{border-top:1px solid var(--line)}details.data-section:last-child,details.check:last-child{border-bottom:1px solid var(--line)}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
  .data-section>summary{display:flex;justify-content:space-between;padding:1rem 0;font-weight:700}.data-section>summary span{color:var(--muted);font-weight:500}.data-section>summary:hover,.check>summary:hover{color:var(--cyan)}
  .table-wrap{overflow:auto;padding-bottom:1rem}table{width:100%;border-collapse:collapse;font-size:.84rem}th,td{text-align:left;vertical-align:top;padding:.75rem;border-top:1px solid var(--line)}thead th{color:var(--muted);font-size:.68rem;text-transform:uppercase;letter-spacing:.08em}tbody th{min-width:13rem}.routes td:last-child{min-width:28rem;color:#c5ced6}
  .status{display:inline-block;font:700 .68rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em}.status.pass{color:var(--green)}.status.fail{color:var(--red)}.status.advisory{color:var(--amber)}
  .check-controls{display:flex;gap:.6rem;margin-bottom:1rem}.check-controls button{font:inherit;font-size:.8rem;background:transparent;color:#c5ced6;border:1px solid var(--line);padding:.45rem .75rem;cursor:pointer}.check-controls button:hover,.check-controls button:focus{border-color:var(--cyan);color:white}
  .check>summary{display:grid;grid-template-columns:5rem minmax(0,1fr) auto;gap:1rem;align-items:center;padding:.8rem 0}.check>summary small{color:var(--muted)}.check-body{padding:0 0 1rem 6rem}.check-body>p{margin:.25rem 0;color:#c5ced6}
  .evidence{margin-top:.75rem}.evidence summary{color:var(--muted);font-size:.8rem}.evidence pre{overflow:auto;white-space:pre-wrap;background:#11161b;padding:1rem;border-left:2px solid var(--line);font:500 .74rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
  .empty{color:var(--muted)}.empty.good{color:var(--green)}footer{padding:3rem 0 5rem}footer strong{text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--amber)}footer p{max-width:58rem;color:#c5ced6}.final-verdict{font-size:1.2rem;font-weight:700;color:white}
  @media(max-width:900px){.headline{display:block}.headline p{margin-top:1rem}.metrics{grid-template-columns:repeat(2,1fr)}.metrics div:nth-child(2n){border-right:0}.missing-list li{grid-template-columns:1fr}.check>summary{grid-template-columns:4.5rem minmax(0,1fr)}.check>summary small{grid-column:2}.check-body{padding-left:5.5rem}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`

const Script = `
  (function(){
    var checks=function(){return document.querySelectorAll("#checks details.check")};
    document.querySelectorAll("[data-fold]").forEach(function(button){
      button.addEventListener("click",function(){
        var mode=button.getAttribute("data-fold");
        checks().forEach(function(item){
          item.open=mode==="expand"||(mode==="failures"&&item.classList.contains("fail"));
        });
      });
    });
  })();
`
