/** App-owned, optional host presentation extension for the pinned Workbench kit.
 * The panel verifies the host origin/source before accepting it. Older hosts keep
 * the original side-panel view; document tabs keep the renderer's normal layout.
 */
export const STARK_PAGES_PRESENTATION_VERSION = 7;

export function adaptStarkPagesPanel(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error(
        "Stark Pages panel changed; review the document presentation/selection adaptation.",
      );
    source = source.replace(before, after);
  };
  replace(
    "agent: d.agent === 'codex' ? 'codex' : 'claude' };",
    "agent: d.agent === 'codex' ? 'codex' : 'claude', presentation: d.presentation === 'document' ? 'document' : 'panel', embeddedControls: d.embeddedControls === true, ...(typeof d.selectionToken === 'string' && /^[a-zA-Z0-9-]{16,128}$/.test(d.selectionToken) ? { selectionToken: d.selectionToken } : {}) };",
  );
  replace(
    "agent: 'claude' | 'codex' } | null}",
    "agent: 'claude' | 'codex', presentation: 'panel' | 'document', embeddedControls: boolean, selectionToken?: string } | null}",
  );
  replace(
    ".bar{display:flex;",
    `#folder-context{display:none}
.bar .title{display:none}
body[data-presentation="document"]{--bg:#101112;--fg:#dddcd7;--muted:#9ba196;--line:#363a37;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body[data-presentation="document"] .mark,body[data-presentation="document"] .title,body[data-presentation="document"] #pause,body[data-presentation="document"] #resume{display:none}
body[data-presentation="document"] .bar{min-height:55px;padding:10px 22px;gap:8px 12px}
body[data-presentation="document"] .line1{flex:1;min-width:0;gap:12px}
body[data-presentation="document"] #folder-context{display:block;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
body[data-presentation="document"] .chip{font:500 10px/1.4 var(--sans);text-transform:none;letter-spacing:0;border:1px solid #44483e;border-radius:5px;background:transparent;padding:3px 7px;color:#b8beab}
body[data-presentation="document"] .actions button,body[data-presentation="document"] .actions .btn{border-color:transparent;border-radius:7px;padding:8px 10px;color:#b7bcb0}
body[data-presentation="document"] #publish{background:#c4b483;color:#20241a}
body[data-embedded-controls="true"] .bar{display:none}
body[data-embedded-controls="true"] .bar:has(#publish:not([hidden]),#next:not([hidden])){display:flex;min-height:0;padding:6px 12px;justify-content:flex-end}
body[data-embedded-controls="true"] .line1,body[data-embedded-controls="true"] #pick,body[data-embedded-controls="true"] #open,body[data-embedded-controls="true"] #pause,body[data-embedded-controls="true"] #resume{display:none}
@media(prefers-color-scheme:light){body[data-presentation="document"]{--bg:#f7f7f3;--fg:#272a23;--muted:#636b5d;--line:#d6d9ce}body[data-presentation="document"] .actions button,body[data-presentation="document"] .actions .btn,body[data-presentation="document"] .chip{color:#636b5d}}
.bar{display:flex;`,
  );
  replace(
    '<span class="chip" id="status" hidden></span>',
    '<span class="chip" id="status" hidden></span><span id="folder-context"></span>',
  );
  replace(
    "  var frame = $('view');",
    "  var frame = $('view');\n  var presentation = 'panel';\n  var selectionToken = null;",
  );
  replace("'/?view=panel&rev='", "'/?' + (presentation === 'panel' ? 'view=panel&' : '') + 'rev='");
  replace(
    "      agent = m.agent;",
    "      agent = m.agent;\n      selectionToken = m.selectionToken || null;\n      document.body.setAttribute('data-embedded-controls', m.embeddedControls ? 'true' : 'false');\n      if (presentation !== m.presentation) {\n        presentation = m.presentation;\n        document.body.setAttribute('data-presentation', presentation);\n        $('pick').textContent = presentation === 'document' ? 'Page library' : 'Pages';\n        $('open').textContent = presentation === 'document' ? 'Open in browser' : 'Open';\n        $('folder-context').textContent = 'Local pages · ' + String(cfg.root || '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean).pop();\n        if (presentation === 'document') { setPaused(true); closeMenu(false); }\n        if (current) show(current);\n      }",
  );
  replace(
    "    if (paused) {\n      waiting = p;",
    "    if (presentation === 'document' && current && p.slug !== current.slug) return;\n    if (paused) {\n      waiting = p;",
  );
  replace(
    "$('next').textContent = 'New: ' +",
    "$('next').textContent = presentation === 'document' ? 'Update available' : 'New: ' +",
  );
  // Keep this optional bridge aligned with Workbench's panel protocol until the
  // next reviewed vendor refresh. The pinned payload otherwise has no selection API.
  replace(
    "    m.url = capText(b.url, 2048);\n  } else {",
    `    m.url = capText(b.url, 2048);
  } else if (type === 'selection') {
    if (typeof b.selectionToken !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(b.selectionToken)
      || typeof b.slug !== 'string' || !/^[a-z0-9-]{3,64}$/.test(b.slug)
      || typeof b.text !== 'string' || b.text.length > 8000) return null;
    if (b.tooLong === true && b.text !== '') return null;
    m.selectionToken = b.selectionToken;
    m.slug = b.slug;
    m.text = b.text;
    m.tooLong = b.tooLong === true;
  } else {`,
  );
  replace(
    "      if (d && d.addEventListener) {\n        d.addEventListener('click', function (e) {",
    `      if (d && d.addEventListener) {
        var selectedPage = current;
        function sendSelection() {
          if (!selectionToken || !selectedPage || current !== selectedPage || frame.contentDocument !== d) return;
          try {
            var selected = d.getSelection();
            var text = selected && !selected.isCollapsed ? selected.toString() : '';
            post('selection', { selectionToken: selectionToken, slug: selectedPage.slug, text: text.length <= 8000 ? text : '', tooLong: text.length > 8000 });
          } catch (e) { /* inaccessible page: no selection capability */ }
        }
        d.addEventListener('pointerup', sendSelection);
        d.addEventListener('keyup', sendSelection);
        d.addEventListener('click', function (e) {`,
  );
  return source;
}
