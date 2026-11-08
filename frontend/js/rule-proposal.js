import { api } from "./api.js";
import { $, busy, esc, modal, toast } from "./util.js";

// Older versions stored multiple appeal IDs at the start of the version note.
export function versionSources(current) {
  const note = current.note?.trim() || "";
  const prefix = note.match(/^По апелляци(?:и|ям)\s+(#\d+(?:\s*,\s*#\d+)*)(?=\s*(?:·|$))\s*(?:·\s*)?/iu);
  const ids = (prefix?.[1].match(/\d+/g) || []).map(Number);
  return {
    note: prefix ? note.slice(prefix[0].length) : note,
    appealIds: [...new Set([current.source_appeal_id, ...ids].filter((id) => Number.isSafeInteger(id) && id > 0))],
  };
}

export async function latestRuleChecklist(source, versions) {
  const list = versions ?? await api.checklists();
  const [latest] = list.filter((version) => version.name === source.config.name)
    .sort((a, b) => b.version - a.version || b.id - a.id);
  return latest && latest.id !== source.id ? api.checklist(latest.id) : source;
}

export function sameRule(source, target, criterionId) {
  const original = source.config.criteria.find((criterion) => criterion.id === criterionId);
  const current = target.config.criteria.find((criterion) => criterion.id === criterionId);
  return Boolean(original && current && JSON.stringify(original) === JSON.stringify(current));
}

const normalized = (text) => (text || "").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");

function appendGuidance(criterion, addition) {
  if (!addition) throw new Error("Введите текст уточнения.");
  if (normalized(criterion.guidance).includes(normalized(addition))) {
    throw new Error("Это уточнение уже есть в правиле.");
  }
  return [criterion.guidance?.trim(), addition].filter(Boolean).join("\n\n");
}

export async function openRuleProposal(button, {
  source, criterionId, sourceAppealId, onDraft, canSave, onSaved,
}) {
  busy(button, true, "Готовим предложение…");
  try {
    const target = await latestRuleChecklist(source);
    if (!button.isConnected) return;
    if (!sameRule(source, target, criterionId)) {
      const newer = modal({
        title: "Правило уже обновлялось",
        cancelText: "Закрыть",
        body: `<p>Откройте последнюю версию чек-листа, чтобы увидеть актуальное правило.</p>
          <a class="btn" href="#/checklists/${target.id}" data-x>Открыть v${esc(target.version)}</a>`,
      });
      $('[role="dialog"]', newer.el).setAttribute("aria-label", "Правило уже обновлялось");
      return;
    }
    if (onDraft && target.id !== source.id) {
      throw new Error("Откройте последнюю версию чек-листа, чтобы добавить уточнение.");
    }

    const proposal = await api.suggestRule(source.id, criterionId);
    if (!button.isConnected) return;
    const criterion = target.config.criteria.find((item) => item.id === criterionId);
    const links = proposal.appeal_ids.map((id) =>
      `<a href="#/appeals/${esc(id)}" target="_blank" rel="noopener">#${esc(id)}</a>`).join(", ");
    const title = `${criterion.code || criterion.id} · ${criterion.title}`;
    const preview = modal({
      title,
      cancelText: "Закрыть",
      submitText: onDraft ? "Вставить в черновик" : "Сохранить новую версию",
      body: `<p>${esc(proposal.reason)}</p>
        ${proposal.addition ? `<label class="field">Уточнение правила
          <textarea class="input rule-suggestion-text" id="rule-proposal-addition" rows="4" maxlength="1200">${esc(proposal.addition)}</textarea></label>` : ""}
        <p class="muted small">Апелляции ${links} · оценивались по v${esc(source.version)}</p>
        ${proposal.addition && criterion.guidance ? `<details class="rule-proposal-current"><summary>Действующее правило</summary>
          <p class="muted small">${esc(criterion.guidance)}</p></details>` : ""}
        ${proposal.addition && !onDraft ? `<p class="muted small">Новая версия на основе v${esc(target.version)} будет сохранена для проверки перед включением.</p>` : ""}`,
      onSubmit: proposal.addition ? async (el) => {
        if (!button.isConnected) return;
        const addition = $("#rule-proposal-addition", el).value.trim();
        const guidance = appendGuidance(criterion, addition);
        if (!onDraft && canSave && !canSave()) throw new Error("Сначала сохраните изменения в редакторе.");

        const latest = await latestRuleChecklist(source);
        if (!button.isConnected || !el.isConnected) return;
        if (!onDraft && canSave && !canSave()) throw new Error("Сначала сохраните изменения в редакторе.");
        if (latest.id !== target.id) {
          throw new Error("Появилась новая версия чек-листа. Закройте предложение и запросите его снова.");
        }
        if (onDraft) return onDraft(guidance, proposal.appeal_ids);
        const config = structuredClone(latest.config);
        config.criteria.find((item) => item.id === criterionId).guidance = guidance;
        const appealIds = proposal.appeal_ids;
        const sourceId = appealIds.includes(sourceAppealId) ? sourceAppealId : appealIds[0];
        const note = `По апелляциям ${appealIds.map((id) => `#${id}`).join(", ")} · Критерий ${criterion.code || criterion.id}`;
        const saved = await api.saveChecklist(config, note.slice(0, 300), false, sourceId, latest.id);
        toast(`Версия v${saved.version} сохранена для проверки`);
        if (!button.isConnected || !el.isConnected) return;
        if (onSaved) onSaved(saved);
        else location.hash = `#/checklists/${saved.id}`;
      } : null,
    });
    const dialog = $('[role="dialog"]', preview.el);
    dialog.classList.add("modal-wide");
    dialog.setAttribute("aria-label", title);
  } catch (error) {
    if (button.isConnected) toast(error.message, true);
  } finally {
    busy(button, false);
  }
}
