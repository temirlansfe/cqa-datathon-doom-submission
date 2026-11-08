// Thin API client. The base URL is configurable so the UI can be hosted
// separately (e.g. as a Dynamics 365 HTML web resource).
const base = () => (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || "";

async function req(method, path, body, raw = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (raw) {
      opts.body = body;
      opts.headers["content-type"] = "application/json";
    } else {
      opts.body = JSON.stringify(body);
      opts.headers["content-type"] = "application/json";
    }
  }
  const r = await fetch(base() + path, opts);
  if (r.status === 401 && !base()) {
    // Google sign-in gate (nginx + oauth2-proxy): remember the screen, then sign in.
    try { sessionStorage.setItem("cqa.returnTo", location.hash); } catch { /* ignore */ }
    location.href = "/oauth2/sign_in?rd=" + encodeURIComponent("/");
    throw new Error("Требуется вход");
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    let msg = data && data.detail ? data.detail : `HTTP ${r.status}`;
    if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).join(".")}: ${d.msg}`).join("; ");
    throw new Error(msg);
  }
  return data;
}

const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return p.length ? "?" + new URLSearchParams(p).toString() : "";
};

export const api = {
  meta: () => req("GET", "/api/meta"),
  me: () => req("GET", "/api/me"),
  groups: () => req("GET", "/api/groups"),
  importGroup: (group_id, api_url) => req("POST", "/api/datasets/import", { group_id, api_url: api_url || null }),
  upload: (jsonText, group) => req("POST", "/api/datasets/upload" + qs({ group }), jsonText, true),

  conversations: (params = {}) => req("GET", "/api/conversations" + qs(params)),
  conversation: (id) => req("GET", `/api/conversations/${encodeURIComponent(id)}`),
  audioUrl: (id) => `${base()}/api/audio/${encodeURIComponent(id)}`,
  groundTruth: () => req("GET", "/api/ground-truth"),
  uploadGroundTruth: (group, text, note) =>
    req("POST", `/api/ground-truth?${new URLSearchParams({ group, ...(note ? { note } : {}) })}`, text, true),
  accuracy: (group, gtId) => req("GET", `/api/accuracy?${new URLSearchParams({ group, ...(gtId ? { gt_id: gtId } : {}) })}`),
  accuracyRun: (id, { gtId, compare } = {}) =>
    req("GET", `/api/accuracy/${id}?${new URLSearchParams({ ...(gtId ? { gt_id: gtId } : {}), ...(compare ? { compare } : {}) })}`),
  updateBatchNote: (id, note) => req("PATCH", `/api/batches/${id}`, { note }),
  radarRuns: (group) => req("GET", "/api/radar/runs" + qs({ group })),
  radarRun: (id) => req("GET", `/api/radar/runs/${id}`),
  startRadar: (group) => req("POST", "/api/radar/runs", { group }),
  radarTasks: () => req("GET", "/api/radar/tasks"),
  radarTask: (id) => req("GET", `/api/radar/tasks/${id}`),
  createRadarTask: (body) => req("POST", "/api/radar/tasks", body),
  setRadarTaskStatus: (id, status) => req("PATCH", `/api/radar/tasks/${id}`, { status }),

  checklists: () => req("GET", "/api/checklists"),
  checklist: (id) => req("GET", `/api/checklists/${id}`),
  activeChecklist: () => req("GET", "/api/checklists/active"),
  saveChecklist: (config, note, activate = true, source_appeal_id = null, base_checklist_id) =>
    req("POST", "/api/checklists", { config, note, activate, source_appeal_id, base_checklist_id }),
  activateChecklist: (id) => req("POST", `/api/checklists/${id}/activate`),
  ruleExamples: (id, criterion_id) => req("GET", `/api/checklists/${id}/rule-examples` + qs({ criterion_id })),
  addRuleExample: (id, body) => req("POST", `/api/checklists/${id}/rule-examples`, body),
  removeRuleExample: (id, criterion_id, conversation_id) =>
    req("DELETE", `/api/checklists/${id}/rule-examples` + qs({ criterion_id, conversation_id })),
  ruleCheck: (id, criterion_id) => req("GET", `/api/checklists/${id}/rule-check` + qs({ criterion_id })),
  runRuleCheck: (id, body) => req("POST", `/api/checklists/${id}/rule-check`, body),
  ruleSuggestions: (id) => req("GET", `/api/checklists/${id}/rule-suggestions`),
  suggestRule: (id, criterion_id) => req("POST", `/api/checklists/${id}/rule-suggestions`, { criterion_id }),

  evaluate: (conversation_id, checklist_id) => req("POST", "/api/evaluations", { conversation_id, checklist_id }),
  evaluation: (id) => req("GET", `/api/evaluations/${id}`),
  batch: (body) => req("POST", "/api/batches", body),
  batchStatus: (id) => req("GET", `/api/batches/${id}`),
  batches: () => req("GET", "/api/batches"),

  appeals: (status) => req("GET", "/api/appeals" + qs({ status })),
  appeal: (id) => req("GET", `/api/appeals/${id}`),
  createAppeal: (body) => req("POST", "/api/appeals", body),
  saveAppealCase: (id, body) => req("PATCH", `/api/appeals/${id}/case`, body),
  decide: (id, body) => req("POST", `/api/appeals/${id}/decision`, body),

  stats: (params = {}) => req("GET", "/api/stats" + qs(params)),
  exportUrl: (params = {}) => base() + "/api/export.csv" + qs(params),
};
