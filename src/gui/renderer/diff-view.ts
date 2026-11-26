import { element } from "./dom";
import { interpolate, translate } from "./i18n";
import { t, type RendererStore } from "./state";
import type { DiffDisplayLine, FileChange, Language } from "./types";

export function botChanges(store: RendererStore): FileChange[] {
  return store.currentBot?.turns.flatMap((turn) => turn.changes ?? []) ?? [];
}

export function diffDisplayLines(change: FileChange, language: Language = "en"): DiffDisplayLine[] {
  return change.hunks.flatMap((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines: DiffDisplayLine[] = [{ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` }];
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        lines.push({ kind: "note", marker: "\\", text: translate(language, "noNewline") });
      } else {
        const kind = line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "context";
        lines.push({
          kind,
          marker: line[0],
          text: line.slice(1),
          ...(kind !== "addition" ? { oldLine: oldLine++ } : {}),
          ...(kind !== "deletion" ? { newLine: newLine++ } : {}),
        });
      }
    }
    return lines;
  });
}

export function fileChangeText(change: FileChange, language: Language = "en"): string {
  return [
    `--- ${change.operation === "create" ? "/dev/null" : change.path}`,
    `+++ ${change.path}`,
    ...change.hunks.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]),
    ...(change.truncated ? [`... ${translate(language, "diffTruncated")}`] : []),
    "",
  ].join("\n");
}

export function fileChangeCard(store: RendererStore, change: FileChange, open = false): HTMLDetailsElement {
  const card = document.createElement("details");
  card.className = "file-change";
  card.dataset.changeId = change.id;
  card.open = open;
  const summary = document.createElement("summary");
  const path = document.createElement("span");
  path.className = "change-path";
  path.textContent = change.path;
  path.title = change.path;
  const operation = document.createElement("span");
  operation.className = "change-operation";
  operation.textContent = t(store, change.operation === "create" ? "createdFile" : change.operation === "edit" ? "editedFile" : "replacedFile");
  const stats = document.createElement("span");
  stats.className = "change-stats";
  if (change.additions !== null && change.deletions !== null) {
    const additions = document.createElement("span");
    additions.className = "diff-additions";
    additions.textContent = `+${change.additions}`;
    const deletions = document.createElement("span");
    deletions.className = "diff-deletions";
    deletions.textContent = `−${change.deletions}`;
    stats.append(additions, deletions);
  }
  summary.append(path, operation, stats);
  card.append(summary);
  let loaded = false;
  const load = (): void => {
    if (loaded) return;
    loaded = true;
    const body = document.createElement("div");
    body.className = "diff-body";
    const language = store.state?.language ?? "en";
    const rows = diffDisplayLines(change, language);
    if (rows.length > 0) {
      const toolbar = document.createElement("div");
      toolbar.className = "diff-toolbar";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "diff-copy";
      copy.textContent = t(store, "copyDiff");
      copy.addEventListener("click", () => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(fileChangeText(change, language));
            copy.textContent = t(store, "copiedDiff");
          } catch { copy.textContent = t(store, "copyDiffFailed"); }
        })();
      });
      toolbar.append(copy);
      const scroll = document.createElement("div");
      scroll.className = "diff-lines";
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", `${t(store, "changes")} · ${change.path}`);
      const grid = document.createElement("div");
      grid.className = "diff-grid";
      scroll.append(grid);
      let expanded = false;
      const appendRow = (line: DiffDisplayLine): void => {
        const row = document.createElement("div");
        row.className = `diff-row ${line.kind}`;
        if (line.kind === "hunk") row.textContent = line.text;
        else {
          for (const number of [line.oldLine, line.newLine]) {
            const gutter = document.createElement("span");
            gutter.className = "diff-number";
            gutter.textContent = number === undefined ? "" : String(number);
            gutter.setAttribute("aria-hidden", "true");
            row.append(gutter);
          }
          const marker = document.createElement("span");
          marker.className = "diff-marker";
          marker.textContent = line.marker ?? "";
          const code = document.createElement("code");
          code.className = "diff-code";
          code.textContent = line.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
          row.append(marker, code);
        }
        grid.append(row);
      };
      const renderRows = (): void => {
        grid.replaceChildren();
        if (rows.length <= 16 || expanded) rows.forEach(appendRow);
        else rows.slice(0, 8).forEach(appendRow);
        if (rows.length > 16) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "diff-expand";
          toggle.textContent = expanded ? t(store, "collapseDiff") : interpolate(t(store, "showDiffLines"), { count: rows.length - 16 });
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.addEventListener("click", () => {
            expanded = !expanded;
            renderRows();
            grid.querySelector<HTMLButtonElement>(".diff-expand")?.focus({ preventScroll: true });
          });
          grid.append(toggle);
          if (!expanded) rows.slice(-8).forEach(appendRow);
        }
      };
      renderRows();
      body.append(toolbar, scroll);
    } else {
      const empty = document.createElement("p");
      empty.className = "diff-notice";
      empty.textContent = t(store, change.additions === null ? "diffUnavailable" : change.operation === "create" ? "emptyFileCreated" : "noTextChanges");
      body.append(empty);
    }
    if (change.truncated && change.additions !== null) {
      const notice = document.createElement("p");
      notice.className = "diff-notice";
      notice.textContent = t(store, "diffTruncated");
      body.append(notice);
    }
    card.append(body);
  };
  card.addEventListener("toggle", () => { if (card.open) load(); });
  if (open) load();
  return card;
}

export function renderChanges(store: RendererStore): void {
  const changes = botChanges(store);
  const count = element<HTMLSpanElement>("changes-count");
  const files = new Set(changes.map((change) => change.path)).size;
  count.hidden = files === 0;
  count.textContent = String(files);
  element<HTMLDivElement>("changes-summary").textContent = changes.length === 0 ? ""
    : interpolate(t(store, "changesSummary"), { files, changes: changes.length });
  const list = element<HTMLDivElement>("change-list");
  const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>(".file-change[open]"), (card) => card.dataset.changeId));
  list.replaceChildren();
  if (changes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t(store, "noChanges");
    list.append(empty);
  } else {
    // Each entry is the diff at the time of the operation, including repeated edits to one path.
    for (const change of changes.toReversed()) list.append(fileChangeCard(store, change, open.has(change.id)));
  }
}
