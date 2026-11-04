import * as NodeFS from "node:fs";

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Stark Pages renderer changed; review the local reading layout adaptation.");
  return source.replace(before, after);
}

/** Build-time extension of the pinned kit; never edits the source archive. */
export function adaptStarkPagesCss(source) {
  const css = NodeFS.readFileSync(new URL("./stark-pages-reader.css", import.meta.url), "utf8");
  return replaceOnce(
    source,
    "const RULES = `",
    `const READER_RULES = ${JSON.stringify(css)};\nconst RULES = \``,
  )
    .replace("${FONTS}${RULES}", "${FONTS}${RULES}${READER_RULES}")
    .replace("${RULES}${ALIGN_RULES}", "${RULES}${ALIGN_RULES}${READER_RULES}");
}

export function adaptStarkPagesRenderer(source) {
  return replaceOnce(
    source,
    "[type || 'page', status].filter(Boolean)",
    "[type || 'page', status === 'draft' ? '' : status].filter(Boolean)",
  );
}

export function adaptStarkPagesChrome(source) {
  return replaceOnce(
    source,
    "</style>",
    `
:root,body[data-presentation="document"]{--bg:#17191d;--fg:#eceef2;--muted:#a7afbc;--line:#343940;--display:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--sans:var(--display)}
.bar,body[data-presentation="document"] .bar{min-height:44px;padding:8px 16px;gap:8px 12px}
.label,.empty h1{font-family:var(--sans);text-transform:none;letter-spacing:0}
.label{font-size:12px;color:var(--muted)}
.mark{width:5px;height:5px;border-radius:50%}
#status{display:none}
button,.actions button,.actions .btn{border-radius:6px}
button:focus-visible,a:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
@media(prefers-color-scheme:light){:root,body[data-presentation="document"]{--bg:#fafbfc;--fg:#242a33;--muted:#596474;--line:#dbe0e6}}
</style>`,
  );
}
